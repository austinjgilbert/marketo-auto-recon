# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Scope

**marketo-auto-recon** is a read-only Marketo REST API client. It:

- Reads from the Marketo REST API using OAuth 2.0 client credentials (never writes or mutates data)
- Optionally calls the Anthropic Claude API to generate natural-language narratives
- Optionally POSTs signals to a user-configured HTTPS webhook sink

Credentials (Marketo client ID/secret, Claude API key, webhook URL) are stored in a local
`.mse-config.json` file. **Never commit this file to version control** — it is listed in
`.gitignore` by default.

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please **do not open a public
GitHub issue**. Instead, report it privately:

**Email:** `austinjgilbert@gmail.com`

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if safe to share)
- Any suggested mitigations you have identified

### Response SLA

| Milestone                  | Target     |
| -------------------------- | ---------- |
| Acknowledgment             | 48 hours   |
| Initial triage + severity  | 5 business days |
| Fix or mitigation shipped  | Depends on severity — critical within 14 days |

We will coordinate a disclosure timeline with you. We follow responsible disclosure
practices and will credit reporters in the release notes unless you prefer to remain
anonymous.

## Security Considerations for Users

1. **Protect `.mse-config.json`** — it contains Marketo OAuth credentials. Treat it like a
   `.env` file: never commit it, restrict file permissions (`chmod 600 .mse-config.json`).
2. **Marketo credentials are read-only** — the tool only calls GET endpoints and the OAuth
   token endpoint. It does not write, update, or delete any Marketo data.
3. **Webhook sink** — if you configure a webhook, ensure the endpoint uses HTTPS and
   validates the payload on the receiving end.
4. **Claude API key** — if you use the LLM narrative feature, your Marketo lead data is
   sent to Anthropic's API. Review Anthropic's data processing terms before enabling this
   feature in regulated environments.
