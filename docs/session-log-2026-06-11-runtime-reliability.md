# Session Log — 2026-06-11 — Runtime Reliability Fix Plan (first implementation pass)

Implements the highest-leverage slices of `2026-06-11-runtime-reliability-fix-plan.md`
(merged Claude + Codex plan). All changes verified: focused vitest suites green
(127 tests across 11 files) and `tsc --noEmit` clean.

## Shipped

### Slice 2 — Source coverage & grounded answers (RC1)
- **NEW `lib/source-coverage.ts`** (+ 13 tests): pure helpers — `extractSourceNeeds`,
  `buildSourceCoverage` (required/used/missing), `selectRelevantDocuments`
  (deterministic keyword top-K), `formatSourceCoverage`, `formatSourceDocumentsBlock`.
- **`lib/orchestrator-runtime.ts`**:
  - `buildLiveContext` now ALWAYS fetches company documents (was gated on
    `productDocs`/`tonePolicy` seats) and injects `ctx.sourceDocuments`
    (relevance-ranked, no type filter, 1500-char excerpts with ids) +
    `ctx.sourceCoverage` into every seat.
  - `generateOrchestrationPlan` computes coverage and injects it into the
    planner prompt; final output must state available vs missing sources.
  - Critic prompt: 'retry' when output claims available docs were unavailable
    or claims to have audited a missing source; uncited doc-claims are a gap.
- **`lib/artifacts.ts`**: artifact drafts pick documents by relevance (not
  recency) and render a `## Source Coverage` section (used vs missing).

### Slice 3 — Workbench scope policy, sanitization, smart stopping (RC3)
- **NEW `lib/workbench-intent-policy.ts`** (+ 19 tests): classifies objectives
  (`build | analysis | research | commandRecovery | deploymentPlan | artifactOnly`),
  derives enforceable policy (scaffold / source edits / dev server / mutating
  shell / named deliverables), `isProseCommand` (rejects `#`, bullets,
  checklists, prose), `checkWriteAllowed`, `checkActionAgainstPolicy`.
- **`lib/workbench-build-loop.ts`**:
  - Scope policy derived before the model gets authority; non-build intents
    skip starter-template scaffolding; every action gated in code
    (`scope_blocked` status, prose commands become notes — never dispatched).
  - Scope contract appended to the model prompt for non-build intents.
  - Smart stopping: identical failure signature on two consecutive
    verifications stops the loop as blocked (MAX_BUILD_ATTEMPTS is a ceiling).
  - Final summary verdict: `passed ✓` / `DEGRADED` / `FAILED ✗` — a critic-skip
    pass can no longer be summarized as a clean pass.
- **`lib/workbench-verify.ts`**: `VerifyVerdict.degraded` — passed-with-critic-skip.

### Slice 1 — Command terminal state & critic integrity (RC2)
- **`components/command-client.tsx`**: SSE error → backoff reconnect (×2) →
  polling fallback against the persisted run snapshot until terminal status;
  45s stream-silence watchdog; saved CEO report rendered without refresh.
- **`app/api/companies/[id]/orchestrate/stream/route.ts`**: terminal event sent
  immediately when connecting to an already-finished run; 5s server-side
  reconciliation poll synthesizes terminal events for runs completed on a
  worker/other process (in-process bus never fires there).
- **`lib/orchestrator-run-phases.ts`**: critic `retry` output is re-critiqued;
  second failure → step failed with DEGRADED note (never silent completion);
  replan/escalate now follow the re-critique verdict.

### Slice 6 — Artifact Builder terminal feedback (RC2)
- **`components/artifacts-client.tsx`**: error card + retry for failed POSTs,
  3-minute timeout state, list refetch after every attempt (success or fail).

### Slice 5 (lite) — Research/design grounding (RC1)
- **`lib/workbench-build-loop.ts` `runStreamingMode`**: research/design passes
  inject relevance-ranked company docs + coverage; when sources are missing the
  answer must open with a Source coverage section and must not fabricate or
  re-request files listed as Available.

### Slice 7 (lite) — App Solo launch errors (RC2)
- **`lib/app-solo-run.ts`**: launch failure now surfaces provider, HTTP status,
  server error detail, and recovery hints.

## Verification
```
npx vitest run lib/source-coverage.test.ts lib/workbench-intent-policy.test.ts \
  lib/workbench-build-loop.test.ts lib/workbench-verify.test.ts \
  lib/workbench-agent.test.ts lib/orchestrator-run-phases.test.ts \
  lib/orchestrator-runtime.test.ts lib/command-orchestration-transcript.test.ts \
  lib/artifacts.test.ts lib/app-solo-run.test.ts lib/workbench-eval-suite.test.ts
# → 11 files, 127 tests, all passing
npx tsc --noEmit --incremental false   # → clean
```
Note: tests were run with `VITEST_SKIP_DB_RESET=1` (no Postgres in this
environment). Linux-native binaries (`@rollup/rollup-linux-arm64-gnu`,
`@esbuild/linux-arm64`) were added to node_modules with `--no-save` for the
test sandbox — they do not affect macOS use and are not in package.json.

