/**
 * Stage: Normalize — raw Marketo activities → a chronological, canonical
 * journey per lead, rolled up per account. This is the "formulaic, normalized
 * blob" agents and sellers consume: every event carries its canonical type,
 * URL category, form intent, and score delta, so downstream stages never
 * touch raw Marketo shapes again.
 */

import { classifyUrl } from './signal-map.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'your', 'from', 'this', 'that', 'off', 'our', 'via',
  'blog', 'docs', 'page', 'form', 'email', 'invite', 'download', 'signup', 'wbn', 'nur',
  'www', 'com', 'https', 'http',
]);

function attrsToObject(attributes = []) {
  const out = {};
  for (const a of attributes) out[a.name] = a.value;
  return out;
}

function parseScoreDelta(attrs) {
  const raw = attrs['Change Value'] ?? attrs['changeValue'];
  if (raw === undefined) return null;
  const n = Number(String(raw).replace('+', ''));
  return Number.isFinite(n) ? n : null;
}

/** One raw Marketo activity → one canonical event (or null when mapped to ignore/unknown). */
export function normalizeActivity(activity, signalMap) {
  const mapping = signalMap.activityTypes[activity.activityTypeId];
  const canonicalType = mapping?.canonical || 'unknown';
  if (canonicalType === 'ignore') return null;

  const attrs = attrsToObject(activity.attributes);
  const url = attrs['Webpage URL'] || attrs['webpage URL'] || null;
  const event = {
    id: activity.id,
    leadId: activity.leadId,
    ts: new Date(activity.activityDate).toISOString(),
    canonicalType,
    rawTypeId: activity.activityTypeId,
    rawTypeName: mapping?.name || `type-${activity.activityTypeId}`,
    asset: activity.primaryAttributeValue || null,
    url,
    urlCategory: url ? classifyUrl(url, signalMap.urlPatterns) : null,
    formIntent: null,
    scoreDelta: canonicalType === 'score_change' ? parseScoreDelta(attrs) : null,
    attrs,
  };

  if (canonicalType === 'form_fill') {
    const formName = attrs['Form Name'] || activity.primaryAttributeValue || '';
    event.formIntent = signalMap.forms[formName]?.signalType || 'form_fill';
    event.asset = formName || event.asset;
  }
  if (canonicalType === 'data_change') {
    event.asset = activity.primaryAttributeValue || null; // the changed field name
  }
  return event;
}

export function normalizeActivities(activities, signalMap) {
  return activities
    .map((a) => normalizeActivity(a, signalMap))
    .filter(Boolean)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Role guess from title — ATL/BTL style lanes for the committee view. */
export function guessRole(title) {
  const t = (title || '').toLowerCase();
  if (!t) return { role: 'unknown', lane: 'unknown' };
  if (/chief|cxo|c[emit]o\b|founder|president|vp|vice president|head of|svp|evp/.test(t)) {
    return { role: 'executive', lane: 'ATL' };
  }
  if (/director|manager|lead\b|principal/.test(t)) return { role: 'manager', lane: 'ATL' };
  if (/engineer|developer|architect|analyst|specialist|coordinator|designer|admin/.test(t)) {
    return { role: 'practitioner', lane: 'BTL' };
  }
  return { role: 'other', lane: 'BTL' };
}

/** Freemail providers — matched exactly or as a dotted suffix (yahoo.co.uk),
    never as a substring, so corporate domains like notgmail.com attribute fine. */
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com',
  'fastmail.com', 'hey.com', 'tutanota.com', 'mail.ru', 'qq.com', '163.com', '126.com',
]);
const FREEMAIL_SUFFIX_BASES = ['yahoo', 'hotmail', 'outlook', 'live', 'googlemail', 'gmx', 'yandex'];

export function isFreemailDomain(domain) {
  const d = (domain || '').toLowerCase();
  if (FREEMAIL_DOMAINS.has(d)) return true;
  // Country variants: yahoo.co.uk, hotmail.fr, outlook.com.br, ...
  return FREEMAIL_SUFFIX_BASES.some((base) => d.startsWith(`${base}.`));
}

export function domainOf(lead) {
  if (lead.email && lead.email.includes('@')) {
    const domain = lead.email.split('@')[1].toLowerCase();
    // Skip freemail — can't be attributed to an account.
    if (!isFreemailDomain(domain)) return domain;
  }
  if (lead.website) {
    return lead.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
  return null;
}

/** Event types whose asset names describe CONTENT (not plumbing). */
const TOPIC_EVENT_TYPES = new Set([
  'web_visit', 'form_fill', 'link_click', 'email_open', 'email_click', 'event_attended', 'trial_start',
]);

/** Keyword topics from what the lead actually touched (assets + urls). */
export function extractTopics(events, { max = 6 } = {}) {
  const counts = new Map();
  for (const e of events) {
    if (!TOPIC_EVENT_TYPES.has(e.canonicalType)) continue;
    const text = `${e.asset || ''} ${e.url || ''}`.toLowerCase();
    for (const token of text.split(/[^a-z0-9]+/)) {
      if (token.length < 4 || STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([topic, count]) => ({ topic, count }));
}

/** Per-lead journey blob. */
export function buildLeadJourney(lead, events) {
  const mine = events.filter((e) => e.leadId === lead.id);
  const { role, lane } = guessRole(lead.title);
  return {
    lead: {
      id: lead.id,
      email: lead.email,
      name: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email,
      title: lead.title || null,
      company: lead.company || null,
      domain: domainOf(lead),
      score: lead.leadScore ?? null,
      status: lead.leadStatus || null,
      role,
      lane,
      utm: {
        source: lead.utm_source__c || lead.utmSource || null,
        medium: lead.utm_medium__c || lead.utmMedium || null,
        campaign: lead.utm_campaign__c || lead.utmCampaign || null,
      },
      originalSource: lead.originalSourceType || null,
    },
    events: mine,
    firstSeen: mine[0]?.ts || null,
    lastSeen: mine[mine.length - 1]?.ts || null,
    counts: mine.reduce((acc, e) => ((acc[e.canonicalType] = (acc[e.canonicalType] || 0) + 1), acc), {}),
    topics: extractTopics(mine),
  };
}

/** Account rollup: all leads at a domain, combined chronological timeline. */
export function buildAccountJourney(leadJourneys) {
  const active = leadJourneys.filter((j) => j.events.length > 0);
  const timeline = leadJourneys
    .flatMap((j) => j.events.map((e) => ({ ...e, email: j.lead.email, personName: j.lead.name })))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const domain = leadJourneys[0]?.lead.domain || null;
  return {
    domain,
    company: leadJourneys[0]?.lead.company || domain,
    members: leadJourneys.map((j) => ({
      id: j.lead.id,
      email: j.lead.email,
      name: j.lead.name,
      title: j.lead.title,
      role: j.lead.role,
      lane: j.lead.lane,
      score: j.lead.score,
      eventCount: j.events.length,
      firstSeen: j.firstSeen,
      lastSeen: j.lastSeen,
    })),
    committee: {
      size: leadJourneys.length,
      activeCount: active.length,
      lanes: {
        ATL: leadJourneys.filter((j) => j.lead.lane === 'ATL').length,
        BTL: leadJourneys.filter((j) => j.lead.lane === 'BTL').length,
      },
    },
    timeline,
    firstSeen: timeline[0]?.ts || null,
    lastSeen: timeline[timeline.length - 1]?.ts || null,
    topics: extractTopics(timeline),
    leadJourneys,
  };
}
