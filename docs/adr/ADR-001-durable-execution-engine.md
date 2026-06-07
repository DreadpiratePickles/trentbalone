# ADR-001 — Choice of durable execution engine

**Status**: proposed  
**Date**: 2026-05-27  
**Authors**: @DreadpiratePickles

---

## Context

Trent's agent cycles must survive worker restarts, network partitions, and long-running tool calls (a GitHub PR review or ad-performance pull can take minutes). We need a durable execution primitive that:

- Persists cycle state across process restarts
- Retries failed steps with configurable backoff
- Supports fan-out (multiple agents per cycle) and fan-in (cycle summary)
- Emits real-time step events for the SSE feed
- Works within a Vercel/Next.js deployment without dedicated infra

**Finalists evaluated**: Trigger.dev v3 · Inngest · Temporal · BullMQ (current)

---

## Decision

**Use BullMQ (current) for Phase 1** with a planned migration to Trigger.dev v3 before Phase 2 GA.

### Phase 1 rationale (BullMQ)

- Already implemented and passing integration tests
- Redis-optional fallback (in-process queue for local dev, zero setup)
- SSE feed already wired to job events
- No new infra required during private beta

### Phase 2 migration target: Trigger.dev v3

- Durable execution with automatic resume on worker restart — BullMQ jobs are lost on Redis flush
- Built-in retry with deterministic step IDs
- Native fan-out / fan-in patterns for multi-agent orchestration
- OpenTelemetry traces out-of-the-box
- Replay and debuggability from the Trigger.dev dashboard
- Vercel-compatible (serverless tasks)

### Why not Inngest

- Less expressive workflow primitives for our nested plan → step pattern
- Pricing at scale is less predictable

### Why not Temporal

- Operational overhead (separate cluster) unjustified at Phase 1 scale
- Re-evaluate at 50k+ cycles/day

---

## Consequences

**Phase 1 (BullMQ)**
+ Fast to ship; no new dependencies
- Job durability limited to Redis TTL; worker restarts lose in-flight jobs
- Manual resume logic required for long cycles

**Phase 2 (Trigger.dev v3)**
+ True durability; step-level replay
+ Reduces custom orchestration code in `lib/cycles.ts`
- Migration effort: adapter layer between current BullMQ API and Trigger.dev task API
- Trigger.dev adds a SaaS dependency; consider self-hosted if SOC 2 requires it

---

## Migration checklist (Phase 2)

- [ ] Spike: port `lib/cycles.ts` cycle runner to a Trigger.dev task
- [ ] Verify SSE fan-out still works via Trigger.dev realtime API
- [ ] Port `lib/scheduler.ts` to Trigger.dev scheduled tasks
- [ ] Run parallel workload test (BullMQ vs Trigger.dev) on staging
- [ ] Cut over with feature flag; rollback path is re-enabling BullMQ queue
