---
description: Query all provisioned resources for a company and their health status.
---

# /provision-status [company-id]

Show the current provisioning state across all provisioners for a company.

## What this returns

| Resource | Provider key | Status |
|---|---|---|
| GitHub repo | GitHub-Provisioned | repoUrl, repoFullName, defaultBranch |
| Neon Postgres | Neon-Provisioned | projectId, branchIds (not connection strings — those are encrypted) |
| Hosting | Vercel-Provisioned or Render-Provisioned | projectId, deploymentUrl |
| R2 Bucket | R2-Provisioned | bucketName, publicUrl |
| DNS | DNS-Provisioned | fqdn, certStatus (pending/active) |
| Custom Domain | Domain-Provisioned | customDomain, certStatus |
| Expo | Expo-Provisioned | projectId, otaChannels |
| Sentry | Sentry-Provisioned | projectSlug (DSN is encrypted) |

## Usage

```
/provision-status company_abc123
```

## Implementation

Call `GET /api/provisioning?companyId=[company-id]` and display the `status` object.

For each resource:
- Show ✅ if provisioned
- Show ⬜ if null (not yet provisioned)
- Show certStatus for DNS/domain (pending = DNS still propagating)

## What to do if a resource is missing

If github, neon, or hosting are null, run `/provision-company [company-id]` to provision them.
If dns or domain are null, the respective provisioner needs to be called separately.
