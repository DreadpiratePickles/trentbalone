# 2026-09-13 — delegate port bound, pinned sandbox image (agent session)

Branch `feature/trent-fleet-v2`, no git operations. Not touched: `improve/**`, `improve.ts`,
`apps/web/**`, `tui/**`, `slash/**`.

## 1. `delegate_task` -> the orchestrator's `[delegated]` child step

- RED (verbatim): `Error: Cannot find module './delegate-port.js'` (unit);
  `AssertionError: a [delegated] child step exists in the run: expected undefined to be defined`
  (REPL, the tool reported `not_available` with no port bound).
- `orchestrator/delegate-port.ts`: `createOrchestratorDelegatePort({ runner })` implements
  `DelegatePort` plus `wrapSeatModel` / `runStarted` / `runFinished` (the fleet-memory hook pattern)
  so it knows which run and step is delegating; assigns the child step id; caps 6 children per run
  (in-flight ones counted, so one call with 8 tasks cannot beat it) and depth 2.
- `orchestrator/delegate-child.ts`: the real runner inserts a `[delegated] <task>` step after the
  parent in the LIVE run, `persistStep` + `step_pending`/`step_start`, runs
  `executeStepWithRuntime`, `step_output`/`step_end`, returns output + tool calls untouched. No
  critic pass; a child that pauses for approval is returned `blocked` (the parent's tool loop
  cannot park the run). Finding: the app's seat loop ends a step on any `blocked` tool call, so
  the memory-writing child's output IS the block message — the REPL test uses two children.
- `orchestrator/index.ts`: `deps.delegate` hook, delimited like `fleetMemory`.
- REPL: `index.ts` builds the port once and hands it to `wireTools({ delegate })` and
  `createOrchestrator({ delegate })`; `tools.ts` passes `delegate` and
  `pluginsDir: <profileDir>/plugins` to `buildTrentToolAdapters`.

## 2. Sandbox image `trent-sandbox:1`

- RED (verbatim): `Cannot find module './sandbox-image.js'` x3 (core, doctor, CLI suites).
- `scripts/sandbox/Dockerfile`: alpine:3.20 + python3 + nodejs, `apk` removed, user `sandbox`
  (uid 1000), `/workspace`. `terminal/sandbox-image.ts` owns `SANDBOX_IMAGE`; `DockerBackend`,
  config default, `tools/index.ts`, `tools/sandbox.ts`, `repl/tools.ts` read it.
- Doctor: probes the configured image (default = pinned); absent -> `warn` naming
  `trent sandbox build` and execute_code; present -> `ok`.
- `trent sandbox build` (`commands/groups/sandbox.ts`, so the fix-hint guard sees it):
  `docker build -t trent-sandbox:1 -f scripts/sandbox/Dockerfile scripts/sandbox`; `--dry-run`,
  `--json`, `--dockerfile`; exit 3 with docker's stderr on failure. Seam: `CliOverrides.sandboxExec`.
- Measured: `docker build --pull` hung >10 min (BuildKit `DeadlineExceeded` behind Docker
  Desktop's proxy; `docker pull alpine:3.20` alone took minutes). Without `--pull` the build takes
  3 s. `--pull` dropped; the Dockerfile pins the base tag.
- Gated test `tools/code_execution/sandbox-image.docker.test.ts` ran for real (5.9 s): python and
  node print the marker as uid 1000, no `apk`, `NetworkMode=none`. `sandbox.yml` builds the image
  and adds `tools/code_execution` to its suites.
- Adjusted existing test: "never reports ok on this machine, where the Docker daemon is down"
  assumed an environment that is no longer true; it now measures daemon/image state and asserts
  the matching status.

## Evidence
```
npx vitest run packages/trent-core/src/orchestrator packages/trent-core/src/tools \
  packages/trent-core/src/doctor apps/cli/src/repl apps/cli/src/commands/__tests__/sandbox.test.ts
  -> exit 0, 45 files, 326 tests
npx tsc --noEmit -p packages/trent-core/tsconfig.json   -> exit 0, 0 errors
npx tsc --noEmit -p apps/cli/tsconfig.json              -> exit 2: only apps/cli/src/tui/App.tsx(235) fixAll (pre-existing)
node scripts/ci/repo-scan.mjs --report-only | grep -A2 canned -> PASS - 0 violations
```
Docs: `docs/terminal.md` section "The sandbox image and `trent sandbox build`".
