/**
 * Synthetic Marketo instance — a realistic mid-size B2B SaaS mess: standard
 * activity types plus custom ones, junk fields, dead campaigns, and four leads
 * whose activity tells the full demo story:
 *
 *   Jane Doe (Director of Marketing, acme.com)  — awareness → consideration →
 *     decision: blog visits, webinar, whitepaper, email engagement, two pricing
 *     visits, a "Contact Sales" form fill, and score jumps.
 *   Bob Smith (Web Engineer, acme.com)          — engaged in May, stalled ~5
 *     weeks, reactivated in July (stall + reactivation signals).
 *   Carol Jones (VP Digital Experience, acme.com) — first activity July 6
 *     (committee-growth signal).
 *   Dana Lee (Marketing Manager, globex.com)    — light single-touch contrast.
 *
 * All commands run against this instance with MSE_MOCK=1 — no credentials.
 */

export const MOCK_NOW = '2026-07-08T00:00:00Z';

export const ACTIVITY_TYPES = [
  { id: 1, name: 'Visit Webpage', description: 'User visits a web page', primaryAttribute: { name: 'Webpage ID' } },
  { id: 2, name: 'Fill Out Form', description: 'User fills out a form', primaryAttribute: { name: 'Form ID' } },
  { id: 3, name: 'Click Link', description: 'User clicks a link on a page', primaryAttribute: { name: 'Link ID' } },
  { id: 6, name: 'Send Email', description: 'Email sent to lead', primaryAttribute: { name: 'Email ID' } },
  { id: 7, name: 'Email Delivered', description: 'Email delivered', primaryAttribute: { name: 'Email ID' } },
  { id: 8, name: 'Email Bounced', description: 'Email bounced', primaryAttribute: { name: 'Email ID' } },
  { id: 9, name: 'Unsubscribe Email', description: 'Lead unsubscribes', primaryAttribute: { name: 'Email ID' } },
  { id: 10, name: 'Open Email', description: 'Lead opens email', primaryAttribute: { name: 'Email ID' } },
  { id: 11, name: 'Click Email', description: 'Lead clicks email link', primaryAttribute: { name: 'Email ID' } },
  { id: 12, name: 'New Lead', description: 'Lead created', primaryAttribute: { name: 'Lead ID' } },
  { id: 13, name: 'Change Data Value', description: 'Field value changed', primaryAttribute: { name: 'Attribute Name' } },
  { id: 22, name: 'Change Score', description: 'Lead score changed', primaryAttribute: { name: 'Score Name' } },
  { id: 46, name: 'Interesting Moment', description: 'Flagged interesting moment', primaryAttribute: { name: 'Type' } },
  { id: 100001, name: 'Attended Webinar (GoToWebinar)', description: 'Custom: webinar attendance sync', primaryAttribute: { name: 'Webinar Name' } },
  { id: 100002, name: 'Started Product Trial', description: 'Custom: product-led trial start', primaryAttribute: { name: 'Trial Plan' } },
  { id: 100003, name: 'Legacy Sync Event', description: 'Custom: deprecated ESB sync (unused since 2023)', primaryAttribute: { name: 'Payload' } },
];

