# Security Readiness API Contracts

Date: 2026-06-20

This is a starter contract inventory for the security and readiness surfaces. It is not a full OpenAPI document yet. The next step is to generate or maintain OpenAPI 3.1 from route schemas and enforce contract tests.

## Shared Response Rules

All protected JSON APIs should return one of:

```json
{ "error": "Unauthorized" }
```

```json
{ "error": "Forbidden" }
```

```json
{
  "error": "rate_limit_exceeded",
  "retryAfterSeconds": 60
}
```

Future API error envelopes should converge to:

```json
{
  "error": {
    "code": "provider_unavailable",
    "message": "Email provider is not configured.",
    "retryable": false,
    "evidenceId": "evt_..."
  }
}
```

## GET /api/health

Purpose: app liveness and readiness.

Authentication: public.

Response:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 123,
  "checks": {
    "app": "ok",
    "database": "ok"
  },
  "readiness": {},
  "worker": {
    "seenAt": "2026-06-20T00:00:00.000Z",
    "alive": true
  },
  "backup": {},
  "ts": "2026-06-20T00:00:00.000Z"
}
```

## GET /api/companies/:id/connectors/matrix

Purpose: show provider/tool readiness for a company.

Authentication: required.

Authorization: company viewer or higher.

Response requirements:

- Each connector reports only real health states: `connected`, `needs_credentials`, `failed`, `approval_required`, `test_only`, or `unavailable`.
- No mock-only connector may report a production success state.
- Missing credentials must include a recovery action.

## GET /api/companies/:id/proofs

Purpose: show latest production/local proof status and failure history.

Authentication: required.

Authorization: company viewer or higher.

Response requirements:

- Every pass must include evidence artifact references.
- Failed and credential-blocked proofs must preserve the error class.
- Proof freshness must be visible.

## POST /api/companies/:id/cycles

Purpose: launch a durable scheduled operating cycle.

Authentication: required.

Authorization: company member or higher.

Request:

```json
{
  "objective": "Inspect state, execute safe work, queue approvals, produce CEO summary.",
  "cycleKind": "scheduled"
}
```

Response requirements:

- Returns queued job ID immediately.
- Reconciles to durable run ID once worker starts.
- Never calls legacy linear cycle engine.
- Rate limited by company cycle bucket.

## POST /api/companies/:id/orchestrate/approve

Purpose: approve or reject a paused durable action.

Authentication: required.

Authorization: company member or higher.

Request:

```json
{
  "approvalId": "approval_...",
  "decision": "approved"
}
```

Response requirements:

- Decision resumes the original paused action only.
- Rejection leaves an evidence record.
- Duplicate approval attempts are idempotent.

## Workbench APIs

Representative routes:

- `GET /api/workbench`
- `POST /api/workbench`
- `GET /api/workbench/:id`
- `PATCH /api/workbench/:id`
- `POST /api/workbench/:id/uploads`
- `POST /api/workbench/:id/start`
- `POST /api/workbench/:id/exec`
- `POST /api/workbench/:id/restore`

Contract requirements:

- All routes require auth.
- Read routes require viewer.
- Mutating routes require member.
- Uploads reject path traversal, absolute paths, oversized payloads, unsafe file counts, and unsafe text extraction.
- Execution routes must return evidence: command, exit code, stdout/stderr excerpt, changed files, checkpoint/diff, and verification state.
- Restore routes must identify checkpoint ID and restore scope.

## Next Step

Create `openapi/trent-public.yaml` or generate it from route schemas. Contract tests should compare implemented routes to the OpenAPI paths and fail if a public/protected route lacks an auth, body, response, or rate-limit declaration.
