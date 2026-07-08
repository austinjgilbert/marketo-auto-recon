/**
 * Stage: Interpret — derive commercial meaning from normalized journeys:
 * journey stage, stall detection, velocity, and the state-change signals the
 * harvester emits. Everything is deterministic and rule-based with visible
 * rationale (no opaque scoring), and every signal carries a stable dedupeKey
 * so re-polls never double-emit.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const daysBetween = (a, b) => Math.abs(new Date(b) - new Date(a)) / DAY_MS;

/* ── journey stage ── */

const DECISION_FORM_INTENTS = new Set(['contact_us', 'demo_request']);

export function deriveJourneyStage(journey, now = new Date()) {
  const events = journey.events || journey.timeline || [];
  const status = (journey.lead?.status || '').toLowerCase();
  const reasons = [];

  if (/customer|closed.?won/.test(status)) {
    return { stage: 'customer', reasons: [`lead status "${journey.lead.status}"`] };
  }

  const decisionEvents = events.filter(
    (e) =>
      (e.canonicalType === 'form_fill' && DECISION_FORM_INTENTS.has(e.formIntent)) ||
      e.urlCategory === 'pricing' ||
      e.urlCategory === 'competitor' ||
      e.canonicalType === 'trial_start',
  );
  if (decisionEvents.length || /mql|sql|sal|opportunit/.test(status)) {
    if (decisionEvents.length) {
      const kinds = [...new Set(decisionEvents.map((e) => e.formIntent || e.urlCategory || e.canonicalType))];
      reasons.push(`decision behavior: ${kinds.join(', ')}`);
    }
    if (/mql|sql|sal|opportunit/.test(status)) reasons.push(`lead status "${journey.lead?.status}"`);
    return { stage: 'decision', reasons };
  }

  const considerationEvents = events.filter(
    (e) =>
      (e.canonicalType === 'form_fill' && ['content_download', 'event_registration'].includes(e.formIntent)) ||
      e.canonicalType === 'event_attended' ||
      e.canonicalType === 'email_click' ||
      e.urlCategory === 'product' ||
      e.urlCategory === 'docs' ||
      e.urlCategory === 'case-study',
  );
  if (considerationEvents.length >= 2) {
    const kinds = [...new Set(considerationEvents.map((e) => e.formIntent || e.urlCategory || e.canonicalType))];
    return { stage: 'consideration', reasons: [`engaged with: ${kinds.join(', ')}`] };
  }

  return { stage: 'awareness', reasons: events.length ? ['only light/top-of-funnel touches'] : ['no activity'] };
}

/* ── stalls ── */

export function detectStalls(events, { now = new Date(), stallGapDays = 21 } = {}) {
  const stalls = [];
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));

  for (let i = 1; i < sorted.length; i++) {
    const gap = daysBetween(sorted[i - 1].ts, sorted[i].ts);
    if (gap >= stallGapDays) {
      stalls.push({
        kind: 'gap',
        fromTs: sorted[i - 1].ts,
        toTs: sorted[i].ts,
        days: Math.round(gap),
        detail: `${Math.round(gap)}-day gap after "${sorted[i - 1].asset || sorted[i - 1].canonicalType}"`,
        resumed: true,
      });
    }
  }

  const last = sorted[sorted.length - 1];
  if (last && sorted.length >= 3) {
    const trailing = daysBetween(last.ts, now);
    if (trailing >= stallGapDays) {
      stalls.push({
        kind: 'trailing',
        fromTs: last.ts,
        toTs: null,
        days: Math.round(trailing),
        detail: `No activity for ${Math.round(trailing)} days after an engaged period (last: "${last.asset || last.canonicalType}")`,
        resumed: false,
      });
    }
  }

  const drops = sorted.filter((e) => e.canonicalType === 'score_change' && (e.scoreDelta ?? 0) < 0);
  for (const d of drops) {
    stalls.push({ kind: 'score-drop', fromTs: d.ts, toTs: d.ts, days: 0, detail: `Score dropped ${d.scoreDelta}`, resumed: true });
  }

  // Repeat-without-progress: 3+ visits to the same category with no form fill after.
  const byCategory = new Map();
  for (const e of sorted) {
    if (e.canonicalType === 'web_visit' && e.urlCategory && e.urlCategory !== 'other') {
      (byCategory.get(e.urlCategory) || byCategory.set(e.urlCategory, []).get(e.urlCategory)).push(e);
    }
  }
  for (const [category, visits] of byCategory) {
    if (visits.length >= 3) {
      const lastVisit = visits[visits.length - 1];
      const formAfter = sorted.some((e) => e.canonicalType === 'form_fill' && e.ts > lastVisit.ts);
      if (!formAfter) {
        stalls.push({
          kind: 'repeat-without-progress',
          fromTs: visits[0].ts,
          toTs: lastVisit.ts,
          days: Math.round(daysBetween(visits[0].ts, lastVisit.ts)),
          detail: `${visits.length} visits to ${category} pages with no form fill — possibly stuck or unconvinced`,
          resumed: false,
        });
      }
    }
  }

  return stalls;
}

