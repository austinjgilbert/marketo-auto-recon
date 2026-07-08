/**
 * Stage: Signal Map — classify the recon inventory into a canonical taxonomy
 * that the normalizer and harvester consume. The map is written to
 * outputs/signal-map.json and is DESIGNED TO BE HAND-EDITED: every mapping
 * carries a confidence and a rationale, and anything the heuristics can't
 * place lands in `unmapped` for human review instead of being silently
 * dropped. Optional LLM assist (`mse map --llm`) proposes mappings for the
 * ambiguous leftovers.
 */

/** Canonical event types the normalizer understands. */
export const CANONICAL_EVENT_TYPES = [
  'web_visit',
  'form_fill',
  'link_click',
  'email_sent',
  'email_delivered',
  'email_bounced',
  'email_open',
  'email_click',
  'unsubscribe',
  'new_lead',
  'data_change',
  'score_change',
  'interesting_moment',
  'event_attended',
  'trial_start',
  'ignore',
];

/** Standard Marketo activity-type IDs — fixed by the platform. */
const STANDARD_ACTIVITY_MAP = {
  1: 'web_visit',
  2: 'form_fill',
  3: 'link_click',
  6: 'email_sent',
  7: 'email_delivered',
  8: 'email_bounced',
  9: 'unsubscribe',
  10: 'email_open',
  11: 'email_click',
  12: 'new_lead',
  13: 'data_change',
  22: 'score_change',
  46: 'interesting_moment',
};

/** Keyword rules for custom activity types (id >= 100000). */
const CUSTOM_ACTIVITY_RULES = [
  // Ignore rules first: a "Legacy Event Sync" must not classify as event_attended.
  { canonical: 'ignore', pattern: /legacy|deprecated|unused|sync|etl|migration|do.?not/i, confidence: 0.6 },
  { canonical: 'event_attended', pattern: /webinar|event|attended|conference|meetup|session/i, confidence: 0.75 },
  { canonical: 'trial_start', pattern: /trial|signup|sign.?up|free.?tier|activation|onboard/i, confidence: 0.75 },
  { canonical: 'form_fill', pattern: /form|submission|registered/i, confidence: 0.6 },
];

/** Form-intent rules: form name → the signalType a fill should emit. */
const FORM_INTENT_RULES = [
  { signalType: 'contact_us', pattern: /contact|talk to|speak (to|with)|get in touch|sales/i, confidence: 0.95 },
  { signalType: 'demo_request', pattern: /demo|trial request|see it|book a/i, confidence: 0.95 },
  { signalType: 'event_registration', pattern: /webinar|event|register|workshop|conference/i, confidence: 0.85 },
  { signalType: 'content_download', pattern: /whitepaper|ebook|e-book|guide|download|report|checklist/i, confidence: 0.85 },
  { signalType: 'newsletter', pattern: /newsletter|subscribe|updates/i, confidence: 0.85 },
];

/** URL-category rules applied to landing pages and visited-page URLs. */
const URL_CATEGORY_RULES = [
  { category: 'pricing', pattern: /\/pricing|\/plans|\/cost/i },
  { category: 'competitor', pattern: /\/compare|\/vs-|-vs-|\/alternative/i },
  { category: 'docs', pattern: /\/docs|\/developer|\/api(\b|\/)|\/reference/i },
  { category: 'product', pattern: /\/product|\/platform|\/features|\/solutions/i },
  { category: 'blog', pattern: /\/blog|\/articles|\/resources\/(?!.*(whitepaper|guide))/i },
  { category: 'case-study', pattern: /\/customers|\/case-stud|\/success/i },
];

export function classifyUrl(url, urlPatterns) {
  const target = url || '';
  // Custom patterns from the (possibly hand-edited) map take precedence.
  if (urlPatterns) {
    for (const [category, patterns] of Object.entries(urlPatterns)) {
      if (patterns.some((p) => target.toLowerCase().includes(p.toLowerCase()))) return category;
    }
  }
  for (const rule of URL_CATEGORY_RULES) {
    if (rule.pattern.test(target)) return rule.category;
  }
  return 'other';
}