export const LEAD_FIELDS = [
  { name: 'id', displayName: 'Id', dataType: 'integer' },
  { name: 'email', displayName: 'Email Address', dataType: 'email' },
  { name: 'firstName', displayName: 'First Name', dataType: 'string' },
  { name: 'lastName', displayName: 'Last Name', dataType: 'string' },
  { name: 'title', displayName: 'Job Title', dataType: 'string' },
  { name: 'company', displayName: 'Company Name', dataType: 'string' },
  { name: 'website', displayName: 'Website', dataType: 'url' },
  { name: 'leadScore', displayName: 'Lead Score', dataType: 'integer' },
  { name: 'leadStatus', displayName: 'Lead Status', dataType: 'string' },
  { name: 'lifecycleStage__c', displayName: 'Lifecycle Stage', dataType: 'string' },
  { name: 'utm_source__c', displayName: 'UTM Source', dataType: 'string' },
  { name: 'utm_medium__c', displayName: 'UTM Medium', dataType: 'string' },
  { name: 'utm_campaign__c', displayName: 'UTM Campaign', dataType: 'string' },
  { name: 'originalSourceType', displayName: 'Original Source Type', dataType: 'string' },
  { name: 'acquisitionProgramId', displayName: 'Acquisition Program', dataType: 'integer' },
  { name: 'inferredCompany', displayName: 'Inferred Company', dataType: 'string' },
  { name: 'competitorTool__c', displayName: 'Competitor Tool In Use', dataType: 'string' },
  { name: 'partnerAgency__c', displayName: 'Implementation Partner', dataType: 'string' },
  { name: 'legacyRegion2014__c', displayName: 'Legacy Region (2014)', dataType: 'string' },
  { name: 'tempField_DO_NOT_USE__c', displayName: 'tempField DO NOT USE', dataType: 'string' },
  { name: 'mktoAcquisitionDate', displayName: 'Acquisition Date', dataType: 'datetime' },
];

export const PROGRAMS = [
  { id: 1001, name: 'WBN-2026-05-AI-Content-Readiness', type: 'Event', channel: 'Webinar', status: 'Completed' },
  { id: 1002, name: 'NUR-Evergreen-Product-Education', type: 'Engagement', channel: 'Nurture', status: 'On' },
  { id: 1003, name: 'CON-Whitepaper-Composable-Content', type: 'Default', channel: 'Content Download', status: 'On' },
  { id: 1004, name: 'EVT-2019-Roadshow-Chicago', type: 'Event', channel: 'Roadshow', status: 'Completed' },
  { id: 1005, name: 'OPS-Data-Cleanup-2022', type: 'Default', channel: 'Operational', status: 'Completed' },
];

export const SMART_CAMPAIGNS = [
  { id: 2001, name: 'Score - Pricing Page Visit', status: 'Active' },
  { id: 2002, name: 'MQL Threshold Alert', status: 'Active' },
  { id: 2003, name: 'Old Field Sync (broken)', status: 'Deactivated' },
];

export const FORMS = [
  { id: 3001, name: 'Contact Sales', status: 'approved' },
  { id: 3002, name: 'Demo Request', status: 'approved' },
  { id: 3003, name: 'Whitepaper Download - Composable Content', status: 'approved' },
  { id: 3004, name: 'Newsletter Signup', status: 'approved' },
  { id: 3005, name: 'Webinar Registration - AI Content Readiness', status: 'approved' },
];

export const LANDING_PAGES = [
  { id: 4001, name: 'Pricing', URL: 'https://www.example-saas.com/pricing' },
  { id: 4002, name: 'Product - Content Platform', URL: 'https://www.example-saas.com/product/content-platform' },
  { id: 4003, name: 'Blog - Structured Content 101', URL: 'https://www.example-saas.com/blog/structured-content-101' },
  { id: 4004, name: 'Blog - Migrating Off Legacy CMS', URL: 'https://www.example-saas.com/blog/migrating-off-legacy-cms' },
  { id: 4005, name: 'Docs - API Reference', URL: 'https://www.example-saas.com/docs/api' },
  { id: 4006, name: 'Compare - Us vs LegacyCMS', URL: 'https://www.example-saas.com/compare/legacycms' },
];

export const EMAILS = [
  { id: 5001, name: 'NUR-01 Welcome to Product Education', subject: 'Getting started with structured content' },
  { id: 5002, name: 'NUR-02 Composable Content Whitepaper', subject: 'The composable content playbook' },
  { id: 5003, name: 'WBN Invite - AI Content Readiness', subject: 'Is your content AI-ready? Live session' },
];

export const CAMPAIGNS = [
  { id: 6001, name: 'Score - Pricing Page Visit', type: 'trigger', active: true },
  { id: 6002, name: 'MQL Threshold Alert', type: 'trigger', active: true },
];