/* ── velocity ── */

export function computeVelocity(events, now = new Date()) {
  const recent = events.filter((e) => daysBetween(e.ts, now) <= 14).length;
  const prior = events.filter((e) => {
    const d = daysBetween(e.ts, now);
    return d > 14 && d <= 28;
  }).length;
  let trend = 'dormant';
  if (recent > 0 && recent > prior) trend = 'rising';
  else if (recent > 0 && recent === prior) trend = 'steady';
  else if (recent > 0) trend = 'falling';
  return { recent14d: recent, prior14d: prior, trend };
}

/* ── full interpretation of a journey (lead or account) ── */

export function interpretJourney(journey, { signalMap, now = new Date() } = {}) {
  const events = journey.events || journey.timeline || [];
  const thresholds = signalMap?.thresholds || {};
  return {
    stage: deriveJourneyStage(journey, now),
    stalls: detectStalls(events, { now, stallGapDays: thresholds.stallGapDays ?? 21 }),
    velocity: computeVelocity(events, now),
  };
}

/* ── state-change signals (the harvester's currency) ── */

const dayBucket = (ts) => String(ts).slice(0, 10);

function signal({ domain, signalType, leadId, email, ts, strength, summary, evidence, dedupeSuffix }) {
  return {
    dedupeKey: `${domain}:${signalType}:${leadId ?? 'account'}:${dedupeSuffix ?? dayBucket(ts)}`,
    domain,
    signalType,
    leadId: leadId ?? null,
    email: email ?? null,
    timestamp: ts,
    strength,
    summary,
    evidence: evidence || [],
  };
}

const FORM_INTENT_TO_SIGNAL = {
  contact_us: { signalType: 'contact_us', strength: 95 },
  demo_request: { signalType: 'demo_request', strength: 95 },
  content_download: { signalType: 'form_fill', strength: 60 },
  event_registration: { signalType: 'form_fill', strength: 55 },
  newsletter: { signalType: 'form_fill', strength: 30 },
  form_fill: { signalType: 'form_fill', strength: 50 },
};

/**
 * Event-driven signals from a batch of NEW events (harvester passes only what
 * arrived since the last poll). Pure — dedupe is the caller's job via dedupeKey.
 */
