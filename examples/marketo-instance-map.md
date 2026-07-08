# Marketo instance map

Generated 2026-07-08T03:41:47.074Z by marketo-signal-engine `mse recon`.

## Inventory counts

| Object | Count |
|---|---|
| activityTypes | 16 |
| customActivityTypes | 3 |
| leadFields | 21 |
| programs | 5 |
| smartCampaigns | 3 |
| forms | 5 |
| landingPages | 6 |
| emails | 3 |
| campaigns | 2 |
| dataQualityIssues | 6 |

## Activity types

| ID | Name | Custom | Primary attribute |
|---|---|---|---|
| 1 | Visit Webpage |  | Webpage ID |
| 2 | Fill Out Form |  | Form ID |
| 3 | Click Link |  | Link ID |
| 6 | Send Email |  | Email ID |
| 7 | Email Delivered |  | Email ID |
| 8 | Email Bounced |  | Email ID |
| 9 | Unsubscribe Email |  | Email ID |
| 10 | Open Email |  | Email ID |
| 11 | Click Email |  | Email ID |
| 12 | New Lead |  | Lead ID |
| 13 | Change Data Value |  | Attribute Name |
| 22 | Change Score |  | Score Name |
| 46 | Interesting Moment |  | Type |
| 100001 | Attended Webinar (GoToWebinar) | yes | Webinar Name |
| 100002 | Started Product Trial | yes | Trial Plan |
| 100003 | Legacy Sync Event | yes | Payload |

## Lead fields by category

### standard-other (5)

- `id` — Id (integer)
- `email` — Email Address (email)
- `firstName` — First Name (string)
- `lastName` — Last Name (string)
- `title` — Job Title (string)

### company (3)

- `company` — Company Name (string)
- `website` — Website (url)
- `inferredCompany` — Inferred Company (string)

### scoring (1)

- `leadScore` — Lead Score (integer)

### lifecycle (2)

- `leadStatus` — Lead Status (string)
- `lifecycleStage__c` — Lifecycle Stage (string)

### utm (3)

- `utm_source__c` — UTM Source (string)
- `utm_medium__c` — UTM Medium (string)
- `utm_campaign__c` — UTM Campaign (string)

### attribution (3)

- `originalSourceType` — Original Source Type (string)
- `acquisitionProgramId` — Acquisition Program (integer)
- `mktoAcquisitionDate` — Acquisition Date (datetime)

### competitive (1)

- `competitorTool__c` — Competitor Tool In Use (string)

### partner (1)

- `partnerAgency__c` — Implementation Partner (string)

### suspect (2)

- `legacyRegion2014__c` — Legacy Region (2014) (string)
- `tempField_DO_NOT_USE__c` — tempField DO NOT USE (string)

## Programs (5)

- **WBN-2026-05-AI-Content-Readiness** — Event/Webinar (Completed)
- **NUR-Evergreen-Product-Education** — Engagement/Nurture (On)
- **CON-Whitepaper-Composable-Content** — Default/Content Download (On)
- **EVT-2019-Roadshow-Chicago** — Event/Roadshow (Completed)
- **OPS-Data-Cleanup-2022** — Default/Operational (Completed)

## Smart campaigns (3)

- **Score - Pricing Page Visit** (Active)
- **MQL Threshold Alert** (Active)
- **Old Field Sync (broken)** (Deactivated)

## Forms (5)

- **Contact Sales** (approved)
- **Demo Request** (approved)
- **Whitepaper Download - Composable Content** (approved)
- **Newsletter Signup** (approved)
- **Webinar Registration - AI Content Readiness** (approved)

## Landing pages (6)

- **Pricing** — https://www.example-saas.com/pricing
- **Product - Content Platform** — https://www.example-saas.com/product/content-platform
- **Blog - Structured Content 101** — https://www.example-saas.com/blog/structured-content-101
- **Blog - Migrating Off Legacy CMS** — https://www.example-saas.com/blog/migrating-off-legacy-cms
- **Docs - API Reference** — https://www.example-saas.com/docs/api
- **Compare - Us vs LegacyCMS** — https://www.example-saas.com/compare/legacycms

## Emails (3)

- **NUR-01 Welcome to Product Education** — "Getting started with structured content"
- **NUR-02 Composable Content Whitepaper** — "The composable content playbook"
- **WBN Invite - AI Content Readiness** — "Is your content AI-ready? Live session"

## Data quality issues

- **[suspect-field]** legacyRegion2014__c: Field name suggests it is temporary/deprecated ("Legacy Region (2014)"). Verify before mapping.
- **[suspect-field]** tempField_DO_NOT_USE__c: Field name suggests it is temporary/deprecated ("tempField DO NOT USE"). Verify before mapping.
- **[stale-program]** EVT-2019-Roadshow-Chicago: Program references 2019 and is not active — candidate for archive; exclude from mapping.
- **[stale-program]** OPS-Data-Cleanup-2022: Program references 2022 and is not active — candidate for archive; exclude from mapping.
- **[inactive-smart-campaign]** Old Field Sync (broken): Smart campaign is deactivated or self-describes as broken (status: Deactivated).
- **[dead-custom-activity]** Legacy Sync Event: Custom activity type 100003 self-describes as legacy/unused — likely noise.
