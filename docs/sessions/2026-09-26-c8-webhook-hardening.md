# C8 webhook hardening, 2026-09-26

Council item C8, the hardening part only (`02_plan/output/hermes-council-verdict-2026-09-26.md`,
section C8; P3's listener landed in d364755). Owner: one Opus agent, no subagents. Branch
`feature/trent-fleet-v2`, HEAD d364755. No commit, stash, checkout, reset or push.

Ownership: `packages/trent-core/src/webhooks/**`, `config/sections/gateway.ts` only for the new
scheme's name and fields, `docs/webhooks.md` (one section), this log. Not touched: gateway/**,
apps/cli/**, egress/**, governance/** (other agents are there).

## Read first
- AGENTS.md; rulebook Universal Coding Rules, Phase 4, and section 11: "Webhooks require signature,
  replay, idempotency, malformed-body, and unsupported-event tests".
- C8 defects: (a) `webhooks/engine.ts:113-114`: a `none-localhost-only` route accepts any loopback
  POST, and a page in the owner's browser posts from 127.0.0.1 too. (b) `webhooks/signature.ts:81-91`:
  generic `hmac-sha256` is over the body alone, so a captured delivery replays after the 24 h dedupe.
- Hermes binds a timestamp (`~/.hermes/hermes-agent/gateway/platforms/webhook.py`): line 63
  `_V2_REPLAY_WINDOW_SECONDS = 300`; lines 85-95 `_timestamp_fresh` (abs skew, unparseable refused);
  lines 725-739: V2 signs `<timestamp>.<body>`, `X-Webhook-Timestamp` required, and the V2 header
  commits to V2 (no fallback to the body-only MAC). In Trent the scheme is fixed per route by
  config, so there is no header-driven fallback to guard against.
- `schema-split.input.json` carries another agent's uncommitted reformat (M in git status); the
  snapshot is unmodified.

## Plan
1. RED: engine.test.ts (Origin header, text/plain body, unparseable body on a loopback route);
   signature.test.ts + engine.test.ts (`hmac-sha256-ts`, 301 s old); config.test.ts (the scheme
   parses, `timestamp_header` only on it).
2. GREEN: engine.ts browser guard; signature.ts `hmac-sha256-ts`; types.ts two verdicts;
   gateway.ts enum + `timestamp_header` (optional, no zod default, so existing parses are unchanged
   and the schema-split snapshot need not move).
3. docs/webhooks.md: the scheme, the loopback rule, one tunnel recipe, verified as far as this
   machine allows.
4. Verify with the lead's commands; record each exit code here.

## Baseline (02:16 local)
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/webhooks packages/trent-core/src/gateway/WebhookServer.test.ts`
  -> exit 0, 6 files, 60 tests.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/config` -> exit 0, 14 files, 75 tests.

## RED (02:21 local), one file at a time
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/webhooks/engine.test.ts`
  -> exit 1, 4 failed | 30 passed (34):
  - "refuses a loopback POST carrying an Origin header with 403, records why, and starts no run"
    (`Origin: https://evil.test`, then `Origin: null`): `expected 202 to be 403`. Defect (a) as stated:
    the run starts today.
  - "refuses a text/plain or untyped body, and a body that does not parse, with 403 and no run":
    `expected 202 to be 403` on the first call (`content-type: text/plain` with a JSON-looking body,
    the `<form enctype="text/plain">` shape).
  - "refuses a loopback POST that a proxy forwarded, with 403 and no run": `expected 202 to be 403`.
    Beyond the brief, added because the tunnel recipe this item documents connects to the listener
    from loopback: without it a tunnelled listener serves a `none-localhost-only` route to the internet.
  - "hmac-sha256-ts: a fresh delivery starts a run, the same one correctly signed 301 s ago is 401":
    `ZodError ... invalid_enum_value, received "hmac-sha256-ts"`. The scheme does not exist, so the
    test is written against the expected wire format (`<t>.<body>`, `x-trent-timestamp`, or
    `t=<unix>,v1=<hex>` inline).
- `... vitest run packages/trent-core/src/webhooks/signature.test.ts` -> exit 1, 5 failed | 11 passed
  (16): the five `hmac-sha256-ts` cases, each `Invalid enum value ... received 'hmac-sha256-ts'`
  (each `it` builds its own route, so the file still collects and the old 11 stay green).
- `... vitest run packages/trent-core/src/webhooks/config.test.ts` -> exit 1, 1 failed | 7 passed (8):
  "parses hmac-sha256-ts with its headers, and keeps timestamp_header off every other scheme", same
  enum error.
- Changed requirement, recorded: the existing "accepts an unsigned loopback request on a loopback
  listener" now sends `content-type: application/json; charset=utf-8` (a loopback route takes JSON
  only, per C8). Its assertions are unchanged.

## GREEN (02:25 local)
- `config/sections/gateway.ts` (`// [C8]` hunks): `hmac-sha256-ts` in `WEBHOOK_SIGNATURES`;
  `timestamp_header` (optional, no zod default, so a route without it parses to the same object as
  before); `signature_header` allowed on both generic HMACs; `timestamp_header` refused on any
  other scheme; the `tolerance_seconds` comment names both timestamped schemes.
- `webhooks/signature.ts`: Stripe's `t=/v1=` parse and its tolerance-plus-MAC check moved into
  `parseTimestamped` + `verifyTimestamped`, which Stripe and `hmac-sha256-ts` share (one rule, not
  two copies). `hmac-sha256-ts`: digest in `signature_header` (default `x-webhook-signature`), over
  `<t>.<raw body>`; `t` from `timestamp_header` (default `x-trent-timestamp`), or inline
  `t=<unix>,v1=<hex>` in the signature header. Unix seconds only (1-12 digits). Refusal texts for
  Stripe changed slightly (nothing asserts them; they go to the row's `detail`).
- `webhooks/types.ts`: verdicts `browser_origin` and `not_json`.
- `webhooks/engine.ts`: `refuseNonLocal` after the loopback peer/listener check on a
  `none-localhost-only` route: `Origin` present -> 403 `browser_origin` (detail: the Origin, clipped
  to 100); a forwarding header (`forwarded`, `x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`,
  `true-client-ip`) -> 403 `not_loopback` (detail names the header, never its value); media type
  not `application/json` -> 403 `not_json`. A body that does not parse is 403 `not_json` on a loopback
  route and stays 400 `bad_body` on a signed one.
- One file at a time: engine.test.ts exit 0 (34/34), signature.test.ts exit 0 (16/16),
  config.test.ts exit 0 (8/8).
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/webhooks packages/trent-core/src/gateway/WebhookServer.test.ts`
  -> exit 0, 6 files, 70 tests.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/config` -> exit 0, 14 files,
  75 tests: the schema-split snapshot test passes unchanged, so neither `schema-split.input.json`
  nor the snapshot was touched and `regen-snapshot.mjs` was not run.

## Tunnel recipe: what was and was not run (02:28-02:33 local)
- `which cloudflared ngrok autossh` -> none installed. `cloudflared tunnel --url http://127.0.0.1:8644`
  was NOT run. sshd answers on 127.0.0.1:22, but an `ssh -R` rehearsal would need a login to a host,
  so it was not attempted either.
- Run instead, from the scratchpad (not committed): the real listener (`openWebhookRoutes`, the call
  `trent gateway start` makes) on 127.0.0.1:8644 with an `hmac-sha256-ts` route `acme`
  (`secret_env: ACME_WEBHOOK_SECRET`) and a `none-localhost-only` route `local`, and a runner that
  yields run_start/run_done and reaches no model; plus a Node proxy on 127.0.0.1:8645 standing in
  for the tunnel's connector (forwards to :8644, adds `X-Forwarded-For` and `CF-Connecting-IP` as
  cloudflared does). The secret was `openssl rand -hex 32` in the script's environment, never printed.
  The doc's signing step (`printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac ... | sed 's/^.* //'`
  and the `curl`) ran verbatim with `BASE=http://127.0.0.1:8645`. `rehearse.sh` exit 0:
  1 signed fresh via proxy 202; 2 same again 200 replay (same run id); 3 other secret 401;
  4 signed 301 s ago 401 (`x-webhook-signature timestamp is 301s from this host's clock (tolerance 300s)`);
  5 inline `t=,v1=` 202; 6 loopback route through the proxy 403 (`not_loopback`, forwarded
  (x-forwarded-for)); 7 direct with `Origin: https://evil.test` 403 (`browser_origin`); 8 direct
  `text/plain` 403 (`not_json`); 9 direct JSON from a local script 202. `grep -c` of the secret in the
  delivery store, the listener log and the proxy log: 0, 0, 0. Ports 8644/8645 free afterwards.
- The first run showed the header form's mismatch detail labelled by the timestamp header
  (`x-trent-timestamp: no signature matches`); fixed to name the signature header, with the
  timestamp format checked first (`x-trent-timestamp is not unix seconds`); signature.test.ts
  re-run exit 0 (16/16), rehearsal re-run exit 0 with the same nine answers.

## docs/webhooks.md
- New section "A tunnel in front of the listener": the cloudflared quick-tunnel commands, what the
  tunnel exposes (every path, so only signed routes; a raw `ssh -R` forward cannot be told from a
  local script), an `hmac-sha256-ts` route and test sender, and exactly what was and was not run.
- Touch-ups so existing lines stay true: the scheme list in the YAML comment, an `hmac-sha256-ts`
  bullet and the replay caveat on `hmac-sha256` in "Order of checks", the loopback bullet's new
  403s, step 4's 403, and the two new verdicts plus the `Origin` detail in "The delivery store".

## Verification, final (02:34 local; after the last code change)
- Every hunk in an existing file carries `// [C8]`: `git diff -U0` 28 hunks and `-U3` 20 hunks, 0
  unmarked (two single-line hunks got an inline marker after the first check found them).
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/webhooks packages/trent-core/src/gateway/WebhookServer.test.ts`
  -> exit 0, 6 files, 70 tests (60 before: +4 engine, +5 signature, +1 config).
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/config` -> exit 0, 14 files,
  75 tests. Note: C3 edited `config/sections/governance.ts` and `schema-split.snapshot.json`
  (`max_class`) at 02:30, concurrently; this run includes their state and is green.
- `cd packages/trent-core && npm run build` -> exit 0, 0 `error TS`.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0, 0 errors.
- `node scripts/ci/repo-scan.mjs` -> exit 0 (canned, hex, emoji: PASS).
- Largest touched file: `webhooks/engine.test.ts` 413 lines; `engine.ts` 339; all under 500.

## Open, for other owners
- `docs/configuration.md:762-766` still lists four schemes and calls `tolerance_seconds` Stripe's
  and `signature_header` hmac-sha256's; it is outside this item's files. It needs
  `hmac-sha256-ts`, `timestamp_header`, and the loopback route's JSON-only rule.
- The forwarding-header refusal is beyond the brief (recorded above, with its own test). Drop the
  test and `FORWARDING_HEADERS` if the lead rules it out; the doc's tunnel section then needs its
  second bullet rewritten to "never keep a loopback route on a tunnelled listener".
- C8's Accept line (a signed LINE POST through `gateway start`, forged 401, Origin 403, 301 s 401)
  and the live proof through a real tunnel are not done here: they need cloudflared (or a host for
  `ssh -R`) and LINE credentials.
