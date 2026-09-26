# C7: a chat user can be paired, and the owner can decide cards in plain words (2026-09-26)

Council item C7 (`02_plan/output/hermes-council-verdict-2026-09-26.md`, Tier 2). One Opus agent, no
subagents, no commits. HEAD d364755, branch feature/trent-fleet-v2.

## Scope given
- New `apps/cli/src/commands/groups/gateway-pair.ts` (+ `__tests__/gateway-pair.test.ts`):
  `gateway pair <platform> <code> [--admin]`, `gateway pairings`, `gateway revoke <platform> <sender-id>`.
- `GatewayManager.ts` stranger reply only; `ApprovalBridge.ts` card text only; their tests.
- Writes go through the same store path `trent approvals approve` uses: a fresh
  `FileGatewayStore(<profile>/gateway.json)` per call; every mutation re-reads the file, so a running
  gateway (which holds `<profile>/locks/gateway.lock`) sees the pairing on the sender's next message.

## Reading (done)
- Defect confirmed: `GatewayManager.ts:327` names `trent gateway pair`, which is not registered;
  `PairingManager.pair()` has no production caller; `ApprovalBridge.ts:267` prints
  `Details: ${JSON.stringify(details)}`.
- `PairingManager.listPendingCodes()` drops the code itself, so `gateway pairings` reads the store
  snapshot for the code (PairingManager is outside this item's files).
- Four wire tests (matrix, ntfy, line, mattermost) assert the old hint `trent gateway pair <p> <code>`;
  they pin the defect and change with the reply (one assertion line each, marked `// [C7]`).

## Log
- RED (1), CLI, real GatewayManager + fake Telegram Bot API (webhook mode) on the command's profile,
  holding the gateway lock: `TRENT_QUEUE_FALLBACK=disabled npx vitest run
  apps/cli/src/commands/__tests__/gateway-pair.test.ts` -> exit 1, 5 failed / 5. The harness steps
  pass first (manager started, stranger's message offered a code, code read from the store); then
  `gateway pair telegram <code> --admin --json` -> exit 2,
  `{"error":{"code":2,"operation":"cli.usage","message":"cli.usage: unknown option '--admin'"}}`;
  without `--admin`, `cli.usage: too many arguments for 'gateway'. Expected 0 arguments but got 1.`
  (Commander's wording for an unregistered subcommand under a group with no arguments; it does not
  literally say "unknown command"). Refusal tests fail on the same usage error, not on their messages;
  the dry-run test fails with exit 2.
- RED (2), stranger reply: `npx vitest run packages/trent-core/src/gateway/GatewayManager.test.ts`
  -> exit 1, 1 failed / 15 passed: `expected 'This sender is not paired with Trent.…' not to contain
  'trent '` (the old hint names `trent gateway pair telegram <code>`).
- RED (3), card text: `npx vitest run packages/trent-core/src/gateway/ApprovalBridge.test.ts` -> exit 1,
  4 failed / 11 passed: `expected 'APPROVAL REQUIRED\nAgent: ceo\nAction…' not to contain '{'`; the
  received card carries `Details: {"kind":"bound_call","tool":"write_file","args":{...}}`.
- GREEN (3): `ApprovalBridge.cardText` is now `APPROVAL REQUIRED` / one action line / `Ref: <id>`
  (plus the old `Budget impact` line when that field is set; nothing sets it in production). The line is
  `<agent> wants to run <tool> on <target> for <amount>` when a tool is known (a bound row's
  `details.tool`/`args`, or an action written `<tool> <json>` / `<adapter> <tool> <json>`, the MCP gate's
  rows and a solo gate's clipped step title), else `<agent> wants to: <action>`; braces dropped, 160
  chars max; amounts from integer cents as `$241.00` or `0.05 EUR`. Found while fixing: the solo gate's
  row action is `<adapter> <tool> <json>` clipped at 120 chars (`solo/events.ts` gate title), so the
  JSON may not parse; the target is then read off the raw text. Test added for it.
  `npx vitest run packages/trent-core/src/gateway/ApprovalBridge.test.ts` -> exit 0, 15 passed.
- GREEN (2): stranger reply is now `Trent does not know you yet.\nPairing code: <code>\nThe owner can
  approve it; the code expires in one hour.` (keeps the `Pairing code: <code>` line the wire and
  voice-note tests parse). One more GatewayManager assertion pinned the old first line (`not paired`,
  the email stranger); updated with `// [C7]`.
  `npx vitest run packages/trent-core/src/gateway/GatewayManager.test.ts` -> exit 0, 16 passed.
- Four wire tests pinned the old hint (`matrix` watched red: `expected 'Trent does not know you
  yet.\nPairing…' to contain 'trent gateway pair matrix PBBN3GKZ'`, exit 1); each assertion now says
  `not.toContain("trent ")`, marked `// [C7]`.
- GREEN (1): new `apps/cli/src/commands/groups/gateway-pair.ts` (133 lines): `pair <platform> <code>
  [--admin]`, `pairings`, `revoke <platform> <sender-id>`, each over a fresh
  `FileGatewayStore(<profile>/gateway.json)` and `PairingManager`, no lock taken (as `approvals
  approve`). Registered in `servers.ts` beside `gatewaySetupSpec`: one import and one spread line, both
  `// [C7]` (435 lines). `pairings` reads the store snapshot for the live codes (PairingManager's
  `listPendingCodes` drops the code). Exit 2 for an unknown/expired code, unknown platform, or a revoke
  of a sender who is not paired; a store read/write failure is rethrown, not reported as a bad code.
  `npx vitest run apps/cli/src/commands/__tests__/gateway-pair.test.ts` -> exit 0, 5 passed.
- `npx vitest run apps/cli/src/commands/__tests__/registry.test.ts` -> exit 1, 1 failed / 776 passed;
  discovered 155 commands (was 152). All 15 cases for `gateway pair|pairings|revoke` pass (their
  `--json --dry-run` exits 0 in an empty profile). The one failure is `service install: emits parseable
  JSON` -> exit 3 (`durable: false`, "the SQLite store needs Bun"): `service.ts` is being changed in the
  working tree right now by another agent (`[C10]`, `--allow-ephemeral`; not modified at session start),
  not by C7. Reported, not touched.
- `npx vitest run apps/cli/src/commands/__tests__/gateway-start.test.ts` -> exit 1, 1 failed / 6
  passed. The failure is the [P3] auto-review case: `config.save: invalid config:
  governance.auto_review.max_class ... external_send is not allowed` at the test's own `saveConfig`
  (line 259). `governance/auto-review-config.ts` is modified in the working tree by another agent
  (off limits to C7); nothing in C7 touches config or governance. Reported, not touched.
- Affected gateway files, one at a time, all exit 0: matrix.wire (7), ntfy.wire (6), line.wire (8),
  mattermost.wire (7), voice-notes (12 + 1 skipped), security/pairing (6), security/approvals (8),
  RunApprovalLink (10), email.wire (12), telegram.wire (6).
- `npx vitest run apps/cli/src/commands/__tests__/docs-truth.test.ts` -> exit 1, 1 failed / 11:
  `expected [ 36, 152 ] to deeply equal [ 36, 155 ]`. README must read "36 commands, 155 with their
  subcommands"; left for the lead (README is not C7's to edit).
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0 (run twice, the second after the harness
  stopped a stalled stream; tree state was intact). `cd packages/trent-core && npm run build` -> exit 0.
  `node scripts/ci/repo-scan.mjs` -> exit 0 (1259 files; canned strings, hex colours, emoji: 0).
- Every hunk in an existing file carries `// [C7]` (ApprovalBridge.ts: one block, `[C7]` .. `[C7] end`).

## Residuals (not fixed; outside C7's files or needing Bobby)
- No file lock on `gateway.json`: a pairing written by the CLI at the same instant the running gateway
  mutates the file can be lost, exactly as for `approvals approve` (read-modify-write per mutation).
- `cardSubject` (email subject, ntfy title) is still `Approval needed: <action>`, which for an MCP row or a
  solo gate's clipped title can carry `{`; it sits outside lines 261-271.
- The row keeps its details, but `trent approvals list` shows only id, action and seat; there is no
  `approvals show <id>` for the full arguments.
- Live proof (pair from Bobby's phone, approve a held `write_file` by reaction) needs his bot token and
  phone: not run.
- README count pin: 36 commands, 155 with subcommands (docs-truth is red until README says so).