export function extractEventSignals(newEvents, { domain, leadById = new Map(), signalMap }) {
  const thresholds = signalMap?.thresholds || {};
  const scoreJumpMin = thresholds.scoreJumpMin ?? 10;
  const signals = [];

  for (const e of newEvents) {
    const lead = leadById.get(e.leadId) || {};
    const who = lead.name || lead.email || `lead ${e.leadId}`;
    const title = lead.title ? ` (${lead.title})` : '';

    if (e.canonicalType === 'form_fill') {
      const mapped = FORM_INTENT_TO_SIGNAL[e.formIntent] || FORM_INTENT_TO_SIGNAL.form_fill;
      signals.push(
        signal({
          domain,
          signalType: mapped.signalType,
          leadId: e.leadId,
          email: lead.email,
          ts: e.ts,
          strength: mapped.strength,
          summary: `${who}${title} filled out "${e.asset}"${e.attrs?.Comments ? ` — "${e.attrs.Comments}"` : ''}`,
          evidence: [e.id],
          dedupeSuffix: `${e.asset}:${dayBucket(e.ts)}`,
        }),
      );
    }

    if (e.canonicalType === 'web_visit' && e.urlCategory === 'pricing') {
      signals.push(
        signal({
          domain,
          signalType: 'pricing_page_visit',
          leadId: e.leadId,
          email: lead.email,
          ts: e.ts,
          strength: 70,
          summary: `${who}${title} visited the pricing page`,
          evidence: [e.id],
        }),
      );
    }

    if (e.canonicalType === 'web_visit' && e.urlCategory === 'competitor') {
      signals.push(
        signal({
          domain,
          signalType: 'competitor_research',
          leadId: e.leadId,
          email: lead.email,
          ts: e.ts,
          strength: 65,
          summary: `${who}${title} viewed a competitor comparison page (${e.url})`,
          evidence: [e.id],
        }),
      );
    }

    if (e.canonicalType === 'score_change' && (e.scoreDelta ?? 0) >= scoreJumpMin) {
      signals.push(
        signal({
          domain,
          signalType: 'score_jump',
          leadId: e.leadId,
          email: lead.email,
          ts: e.ts,
          strength: Math.min(80, 40 + e.scoreDelta),
          summary: `${who}${title} score jumped +${e.scoreDelta}${e.attrs?.['New Value'] ? ` to ${e.attrs['New Value']}` : ''}`,
          evidence: [e.id],
        }),
      );
    }

    if (e.canonicalType === 'trial_start') {
      signals.push(
        signal({
          domain,
          signalType: 'product_signup',
          leadId: e.leadId,
          email: lead.email,
          ts: e.ts,
          strength: 85,
          summary: `${who}${title} started a product trial (${e.asset})`,
          evidence: [e.id],
        }),
      );
    }

    if (e.canonicalType === 'data_change' && /status|stage/i.test(e.asset || '') && /mql|sql|sal/i.test(e.attrs?.['New Value'] || '')) {
      signals.push(
        signal({
          domain,
          signalType: 'mql',
          leadId: e.leadId,
          email: lead.email,
          ts: e.ts,
          strength: 75,
          summary: `${who}${title} moved to ${e.attrs['New Value']}`,
          evidence: [e.id],
        }),
      );
    }
  }
  return signals;
}

/**
 * Pattern signals over the account journey: content binge, intent surge,
 * committee growth, reactivation, journey stall. `state` carries what earlier
 * polls knew: { knownLeadIds: [], stalledLeadIds: [] }.
 */