export const LEADS = [
  {
    id: 101,
    email: 'jane.doe@acme.com',
    firstName: 'Jane',
    lastName: 'Doe',
    title: 'Director of Marketing',
    company: 'Acme Corp',
    website: 'https://www.acme.com',
    leadScore: 87,
    leadStatus: 'MQL',
    lifecycleStage__c: 'Marketing Qualified',
    utm_source__c: 'google',
    utm_medium__c: 'organic',
    utm_campaign__c: 'structured-content-101',
    originalSourceType: 'Web - Organic',
    competitorTool__c: 'LegacyCMS',
    partnerAgency__c: '',
  },
  {
    id: 102,
    email: 'bob.smith@acme.com',
    firstName: 'Bob',
    lastName: 'Smith',
    title: 'Web Engineer',
    company: 'Acme Corp',
    website: 'https://www.acme.com',
    leadScore: 34,
    leadStatus: 'Engaged',
    lifecycleStage__c: 'Engaged',
    utm_source__c: 'direct',
    originalSourceType: 'Web - Direct',
  },
  {
    id: 103,
    email: 'carol.jones@acme.com',
    firstName: 'Carol',
    lastName: 'Jones',
    title: 'VP Digital Experience',
    company: 'Acme Corp',
    website: 'https://www.acme.com',
    leadScore: 12,
    leadStatus: 'New',
    lifecycleStage__c: 'New',
    utm_source__c: 'linkedin',
    utm_medium__c: 'paid',
    originalSourceType: 'Paid Social',
  },
  {
    id: 201,
    email: 'dana.lee@globex.com',
    firstName: 'Dana',
    lastName: 'Lee',
    title: 'Marketing Manager',
    company: 'Globex',
    website: 'https://www.globex.com',
    leadScore: 8,
    leadStatus: 'New',
    lifecycleStage__c: 'New',
    originalSourceType: 'Web - Organic',
  },
];

let seq = 9000;
function act(leadId, iso, typeId, primary, attributes = {}) {
  seq += 1;
  return {
    id: seq,
    marketoGUID: `mock-${seq}`,
    leadId,
    activityDate: iso,
    activityTypeId: typeId,
    primaryAttributeValue: primary,
    attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
  };
}

