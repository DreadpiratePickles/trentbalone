# ADR-002: Security And Reliability Control Register

Date: 2026-06-20  
Status: Accepted

## Context

Trent now has many security and reliability controls spread across middleware, API routes, provider adapters, orchestration, Workbench, CI, and verification docs. That makes it too easy for the team to overclaim readiness or forget a control when implementation moves quickly.

The product needs a single, typed register that distinguishes:

- controls enforced in code or CI
- controls partially implemented but not complete
- controls that need external infrastructure, provider accounts, legal decisions, or organizational process
- controls that need live proof before being claimed complete

## Decision

Add `lib/readiness-controls.ts` as the canonical control register for the current pre-production hardening checklist.

Every control must include:

- stable slug
- label
- category
- status
- why the control matters
- evidence references
- next action

Add tests and CI checks so the register cannot silently drift:

- `lib/readiness-controls.test.ts`
- `scripts/ci/security-readiness-check.ts`
- `npm run preflight:security`

## Consequences

Positive:

- Checklist coverage is machine-checkable.
- Partial/external items stay explicit instead of being hidden in prose.
- CI can catch missing readiness controls, lost security headers, and missing dependency gates.

Tradeoffs:

- The register is not a substitute for a formal SOC 2/GDPR control matrix.
- It adds maintenance work whenever Trent changes security, data, provider, or reliability boundaries.
- Some controls remain external until Railway, provider, legal, and branch-protection settings are actually configured.

## Follow-Up ADRs

Create separate ADRs for:

1. Cache strategy and invalidation.
2. Data retention and deletion.
3. Disaster recovery and RTO/RPO.
4. API contract generation strategy.
