# Sub-Processor / Vendor List

**Last updated:** 2026-05-28  
**Review cadence:** Annually, or when adding a new vendor

> This list covers all vendors who receive, store, or process Trent customer data.

| Vendor | Service | Data accessed | SOC 2? | DPA signed? | Notes |
|---|---|---|---|---|---|
| **Supabase** | Postgres database (primary store) | All customer data | ✅ SOC 2 Type II | ⚠️ DPA via Supabase ToS (sign explicit DPA for Enterprise) | PITR enabled; data in AWS us-east-1 |
| **Vercel** | App hosting + CDN | HTTP requests (logs); no persistent customer data stored | ✅ SOC 2 Type II | ⚠️ DPA via Vercel ToS | Edge functions process requests transiently |
| **OpenAI** | LLM inference (gpt-4.1-mini) | Agent prompts + outputs (customer company data as context) | ✅ SOC 2 Type II | ✅ Data processing addendum via API ToS | Zero data retention API option available; enable when billing allows |
| **Anthropic** | LLM inference (fallback) | Same as OpenAI row | ✅ SOC 2 Type II | ✅ Via API ToS | |
| **Redis (self-hosted)** | Rate limiting + job queue (BullMQ) | Session keys and rate limit counters — no PII | N/A (self-hosted on Render/Railway) | N/A | Fail-open on Redis unavailability |
| **GitHub** | Source code + CI | Source code only; no customer data | ✅ SOC 2 Type II | ✅ Via GitHub ToS | |
| **Postmark** (Phase 2) | Transactional email | Customer email addresses | ✅ SOC 2 Type II | ⚠️ Sign DPA before enabling | Not yet active |
| **Sentry** | Error tracking | Stack traces (may contain request context) | ✅ SOC 2 Type II | ⚠️ Sign DPA | Scrub PII from Sentry payloads |
| **Cloudflare** | DNS + edge (when configured) | IP addresses in access logs | ✅ SOC 2 Type II | ✅ Via ToS | |

## Vendors NOT on this list (no customer data)

| Vendor | Why excluded |
|---|---|
| Stripe | Not yet integrated; when added, treat as sub-processor |
| Google Analytics | Not used |
| Intercom / HubSpot | Not yet integrated |

## Action items

- [ ] Sign explicit DPA with Supabase (Enterprise plan or via DPA request form)
- [ ] Sign explicit DPA with Vercel (via legal@vercel.com)
- [ ] Enable OpenAI zero data retention once on appropriate plan
- [ ] Scrub PII from Sentry before it ships
- [ ] Sign Postmark DPA before enabling email sending