export function classifyActivityType(type) {
  if (STANDARD_ACTIVITY_MAP[type.id]) {
    return {
      canonical: STANDARD_ACTIVITY_MAP[type.id],
      confidence: 1,
      rationale: `Standard Marketo activity type ${type.id} (${type.name})`,
    };
  }
  const haystack = `${type.name} ${type.description || ''}`;
  for (const rule of CUSTOM_ACTIVITY_RULES) {
    if (rule.pattern.test(haystack)) {
      return {
        canonical: rule.canonical,
        confidence: rule.confidence,
        rationale: `Custom type name/description matches /${rule.pattern.source}/`,
      };
    }
  }
  return null;
}

export function classifyForm(form) {
  for (const rule of FORM_INTENT_RULES) {
    if (rule.pattern.test(form.name || '')) {
      return {
        signalType: rule.signalType,
        confidence: rule.confidence,
        rationale: `Form name matches /${rule.pattern.source}/`,
      };
    }
  }
  return { signalType: 'form_fill', confidence: 0.4, rationale: 'No intent keyword matched — generic form fill' };
}

/**
 * Build the signal map from a recon instance map. `llmAssist` is an optional
 * async (unmappedItems) => [{ id, canonical, confidence, rationale }] hook.
 */
export async function buildSignalMap(instanceMap, { llmAssist } = {}) {
  const activityTypes = {};
  const unmapped = [];

  for (const type of instanceMap.activityTypes) {
    const hit = classifyActivityType(type);
    if (hit) {
      activityTypes[type.id] = { name: type.name, ...hit };
    } else {
      unmapped.push({ kind: 'activityType', id: type.id, name: type.name, description: type.description });
    }
  }

  if (llmAssist && unmapped.length) {
    try {
      const suggestions = await llmAssist(unmapped);
      for (const s of suggestions || []) {
        if (!CANONICAL_EVENT_TYPES.includes(s.canonical)) continue;
        activityTypes[s.id] = {
          name: unmapped.find((u) => u.id === s.id)?.name || String(s.id),
          canonical: s.canonical,
          confidence: Math.min(0.7, s.confidence ?? 0.5),
          rationale: `LLM suggestion: ${s.rationale || 'no rationale given'}`,
        };
      }
    } catch (err) {
      console.error(`LLM assist failed (continuing with heuristics only): ${err.message}`);
    }
  }
  const stillUnmapped = unmapped.filter((u) => !activityTypes[u.id]);

  const forms = {};
  for (const form of instanceMap.forms) {
    forms[form.name] = classifyForm(form);
  }

  // Seed URL patterns from the landing-page inventory so the map shows real paths.
  const urlPatterns = { pricing: [], competitor: [], docs: [], product: [], blog: [], 'case-study': [] };
  for (const lp of instanceMap.landingPages) {
    const category = classifyUrl(lp.url || lp.name);
    if (urlPatterns[category]) {
      const path = (lp.url || '').replace(/^https?:\/\/[^/]+/, '');
      if (path && !urlPatterns[category].includes(path)) urlPatterns[category].push(path);
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    note: 'This file is meant to be reviewed and hand-edited. Re-run `mse map` to regenerate (your edits will be overwritten — keep a copy or bump `version`).',
    activityTypes,
    forms,
    urlPatterns,
    thresholds: {
      scoreJumpMin: 10,
      contentBingeTouches: 3,
      contentBingeWindowHours: 72,
      stallGapDays: 21,
      intentSurgeTouches: 5,
      intentSurgeWindowHours: 24,
    },
    unmapped: stillUnmapped,
  };
}

/** Coverage stats for `mse explain`. */
export function mapCoverage(signalMap, instanceMap) {
  const total = instanceMap.activityTypes.length;
  const mapped = Object.keys(signalMap.activityTypes).length;
  const confidences = Object.values(signalMap.activityTypes).map((m) => m.confidence);
  const avgConfidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
    : 0;
  return {
    activityTypesMapped: mapped,
    activityTypesTotal: total,
    coveragePct: total ? Math.round((mapped / total) * 100) : 0,
    avgConfidence,
    unmappedCount: (signalMap.unmapped || []).length,
    lowConfidence: Object.entries(signalMap.activityTypes)
      .filter(([, m]) => m.confidence < 0.7)
      .map(([id, m]) => ({ id: Number(id), name: m.name, canonical: m.canonical, confidence: m.confidence })),
  };
}