## Not yet done (next session, per master plan order)
- Slice 0 regression fixtures for the full tester scenario list.
- Slice 1: durable `OrcEventRecord` persistence (current fix reconciles via
  snapshot polling; DB-backed event replay is the stronger contract).
- Slice 1: routing prompts engaging analyst/engineer/growth/finance on broad
  audits; real approval records for "Founder approve X" outputs.
- Slice 3: pre-write duplicate-import gate in `workbench-syntax-gate.ts`
  (syntax gate exists; duplicate-identifier check not yet added).
- Slice 4: Workbench upload (+ button, zip extraction, provider mounting).
- Slice 5: browser provider abstraction + web research for research mode.
- Slice 7: durable App Solo launch attempts, resume/cancel affordances.
- Slice 8: event-driven structured memory across all surfaces.

---

# Session 2 — same day, continued

## Shipped

### Slice 3 remainder — duplicate-import pre-write gate (RC3)
- `lib/workbench-syntax-gate.ts`: new `duplicateImportSummary()` wired into
  `syntaxErrorSummary` — repair writes that re-import Button/Card/etc. are
  rejected before landing (tester regression: duplicate imports broke the app).
  +4 tests.

### Slice 4 — Workbench upload (RC1)
- **NEW `lib/workbench-upload.ts`** (+13 tests): pure upload expansion —
  `sanitizeUploadPath` (traversal/absolute/drive-letter rejection),
  zip extraction via `fflate` (new prod dependency in package.json — run
  `npm install` locally), folder structure preservation, per-file/total/count
  limits with explicit skip reasons, binary detection, content-free summaries.
- **NEW `app/api/workbench/[id]/uploads/route.ts`**: multipart POST; writes
  ok entries through the provider, records a WorkbenchEvent per file plus a
  batch summary event; returns written/skipped/failed/errors.
- `components/workbench-client.tsx`: + button in the composer (click = files
  or zips, right-click = folder), uploading spinner, success/skip notice,
  error banner; refreshes the session so uploads appear in evidence.

### Slice 1 remainder (RC2)
- `app/api/companies/[id]/orchestrate/stream/route.ts`: durable event relay —
  when the in-process bus is silent (run executing on the worker/another
  instance), persisted `OrchestratorEvent` rows are replayed by seq every 5s,
  so the client gets live progress, not just the synthesized terminal event.
- `lib/orchestrator-runtime.ts`: `isBroadPlanningObjective()` — top-N
  priority/audit/cross-functional prompts force ≥3 specialist seats into the
  plan (tester regression: ceo+escalation-only audits). +3 tests.
- `lib/orchestrator-run-phases.ts`: approval semantics — a consolidated brief
  asking for founder approval now creates a real Approval record (noted with
  its id in the brief) or is explicitly relabeled "FOR REVIEW".

## Verification
13 test files, 152 tests passing; `tsc --noEmit` clean.

## Still open (next session)
- Slice 5: research-mode browser provider abstraction + web research.
- Slice 7: durable App Solo launch attempts, resume/cancel UI, heartbeat wiring.
- Slice 8: normalized event→memory payloads across all surfaces; failed-launch
  memory; acceptance-runner scorecards (pass/partial/fail/blocked).
- Slice 0: full regression fixture suite for the exact tester prompts.
- E2B/Daytona implementations of upload mounting (mock_local/local path done).

---

# Session 3 — same day, continued

## Shipped

### Slice 7 — App Solo launch durability + recovery (RC2)
- `app/api/workbench/route.ts`: session-create failures now caught — write an
  episodic memory document ("Workbench launch failed: …") and return a
  structured 502 with provider + detail + retryable flag (was an opaque 500).
- `components/app-solo-client.tsx`: error state offers "retry launch" and
  "retry with auto provider" (provider override actually flows into the
  relaunch — switching the segmented control alone never relaunched).

### Slice 8 — failure memory (RC4)
- Failed launches leave durable memory (above). Audit confirmed Command
  consolidate already writes memory log + artifact for completed AND failed
  runs; Workbench writes memory on success and failure paths; scope blocks
  and no-progress stops are durable WorkbenchEvents included in memory logs.

### Slice 0 — tester regression fixtures + re-test script
- `lib/runtime-acceptance-evals.ts`: +10 fixtures tagged `tester_2026_06_11`
  covering every reported failure (source coverage, stream-loss convergence,
  read-only analysis, command recovery, prose-command sanitization,
  verdict/sub-check consistency, research file grounding, deployment-plan
  repo grounding, artifact terminal feedback, app-solo launch durability).
- **NEW `docs/retest-script-2026-06-11.md`**: 12-scenario manual re-test with
  the exact tester prompts, original failure, and pass criteria + result table.

## Verification
14 test files, 159 tests passing; `tsc --noEmit` clean.

## Still open
- Slice 5: browser provider abstraction + live web research in research mode.
- Slice 7: mid-run resume for stalled App Solo runs (stale-run heartbeat
  detection); durable run-state restore beyond launch failures.
- Slice 8: normalized cross-surface event→memory payload schema; memory
  feedback into retrieval ranking.
- E2B/Daytona upload mounting validation (route is provider-agnostic; only
  exercised against the local provider here).
- Wire the 10 new acceptance fixtures into the live eval runner with real
  actuals (currently fixture definitions + passing-actuals scaffolding).
