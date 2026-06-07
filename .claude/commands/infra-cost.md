---
description: Query cost attribution for a company across all provisioned resources. Shows monthly spend by resource type wired to the Phase 2 ledger.
---

# /infra-cost [company-id]

Show per-company infra cost breakdown from the Phase 2 usage ledger.

## What this returns

- Total infra spend in cents
- Breakdown by resource type (neon_project, vercel_project, r2_bucket, etc.)
- Individual cost entries with description and billing period

## Usage

```
/infra-cost company_abc123
```

## Implementation

Use `getCostSummary(companyId)` from `lib/provisioning/cost-attributor.ts`:

```typescript
import { getCostSummary } from "@/lib/provisioning/cost-attributor";
const summary = await getCostSummary("[company-id]");
```

Or call the usage API:
```bash
curl "/api/companies/[company-id]/billing/usage"
```
Filter for `category: "infra"` entries.

## Output format

```
Infra cost summary for [company-id]:
Total: $XX.XX/mo

By resource type:
  neon_project:    $15.00  (2 periods)
  vercel_project:  $20.00  (1 period)
  r2_bucket:       $2.00   (1 period)
  cloudflare_dns:  $0.50   (1 period)

Recent entries:
  [2026-01] Neon Postgres — Jan 2026          $15.00
  [2026-01] Vercel Pro — Jan 2026             $20.00
  [2026-01] Cloudflare R2 — Jan 2026          $2.00
```

## Notes

- Costs are recorded by `recordProvisioningCost()` in `cost-attributor.ts`
- n8n syncs actual provider billing API costs daily
- Budget cap breach triggers a human escalation approval via n8n
