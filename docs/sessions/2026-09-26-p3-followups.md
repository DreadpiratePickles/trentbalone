# 2026-09-26 — P3 follow-ups (gateway listener, setup names, automatic review, untrusted stamp)

Agent: P3 (one Opus worker, no subagents). Branch `feature/trent-fleet-v2`, built on the working
tree as it stands (S2 and H3 landing; H5 and L1 hunks present, unlanded). Every hunk is `// [P3]`.
No commit, stash, checkout or push. No cloud model call: every reviewer in a test is a fake.

## Scope (from the lead)

1. `gateway start` opens the WebhookServer only when `gateway.webhooks` has a route, so LINE and
   WhatsApp never listen otherwise. Open it when a webhook-only adapter is configured OR a route exists.
2. `gateway setup <platform>` writes `<PLATFORM>_BOT_TOKEN` (right for Mattermost only among the four
   new adapters). Write each adapter's real names from the registry.
3. H1's reviewer has no automatic trigger. The service daemon and the heartbeat run one pass per tick
   when `governance.auto_review.enabled`, through `reviewHeldApprovals`.
4. A held row records `untrusted_inbound: true` when the run's ring carries an inbound entry; the
   reviewer refuses such rows whatever the policy says.
5. Comments and docs that list only the older platforms.
6. docs/security.md: one paragraph on the automatic pass and the stamp.

## Baseline

`TRENT_QUEUE_FALLBACK=disabled npx vitest run <the lead's verify set>` from the repo root, before any
change: exit 1, 72 files passed, 519 tests passed, 1 failed:
`apps/cli/src/repl/__tests__/boot.test.ts` "any other key skips the animation and the REPL proceeds
to its prompt" (`Error: no prompt appeared`, a wall-clock deadline in the REPL boot test; not in
this scope and not touched by it).

## Findings before code

- Webhook-only inbound, read off each adapter's `start()`: `line` and `whatsapp` always;
  `homeassistant` always (inbound is its `/webhooks/homeassistant` route); `slack` when
  `SLACK_APP_TOKEN` is unset (Events API mode); `telegram` when `TELEGRAM_WEBHOOK_URL` is set.
  `teams` polls and takes change notifications, so it is not webhook-only.
- Audio attachments (`kind: "audio"`), per adapter source: telegram, whatsapp, signal, discord,
  slack, matrix, mattermost, line, ntfy (nine). email, teams, homeassistant carry none. Each of the
  four new adapters has a wire test for it.
- The policy ring of a fleet run is private to the `PolicyDispatcher` that `tools/index.ts` builds
  beside the bound-approval store; `tools/index.ts` is at 500 lines and not this agent's. A solo run's
  ring is its session taint (`provenance.ts` `currentSessionTaint`), reachable from `bound-approvals.ts`.

## Log

### Item 1 — the listener for webhook-only adapters

- RED: `npx vitest run apps/cli/src/commands/__tests__/gateway-webhooks.test.ts packages/trent-core/src/gateway/registry.test.ts`
  (with the setup file below) exit 1: "LINE up and no route" failed `expected undefined to match
  object { routes: [], adapters: [ 'line' ] }` (nothing listened); the route case failed on the
  missing `adapters` field; registry `TypeError: (0 , webhookOnly) is not a function`.
- GREEN: `registry.ts` [P3] `webhookOnly` per entry (line, whatsapp, homeassistant always; slack
  without `SLACK_APP_TOKEN`; telegram with `TELEGRAM_WEBHOOK_URL`) and `webhookOnly(id, setting)`;
  `servers.ts` [P3] opens a route-less `WebhookServer` where `gateway.webhooks` says (defaults
  127.0.0.1:8644) when no route opened one and a started platform is webhook-only; the report adds
  `webhooks.adapters`. Telegram polling with no route still opens nothing (tested).

### Item 2 — `gateway setup` writes the registry's names

