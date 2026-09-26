# 2026-09-26 — C10: the always-on service says when it will forget

Agent C10 (Opus), council item C10 of `02_plan/output/hermes-council-verdict-2026-09-26.md`.
Branch `feature/trent-fleet-v2`, HEAD `d364755` (P3's `[P3]` hunks in `service-daemon.ts` landed there;
left alone). No commit, stash, checkout, reset or push; no subagents; single test files only.

## Brief
`trent service install` (and `--dry-run`) reports `durable: true|false` in `--json` and one plain line in
text, by the rule the runtime uses (`packages/trent-core/src/store/durability.ts`, not restated). Under Node
it exits 3 with "This service would forget its runs, approvals and audit on every restart (Node has no
durable store); run it from the binary or Bun, or pass --allow-ephemeral" unless `--allow-ephemeral`;
under Bun or the compiled binary it reports `durable: true` and installs as today. The daemon logs one
`service.ephemeral_store` line at start when its runtime is not durable.

## Read first
AGENTS.md (known defect 9: under Node every durable layer is `EphemeralStore`); rulebook Universal Coding
Rules + Phase 4; council C10; docs/service.md; `store/durability.ts`; `runtime/headless.ts` `openStore`
(231-239); `service/{install,program,index}.ts`; `commands/groups/{service,service-daemon}.ts`;
`__tests__/{service,service-auto-review,store-durability}.test.ts`; `service/program.test.ts`.

## Facts checked before code
- `wc -l`: `service-daemon.ts` 293, `service.ts` 229, `service/install.ts` 300, `service.test.ts` 469
  (a C10 test block would cross 500, so the C10 CLI tests go in a new `service-durability.test.ts`).
- The `install` subcommand, its options and its renderer live in `apps/cli/src/commands/groups/service.ts`,
  NOT `service-daemon.ts` (which holds only `daemon`). `--allow-ephemeral` cannot be declared, nor `durable`
  reach `--json`, without hunks there. The file is clean in the tree and carries no other agent's marker.
  Decision (as C9 did for its two out-of-list files): minimal `// [C10]` hunks in `service.ts`, the rule and
  the words in a new core module under `service/`, reported to the lead as outside the list.
- The daemon's unit runs this process's own runtime (`service/program.ts`: the unit names
  `processView.execPath`), so install knows the daemon's store before it starts: Node (`node-entry`) has no
  `bun:sqlite`; binary and `bun-entry` run under Bun. The test seam for Bun/binary is
  `setServiceHostForTests({ processView: { ..., bunVersion } })` (service.test.ts; program.test.ts views).
- `HeadlessRuntime.durable` is the runtime's own flag (headless.ts:191, from `openStore`); the REPL turns it
  into a reason with `diagnoseStoreFailure()` (repl/index.ts:327). The daemon does the same.
- Existing install tests in `service.test.ts` use a Node process view, so under C10 they exit 3. They are
  about plist content, `--force` and systemctl lines, not durability: each install call gains
  `--allow-ephemeral` (marked `// [C10]`), no assertion changes. Windows is refused before durability.

## Log
### Baseline (before any change; single files, `TRENT_QUEUE_FALLBACK=disabled npx vitest run <file>`)
- `apps/cli/src/commands/__tests__/service.test.ts` -> exit 0, 16 passed.
- `packages/trent-core/src/service` -> exit 0, 5 files, 54 passed.
- `apps/cli/src/commands/__tests__/service-auto-review.test.ts` -> exit 0, 3 passed.

### Red (new `apps/cli/src/commands/__tests__/service-durability.test.ts`, no production change yet)
`npx vitest run apps/cli/src/commands/__tests__/service-durability.test.ts` -> **exit 1**, 6 failed, 1 passed:
- (1) under Node, `service install --dry-run --json`: `expected { exitCode: +0, durable: undefined } to deeply
  equal { exitCode: 3, durable: false }` — today it exits 0 and the JSON has no `durable` key.
- Node, text install without the flag: `expected +0 to be 3`.
- Node, `--allow-ephemeral`: `expected 2 to be +0` (commander: unknown option).
- compiled binary / Bun source: `toMatchObject` diff is exactly one line, `- "durable": true` (key absent).
- (2) daemon under a runtime with `durable: false`: `expected [] to have a length of 1 but got +0` — no
  `service.ephemeral_store` line today.
- Passing guard: a durable runtime logs no such line.

### Core unit test (written after the CLI red)
`packages/trent-core/src/service/durability.test.ts` red: exit 1, `Cannot find module './durability.js'` (the
unit under test did not exist; weaker evidence than the behavioural reds above, which are the proof).

### Implementation
- NEW `packages/trent-core/src/service/durability.ts` (36 lines): `serviceDurability(view)` asks
  `store/durability.ts` `explainStoreFailure(undefined, bun)`; its `needs_bun` cause (the one failure nameable
  without opening a store) means not durable, with the store's own `reason`; the refusal line constant;
  `serviceDurabilityLine` (install's text line); `ephemeralStoreLine` (the daemon's start line).
