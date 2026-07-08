/**
 * Stage: Instance Recon — inventory everything the API user can see and audit
 * obvious data-quality problems, so an engineer entering an unknown Marketo
 * instance gets a map before touching anything.
 *
 * Output: outputs/marketo-instance-map.json (machine) + .md (human).
 */

const FIELD_CATEGORY_RULES = [
  { category: 'scoring', pattern: /score/i },
  { category: 'lifecycle', pattern: /lifecycle|lead.?status|stage|mql|sql|sal\b/i },
  { category: 'utm', pattern: /^utm|utm_/i },
  { category: 'attribution', pattern: /source|acquisition|referr|original|first.?touch|last.?touch|channel/i },
  { category: 'company', pattern: /company|website|domain|industry|employee|revenue|account/i },
  { category: 'identity', pattern: /^(id|email|first.?name|last.?name|phone|title|full.?name)$/i },
  { category: 'competitive', pattern: /competitor|compare|displac/i },
  { category: 'partner', pattern: /partner|agency|reseller|integrator/i },
  { category: 'suspect', pattern: /\btemp|\btest\b|do.?not.?use|deprecated|legacy|\bold\b|_?bak\b|backup|zz/i },
];

export function categorizeField(field) {
  const haystack = `${field.name} ${field.displayName || ''}`;
  for (const rule of FIELD_CATEGORY_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }
  return field.name.endsWith('__c') || /^[A-Z]/.test(field.name) ? 'custom-other' : 'standard-other';
}

export function auditDataQuality({ leadFields, programs, smartCampaigns, activityTypes }) {
  const issues = [];

  const suspectFields = leadFields.filter((f) => categorizeField(f) === 'suspect');
  for (const f of suspectFields) {
    issues.push({ kind: 'suspect-field', subject: f.name, detail: `Field name suggests it is temporary/deprecated ("${f.displayName || f.name}"). Verify before mapping.` });
  }

  const byNormName = new Map();
  for (const f of leadFields) {
    const norm = (f.displayName || f.name).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!byNormName.has(norm)) byNormName.set(norm, []);
    byNormName.get(norm).push(f.name);
  }
  for (const [norm, names] of byNormName) {
    if (names.length > 1) {
      issues.push({ kind: 'duplicate-looking-fields', subject: names.join(', '), detail: `Multiple fields normalize to "${norm}" — likely a migration leftover. Pick one canonical field.` });
    }
  }

  for (const p of programs) {
    const yearMatch = (p.name || '').match(/\b(20[0-2]\d)\b/);
    if (yearMatch && Number(yearMatch[1]) < new Date().getFullYear() - 2 && p.status !== 'On') {
      issues.push({ kind: 'stale-program', subject: p.name, detail: `Program references ${yearMatch[1]} and is not active — candidate for archive; exclude from mapping.` });
    }
  }

  for (const sc of smartCampaigns || []) {
    if (/broken|deprecated|\bold\b|do.?not/i.test(sc.name || '') || sc.status === 'Deactivated') {
      issues.push({ kind: 'inactive-smart-campaign', subject: sc.name, detail: `Smart campaign is deactivated or self-describes as broken (status: ${sc.status}).` });
    }
  }

  for (const t of activityTypes) {
    if (t.id >= 100000 && /legacy|deprecated|unused|old/i.test(`${t.name} ${t.description || ''}`)) {
      issues.push({ kind: 'dead-custom-activity', subject: t.name, detail: `Custom activity type ${t.id} self-describes as legacy/unused — likely noise.` });
    }
  }

  return issues;
}

export async function runRecon(client) {
  const [activityTypes, leadFields, programs, smartCampaigns, forms, landingPages, emails, campaigns] =
    await Promise.all([
      client.getActivityTypes(),
      client.describeLeadFields(),
      client.getPrograms().catch(() => []),
      client.getSmartCampaigns().catch(() => []),
      client.getForms().catch(() => []),
      client.getLandingPages().catch(() => []),
      client.getEmails().catch(() => []),
      client.getCampaigns().catch(() => []),
    ]);

  const fieldsByCategory = {};
  for (const f of leadFields) {
    const cat = categorizeField(f);
    (fieldsByCategory[cat] ||= []).push({ name: f.name, displayName: f.displayName, dataType: f.dataType });
  }

  const dataQualityIssues = auditDataQuality({ leadFields, programs, smartCampaigns, activityTypes });

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      activityTypes: activityTypes.length,
      customActivityTypes: activityTypes.filter((t) => t.id >= 100000).length,
      leadFields: leadFields.length,
      programs: programs.length,
      smartCampaigns: smartCampaigns.length,
      forms: forms.length,
      landingPages: landingPages.length,
      emails: emails.length,
      campaigns: campaigns.length,
      dataQualityIssues: dataQualityIssues.length,
    },
    activityTypes: activityTypes.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description || '',
      custom: t.id >= 100000,
      primaryAttribute: t.primaryAttribute?.name || null,
    })),
    fieldsByCategory,
    programs: programs.map((p) => ({ id: p.id, name: p.name, type: p.type, channel: p.channel, status: p.status })),
    smartCampaigns: (smartCampaigns || []).map((c) => ({ id: c.id, name: c.name, status: c.status })),
    forms: forms.map((f) => ({ id: f.id, name: f.name, status: f.status })),
    landingPages: landingPages.map((lp) => ({ id: lp.id, name: lp.name, url: lp.URL || lp.url || null })),
    emails: emails.map((e) => ({ id: e.id, name: e.name, subject: e.subject || null })),
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, type: c.type, active: c.active })),
    dataQualityIssues,
  };
}

export function renderInstanceMapMarkdown(map) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('# Marketo instance map');
  push();
  push(`Generated ${map.generatedAt} by marketo-signal-engine \`mse recon\`.`);
  push();
  push('## Inventory counts');
  push();
  push('| Object | Count |');
  push('|---|---|');
  for (const [k, v] of Object.entries(map.counts)) push(`| ${k} | ${v} |`);
  push();

  push('## Activity types');
  push();
  push('| ID | Name | Custom | Primary attribute |');
  push('|---|---|---|---|');
  for (const t of map.activityTypes) push(`| ${t.id} | ${t.name} | ${t.custom ? 'yes' : ''} | ${t.primaryAttribute || ''} |`);
  push();

  push('## Lead fields by category');
  push();
  for (const [cat, fields] of Object.entries(map.fieldsByCategory)) {
    push(`### ${cat} (${fields.length})`);
    push();
    for (const f of fields) push(`- \`${f.name}\` — ${f.displayName || ''} (${f.dataType})`);
    push();
  }

  const section = (title, rows, render) => {
    push(`## ${title} (${rows.length})`);
    push();
    for (const r of rows) push(`- ${render(r)}`);
    push();
  };
  section('Programs', map.programs, (p) => `**${p.name}** — ${p.type}/${p.channel} (${p.status})`);
  section('Smart campaigns', map.smartCampaigns, (c) => `**${c.name}** (${c.status})`);
  section('Forms', map.forms, (f) => `**${f.name}** (${f.status})`);
  section('Landing pages', map.landingPages, (lp) => `**${lp.name}** — ${lp.url || 'n/a'}`);
  section('Emails', map.emails, (e) => `**${e.name}**${e.subject ? ` — "${e.subject}"` : ''}`);

  push('## Data quality issues');
  push();
  if (!map.dataQualityIssues.length) push('None detected.');
  for (const issue of map.dataQualityIssues) push(`- **[${issue.kind}]** ${issue.subject}: ${issue.detail}`);
  push();

  return lines.join('\n');
}
