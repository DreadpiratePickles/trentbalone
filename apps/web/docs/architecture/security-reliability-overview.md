# Security And Reliability Architecture Overview

Date: 2026-06-20

## Runtime Boundary

```mermaid
flowchart LR
  user["Operator browser"] --> edge["Railway / domain TLS"]
  edge --> next["Next.js app"]
  next --> auth["Auth.js session/JWT"]
  next --> api["Company-scoped API routes"]
  api --> rbac["RBAC: requireRoleForRequest"]
  api --> rls["RLS context"]
  rls --> db["Postgres"]
  api --> redis["Redis rate-limit / queues"]
  api --> worker["Durable worker"]
  worker --> orch["Durable orchestrator"]
  orch --> providers["Provider adapters"]
  providers --> external["GitHub / Stripe / PostHog / Sentry / Resend / Attio / MCP / Daytona"]
  orch --> audit["Hash-chained audit log"]
  orch --> evidence["Proof and evidence artifacts"]
```

## Tenant Boundary

```mermaid
flowchart TD
  request["Request with user + company id"] --> middleware["JWT-validating middleware"]
  middleware --> role["Role check"]
  role --> context["RLS company context"]
  context --> query["DB/store query"]
  query --> result["Tenant-scoped response"]
  role --> deny["401/403/not found"]
```

## Evidence Boundary

```mermaid
flowchart LR
  action["Agent/tool action"] --> proof["Evidence required"]
  proof --> one["provider receipt"]
  proof --> two["file diff"]
  proof --> three["screenshot/trace"]
  proof --> four["approval id"]
  proof --> five["memory read/write"]
  one --> trust["Trust / proof dashboard"]
  two --> trust
  three --> trust
  four --> trust
  five --> trust
  action --> audit["Audit log hash chain"]
```

## Failure Model

| Failure | Expected behavior |
|---|---|
| Unauthenticated request | 401 JSON for APIs; redirect for pages. |
| Missing role | 403 or not found depending on surface sensitivity. |
| Missing provider credential | `unavailable` or `needs_credentials`; no fake success. |
| Provider error | `failed` with recovery message; no claim without evidence. |
| Redis unavailable | Low-risk routes may fail open today; high-cost routes should be changed to fail closed. |
| Worker/SSE lost contact | UI falls back to polling durable run state. |
| Audit chain mismatch | Must be detected by scheduled verifier and escalated. |

## Gaps To Close

1. Route inventory guard for authz and validation.
2. Provider circuit breakers.
3. Explicit cache strategy.
4. DR runbook and RTO/RPO targets.
5. OpenAPI 3.1 contract generation or hand-maintained contract tests.
