/**
 * Optional Anthropic layer — graceful no-op when ANTHROPIC_API_KEY is unset.
 * Used for (a) narrative seller snapshots and (b) mapping suggestions for
 * ambiguous custom activity types. The deterministic pipeline never depends
 * on this module returning anything.
 *
 * Privacy: the narrative path ships journey data (names, emails, activity)
 * to Anthropic. Set MSE_LLM_REDACT=1 to pseudonymize emails and surnames
 * before anything leaves the machine.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const LLM_TIMEOUT_MS = 60_000;

export function llmAvailable(config) {
  return Boolean(config.anthropic?.apiKey);
}

async function callClaude(config, { system, prompt, maxTokens = 1500 }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/* ── PII redaction (MSE_LLM_REDACT=1) ── */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Walk any JSON-ish value collecting person names from name-bearing keys. */
function collectNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const v of value) collectNames(v, names);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && /^(name|personName|fullName)$/i.test(k) && !v.includes('@')) names.add(v);
      else if (typeof v === 'string' && /^lastName$/i.test(k)) names.add(v);
      else collectNames(v, names);
    }
  }
  return names;
}

/**
 * Pseudonymize emails and surnames consistently across a set of texts, so
 * the story still hangs together ("Person-1 filled the form, Person-1's
 * colleague...") without shipping identities to the LLM provider.
 * Returns the redacted texts in the same order.
 */
export function redactForLlm(texts, { context } = {}) {
  const emailAlias = new Map();
  const aliasFor = (email) => {
    const key = email.toLowerCase();
    if (!emailAlias.has(key)) emailAlias.set(key, `person-${emailAlias.size + 1}@redacted.invalid`);
    return emailAlias.get(key);
  };

  // Surnames: from context objects (journey blobs) and from first.last@ email shapes.
  const surnames = new Set();
  for (const name of collectNames(context || {})) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) surnames.add(parts[parts.length - 1]);
    else if (parts.length === 1 && parts[0]) surnames.add(parts[0]);
  }
  for (const text of texts) {
    for (const email of text.match(EMAIL_RE) || []) {
      const local = email.split('@')[0];
      const bits = local.split(/[._-]+/).filter((b) => b.length > 2 && !/\d/.test(b));
      if (bits.length >= 2) surnames.add(bits[bits.length - 1]);
    }
  }

  const surnameAlias = new Map();
  let n = 0;
  for (const s of [...surnames].sort((a, b) => b.length - a.length)) {
    surnameAlias.set(s, `Surname${++n}`);
  }

  return texts.map((text) => {
    let out = text.replace(EMAIL_RE, (email) => aliasFor(email));
    for (const [surname, alias] of surnameAlias) {
      out = out.replace(new RegExp(`\\b${escapeRegExp(surname)}\\b`, 'gi'), alias);
    }
    return out;
  });
}

/** Mapping assist: unmapped activity types → canonical suggestions. */
export function makeLlmMappingAssist(config) {
  if (!llmAvailable(config)) return null;
  return async function llmAssist(unmappedItems) {
    const text = await callClaude(config, {
      system:
        'You classify Marketo custom activity types into a fixed canonical taxonomy. ' +
        'Respond ONLY with a JSON array, no prose.',
      prompt:
        `Canonical types: web_visit, form_fill, link_click, email_sent, email_delivered, email_bounced, ` +
        `email_open, email_click, unsubscribe, new_lead, data_change, score_change, interesting_moment, ` +
        `event_attended, trial_start, ignore.\n\n` +
        `Classify each of these Marketo custom activity types. Return JSON: ` +
        `[{"id": <id>, "canonical": "<type>", "confidence": 0-1, "rationale": "<why>"}]\n\n` +
        JSON.stringify(unmappedItems, null, 2),
    });
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  };
}

/** Narrative snapshot: rewrite the deterministic brief as a tight seller story. */
export async function generateNarrativeSnapshot(config, { deterministicBrief, journeyJson }) {
  if (!llmAvailable(config)) return null;
  let brief = deterministicBrief;
  let journeyText = JSON.stringify(journeyJson).slice(0, 12_000);
  if (config.anthropic.redact) {
    [brief, journeyText] = redactForLlm([brief, journeyText], { context: journeyJson });
  }
  return callClaude(config, {
    system:
      'You are a sales-intelligence writer. You turn normalized marketing-journey data into a tight brief a ' +
      'seller can read in 20 seconds. Never invent facts not present in the data. Plain text, short ' +
      'paragraphs, no headers beyond the given section names, no emojis, no em-dashes.',
    prompt:
      `Rewrite this seller brief so it reads as one coherent story while keeping every section and every ` +
      `fact. Sharpen the "what to say" and "next step" sections into words a rep could actually use.\n\n` +
      `DETERMINISTIC BRIEF:\n${brief}\n\n` +
      `UNDERLYING JOURNEY DATA (facts only, do not invent beyond this):\n${journeyText}`,
    maxTokens: 2000,
  });
}
