# P1-A: email requires an authenticated From, 2026-09-25

Wave P1, agent A (Opus, no subagents, no commits). Source: `docs/sessions/2026-09-23-daily-parity.md`
section 3, proposal 1. Owned files: `gateway/platforms/email.ts`, `gateway/platforms/email/**`,
`gateway/platforms/email.wire.test.ts`, the gateway/email portion of config, the email paragraph in
`docs/gateway.md`, the key in `docs/configuration.md`, this log.

## Discovery (facts, with file evidence)
- `gateway/platforms/email.ts` `pollOnce` sets `senderId = bareAddress(h.from)` and hands every fetched
  message to the handler; `GatewayManager.handleInbound` then runs `PairingManager.authorize`, which
  issues a pairing code to an unknown sender and routes a paired one. Nothing reads a verification
  verdict: `email/imap.ts` `HEADER_FIELDS` is `FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES`.
- `email/imap.ts` `parseHeaders` keeps the LAST value of a repeated header. For
  Authentication-Results that would be the one furthest from the receiving MTA, i.e. one the sender
  can write. The fix must read the FIRST (topmost) one.
- Email settings are secrets/env (`EMAIL_IMAP_HOST`, ...) read by `readSetting`; there is no email or
  imap key anywhere in `config/`. The config home for this key is `config/sections/gateway.ts`
  (`gateway.email.require_authenticated_from`), with the default mirrored in `config/defaults.ts`
  (`DEFAULT_CONFIG` is typed as the parsed output and is returned unparsed when no config.yaml exists).
- No email or gateway check exists under `packages/trent-core/src/doctor/`; step (3) is a no-op.
- `email.wire.test.ts` asserts the exact `UID FETCH` command and its fixture has no
  Authentication-Results header; both change with this requirement (documented here, not weakened).

## RED (before any production change)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/gateway/platforms/email.wire.test.ts`
-> exit 1, `Tests  6 failed | 3 passed (9)`. Each failure is the defect itself: the dmarc=fail spoof of
a paired admin reached the agent handler; a mail with no Authentication-Results reached it; an
unaligned spf=pass reached it; a pass the sender wrote BELOW the MTA's fail reached it; a spoofed
`APPROVE <id> <nonce>` approved the row; the FETCH command lacked the two verdict headers. The three
greens are the unchanged SMTP test and two preservation tests (dmarc=pass from a paired sender is
handled as today; the opt-out restores the old behaviour), which by construction cannot be red first.

## Parser unit tests (RED then GREEN)
`email/auth-results.test.ts` written before `email/auth-results.ts`: exit 1, "Cannot find module
'./auth-results.js'" (new module). After the module: exit 0, `Tests  16 passed (16)`.

## GREEN (implementation)
- `email/auth-results.ts` (new, pure): RFC 8601 parser (comments dropped, nested; `;` split outside
  quotes; `none`), Received-SPF parser, `domainOf`, `isAligned`, `checkSenderAuth`.
- `email/imap.ts`: HEADER_FIELDS += `AUTHENTICATION-RESULTS RECEIVED-SPF`; `FetchedMessage.headerValues`
  keeps every occurrence in order (`parseHeaders` keeps its last-wins shape).
- `email.ts`: reads `gateway.email.require_authenticated_from` before connecting (a config error loses
  no mail), and refuses with one `warn` ({ from, verdict }) before `messageHandler`, so no pairing,
  routing or approval path runs.
- Config: `sections/gateway.ts` `email: { require_authenticated_from: true }` (default `{}`),
  mirrored in `defaults.ts` under `// [P1-A] email auth`; `schema-split.input.json` sets it `false`.
  `schema-split.test.ts` failed on the new key as expected; `npx tsx scripts/dev/regen-snapshot.mjs`
  regenerated it (exit 0); its diff is exactly the two `email` blocks.
- Alignment rule: equal domains, or one a dot-boundary suffix of the other with a dot in the shorter
  (subtree form of relaxed alignment); siblings never align, so no Public Suffix List is needed.
  DMARC pass must name the From domain itself in `header.from` (or omit it).
- Wire + parser: exit 0, `Tests  25 passed (25)`.
- Docs: `docs/configuration.md` (YAML key + a short section), `docs/gateway.md` (one section).
- Doctor: no email or gateway check exists; nothing changed.

