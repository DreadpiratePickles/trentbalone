---
name: "source-command-provision-company"
description: "Run the full Phase 3 provisioning orchestrator for a company. Creates GitHub repo, Neon Postgres, Vercel hosting, R2 bucket, DNS subdomain, Sentry project."
---

# source-command-provision-company

Use this skill when the user asks to run the migrated source command `provision-company`.

## Command Template

# /provision-company [company-id]

Provision the full infrastructure stack for a company using the Phase 3 orchestrator.

## What this does

1. Calls `POST /api/provisioning` with the given company ID
2. Runs provisioners in dependency order: env-manager → github → neon → vercel → r2 → dns → sentry
3. On failure at any step, automatically rolls back all successfully created resources
4. Writes a `repo.provision` / `db.provision` / `hosting.provision` audit entry per resource

## Pre-flight checks (run before calling the API)

1. Read the company's current provisioning status with `/provision-status [company-id]`
2. If any resource is already provisioned, this run is idempotent — existing resources are returned, no duplicates created
3. Verify the company has an admin user and a slug set

## Usage

```
/provision-company company_abc123
```

## Implementation

When this command is invoked:

1. Look up the company slug from the store: `store.getCompany("[company-id]")`
2. Call the provisioning API:
   ```bash
   curl -X POST /api/provisioning \
     -H "Content-Type: application/json" \
     -d '{ "companyId": "[company-id]", "companySlug": "[slug]", "enableHosting": true }'
   ```
3. Show the returned resource map (github.repoUrl, neon.projectId, hosting.deploymentUrl)
4. If `success: false`, show `failedAt` and `error`, then suggest `/provision-rollback [company-id]`

## Hard rules

- Do NOT call this without admin RBAC on the session user
- The Phase 2 budget cap is checked before any API call commits spend
- Every provisioning action is logged to the audit trail automatically
