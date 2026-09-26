# 2026-09-26 — H1: auto review of held approvals (gap 10)

Gap 10 of `01_discovery/output/harness-landscape-2026-09-26.md` ("Every approval reaches the human"; the
harness-anthropic auto-mode classifier row and the harness-openai auto-review row). Branch
`feature/trent-fleet-v2`, HEAD at start `e0e13ab`. One Opus agent, no subagents, no commits, stashes,
checkouts or pushes. Other agents edit the tree concurrently (L0-2 model-gateway/**, L0-5
fleet-memory/embedder*, S2 apps/cli surfaces and GatewayManager, H2 tools/mcp and connect/oauth).

Owned here: new `packages/trent-core/src/governance/auto-review*.ts` (+ tests), one `// [H1]` hook point
where approval rows are decided, `apps/cli/src/commands/groups/approvals.ts` (flags on existing
commands), the `// [H1] auto review` block of `config/sections/governance.ts` (+ the key in
`schema-split.input.json`, snapshot regenerated), one section of `docs/security.md`, lines of
`docs/configuration.md`, and this log.

Rules in force: failing test first, `TRENT_QUEUE_FALLBACK=disabled`, vitest from the repo root, no cloud
model call (fake gateway in every test), secrets never read or printed.

## Log

- 03:16Z Read AGENTS.md, CONTEXT.md, the rulebook (principles 6-7, coding rules 5-7, 11). Traced where
  approval rows are made and decided:
  - Two kinds of gateway row are held for a human. A RUN APPROVAL (a step gate) is made by
    `RunApprovalLink` / the TUI through `ApprovalBridge.createApprovalRequest`; its decision fires
    `approval_decided`, which releases the step at once (`orchestrator.approve`). A BOUND CALL row
    (`governance/bound-approvals.ts`, `details.kind: "bound_call"`) carries the exact preview, the
    adapter, the tool and the parsed arguments of one floored call; approving it releases nothing by
    itself — the call runs only when the identical call is replayed and `require()` finds the row
    `approved`. Held memory writes (`tools/memory/holds.ts`) are a third kind, untrusted by definition.
  - Decision paths: `ApprovalBridge.decide(id, decision, decidedBy)` is the local one (CLI
    `trent approvals approve|reject` calls it with `"human"`, the TUI with `"user"`);
    `resolveCallback`/`resolveReaction`/`answerQuestion` route chat decisions into it.
  - No audit row is written for any approval decision today: `decide` stamps
    `status/decidedAt/decidedBy` on the row and mirrors to `StorePort.resolveApproval` when one is
    wired (the CLI wires none). The wrapper has no writer for the app's `AuditLog` table; its verifier
    (`audit/verify.ts` `walkAuditChain`) re-walks NDJSON rows in the `AuditRow` shape.
  - The model gateway request has no response-format field (`model-gateway/types.ts`
    `GatewayStreamRequest`), so "constrained output" is not available to a caller today.
- 03:30Z Design decisions (recorded before code):
  - The reviewer reviews BOUND CALL rows only. A run approval has no bound arguments to hold against a
    policy and is released the instant it is decided; a question is for the founder; a held memory
    write is untrusted by construction. Those are left for the human, always.
  - Policy first, model second: `auto-review-policy.ts` is pure and decides whether a row is even
    eligible (tier <= `max_class`, never `execute`/`destructive`/`deploy`/`secret_access`, money within
    `max_amount_cents` in `currency`, every recipient on `recipients`, no hardline / approval-floor /
    deny-glob hit, no untrusted-provenance string). An ineligible row is escalated with the rule named
    and NO model call. Only an eligible row is put to the model, which may approve, deny or escalate.
  - Approve and deny go through `ApprovalBridge.decide(id, decision, "auto-review:<model>")`, the call
    the CLI's human approve makes. Malformed / absent verdict = escalate (row stays pending).
  - Audit: a profile-local hash chain `<profile>/approvals-audit.ndjson` in the `AuditRow` shape,
    hashed with `computeAuditRowHash` and verified with `walkAuditChain`. Reviewer decisions,
    escalations, reversals, and the CLI's human decisions all append the same row shape; the actor is
    the only difference.
  - Reversal: a bound row's approval does not run the call; the replay does. The ONE `// [H1]` hook is
    in `bound-approvals.ts` `require()`: when a grant decided by `auto-review:*` is honoured, the row is
    stamped `details.autoReviewGrantUsedAt` (only auto-review rows, so with the feature off nothing
    changes). A human `reject` of an auto-approved row whose grant is unused turns it into a denial;
    a used one is refused ("the call already ran").
  - Trigger: `trent approvals list --review` runs the reviewer over the pending rows before listing.
    No long-running surface runs it on its own yet (that needs `buildTrentTools` / the runtime, which
    this task does not own) — reported as the follow-up.
- 03:24Z RED. New tests written first: `governance/auto-review-policy.test.ts` (21: each rule with its
  passing case, the config block, the marker strings pinned to their sources), `governance/auto-review.test.ts`
  (fake gateway: approve / deny / escalate / 3 malformed / absent verdict; out-of-policy never builds a model;
  run approvals untouched; spend charged; the audit chain re-walked by `walkAuditChain`; disabled = byte-identical
  `gateway.json`, no audit file, no model; reversal before the call ran, refusal after, human over a denial),
  and six `[H1]` cases in `apps/cli/src/commands/__tests__/approvals.test.ts` (listing with actor, escalated
  row, `--review` refused while off with nothing changed, `--review` escalating without a model, `--policy`,
  `reject` reversing / refusing). `npx vitest run <the three files>` -> exit 1: "Cannot find module
  './auto-review-audit.js'" (and the two siblings) — red for the reason that the modules do not exist.
- 03:31Z GREEN. `auto-review-config.ts` (schema + actor + the stamp helper; a leaf, so `bound-approvals.ts` can
  import it without a cycle), `auto-review-policy.ts` (pure evaluator), `auto-review-audit.ts` (chain),
  `auto-review.ts` (reviewer, pass, override). The one `// [H1]` hook: `bound-approvals.ts` `require()`, approved
  branch, `stampAutoReviewGrantUse(existing)`. Config: `governance` key (schema.ts, one marked import and one
  marked key before `personality:`), `DEFAULT_CONFIG.governance` (defaults.ts, marked), the `[H1]` block in
  `sections/governance.ts`. CLI: `list --review`, `list --policy`, `reviewed` in `list`, reversal in `decide()`.
  One test fixture fixed, not the rule: the deny-glob case's word "acme-secret" is (rightly) `secret_access`,
  so it read `never_class`; now "acme-skunkworks". Three files: 57 tests, exit 0.
- 03:33Z Mutation checks (sources restored after each, `grep -c MUTANT` -> 0): removing the `[H1]` stamp turns 3
  tests red (approve-then-replay, "refuses to reverse a call that already ran", the CLI reject case); removing
  the actor guard in `stampAutoReviewGrantUse` turns the "disabled: a human approval is exactly as before" test red.
- 03:35Z Snapshot: `governance.auto_review` added to `schema-split.input.json` (non-default values, before
  `personality`); `npx tsx scripts/dev/regen-snapshot.mjs` -> exit 0, "snapshot keys: 44". The regenerated file
  also carries the L0 agents' uncommitted schema changes already in the tree (embedder `base_url`, `models.local`).
- 03:36Z Docs: `docs/configuration.md` (the `governance:` block in the schema listing, "### Auto review"),
  `docs/security.md` ("## Auto review": scope, the rule table, the reviewer contract, the shared decision path,
  the chain, reversal, limits). No subcommand was added (flags on `approvals list`), so no README count line moves.
- 03:37Z Verification (TRENT_QUEUE_FALLBACK=disabled, repo root):
  - `npx vitest run packages/trent-core/src/governance packages/trent-core/src/gateway/ApprovalBridge.test.ts
    packages/trent-core/src/audit apps/cli/src/commands/__tests__/approvals.test.ts packages/trent-core/src/config
    apps/cli/src/commands/__tests__/docs-truth.test.ts packages/trent-core/src/wrapped-modules.test.ts`
    -> 23:33 local: exit 0, 35 files, 333 tests. Re-run 23:39 local: exit 1, 332/333 — the one failure is
    docs-truth "states the command counts": the registry went to 36/152 because S2 registered `trent solo` in
    `apps/cli/src/commands/index.ts` meanwhile; README still says 35/151. Not this change (no command added here).
  - `cd packages/trent-core && npm run build` (= `tsc --noEmit`) -> exit 2; `npx tsc --noEmit -p apps/cli/tsconfig.json`
    -> exit 2. Every error is in a file another agent is editing now (`solo/park.test.ts`, `solo/parse.test.ts`,
    `solo/turn.ts`, `tools/mcp/http-oauth-wire.ts`, `model-gateway/local-runtime.ts`, a transient `zz-probe.test.ts`);
    `grep -E "auto-review|bound-approvals|approvals\.ts|approvals\.test|config/(schema|defaults|sections/governance)"`
    over both outputs -> no match (exit 1). One error WAS mine (a `ListData` cast in the list renderer) and is fixed.
  - `node scripts/ci/repo-scan.mjs` -> exit 0 (canned, hex, emoji: 0 violations).
  - Live local check skipped: `ollama list` shows `qwen3.5:9b`, but `uptime` load average was 74 (limit 20).
- Open / Bobby-gated:
  1. Nothing runs the reviewer on its own: `trent approvals list --review` is the trigger. Running it on every
     parked call (the `require()` park branch, or `buildTrentTools` installing a reviewer beside
     `installBoundApprovals`) needs `tools/index.ts` / the runtime, which this task did not own.
  2. Inside a seat turn the app's step gate still pauses for a person; the reviewer only decides the bound row
     the replay finds. Deciding the step row too would release the step loop-wide (`seat-agent-loop.ts:209`),
     so it was deliberately not done.
  3. A bound row does not record whether its step read untrusted text (the provenance ledger is per process),
     so the allowlist and the cap are what bound an injected send.
  4. No constrained decoding: `GatewayStreamRequest` has no response-format field (model-gateway is L0-2's);
     the JSON shape is enforced on the reply instead.
  5. README command count (S2's `solo`), and the two red typechecks, belong to the agents editing those files.