## Verification (TRENT_QUEUE_FALLBACK=disabled, repo root, 2026-09-25)
- `npx vitest run packages/trent-core/src/gateway packages/trent-core/src/config apps/cli/src/commands/__tests__/docs-truth.test.ts packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 1, `Tests  1 failed | 225 passed (226)`. The one failure is P1-B's in-flight RED test
  `GatewayManager.test.ts:373` ("one gateway per profile": expects a TrentError that
  `GatewayManager.ts`, still unmodified, does not throw yet). email.wire (9), auth-results (16),
  schema-split (5), docs-truth (11), wrapped-modules (3) and the other 15 GatewayManager tests pass.
- `cd packages/trent-core && npm run build` -> exit 2: 5 errors, all in P1-B's in-flight files
  (`src/profile/locks.test.ts` and `src/cron/CronRunner.test.ts` import `profile/locks.js`, which does
  not exist yet); 0 errors in P1-A files. The same `tsc` with only `src/profile/**` and
  `src/cron/CronRunner.test.ts` excluded (scratchpad tsconfig extending the package's) -> exit 0.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
- `node scripts/ci/repo-scan.mjs` -> exit 0.
- Only inbound path: `EmailAdapter.pollOnce` (grep of `platform: "email"` and `EmailAdapter`).

## Residual risks (not fixed here, by scope)
- The check trusts the topmost header without pinning the authserv-id. On a server that writes no
  Authentication-Results, a sender's own header is the topmost one. A follow-up could add an
  optional `EMAIL_AUTHSERV_ID` setting that the topmost header must name.
- A mail server that adds several Authentication-Results headers of its own (OpenDKIM and OpenDMARC
  each add one) is judged on the topmost only; that can refuse legitimate mail, but it never
  accepts spoofed mail.
- Status: implemented and tested locally. Not committed (by instruction), not deployed, and not run
  against a live mail server.

## Follow-up (coordinator): pin the authserv-id
Home chosen: config, `gateway.email.authserv_id?: string` (`z.string().trim().min(1).optional()`) in
`sections/gateway.ts` beside `require_authenticated_from`, under the same `// [P1-A] email auth`
marker. Reason: both switches for one check stay in one schema-validated, documented block; the value
is not a secret. No `defaults.ts` change (optional, unset by default); the fixture input sets it to
`mx.fixture.test`.
- RED: 3 wire tests + 3 unit tests added first. Run of email.wire + auth-results -> exit 1,
  `Tests  4 failed | 27 passed (31)`: a forged `dmarc=pass` from `forged.example` above the server's
  fail was accepted (wire and unit), and a header naming only another server was accepted (wire and
  unit). The two "unset" tests only check that today's behaviour is kept and are green by construction.
- GREEN: `checkSenderAuth` takes `authservId`; when set it reads the first header whose authserv-id
  (unquoted, lower-cased) equals it, never reads Received-SPF, and refuses with
  `no Authentication-Results from <authserv-id>`. `email.ts` passes `gateway.email.authserv_id`.
- Found while testing: an Authentication-Results line that omits the authserv-id and starts with a
  result (`spf=pass ...; dmarc=pass ...`) lost its first result, which was read as the id. RED: exit 1,
  `Tests  1 failed | 19 passed (20)`. Fixed: such a header gets an empty authserv-id, keeps every result,
  and can never match a pinned name.
- Snapshot: `npx tsx scripts/dev/regen-snapshot.mjs` exit 0. It also picked up P1-D's in-tree
  `secrets` key (their `schema.ts`, `sections/secrets.ts` and `schema-split.input.json` hunks). Kept
  because the shared tree must stay consistent. Snapshot hunks by owner: P1-A = the two `gateway.email`
  blocks (defaults and full); P1-D = the two `secrets` blocks. The input file is mixed the same way.
- Docs: `docs/gateway.md` section rewritten (authserv-id rule, yaml, the unset sentence recommending
  it); `docs/configuration.md` YAML comment line and prose.
- Verification after the follow-up (TRENT_QUEUE_FALLBACK=disabled, repo root):
  - vitest gate set -> exit 1, `Tests  1 failed | 234 passed (235)`. The one failure is docs-truth
    "documents every top-level key": `secrets` (P1-D's new top-level key, not yet in
    configuration.md). GatewayManager.test (P1-B) now passes 16/16. email.wire 12, auth-results 20,
    schema-split 5 and wrapped-modules 3 pass; docs-truth passes except that one test.
  - `npm run build` (core) -> exit 2: 20 errors, all in other agents' in-flight RED tests
    (CronRunner.test, spend-ledger.test, spend-report.test, call-policy.test, pricing.test); 0 in
    P1-A files. The same tsc with those 5 files excluded -> exit 0.
  - `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 2: 1 error in `commands/__tests__/cron.test.ts`
    (P1-D cron `model`); with that file excluded -> exit 0.
  - `node scripts/ci/repo-scan.mjs` -> exit 0.