- RED: new `apps/cli/src/commands/__tests__/gateway-setup.test.ts`: 8 of 9 failed (`unknown option
  '--set'`, `expected [ 'MATRIX_BOT_TOKEN' ] to not include 'MATRIX_BOT_TOKEN'`); registry test
  `expected undefined to be 'MATRIX_ACCESS_TOKEN'` (no `tokenSecret`).
- GREEN: `registry.ts` [P3] `tokenSecret` per entry and `platformSecretNames(id)`; the subcommand
  moved to new `apps/cli/src/commands/groups/gateway-setup.ts` (servers.ts is near 500 lines):
  `--token` goes to `tokenSecret`, `--set NAME=value` to any name the platform reads, anything
  else refused (exit 2) naming the names; written with `saveSecrets` (a URL or topic through
  `ConfigManager.set` would have landed in config.yaml); reply names `secretsConfigured` and the
  still-`missing` required names, never a value. `--dry-run` still refuses nothing (the CLI
  registry test runs `gateway setup sample --dry-run`).
- `npx vitest run gateway-webhooks gateway-setup registry(core) gateway-start` exit 0, 49 tests.

### Item 3 — the reviewer's automatic pass

- RED: new `packages/trent-core/src/heartbeat/auto-review-tick.test.ts` (`TypeError:
  loop.beforeEachTick is not a function`), new `apps/cli/src/commands/__tests__/service-auto-review.test.ts`
  (service.test.ts is at 469 lines) and one test in gateway-start.test.ts (`TypeError: (0 ,
  setAutoReviewGatewayForTests) is not a function`); the daemon's dry-run plan had no `auto-review`.
- GREEN: `HeartbeatLoop.ts` [P3] one hook, `beforeEachTick(hook)`, run at the start of every tick
  (quiet too, as consolidation already calls a model in quiet hours), a throw logged, never the
  tick's. `service-daemon.ts` [P3] `autoReviewPass(configManager, log)`: `reviewHeldApprovals` with
  its deps built as `approvals.ts` runReview builds them (gateway.json, policy, hardline,
  approvals.deny, spend ledger, a model gateway only when a row is in policy), config read per pass,
  single-flight; a fourth supervised component `auto-review` every `AUTO_REVIEW_TICK_MS` (60 s),
  present only while `governance.auto_review.enabled` (so every existing component list and log is
  unchanged with the policy off); `setAutoReviewGatewayForTests` is the fake-model seam.
  `servers.ts` [P3] hands the same pass to the heartbeat `gateway start` carries. The daemon does
  NOT also register it on its heartbeat, so one process never runs two passes.
