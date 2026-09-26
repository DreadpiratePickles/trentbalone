# 2026-09-26 — C3: auto-review never approves a send or money

Agent: C3 (one Opus worker, no subagents). Branch `feature/trent-fleet-v2`, HEAD d364755 (P3 landed:
the auto-review tick and the `untrusted_inbound` stamp). Every hunk in an existing TypeScript file is
`// [C3]`. No commit, stash, checkout, reset or push. No cloud model call: every reviewer is a fake.

## Scope (from the lead)

Council item C3 (`02_plan/output/hermes-council-verdict-2026-09-26.md` §3 Tier 1, chair's call §7.3):
`governance.auto_review.max_class` reaches `external_send` and `money`
(`governance/auto-review-config.ts:17,27`), so a reviewer model may approve a send or a payment,
which contradicts README.md:11-13 ("asks you first at every autonomy level").

Required:
1. The approvable ceiling is `read|write`. A config naming `max_class: external_send` or `money` (or
   anything above write) fails validation with an error naming the key and the README promise:
   "auto_review.max_class: money is not allowed: Trent asks you first for every send and every payment".
2. Defence in depth: a policy-eligible `external_send` or `money` row is escalated to a person with no
   model call whatever the config says (a stale config that slipped past validation included).
3. read/write rows behave exactly as before.

Allowed files: `governance/auto-review-config.ts`, `governance/auto-review-policy.ts`, their tests,
`config/sections/governance.ts`, `config/schema-split.input.json` (+ regenerated snapshot), this log.
Not README or docs/*.md (sentences go back to the lead), not `bound-approvals.ts`, `auto-review.ts`
only as far as the ceiling needs, nothing under gateway/, webhooks/, egress/, service/, solo/, repl/.

## Findings before code

- The shipped class floor parks only `external_send`, `money_moving` and `customer_facing`
  (`governance/gate-config-schema.ts:17`); `gate.ask_classes` adds more. After the cap, the reviewer
  can decide only rows an owner parked by putting `write` (or a read class) on `gate.ask_classes`.
  The feature is off by default, so a default profile loses nothing.
- `ConfigManager.loadConfig` validates eagerly and throws `config.load: invalid config: <path>
  <issue message> (<file>)` (`config/ConfigManager.ts:189-199`, `config/errors.ts:27-41`).
- The config's TypeScript type keeps the whole ladder (`AutoReviewTier`). Narrowing it to
  `read|write` would break `npx tsc -p apps/cli` on `gateway-start.test.ts:262` and
  `service-auto-review.test.ts:54` (`{ max_class: "external_send" } as typeof config`, not this
  agent's files), and the policy must handle a config object that never went through the schema
  anyway (the defence-in-depth requirement). The schema refuses at runtime; the policy refuses too.
- Blast radius, from `grep -rn max_class`: tests that assert a reviewer APPROVES an SMS (the
  behaviour C3 removes). In scope (governance must be green): `governance/auto-review.test.ts:52`,
  `governance/untrusted-inbound.test.ts:104`, `governance/auto-review-policy.test.ts:55,145,160,178,211`,
  `config/schema-split.input.json:106` (`max_class: money`). OUT of scope, reported not edited:
  `heartbeat/auto-review-tick.test.ts:35`, `apps/cli/src/commands/__tests__/approvals.test.ts:163,235`,
  `gateway-start.test.ts:262`, `service-auto-review.test.ts:54`. Docs that still list the old ladder:
  `docs/security.md:600`, `docs/configuration.md:211,624-626` (not this agent's).
- Rule placement: the new check runs LAST, after the recipient rules, just before `eligible`. So every
  existing rule fires exactly as before for every input (a valid config with `max_class: write` still
  escalates an SMS as `class_above_max`, which `apps/cli approvals.test.ts:230` asserts), and only a
  row that passed every rule (possible only under a config that skipped the schema) changes: to
  `send_or_money`, no model asked.

## Baseline (before any edit)

All from the repo root with `TRENT_QUEUE_FALLBACK=disabled`:
- `npx vitest run packages/trent-core/src/governance` exit 0: 17 files, 213 tests.
- `npx vitest run packages/trent-core/src/config` exit 0: 14 files, 75 tests.
- Single files, each exit 0: auto-review-policy (21), auto-review (25), untrusted-inbound (4),
  schema-split (5), ConfigManager (25), heartbeat/auto-review-tick (3), apps/cli approvals (11),
  gateway-start (7), service-auto-review (3).

## Log

### RED

- (1) `governance/auto-review-policy.test.ts` [C3] "refuses a profile config whose max_class is above
  write, naming the key and the promise": a temp profile's `config.yaml` with
  `governance.auto_review.max_class: external_send` (then `money`) through `ConfigManager.loadConfig`.
  `npx vitest run packages/trent-core/src/governance/auto-review-policy.test.ts` exit 1:
  `AssertionError: expected [Function] to throw an error` (the config loads today).
- Policy unit, same file, [C3] "escalates a send or a payment that passes every other rule, whatever
  max_class says": same run, `expected 'eligible' to be 'send_or_money'`. 21 existing tests passed.
- (2) `governance/auto-review.test.ts` [C3] "never puts a send or a payment to the model, even under a
  stale config whose max_class reaches it" (an SMS to an allowlisted number and a 25.00 USD payment
  link, `max_class: money` spread onto a parsed config).
  `npx vitest run packages/trent-core/src/governance/auto-review.test.ts` exit 1:
  `expected 1 to be +0` at `expect(fake.built()).toBe(0)` (the reviewer gateway is built and asked
  today). 25 existing tests passed.

### GREEN, step 1: the ceiling and the last rule

- `auto-review-config.ts` [C3]: `AUTO_REVIEW_CEILING = "write"`, `ASKS_YOU_FIRST`, `isApprovableTier`;
  `max_class` is `z.enum(AUTO_REVIEW_TIERS)` with an error map and a `.refine(isApprovableTier)`, both
  giving "auto_review.max_class: <value> is not allowed: Trent asks you first for every send and every
  payment; the highest a reviewer may approve is write". The output type still carries the ladder
  (see findings). A comment over `max_amount_cents`/`currency`/`recipients`: kept (the schema is
  `.strict()`, so dropping them would break a config that names them), inert while the ceiling is write.
- `auto-review-policy.ts` [C3]: rule `send_or_money`, checked LAST: a row that passed every rule and is
  above the ceiling is refused with the promise named. `auto-review.ts` needs no change (it takes
  the rule type from the policy; an ineligible verdict already escalates with no model built).
- Then the three governance files that parse a ceiling above write fail at collection or in one
  test, each with `ZodError ... auto_review.max_class: external_send|money is not allowed: ...`:
  `auto-review-policy.test.ts:59` (`policy()` helper), `auto-review.test.ts:52` (`POLICY`),
  `untrusted-inbound.test.ts:104` (its reviewer test). These tests assert the behaviour C3 removes
  (a reviewer approving an SMS or a payment link), so they are re-fixtured, not weakened:

### Requirement change applied to existing tests (C3, documented before the edit)

A reviewer may approve only read and write calls. Where a test used an SMS as the call a reviewer
approves, the call is now `write_file` on `file_ops` (a write an owner put on `gate.ask_classes`),
under `max_class: write`. Where a test exercised a rule that runs before the ceiling (untrusted,
floors, never_class, money, recipients), the policy is built as a config object that skipped the
schema (`max_class` spread in after parsing), so the rule still fires exactly as before; the case
that used to end `eligible` for a send or a payment now ends `send_or_money`.

### GREEN, step 2: re-fixtured tests (each run alone from the repo root, `TRENT_QUEUE_FALLBACK=disabled`)

- `governance/auto-review-policy.test.ts` [C3]: `policy()` spreads `max_class` after parsing; a
  `WRITE` row (`write_file` on `file_ops`) is the eligible witness in the bound-call, deny-glob and
  ceiling tests; the in-cap payment link and the allowlisted SMS now end `send_or_money`.
  `npx vitest run packages/trent-core/src/governance/auto-review-policy.test.ts` exit 0, 23 passed.
- `governance/auto-review.test.ts` [C3]: the parked call is a write under `max_class: write`; the SMS
  is kept as the outside-policy case (`class_above_max`) and in the new C3 test.
  `npx vitest run packages/trent-core/src/governance/auto-review.test.ts` exit 0, 26 passed.
- `governance/untrusted-inbound.test.ts` [C3]: the reviewer test parks a write in the seeded and the
  clean run, policy `max_class: write`. exit 0, 4 passed.
- `config/schema-split.input.json:106` `max_class: money` -> `write` (JSON takes no comment; the
  file carries another agent's uncommitted reformat, no value of theirs changed). Before:
  `schema-split.test.ts` exit 1, 2 failed on the ZodError. `npx tsx scripts/dev/regen-snapshot.mjs`
  exit 0; `diff` against the pre-regen copy: one line, snapshot:658 `"money"` -> `"write"`.
- `config/sections/governance.ts` [C3]: the doc comment said the switch approves nothing "until a
  ceiling, a cap or a recipient list is written down"; now "until `max_class: write`", and why.

### Coordinator additions (mid-session): the other tests that set max_class above write

C7 (`2026-09-26-c7-gateway-pair.md:71-75`) and C10 (`2026-09-26-c10-service-durability.md:81-85`)
had recorded these failing under the ceiling and left them to this agent; none was modified in the
tree. Each re-fixtured the same way (the reviewable call is a write, the SMS is outside by class),
every hunk `// [C3]`. Before each edit it failed on `config.save: invalid config:
governance.auto_review.max_class auto_review.max_class: external_send is not allowed ...` (or the
ZodError at module load):
- `apps/cli/src/commands/__tests__/service-auto-review.test.ts` (3 failed) -> exit 0, 3 passed.
- `apps/cli/src/commands/__tests__/gateway-start.test.ts` (1 failed, 6 passed) -> exit 0, 7 passed.
- `packages/trent-core/src/heartbeat/auto-review-tick.test.ts` (no tests, ZodError) -> exit 0, 3 passed.
- `apps/cli/src/commands/__tests__/approvals.test.ts` (`:163` external_send, `:235` money; the one
  run before the edit hit a vitest worker timeout under load, not a verdict) -> exit 0, 11 passed.
`grep -rn "max_class" apps/cli/src packages/trent-core/src docs` now finds no test or fixture above
write except the deliberate stale-config objects in the two governance tests. Docs still listing
the old ladder (not this agent's): `docs/security.md:606`, `docs/configuration.md:211,622-627`.

## Verification (after every edit)

- `npx vitest run packages/trent-core/src/governance` exit 0: 17 files, 216 tests (213 + 3 new).
- `npx vitest run packages/trent-core/src/config` exit 0: 14 files, 75 tests.
- `cd packages/trent-core && npm run build` exit 0.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` exit 0.
- `node scripts/ci/repo-scan.mjs` exit 0 (3 checks PASS, 0 violations).
- Every hunk in every edited existing file carries `// [C3]` (checked per hunk with `git diff -U3`,
  41 hunks, 0 missing). Line counts: config 102, policy 288, policy test 258, auto-review test 351,
  untrusted-inbound test 116, sections/governance 43, tick test 121, service-auto-review test 169,
  gateway-start test 286, approvals test 266.

## Residual, stated

- A `write` row can still reach the reviewer, and its untrusted check is still the string match plus
  P3's stamp. That is the council's accepted scope: C3 closes the send and money path; structural
  taint on bound rows is the trigger before anyone raises the ceiling (verdict §4 "Not yet").
- With the ceiling at write, the money and recipient rules are reached only by a config object that
  skipped validation; they stay (tested) for the day the ceiling is raised.

## Doc text handed to the lead (not applied: README and docs/*.md are not this agent's)

- README.md:11-13, one clause: "...asks you first at every autonomy level, whether or not the optional
  reviewer model is on (`governance.auto_review` stops at `write`), and your yes covers that exact
  call only."
- docs/security.md "Auto review": a headline sentence after "it only ever narrows", a
  `class_above_max` row naming the `read|write` ceiling, a new `send_or_money` row, and one sentence
  on the shipped floor. Exact text in the reply to the lead.
