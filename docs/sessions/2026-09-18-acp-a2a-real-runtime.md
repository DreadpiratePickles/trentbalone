# 2026-09-18 — A0.2: ACP and A2A run the real agent runtime

Branch `feature/trent-fleet-v2`, HEAD `c9de8bf`. `TRENT_QUEUE_FALLBACK=disabled` exported in every shell.

## Defect (harness-parity-audit-2026-09-18.md, C.6)
- `packages/trent-core/src/acp/ACPServer.ts:123` — `agent/chat` returned a template string.
- `packages/trent-core/src/a2a/A2AServer.ts:88,92` — `POST /a2a/tasks` returned a fake `completed`.
- `packages/trent-core/src/a2a/A2A.test.ts:79-81` asserted that canned shape (anti-test, AGENTS.md invariant 4).

## Plan
1. New port `packages/trent-core/src/agent-runner/index.ts`: `AgentRunner.run({objective, signal})` ->
   `AsyncIterable<OrcEvent>`, plus `collectAgentRun` which folds the stream into a real outcome.
   Mirrors the fold `apps/cli/src/gateway/agent-handler.ts:replyFromEvent` already uses.
2. A2A: real task lifecycle (submitted -> working -> completed | failed | input-required), stored
   tasks, `GET /a2a/tasks/:id`, HTTP 503 with a plain reason when no runner is attached.
3. ACP: `agent/chat` returns the runner's real output; JSON-RPC error when no runner. Handshake and
   capabilities untouched.
4. CLI: `trent a2a serve` / `trent acp` build `createHeadlessRuntime` and pass its `run` as the runner.
5. Rewrite `A2A.test.ts` and extend `ACPServer.test.ts` with fake runners (no live model).
6. `scripts/ci/repo-scan.mjs` gains the two retired literals.

## Log

### RED (each failure for the right reason)
- `packages/trent-core/src/a2a/A2A.test.ts` — 5 failed: `task.history` undefined (no lifecycle),
  `runner.objectives` empty (nothing ran), POST with no runner returned 200 instead of 503.
- `packages/trent-core/src/acp/ACPServer.test.ts` — 4 failed: `data.result` was the canned
  `{agent, response}` object on every path, so the error assertions all saw a result.
- `apps/cli/src/commands/__tests__/servers.test.ts` — 2 failed: `data.runner` undefined; neither
  command built a runtime.

### GREEN
Port `agent-runner/index.ts` + `a2a/TaskLifecycle.ts` + `acp/chat.ts`; both servers reduced to thin
HTTP adapters; CLI builds the runtime through `commands/groups/protocol-runtime.ts`.

### Coordinator adjustment (design review)
The ACP wire is HTTP (the standard is stdio JSON-RPC) and the A2A payload is Trent-specific, not the
specification's Task/Message/Part/Artifact schema; both are to be replaced for Hermes interop. So the
lifecycle and its tests were moved onto the runner port (`TaskLifecycle.test.ts`, `chat.test.ts`), the
HTTP tests were cut back to adapter depth, and the README now states both limitations plainly.

### Verification (TRENT_QUEUE_FALLBACK=disabled)
```
npx vitest run packages/trent-core/src/acp packages/trent-core/src/a2a \
  packages/trent-core/src/agent-runner apps/cli/src/commands/__tests__/servers.test.ts
  -> exit 0, 5 files / 26 tests passed (baseline for acp+a2a was 2 files / 5 tests, one an anti-test)
npx tsc --noEmit -p apps/cli/tsconfig.json      -> exit 0
npm --prefix packages/trent-core run build      -> exit 2; 0 errors in a2a/, acp/, agent-runner/.
  The failures are other agents' in-flight RED files (model-gateway retry/providers, fleet-memory).
node scripts/ci/repo-scan.mjs                   -> exit 0 (561 files, 0 canned / 0 hex / 0 emoji).
  Proven live: re-adding either retired literal makes it exit 1 naming file and line.
npx vitest run --reporter=dot                   -> 1863 passed / 27 skipped / 30 failed.
  All 30 failures are in files owned by concurrent agents (model-gateway retry+providers+pricing,
  orchestrator/model-env, wrapped-modules 500-line ceiling on orchestrator/index.ts at 502).
```
