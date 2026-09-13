# 2026-09-13 — fleet memory into the CLI, Gemini price rows, doctor image check

Branch `feature/trent-fleet-v2`. Three bounded tasks, test-first, no git commands run.
Not touched: `packages/trent-core/src/improve/**`, `apps/cli/src/commands/improve.ts`, `apps/web/**`.

## 1. Fleet memory wired into `trent`
- RED `apps/cli/src/repl/__tests__/fleet-memory.repl.test.ts` (new): `expected undefined to be defined`
  (`received[0].fleetMemory`) and `expected '' to contain '## Company memory'` (seat `dynamicPrompt`).
- `apps/cli/src/repl/fleet-memory.ts` (new): `wireFleetMemory({ profileDir, store })` builds
  `createFleetMemoryHook({ source: createAppFleetSource({ improve? }), profileDir })`; `store.improve()` is
  used when the store has it (PrismaStore), skipped for the ephemeral store. `fleetMemoryToolListing` for `/tools`.
- `apps/cli/src/repl/index.ts`: `ClassicRepl.start()` passes `fleetMemory` to `createOrchestrator` and lists
  `memory`, `fleet_search` next to the toolsets. `tools` (the toolset adapters) unchanged, so
  `tools.repl.test.ts` still sees `["file_ops","terminal"]`.
- There is no separate non-interactive run path in `apps/cli` that calls `createOrchestrator` (TUI does not run
  the orchestrator); `wireFleetMemory` is the shared helper any future one uses.

## 2. Gemini price rows
- Cost source: `apps/web/lib/model-gateway.ts:194` prices by TIER (Anthropic list); the wrapper's meter row is the
  `usage` event in `packages/trent-core/src/model-gateway/index.ts`.
- RED `packages/trent-core/src/model-gateway/pricing.test.ts` (new): `Cannot find module './pricing.js'`.
- `packages/trent-core/src/model-gateway/pricing.ts` (new): `MODEL_PRICE_TABLE` (integer micro-cents / 1M tokens),
  `priceCall()` -> integer cents rounded up, `pricedAsDefault`, `source`. Gateway `usage` event and
  `GatewayCompletion` carry `priced_as_default`; `estimateCostCents` takes optional `model`.
- Rows: flash-lite 30,000,000 / 250,000,000; flash 150,000,000 / 900,000,000 (source `google-list-2026-09`,
  https://ai.google.dev/gemini-api/docs/pricing, read today). `gemini-3.5-pro` is NOT on Google's page:
  row 200,000,000 / 1,200,000,000 marked `source: "unverified"` (the published gemini-3.1-pro price as stand-in).
- Gap: seat steps priced inside the app's `executeSeatModel` (no `createChatCompletion` port in the live REPL)
  still carry the tier price; the wrapper sees only total tokens there, not the input/output split.

## 3. Doctor workbench image check
- RED in `packages/trent-core/src/doctor/checks/inspection.test.ts` (2 new tests): `expected false to be true`
  (no `inspect --type image` call was made) and `expected 'ok' to be 'warn'` (absent image reported ok).
- `checks/workbench.ts`: `imageAbsent` now runs `docker inspect --type image --format {{.Id}} <ref>` through
  `ctx.execImpl ?? runCommand` (previously the image probe was skipped whenever an exec was injected).

## Evidence
- `npx vitest run apps/cli/src/repl packages/trent-core/src/doctor packages/trent-core/src/fleet-memory packages/trent-core/src/model-gateway packages/trent-core/src/orchestrator` -> 35 files, 250 tests passed, exit 0.
- `npx tsc --noEmit -p packages/trent-core/tsconfig.json` -> exit 2; every error is in `src/improve/` (other agent).
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 2; `commands/__tests__/improve.test.ts` (other agent) and
  `tui/App.tsx:235 fixAll` (pre-existing at HEAD; DoctorRunner untouched).
- `node scripts/ci/repo-scan.mjs --report-only` -> exit 0; violations only in pre-existing `slash/` and `tui/` files.
- Credentials: none read or logged.
