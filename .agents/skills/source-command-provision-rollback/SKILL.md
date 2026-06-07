---
name: "source-command-provision-rollback"
description: "Manually trigger rollback for a failed provisioning run. Cleans up orphaned resources left by a partial failure."
---

# source-command-provision-rollback

Use this skill when the user asks to run the migrated source command `provision-rollback`.

## Command Template

# /provision-rollback [company-id]

Manually roll back provisioned resources for a company. Use when `provisionCompany()` reported failure and left orphaned resources.

## When to use

- `POST /api/provisioning` returned `success: false` with orphaned resources
- Automatic rollback failed during provisioning (network error during cleanup)
- You need to reset a company's provisioning state to start fresh

## Usage

```
/provision-rollback company_abc123
```

## Implementation

1. Run `/provision-status [company-id]` first to see which resources exist
2. For each provisioned resource, call the rollback endpoint with the resource IDs:
   ```bash
   curl -X POST /api/provisioning/rollback \
     -H "Content-Type: application/json" \
     -d '{
       "companyId": "[company-id]",
       "resources": {
         "github": { "repoFullName": "trent-platform/[slug]" },
         "neon": { "projectId": "[neon-project-id]" },
         "hosting": { "projectId": "[vercel-project-id]" }
       }
     }'
   ```
3. Show the `rolledBack` list and any `errors`
4. If errors remain, check the audit log for details

## Resource IDs to pass

Get these from `/provision-status [company-id]`:
- `github.repoFullName` (e.g. "trent-platform/acme-co")
- `neon.projectId` (e.g. "neon-proj-abc123")
- `hosting.projectId` (e.g. "prj-vercel-abc123")

## Hard rules

- Admin RBAC required
- Rollback is permanent — resources will be deleted from provider APIs
- Always check `/provision-status` before rolling back to avoid removing resources that are in use
