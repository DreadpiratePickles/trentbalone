# 2026-09-20 — U1: the side-effect gate every new executor requires

Branch `feature/trent-fleet-v2`. Implementation agent for task U1 of the upgrade round
(`02_plan/output/upgrade-round-design.md` section 1, G1 to G5; the holes are
`02_plan/output/upgrade-round-review.md` section 6, items 1 to 5). Nothing committed or staged by
this agent; no subagents; no model called. `TRENT_QUEUE_FALLBACK=disabled` in every shell.

## What was built (RED first, each)

- **G1 class floor.** `governance/gate-config-schema.ts` (new): `CLASS_FLOOR` =
  `external_send`, `money_moving`, `customer_facing`; `GateConfigSchema` `{ ask_classes }` can only
  add. `autonomy.ts`: `AutonomyInput.classFloor`, verdict `ask` placed after the three refusals and
  before the `never` short-circuit; `classFloorOf(call, floor)` (a pure read carries none).
  `autonomy-dispatch.ts`: options `floor`, `bindings`; `requiresApproval`/`dryRun`/`execute` all see
  it. Classifier gains `book`/`booking`/`appointment`/`reservation` (customer_facing) and `pay`
  (money_moving). Config: `gate` key through a `// [U1] class floor` marked block in
  `config/schema.ts` (import + key) and `config/defaults.ts`; snapshot regenerated with
  `npx tsx scripts/dev/regen-snapshot.mjs` (exit 0); `schema-split.input.json` sets `ask_classes: ["deploy"]`.
- **G2 per-call binding.** `governance/bound-approvals.ts` (new): rows are `ApprovalRow`s in
  `<profile>/gateway.json` (`details.kind: "bound_call"`, `key`, `preview`, `args`, `classes`,
  `previewedAt`), keyed by `toolCallKey({runId, stepId, "<adapter>:<tool>", args})` byte for byte
  with the idempotency key. `dryRun` on a floored call stores the preview and stamps the row;
  `execute` runs only against `approved`, or the stamped row's replay inside the same seat turn
  (recorded `decidedBy: "step approval"`); `denied` blocks; anything else parks a new pending row
  and returns `needs_approval` naming it. `trent approvals approve|reject <id>` decides the row
  through the existing bridge, no CLI change. `TrentToolAdapter.preview?(action)` is the
  adapter's own rendering; the arguments as written are the fallback. Helper for adapters:
  `requireBoundApproval(call, preview, store?)`; `buildTrentTools` installs the profile's store.
- **G3 tokens.** `SIDE_EFFECT_SCOPE_TOKENS` gains publish, post, reply, book, invoice, charge, pay,
  sms, refund, email (substring match kept; over-inclusion only dedups identical calls).
- **G4 inbound.** `provenance.ts`: `UNTRUSTED_ADAPTERS` gains `inbound`; `INBOUND_SCOPE`;
  `isInboundCall` (scope declaration, or `inbox`/`inbound` name token); `adapterProvenance` takes
  scopes and the wrapper passes them. `policy-rules.ts`: class `inbound` (added by the same test,
  so the web/browser/mcp/plugin families carry it too); default rule `send-after-untrusted`
  (`require_approval`, `external_send` after `inbound`, window 20); `PolicyDecision.trigger` names
  the call that was read. `policy-dispatch.ts`: a result an adapter tagged untrusted marks its ring
  entry `inbound` after the fact.
- **G5 external spend.** `spend-ledger.ts`: `SpendSurface` gains `tool`; `SpendRow.tool`/`units`;
  `recordToolSpend({ run_id, tool, provider, cents, model?, units?, seat?, at? }, ledger?)`;
  `dailyTotalCents` counts the rows, which is what `apps/cli/src/repl/budget.ts` reads.
- Audit: `security-audit.ts` probes `classFloorStillAsks` and the `autonomy-never` finding no
  longer claims every call runs unattended.
- Docs: `docs/security.md` "Side-effecting tools: the gate" (appended) plus the `inbound` class and
  the new rule in the policy table; `docs/configuration.md` `gate:` block and a short section.

## Verification (this agent's runs, final state at 01:45)

- `npx vitest run packages/trent-core/src/governance packages/trent-core/src/tools packages/trent-core/src/config packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 0, 49 files, 434 tests (an earlier run had 4 failures in `tools/memory/brain-read.test.ts`,
  another agent's RED tests, since gone green under their owner).
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
- `npm --prefix packages/trent-core run build` -> exit 2: 6 errors, all in the untracked
  `packages/trent-core/src/mcp-server/{server,stdio}.test.ts` (another agent's G9 work); none in U1 files.
- `node scripts/ci/repo-scan.mjs` -> exit 0.
- Environment note: between roughly 01:24 and 01:40 `node_modules/@types/node` was absent (a
  concurrent `npm install`; the lockfile diff adds `@napi-rs/canvas`), so both tsc runs failed with
  1558/2096 `Cannot find module 'node:fs'` errors. This agent verified its own files meanwhile with
  `--typeRoots <scratchpad>/@types --types node` (U1 files clean) and did not run `npm install`
  under running agents. The types are back and the numbers above are from after that.
- Adjacent suites run green: gateway, orchestrator (except the untracked resume test, which uses
  `write_file` and is unaffected by the floor), heartbeat sweep, fleet-memory app writes, improve
  tool overrides, CLI approvals, security, budget, held-writes, headless spend, `docs-truth` (the
  `gate` key resolves; its remaining 3 failures are the `media` key, a new command and five new
  doctor checks from other agents).

## Not done

- No surface lists a bound row with its preview yet: `trent approvals list` prints the clipped
  `action` line (`<tool>: <preview>`) through the existing generic path; a dedicated renderer is
  the surfaces' own change (`apps/cli/src/commands/**`, not this task's files).
- A rejection of the step card (REPL `n`, chat reject) does not mark the stamped row `denied`;
  it fails the step, which never re-runs under its id, so nothing is sent. Marking it would need
  `orchestrator/index.ts` (owned elsewhere).
- Executors that read inbound text should name reads `<family>_list`/`<family>_read`: the
  classifier treats `send`, `email`, `message`, `post`, `publish`, `reply`, `sms` as outbound
  anywhere in a name, so `read_email` would be gated as a send (safe direction, wrong reason).
