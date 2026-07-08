/**
 * Stage: Produce — the seller snapshot. Nine sections, readable in 20 seconds,
 * no interpretation required. Deterministic: every sentence traces back to
 * normalized journey facts. The optional Claude pass (src/llm.js) rewrites
 * this brief as one coherent story but can never add facts.
 */

const fmtDate = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : 'unknown');

function describeEvent(e) {
  switch (e.canonicalType) {
    case 'form_fill':
      return `filled out "${e.asset}"`;
    case 'web_visit':
      return `visited ${e.url || e.asset}`;
    case 'email_click':
      return `clicked "${e.asset}"`;
    case 'email_open':
      return `opened "${e.asset}"`;
    case 'event_attended':
      return `attended "${e.asset}"`;
    case 'trial_start':
      return `started a trial (${e.asset})`;
    case 'score_change':
      return `score ${e.scoreDelta >= 0 ? '+' : ''}${e.scoreDelta}`;
    case 'data_change':
      return `${e.asset} → ${e.attrs?.['New Value'] || 'changed'}`;
    default:
      return `${e.canonicalType.replace(/_/g, ' ')}${e.asset ? `: ${e.asset}` : ''}`;
  }
}

function keyMoments(events, max = 6) {
  const weight = (e) => {
    if (e.canonicalType === 'form_fill' && ['contact_us', 'demo_request'].includes(e.formIntent)) return 100;
    if (e.canonicalType === 'trial_start') return 90;
    if (e.urlCategory === 'pricing') return 80;
    if (e.urlCategory === 'competitor') return 75;
    if (e.canonicalType === 'form_fill') return 70;
    if (e.canonicalType === 'event_attended') return 65;
    if (e.canonicalType === 'email_click') return 40;
    if (e.canonicalType === 'web_visit') return 30;
    return 10;
  };
  return [...events]
    .sort((a, b) => weight(b) - weight(a) || b.ts.localeCompare(a.ts))
    .slice(0, max)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Build the nine-section snapshot from journeys + interpretation. Pure. */
export function buildSnapshot({ focusJourney, accountJourney, interpretation, now = new Date() }) {
  const lead = focusJourney.lead;
  const events = focusJourney.events;
  const { stage, stalls, velocity } = interpretation;

  const contactForm = [...events].reverse().find((e) => e.canonicalType === 'form_fill' && ['contact_us', 'demo_request'].includes(e.formIntent));
  // Lead-typed free text is untrusted input (anyone can submit a public form) —
  // cap what we quote so it can't dominate the brief or the LLM prompt built on it.
  const comments = contactForm?.attrs?.Comments ? String(contactForm.attrs.Comments).slice(0, 200) : null;
  const pricingVisits = events.filter((e) => e.urlCategory === 'pricing');
  const competitorViews = events.filter((e) => e.urlCategory === 'competitor');
  const topTopics = focusJourney.topics.map((t) => t.topic);
  const othersActive = accountJourney.members.filter((m) => m.id !== lead.id && m.eventCount > 0);
  const unresolvedStalls = stalls.filter((s) => !s.resumed);
  const moments = keyMoments(events);

  /* 1 — who */
  const who =
    `${lead.name}, ${lead.title || 'title unknown'} at ${lead.company || lead.domain || 'unknown company'}. ` +
    `First seen ${fmtDate(focusJourney.firstSeen)} via ${lead.originalSource || lead.utm.source || 'unknown source'}` +
    `${lead.utm.campaign ? ` (campaign: ${lead.utm.campaign})` : ''}. ` +
    `${events.length} tracked touches over ${Math.max(1, Math.round((new Date(focusJourney.lastSeen) - new Date(focusJourney.firstSeen)) / 86_400_000))} days; ` +
    `journey stage: ${stage.stage} (${stage.reasons.join('; ')}). Marketo score: ${lead.score ?? 'n/a'}.`;

  /* 2 — interest */
  const interest =
    `Key moments: ${moments.map((e) => `${fmtDate(e.ts)} ${describeEvent(e)}`).join(' · ')}. ` +
    (topTopics.length ? `Recurring topics: ${topTopics.join(', ')}. ` : '') +
    (comments ? `In their own words: "${comments}"` : 'No free-text ask captured — infer from behavior above.');

  /* 3 — why care */
  const whyCareParts = [];
  if (contactForm) whyCareParts.push(`they raised their hand ("${contactForm.asset}", ${fmtDate(contactForm.ts)})`);
  if (pricingVisits.length) whyCareParts.push(`${pricingVisits.length}x pricing views`);
  if (competitorViews.length) whyCareParts.push('actively comparing against an incumbent/competitor');
  if (othersActive.length) whyCareParts.push(`${othersActive.length} other ${othersActive.length === 1 ? 'person' : 'people'} at ${lead.company || 'the account'} also active`);
  if (velocity.trend === 'rising') whyCareParts.push('activity is accelerating');
  const whyCare = whyCareParts.length
    ? `Warmer than 90% of cold pipeline: ${whyCareParts.join('; ')}. This account is moving — time spent here beats time spent prospecting.`
    : `Early but real: tracked engagement exists and nobody has engaged them yet. Low competition for attention.`;

  /* 4 — doubts */
  const doubts = [];
  if (unresolvedStalls.length) doubts.push(...unresolvedStalls.map((s) => s.detail));
  if (competitorViews.length) doubts.push('Evaluating alternatives — expect a comparison conversation, not a blank slate.');
  if (!contactForm && stage.stage !== 'decision') doubts.push('Has not asked to talk — outreach must lead with value, not a meeting ask.');
  if (lead.role === 'practitioner') doubts.push('Practitioner profile — likely influences rather than signs; budget owner is someone else.');
  if (!doubts.length) doubts.push('No visible blockers in the data; standard risks (budget, timing, competing priorities) still apply.');

  /* 5 — what to say */
  const say = contactForm
    ? `Open with their ask: acknowledge the "${contactForm.asset}" submission${comments ? ` and their exact words ("${comments.slice(0, 120)}")` : ''}. ` +
      `Connect it to what they explored (${topTopics.slice(0, 3).join(', ') || 'their content trail'}) and promise a concrete answer on the first call, not discovery-for-discovery.`
    : `Reference the specific thing they engaged with most recently (${moments.length ? describeEvent(moments[moments.length - 1]) : 'their latest touch'}) and offer one useful asset or insight on that exact topic. Promise value in the first message; ask for nothing yet.`;

  /* 6 — channel & timing */
  const lastTs = focusJourney.lastSeen;
  const daysSinceLast = lastTs ? Math.round((now - new Date(lastTs)) / 86_400_000) : null;
  const channel = contactForm
    ? `Email + call same day. They submitted a form ${daysSinceLast ?? '?'} day(s) ago — inbound SLA rules apply: every day of delay costs conversion.`
    : velocity.trend === 'rising'
      ? `Email first, while they are actively researching (activity in the last 14 days: ${velocity.recent14d}). Follow with LinkedIn.`
      : `Email, low-pressure re-engagement. They are ${velocity.trend}; a call now would land cold.`;

  /* 7 — next step */
  const next = contactForm
    ? `Reply to the "${contactForm.asset}" submission today with one concrete answer + one concrete question about their use case. Book the call in the same thread.`
    : unresolvedStalls.some((s) => s.kind === 'repeat-without-progress')
      ? `They looped on the same pages without converting — send the missing piece (pricing clarity, comparison guide, or a customer story matching "${topTopics[0] || 'their topic'}").`
      : `Send one relevant asset tied to "${topTopics[0] || 'their most-viewed topic'}" and watch for a reactivation signal.`;

  /* 8 — follow-up */
  const followUp = othersActive.length
    ? `Multi-thread: also touch ${othersActive.map((m) => `${m.name}${m.title ? ` (${m.title})` : ''}`).join(', ')} — coordinate so the account hears one story. If no reply in 3 business days, follow up referencing a different proof point, then switch channel.`
    : `If no reply in 3 business days, follow up once with a different angle, then a LinkedIn touch. Stop after 3 attempts and hand to nurture — the harvester will flag reactivation.`;

  /* 9 — account context */
  const accountContext = othersActive.length
    ? `${accountJourney.committee.activeCount} active people at ${accountJourney.company} (${accountJourney.committee.lanes.ATL} ATL / ${accountJourney.committee.lanes.BTL} BTL): ` +
      accountJourney.members
        .filter((m) => m.eventCount > 0)
        .map((m) => `${m.name} (${m.title || 'unknown'}, ${m.eventCount} touches, last ${fmtDate(m.lastSeen)})`)
        .join('; ') +
      '. Treat this as a committee forming, not an individual browsing.'
    : `Only ${lead.name} is visibly active at ${accountJourney.company} so far.`;

  const json = {
    generatedAt: now.toISOString(),
    subject: { email: lead.email, name: lead.name, title: lead.title, company: lead.company, domain: lead.domain },
    journeyStage: stage.stage,
    velocity,
    sections: { who, interest, whyCare, doubts, say, channel, next, followUp, accountContext },
    keyMoments: moments.map((e) => ({ ts: e.ts, description: describeEvent(e), canonicalType: e.canonicalType })),
    stalls,
    topics: focusJourney.topics,
    account: {
      domain: accountJourney.domain,
      company: accountJourney.company,
      committee: accountJourney.committee,
      members: accountJourney.members,
    },
  };

  const markdown = [
    `# Seller snapshot — ${lead.name} @ ${accountJourney.company}`,
    '',
    `Generated ${fmtDate(now)} · stage: **${stage.stage}** · velocity: **${velocity.trend}** · score: ${lead.score ?? 'n/a'}`,
    '',
    `## 1. Who this is`,
    who,
    '',
    `## 2. What they care about`,
    interest,
    '',
    `## 3. Why you should want this`,
    whyCare,
    '',
    `## 4. Likely doubts and blockers`,
    ...doubts.map((d) => `- ${d}`),
    '',
    `## 5. What to say`,
    say,
    '',
    `## 6. Channel and timing`,
    channel,
    '',
    `## 7. Next step (do this now)`,
    next,
    '',
    `## 8. Follow-up plan`,
    followUp,
    '',
    `## 9. Who else is involved`,
    accountContext,
    '',
  ].join('\n');

  return { json, markdown };
}
