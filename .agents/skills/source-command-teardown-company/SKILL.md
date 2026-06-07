---
name: "source-command-teardown-company"
description: "Initiate teardown for a company. Transitions to cooling_off state; 30-day timer starts. Resources are NOT deleted immediately."
---

# source-command-teardown-company

Use this skill when the user asks to run the migrated source command `teardown-company`.

## Command Template

# /teardown-company [company-id]

Initiate the teardown lifecycle for a company.

## What this does

1. Calls `POST /api/teardown` with the company ID
2. Transitions teardown state: `active → cooling_off`
3. Records `coolingOffStartedAt` and `coolingOffEndsAt` (30 days from now)
4. Writes a `teardown.initiate` audit entry
5. Triggers the n8n cooling-off timer workflow (polls for day 25 reminder + day 30 expiry)

## Resources are NOT deleted immediately

During the 30-day cooling-off period:
- All provisioned resources remain active
- The company's data is preserved
- The founder can cancel teardown with `/provision-status [company-id]` and then cancel via the API

After 30 days, permanent deletion requires a second explicit confirmation via `/teardown-company confirm [company-id]` (or `POST /api/teardown/confirm`).

## Usage

```
/teardown-company company_abc123
```

## Implementation

1. Confirm the user intent — this starts an irreversible-ish countdown
2. Call:
   ```bash
   curl -X POST /api/teardown \
     -H "Content-Type: application/json" \
     -d '{ "companyId": "[company-id]" }'
   ```
3. Show the returned teardown record with `coolingOffEndsAt`
4. Remind: "Teardown can be cancelled before [coolingOffEndsAt] by calling DELETE /api/teardown?companyId=[company-id]"

## Cancel during cooling-off

```bash
curl -X DELETE "/api/teardown?companyId=[company-id]"
```

This returns state to `active` and clears all cooling-off timestamps.

## Hard rules

- Admin RBAC required
- This command MUST NOT be run without explicit user confirmation
- DO NOT call teardown in response to a vague "delete this company" instruction — require explicit /teardown-company confirmation
