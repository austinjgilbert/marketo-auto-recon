/**
 * Pipeline orchestration — pulls a lead + their account colleagues, runs
 * normalize → interpret → snapshot. Shared by `mse test`, `mse snapshot`,
 * and the harvester. Kept API-frugal: one lead lookup, one company lookup,
 * one activity pull.
 */

import { normalizeActivities, buildLeadJourney, buildAccountJourney, domainOf } from './normalizer.js';
import { interpretJourney } from './interpreter.js';
import { buildSnapshot } from './snapshot.js';

const LEAD_FIELDS = [
  'id', 'email', 'firstName', 'lastName', 'title', 'company', 'website',
  'leadScore', 'leadStatus', 'originalSourceType',
];

/**
 * Find the focus lead plus everyone else visible at the same account.
 * Domain-only lookups need `seedLeadIds` (Marketo has no domain→leads filter):
 * the CLI supplies them from harvest state (`eventCache[domain].leadIds`).
 */
export async function loadAccountLeads(client, { email, domain, seedLeadIds }) {
  let focus = null;
  let colleagues = [];

  if (email) {
    focus = await client.getLeadByEmail(email, LEAD_FIELDS);
    if (!focus) return { focus: null, leads: [] };
  } else if (seedLeadIds?.length) {
    colleagues = await client.getLeadsByFilter('id', seedLeadIds, LEAD_FIELDS).catch(() => []);
  }

  const company = focus?.company || colleagues[0]?.company;
  if (company) {
    const byCompany = await client.getLeadsByFilter('company', company, LEAD_FIELDS).catch(() => []);
    colleagues = [...colleagues, ...byCompany];
  }
  if (!colleagues.length && domain) {
    // No company match — fall back to any leads we can find by inferred domain.
    colleagues = focus ? [focus] : [];
  }

  const byId = new Map();
  for (const l of [...(focus ? [focus] : []), ...colleagues]) byId.set(l.id, l);

  // Domain-filter colleagues so "Acme Corp" homonyms at other domains drop out.
  const focusDomain = domain || (focus ? domainOf(focus) : null);
  const leads = [...byId.values()].filter((l) => !focusDomain || domainOf(l) === focusDomain || l.id === focus?.id);
  return { focus: focus || leads[0] || null, leads };
}

/** Full journey build for an account: activities → journeys → interpretation. */
export async function buildJourneys(client, signalMap, { leads, lookbackDays = 90, now = new Date() }) {
  const since = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString();
  const leadIds = leads.map((l) => l.id);
  const mappedTypeIds = Object.keys(signalMap.activityTypes)
    .map(Number)
    .filter((id) => signalMap.activityTypes[id].canonical !== 'ignore');
  const raw = await client.getLeadActivities(leadIds, {
    sinceDatetime: since,
    activityTypeIds: mappedTypeIds,
  });
  const events = normalizeActivities(raw, signalMap);
  const leadJourneys = leads.map((l) => buildLeadJourney(l, events));
  const accountJourney = buildAccountJourney(leadJourneys);
  return { events, leadJourneys, accountJourney, since };
}

/** One-call snapshot: email/domain → { snapshot, journeys, interpretation }. */
export async function runSnapshotPipeline(client, signalMap, { email, domain, seedLeadIds, lookbackDays = 90, now = new Date() }) {
  const { focus: resolved, leads } = await loadAccountLeads(client, { email, domain, seedLeadIds });
  if (!resolved) return { error: `No Marketo lead found for ${email || domain}` };

  const { accountJourney, leadJourneys } = await buildJourneys(client, signalMap, { leads, lookbackDays, now });
  // Domain-level snapshots (no explicit email) focus on the most active lead.
  const focusJourney = email
    ? leadJourneys.find((j) => j.lead.id === resolved.id) || leadJourneys[0]
    : [...leadJourneys].sort((a, b) => b.events.length - a.events.length)[0];
  const focus = leads.find((l) => l.id === focusJourney.lead.id) || resolved;
  const interpretation = interpretJourney(focusJourney, { signalMap, now });
  const accountInterpretation = interpretJourney(accountJourney, { signalMap, now });
  const snapshot = buildSnapshot({ focusJourney, accountJourney, interpretation, now });

  return { focus, focusJourney, accountJourney, interpretation, accountInterpretation, snapshot };
}