export const ACTIVITIES = [
  /* ── Jane Doe (101): full journey ── */
  act(101, '2026-04-10T14:02:00Z', 12, 'jane.doe@acme.com', { 'Source Type': 'Web - Organic' }),
  act(101, '2026-04-10T14:03:00Z', 1, 'Blog - Structured Content 101', { 'Webpage URL': '/blog/structured-content-101', 'Query Parameters': 'utm_source=google&utm_medium=organic' }),
  act(101, '2026-04-10T14:09:00Z', 2, 'Newsletter Signup', { 'Form Name': 'Newsletter Signup' }),
  act(101, '2026-04-18T09:30:00Z', 1, 'Blog - Migrating Off Legacy CMS', { 'Webpage URL': '/blog/migrating-off-legacy-cms' }),
  act(101, '2026-05-02T16:00:00Z', 6, 'WBN Invite - AI Content Readiness', {}),
  act(101, '2026-05-02T18:12:00Z', 10, 'WBN Invite - AI Content Readiness', {}),
  act(101, '2026-05-02T18:13:00Z', 11, 'WBN Invite - AI Content Readiness', { 'Link': '/webinar/ai-content-readiness/register' }),
  act(101, '2026-05-02T18:14:00Z', 2, 'Webinar Registration - AI Content Readiness', { 'Form Name': 'Webinar Registration - AI Content Readiness' }),
  act(101, '2026-05-02T18:20:00Z', 1, 'Product - Content Platform', { 'Webpage URL': '/product/content-platform' }),
  act(101, '2026-05-14T17:05:00Z', 100001, 'AI Content Readiness', { 'Attendance Minutes': '47' }),
  act(101, '2026-05-14T17:06:00Z', 22, 'Lead Score', { 'Change Value': '+15', 'New Value': '45' }),
  act(101, '2026-05-20T11:20:00Z', 2, 'Whitepaper Download - Composable Content', { 'Form Name': 'Whitepaper Download - Composable Content' }),
  act(101, '2026-05-20T11:21:00Z', 22, 'Lead Score', { 'Change Value': '+10', 'New Value': '55' }),
  act(101, '2026-06-24T10:15:00Z', 1, 'Compare - Us vs LegacyCMS', { 'Webpage URL': '/compare/legacycms' }),
  act(101, '2026-06-28T09:41:00Z', 1, 'Pricing', { 'Webpage URL': '/pricing' }),
  act(101, '2026-06-28T09:44:00Z', 22, 'Lead Score', { 'Change Value': '+12', 'New Value': '67' }),
  act(101, '2026-07-02T15:30:00Z', 1, 'Pricing', { 'Webpage URL': '/pricing' }),
  act(101, '2026-07-02T15:33:00Z', 46, 'Web', { 'Description': 'Visited pricing page twice in a week' }),
  act(101, '2026-07-06T10:02:00Z', 2, 'Contact Sales', { 'Form Name': 'Contact Sales', 'Comments': 'Interested in migrating 4 brand sites off LegacyCMS. Timeline: this fiscal year.' }),
  act(101, '2026-07-06T10:02:30Z', 22, 'Lead Score', { 'Change Value': '+20', 'New Value': '87' }),
  act(101, '2026-07-06T10:03:00Z', 13, 'leadStatus', { 'Old Value': 'Engaged', 'New Value': 'MQL' }),

  /* ── Bob Smith (102): engaged → stall → reactivation ── */
  act(102, '2026-05-05T13:00:00Z', 12, 'bob.smith@acme.com', { 'Source Type': 'Web - Direct' }),
  act(102, '2026-05-05T13:01:00Z', 1, 'Docs - API Reference', { 'Webpage URL': '/docs/api' }),
  act(102, '2026-05-06T09:15:00Z', 1, 'Docs - API Reference', { 'Webpage URL': '/docs/api' }),
  act(102, '2026-05-06T09:40:00Z', 1, 'Product - Content Platform', { 'Webpage URL': '/product/content-platform' }),
  act(102, '2026-05-28T15:22:00Z', 1, 'Docs - API Reference', { 'Webpage URL': '/docs/api' }),
  /* five-week gap — stall */
  act(102, '2026-07-05T20:11:00Z', 100002, 'Developer Free Tier', { 'Trial Plan': 'free' }),
  act(102, '2026-07-05T20:15:00Z', 1, 'Docs - API Reference', { 'Webpage URL': '/docs/api' }),

  /* ── Carol Jones (103): new committee member, late arrival ── */
  act(103, '2026-07-06T14:00:00Z', 12, 'carol.jones@acme.com', { 'Source Type': 'Paid Social' }),
  act(103, '2026-07-06T14:01:00Z', 1, 'Product - Content Platform', { 'Webpage URL': '/product/content-platform', 'Query Parameters': 'utm_source=linkedin&utm_medium=paid' }),
  act(103, '2026-07-07T09:30:00Z', 1, 'Pricing', { 'Webpage URL': '/pricing' }),

  /* ── Dana Lee (201): single light touch at another account ── */
  act(201, '2026-06-15T08:00:00Z', 12, 'dana.lee@globex.com', { 'Source Type': 'Web - Organic' }),
  act(201, '2026-06-15T08:01:00Z', 1, 'Blog - Structured Content 101', { 'Webpage URL': '/blog/structured-content-101' }),
];

export const INSTANCE = {
  mockNow: MOCK_NOW,
  activityTypes: ACTIVITY_TYPES,
  leadFields: LEAD_FIELDS,
  programs: PROGRAMS,
  smartCampaigns: SMART_CAMPAIGNS,
  forms: FORMS,
  landingPages: LANDING_PAGES,
  emails: EMAILS,
  campaigns: CAMPAIGNS,
  leads: LEADS,
  activities: ACTIVITIES,
};