- `service/index.ts`: one `// [C10]` export line.
- `commands/groups/service.ts` (OUTSIDE the brief's list, see Facts): `--allow-ephemeral`; the refusal as data
  + exit 3 after the Windows refusal and before anything is read or written; `durable`/`reason` spread into
  the install JSON; one `store` text line; every hunk `// [C10]`.
- `commands/groups/service-daemon.ts`: after the runtime is built, `if (built.durable === false)` one
  `service.ephemeral_store` line via `diagnoseStoreFailure()` (as the REPL does). `=== false`, so a test fake
  without the field is not taken for an ephemeral runtime.
- `__tests__/service.test.ts`: the 8 install calls on its Node host gain `--allow-ephemeral` (+ one comment).
  Before that edit the run was exit 1, exactly those 4 tests failing `expected 3 to be +0` (the new refusal);
  Windows still passes (refused before durability).

### Green
- `npx vitest run apps/cli/src/commands/__tests__/service-durability.test.ts` -> exit 0, 7 passed.
- `npx vitest run packages/trent-core/src/service` -> exit 0, 6 files, 59 passed.
- `npx vitest run apps/cli/src/commands/__tests__/service.test.ts` -> exit 0, 16 passed.
- `npx vitest run apps/cli/src/commands/__tests__/service-auto-review.test.ts` -> **exit 1, 3 failed, NOT C10**:
  every test throws in its own `configure()` at `ConfigManager.saveConfig` ->
  `governance.auto_review.max_class ... external_send is not allowed ... the highest a reviewer may approve is
  write`, from `governance/auto-review-config.ts`, modified in the working tree by the governance agent. No
  service code is on that path. Baseline at the start of this session: exit 0, 3 passed. Left for that agent.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0. `cd packages/trent-core && npm run build` -> exit 0.
  `node scripts/ci/repo-scan.mjs` -> exit 0.

### Real run on this Mac (dry-run: nothing written; `~/Library/LaunchAgents/uk.let-trent.default.plist` absent after)
- `npm run cli -- service install --dry-run --json` (Node) -> exit 3:
  `{"dryRun":true,"command":"service install","durable":false,"reason":"the SQLite store needs Bun (this is Node: \`npm run cli:bun\` from a clone, or the installed binary)","message":"This service would forget ... or pass --allow-ephemeral"}`
- same with `--no-color` -> exit 3, the one line. With `--allow-ephemeral` -> exit 0, `state: would-write`,
  `durable: false`, text `store     not durable: ...`.
- `npm run cli:bun -- service install --dry-run --json` -> exit 0, `durable: true`, runs `~/.bun/bin/bun .../apps/cli/src/index.ts`.

### Finding (not fixed; outside C10's required behaviour)
The Node unit pins `process.execPath`, which on this Mac is `/Users/bobbymeher/.hermes/node/bin/node`
(Hermes's bundled Node, first on PATH via `~/.local/bin/node`), not Homebrew's. C10's refusal now puts that
path behind `--allow-ephemeral`; pinning a different tool's Node remains the council's second problem clause.

### Doc lines handed to the lead (not applied here: docs are the lead's)
docs/service.md, docs/getting-started.md:18-19 and :43-44; exact text in the C10 report.

## State at hand-off
Files changed: NEW `packages/trent-core/src/service/durability.ts`, NEW `.../service/durability.test.ts`,
NEW `apps/cli/src/commands/__tests__/service-durability.test.ts`, NEW this log; `// [C10]` hunks in
`packages/trent-core/src/service/index.ts`, `apps/cli/src/commands/groups/service.ts`,
`apps/cli/src/commands/groups/service-daemon.ts`, `apps/cli/src/commands/__tests__/service.test.ts`.
Nothing committed, staged or pushed. Open: the Hermes-node pin (Finding); the P3 auto-review test broken by the
governance agent's working-tree change.

## Correction from the coordinator: a dry run refuses nothing
`apps/cli/src/commands/__tests__/registry.test.ts` pins exit 0 for every command's `--json --dry-run` in an
empty profile; C10 made `service install --dry-run` exit 3 under Node (1 failed / 776 passed there). New rule:
`--dry-run` writes nothing, so it exits 0 and reports the truth (`durable: false`, `reason`, plus
`wouldRefuse: true` and the refusal line in `message`, and in text after the `store` line); the real
install still exits 3 unless `--allow-ephemeral`.
- Tests first: `service-durability.test.ts` test (1) now expects exit 0 + `wouldRefuse: true` + the line +
  nothing written, and its text variant; the real-install test gains a `--json` exit-3 check;
  `--allow-ephemeral`, binary and Bun runs assert no `wouldRefuse`. The `service.test.ts` dry-run call
  no longer needs the flag and is back to its original line (its comment now says "every real install").
- Red: `npx vitest run apps/cli/src/commands/__tests__/service-durability.test.ts` -> exit 1, 1 failed / 6
  passed: `expected { exitCode: 3, durable: false, …(1) } to deeply equal { exitCode: +0, durable: false, …(1) }`.
- Fix (`service.ts`, `// [C10]`): `wouldRefuse = !durable && !allowEphemeral`; refuse only when `!ctx.dryRun`;
  the dry-run data spreads `wouldRefuse`/`message`; render adds the line when `wouldRefuse`.
- Green, single files: `service-durability.test.ts` exit 0 (7 passed); `service.test.ts` exit 0 (16);
  `registry.test.ts` exit 0 (777); `npx tsc --noEmit -p apps/cli/tsconfig.json` exit 0.
- Real: `npm run cli -- service install --dry-run --json` (Node) -> exit 0, `durable:false`, `wouldRefuse:true`;
  `npm run cli -- service install --json` (Node, no flag) -> exit 3; the plist still does not exist.
- Docs (the coordinator applied the earlier lines): getting-started 19-20 and 45 stay true (they describe the
  real install). docs/service.md 72-73 must change to say what `--dry-run` does; text in the reply.
