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

/** Find the focus lead plus everyone else visible at the same account. */
export async function loadAccountLeads(client, { email, domain }) {
  let focus = null;
  let colleagues = [];

  if (email) {
    focus = await client.getLeadByEmail(email, LEAD_FIELDS);
    if (!focus) return { focus: null, leads: [] };
  }

  const company = focus?.company;
  if (company) {
    colleagues = await client.getLeadsByFilter('company', company, LEAD_FIELDS).catch(() => []);
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
  const mappedTypeIds = Object.keys(signalMap.activityTypes).map(Number);
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
export async function runSnapshotPipeline(client, signalMap, { email, domain, lookbackDays = 90, now = new Date() }) {
  const { focus, leads } = await loadAccountLeads(client, { email, domain });
  if (!focus) return { error: `No Marketo lead found for ${email || domain}` };

  const { accountJourney, leadJourneys } = await buildJourneys(client, signalMap, { leads, lookbackDays, now });
  const focusJourney = leadJourneys.find((j) => j.lead.id === focus.id) || leadJourneys[0];
  const interpretation = interpretJourney(focusJourney, { signalMap, now });
  const accountInterpretation = interpretJourney(accountJourney, { signalMap, now });
  const snapshot = buildSnapshot({ focusJourney, accountJourney, interpretation, now });

  return { focus, focusJourney, accountJourney, interpretation, accountInterpretation, snapshot };
}
