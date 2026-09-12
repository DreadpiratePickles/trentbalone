---
name: "source-command-export-company-data"
description: "Trigger data export bundle generation for a company. Used before or during teardown to give the founder a full data export."
---

# source-command-export-company-data

Use this skill when the user asks to run the migrated source command `export-company-data`.

## Command Template

# /export-company-data [company-id]

Trigger generation of a full data export bundle for a company.

## What the bundle includes

- All company data from the Trent DB (tasks, cycles, agents, approvals, audit logs, documents, reports)
- Neon Postgres dump (pg_dump from main branch)
- R2 bucket contents (all stored files and artifacts)
- GitHub repo archive (.zip of the provisioned repo)
- Sentry issue export

## Usage

```
/export-company-data company_abc123
```

## Implementation

This is a multi-step async operation. The full implementation will be in `lib/provisioning/data-exporter.ts` (Phase 3 item to be built).

For now, initiate the export workflow:

1. Create an approval with action `"data_export"` so the founder can track it:
   ```typescript
   await store.createApproval({
     companyId: "[company-id]",
     action: "data_export",
     reason: "Full company data export requested",
   });
   ```

2. Trigger n8n export workflow via webhook:
   ```bash
   curl -X POST "$TRENT_WEBHOOK_BASE_URL/api/webhooks/n8n/export" \
     -d '{ "companyId": "[company-id]" }'
   ```

3. Show the approval ID so the founder can check status

## Status

The export is async — n8n polls completion and attaches the export bundle as an artifact to the approval card when ready.

## Notes

- Export is non-destructive — it does not modify or delete any data
- Can be run independently of teardown
- If used during teardown, run BEFORE `confirmDeletion` — the deletion is permanent