- One test bug fixed on the way: the daemon test's "late" row reused the approved row's key.
- Not wired: `trent heartbeat start` alone (`apps/cli/src/commands/groups/heartbeat.ts` is not this
  agent's); it is one line there, `loop.beforeEachTick(autoReviewPass(...))`.

### Item 4 — the untrusted_inbound stamp

- RED: new `packages/trent-core/src/governance/untrusted-inbound.test.ts` (a real PolicyDispatcher
  seeded by `seedInboundTaint`): `expected undefined to be true` x3, and the reviewer approved the
  stamped row; gateway-webhooks.test.ts [P3] test `expected undefined to be true` until servers.ts
  noted the run.
- GREEN: `bound-approvals.ts` [P3] `details.untrusted_inbound: true` on insert, and on a pending row
  in `preview`/`require` (only ever added), when: the run was noted (`noteInboundRun`, bounded 1024),
  or `currentSessionTaint()` (solo) carries `inbound`, or the store's optional `ring` does.
  `auto-review.ts` [P3] a stamped row is escalated as `untrusted_provenance` before the policy is
  evaluated, no model asked. `servers.ts` [P3] the webhook `seedInbound` wrapper calls
  `noteInboundRun(runId)` first.
- GAP (reported, not fixed): a FLEET run that read an inbox or page without a webhook is not
  stamped, because `tools/index.ts:394` builds `createBoundApprovalStore({ profileDir })` without
  `ring: () => policy.history()`. That one-line change (same line count) is the lead's call: the file
  is at 500 lines and not this agent's.

### Items 5 and 6 — comments and docs

- README proof comment now lists the twelve platform files; voice-notes.ts header and
  config/sections/gateway.ts comment name the nine that attach audio (Email, Teams, Home Assistant
  do not, checked by `grep -c 'kind: "audio"'` per adapter). GatewayManager.ts: see the coordination
  change below; the comment is left as it was. docs/gateway.md voice rows were
  already nine (H4); its setup paragraph now describes `--token`/`--set`, and the LINE bullet's
  "listens only when gateway.webhooks has a route" (now false) is corrected. docs/security.md "Limits,
  stated" is replaced by one paragraph on the automatic pass and the stamp, gap included.
- Left stale, outside the allowed hunk: README.md:177 (the Voice row) still names five platforms.

### Coordination change (from the lead, mid-session)

Another session is landing S2+H3 and fixing a race in S2's files: do not edit
`packages/trent-core/src/gateway/GatewayManager.ts`, `apps/cli/src/gateway/agent-handler.ts`,
`apps/cli/src/gateway/agent-handler.solo.test.ts` or `packages/trent-core/src/solo/router.ts`. I had
already changed the one comment in GatewayManager.ts (line 342 in the working tree, 274 at HEAD); it
is reverted to its HEAD text exactly (`git diff HEAD` shows no hunk on that line, `grep -n "\[P3\]"`
finds none). The other three were never touched. The wording to apply once the file is free:

```ts
    // A text reply carrying a decision is a callback on any platform; it is how email, Signal, Teams, Home Assistant,
    // Matrix and Mattermost (beside a reaction) decide, and ntfy's action buttons publish one to the reply topic. [P3]
```

(ntfy's `onCallback` is a no-op: "a tapped action arrives as a reply-topic message, which the gateway
reads as a decision"; Matrix and Mattermost have `buttons: false`, so a card is text plus a reaction;
LINE decides by postback callbacks, not text.)

## Verification (after every edit, including the GatewayManager revert)

All from the repo root with `TRENT_QUEUE_FALLBACK=disabled`:

- `npx vitest run <the lead's verify set>` exit 0: 59 files, 583 passed, 1 skipped. (One run before
  this one, same command, exit 1 on `gateway/platforms/discord.wire.test.ts` "identifies on the
  gateway, heartbeats...": `hb.d` was null, a heartbeat sent before any sequence number arrived.
  Neither discord.ts nor its test differs from HEAD; alone it passed 5 of 5 runs, exit 0 each. A
  timing race under load, not this change. The baseline's boot.test.ts failure did not recur: that
  file is outside the verify set, and the baseline output listed repl/solo/sessions files the
  filters do not match, which later runs of the same command did not.)
- `npx vitest run gateway-setup.test.ts service-auto-review.test.ts apps/cli/src/commands/__tests__/registry.test.ts`
  exit 0: 3 files, 774 tests (the CLI registry sweep runs `gateway setup sample --dry-run`).
- `npx tsc --noEmit -p apps/cli/tsconfig.json` exit 0 (the first run was exit 2 on
  `gateway-setup.ts(25,82) TS2322 number is not ExitCode`, fixed by typing `refuse` with `ExitCode`).
- `cd packages/trent-core && npm run build` exit 0.
- `node scripts/ci/repo-scan.mjs` exit 0: canned strings, hex colours, emoji all PASS, 0 violations.
- Line counts: servers.ts 433, service-daemon.ts 293, gateway-setup.ts 83, HeartbeatLoop.ts 481,
  auto-review.ts 346, bound-approvals.ts 305, registry.ts 148; every test file touched is under 300.