export function extractPatternSignals(accountJourney, { signalMap, now = new Date(), state = {} } = {}) {
  const thresholds = signalMap?.thresholds || {};
  const signals = [];
  const domain = accountJourney.domain;
  const knownLeadIds = new Set(state.knownLeadIds || []);
  const stalledLeadIds = new Set(state.stalledLeadIds || []);

  for (const j of accountJourney.leadJourneys) {
    const events = j.events;
    if (!events.length) continue;
    const who = j.lead.name || j.lead.email;
    const title = j.lead.title ? ` (${j.lead.title})` : '';

    /* content binge: N+ content touches inside the window */
    const bingeTouches = thresholds.contentBingeTouches ?? 3;
    const bingeWindowMs = (thresholds.contentBingeWindowHours ?? 72) * 3_600_000;
    const contentEvents = events.filter(
      (e) => e.canonicalType === 'web_visit' || e.canonicalType === 'email_click' || (e.canonicalType === 'form_fill' && e.formIntent === 'content_download'),
    );
    for (let i = 0; i + bingeTouches - 1 < contentEvents.length; i++) {
      const first = contentEvents[i];
      const last = contentEvents[i + bingeTouches - 1];
      if (new Date(last.ts) - new Date(first.ts) <= bingeWindowMs) {
        signals.push(
          signal({
            domain,
            signalType: 'content_binge',
            leadId: j.lead.id,
            email: j.lead.email,
            ts: last.ts,
            strength: 60,
            summary: `${who}${title} consumed ${bingeTouches}+ pieces of content within ${thresholds.contentBingeWindowHours ?? 72}h`,
            evidence: contentEvents.slice(i, i + bingeTouches).map((e) => e.id),
            dedupeSuffix: dayBucket(last.ts),
          }),
        );
        break; // one binge signal per lead per detection pass
      }
    }

    /* committee growth: a lead this account hasn't shown before becomes active */
    if (knownLeadIds.size && !knownLeadIds.has(j.lead.id)) {
      signals.push(
        signal({
          domain,
          signalType: 'committee_growth',
          leadId: j.lead.id,
          email: j.lead.email,
          ts: j.firstSeen,
          strength: 70,
          summary: `New person active at ${accountJourney.company}: ${who}${title} — buying committee may be forming`,
          evidence: events.slice(0, 3).map((e) => e.id),
          dedupeSuffix: 'first-seen',
        }),
      );
    }

    /* stall + reactivation */
    const stallGapDays = thresholds.stallGapDays ?? 21;
    const stalls = detectStalls(events, { now, stallGapDays });
    const trailing = stalls.find((s) => s.kind === 'trailing');
    if (trailing) {
      signals.push(
        signal({
          domain,
          signalType: 'journey_stall',
          leadId: j.lead.id,
          email: j.lead.email,
          ts: trailing.fromTs,
          strength: 45,
          summary: `${who}${title} went quiet: ${trailing.detail}`,
          evidence: [],
          dedupeSuffix: `stall:${dayBucket(trailing.fromTs)}`,
        }),
      );
    }
    if (stalledLeadIds.has(j.lead.id) && !trailing) {
      const last = events[events.length - 1];
      signals.push(
        signal({
          domain,
          signalType: 'reactivation',
          leadId: j.lead.id,
          email: j.lead.email,
          ts: last.ts,
          strength: 65,
          summary: `${who}${title} is back after a stall — latest: ${last.asset || last.canonicalType}`,
          evidence: [last.id],
          dedupeSuffix: `reactivation:${dayBucket(last.ts)}`,
        }),
      );
    }

    /* intent surge: burst of touches in a day */
    const surgeTouches = thresholds.intentSurgeTouches ?? 5;
    const surgeWindowMs = (thresholds.intentSurgeWindowHours ?? 24) * 3_600_000;
    for (let i = 0; i + surgeTouches - 1 < events.length; i++) {
      if (new Date(events[i + surgeTouches - 1].ts) - new Date(events[i].ts) <= surgeWindowMs) {
        signals.push(
          signal({
            domain,
            signalType: 'intent_surge',
            leadId: j.lead.id,
            email: j.lead.email,
            ts: events[i + surgeTouches - 1].ts,
            strength: 75,
            summary: `${who}${title} showed ${surgeTouches}+ activities within ${thresholds.intentSurgeWindowHours ?? 24}h — active evaluation`,
            evidence: events.slice(i, i + surgeTouches).map((e) => e.id),
            dedupeSuffix: dayBucket(events[i + surgeTouches - 1].ts),
          }),
        );
        break;
      }
    }
  }

  return signals;
}

/** Next-poll state derived from the current journey (persisted by the harvester). */
export function nextPatternState(accountJourney, { signalMap, now = new Date() } = {}) {
  const stallGapDays = signalMap?.thresholds?.stallGapDays ?? 21;
  return {
    knownLeadIds: accountJourney.leadJourneys.filter((j) => j.events.length).map((j) => j.lead.id),
    stalledLeadIds: accountJourney.leadJourneys
      .filter((j) => j.events.length && detectStalls(j.events, { now, stallGapDays }).some((s) => s.kind === 'trailing'))
      .map((j) => j.lead.id),
  };
}
