/**
 * Optional Anthropic layer — graceful no-op when ANTHROPIC_API_KEY is unset.
 * Used for (a) narrative seller snapshots and (b) mapping suggestions for
 * ambiguous custom activity types. The deterministic pipeline never depends
 * on this module returning anything.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';

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
  return callClaude(config, {
    system:
      'You are a sales-intelligence writer. You turn normalized marketing-journey data into a tight brief a ' +
      'seller can read in 20 seconds. Never invent facts not present in the data. Plain text, short ' +
      'paragraphs, no headers beyond the given section names, no emojis, no em-dashes.',
    prompt:
      `Rewrite this seller brief so it reads as one coherent story while keeping every section and every ` +
      `fact. Sharpen the "what to say" and "next step" sections into words a rep could actually use.\n\n` +
      `DETERMINISTIC BRIEF:\n${deterministicBrief}\n\n` +
      `UNDERLYING JOURNEY DATA (facts only, do not invent beyond this):\n${JSON.stringify(journeyJson).slice(0, 12000)}`,
    maxTokens: 2000,
  });
}
