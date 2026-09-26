# 2026-09-26 — C4: secrets stay put (redirects strip credentials; the model cannot read Trent's keys)

Agent: C4 (one Opus worker, no subagents). Branch `feature/trent-fleet-v2`, HEAD 0d73850, built on
the working tree as it stands (C1 egress host binding and other waves present, unlanded). Every hunk
in an existing file carries `// [C4]`. No commit, stash, checkout, reset or push. No secret read or
printed: every credential in a test is a fake literal.

## Scope (from the lead; council verdict section C4)

1. `tools/web/proxied-fetch.ts` honours `redirect: "error"` (throws on a 3xx with a Location) and
   `redirect: "manual"` (returns the 3xx). For `follow` (default) a cross-origin hop drops
   `authorization`, `cookie`, `x-trent-proxy-token`, `x-trent-own-credential`, `proxy-authorization`
   and the body (POST becomes GET for 301/302/303 as fetch does); same-origin hops keep them; at most
   5 hops. `tools/mcp/http-transport.ts` uses this shared rule instead of its private copy.
2. `governance/hardline.ts`: the READ rule also refuses `keys/audit.key` (any `*.key` under `keys/`),
   `egress/ca.key` and `egress/tokens.json` under `~/.trent` or the profile dir, same refusal shape
   as `.env`.

Edit set: `tools/web/proxied-fetch.ts` (+ tests), `tools/mcp/http-transport.ts` (+ tests),
`governance/hardline.ts` (+ tests), `a2a/client.ts` only if needed, this log. Not docs/security.md,
not README, not egress/**, not files with `[L1]`/`[H5]`/`[P3]`/`[S3]` markers.

## Findings before code

- `proxied-fetch.ts:190-203` loops on any 3xx with a Location, ignoring `init.redirect`, and resends
  the same `method`, `headers` and `body` to the new URL. `a2a/client.ts:181` already passes
  `redirect: "error"`; no change is needed there, the transport simply ignores it.
- The proxy token cannot be dropped from the transport's own request to the proxy: the proxy's gate
  answers 407 without it (`egress/EgressProxy.ts:333-336`), and the broker strips it before any
  upstream (`CredentialBroker.ts:32,114`). So on a cross-origin hop the CALLER's credential headers
  (the list above, plus `x-api-key`/`x-goog-api-key`, which the broker also treats as token headers,
  `CredentialBroker.ts:13`) are dropped, and the transport sends the own-credential marker to the
  proxy on that hop so the broker writes no record secret into a request to a host the caller never
  named. Dropping the caller's own-credential marker WITHOUT that would turn an A2A hop into "inject
  the model key here" for any host the record is bound to (pre-C1: every host).
- `http-transport.ts:35-47` (`allowedHop`, `redirectTarget`) is the MCP's private copy of "which hop
  keeps the credential" and "is this a redirect". `docs/mcp.md:175` documents the same-host https
  upgrade as allowed, so the shared rule keeps that case.
- The hardline context already carries `profileDir` (`hardline.ts:30-35`), so the read rule anchors
  under `~/.trent` or the profile dir exactly as `.env` does. The egress default dir is
  `~/.trent/egress` (`CertificateAuthority.ts:40`, `TokenManager.ts:44`); the audit key is
  `<profile>/keys/audit.key` (`audit/signing.ts:18-19`). A terminal action reaches the rule through
  `subjectsOfAction` (`autonomy-dispatch.ts:88`), whose command path matches any command naming the
  path, as for `.env`. The rule id `read-trent-env-or-ssh-keys` is kept (docs/security.md:312 and
  `tools/autonomy-wiring.test.ts:79` name it); only its reason text grows.

## Log

### Hardline read rule (done)

- RED: `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/governance/hardline.test.ts`
  -> exit 1, 1 failed / 19 passed: "7b ... fires on a terminal cat of <profile>/keys/audit.key ..."
  `AssertionError: expected undefined to be 'read-trent-env-or-ssh-keys'` (hardline.test.ts:157, the
  terminal action `cat <profile>/keys/audit.key` through `subjectsOfAction` got no hit).
- FIX: `hardline.ts` `isTrentKeyMaterial` (a `*.key` whose parent dir is `keys` or `egress`, or
  `egress/tokens.json`) joins `.env` inside `isTrentReadTarget`; same anchor (`~/.trent` or the
  profile dir), same rule id, reason text names the keys.
- GREEN: same command -> exit 0, 20 passed.
- Known limit (unchanged shape, shared with `.env`): a glob (`cat keys/*`) or a relative path after
  `cd` is not matched; the hardline is a guardrail, the sandbox is the boundary (hardline.ts:5-9).

### proxied-fetch redirect rule

- New test `tools/web/proxied-fetch.test.ts`: two recording origins on loopback behind a REAL
  EgressProxy (http forward path, `upstreamOverrides`), a recording forward proxy for the exact wire,
  and pure cases for the shared rule.
- RED: `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/web/proxied-fetch.test.ts`
  -> exit 1, 7 failed / 2 passed:
  - cross-origin 302: `expected [ 'POST /landing' ] to deeply equal [ 'GET /landing' ]` (the POST,
    its bearer and body were re-sent to the second origin);
  - `redirect: "error"`: `promise resolved "Response { status: 200 ..." instead of rejecting`;
  - `redirect: "manual"`: `expected 200 to be 302`;
  - cross-origin 307 with a body: resolved instead of rejecting;
  - stripped hop wire: `expected 'POST' to be 'GET'`;
  - shared rule: `nextRedirectHop` / `keepsCredentials` `is not a function` (API not there yet).
  The two passing today are regression guards: same-origin 307 keeps credential+body; 5-hop cap.
- FIX: `proxied-fetch.ts` gains the shared rule: `MAX_REDIRECTS` (5), `CROSS_ORIGIN_DROPPED_HEADERS`
  (the lead's five plus `x-api-key`/`x-goog-api-key`), `redirectTarget`, `keepsCredentials` (same
  origin or same-host http->https upgrade, the rule docs/mcp.md:175 already documents),
  `nextRedirectHop` (fetch's 301/302/303 method rewrite; cross-origin drops credentials and body; a
  cross-origin 307/308 that must re-send a body is refused rather than sent bodiless), and
  `redirectRefusal` (the SSRF floor). `createEgressFetch` honours `init.redirect` and, on a stripped
  hop, adds the own-credential marker to the request to the proxy (token still sent: the gate needs it).
- GREEN: same command -> exit 0, 9 passed.
- MCP: `http-transport.ts` deletes `allowedHop` and its `redirectTarget` (and the
  `RedirectBlockedError` catch that only existed because the base ignored `redirect: "manual"`) and
  uses `redirectTarget`/`keepsCredentials`/`redirectRefusal`. Refactor under green: added a guard to
  `http-egress.test.ts` (same-origin 307 loop through the real proxy keeps the bearer on the MCP host
  and stops at "redirected more than 3 times"); it is not a red (the old path reached the same result
  through the catch). `npx vitest run packages/trent-core/src/tools/mcp/http-egress.test.ts` -> exit 0, 4 passed.

### A2A: the peer's bearer never reaches the redirect target

- `a2a/client.ts` unchanged: it already passes `redirect: "error"` (`:181`); the transport now honours it.
- New test `a2a/client-redirect.test.ts`: the peer behind a REAL EgressProxy answers 302 to a second
  allowlisted origin; transport is `createEgressFetch` with the own-credential marker, as
  `tools/a2a/build.ts` builds it.
- RED, watched against the HEAD transport: my `proxied-fetch.ts` copied to the scratchpad, the HEAD
  blob written over it with `git show HEAD:<path> > <path>` (a file copy, no checkout), the test run,
  my version copied back and `cmp`-verified identical.
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/a2a/client-redirect.test.ts`
  -> exit 1, 1 failed: `expected [ Array(1) ] to deeply equal []` (the redirect target received the
  request, `third.seen.map(authorization)`).
- GREEN (restored transport): same command -> exit 0, 1 passed.

## Verification (each run alone; the machine is loaded)

| Command | Exit | Result |
|---|---|---|
| `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/web` | 0 | 2 files, 20 tests |
| `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/mcp` | 0 | 5 files, 48 tests |
| `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/governance` | 0 | 17 files, 213 tests |
| `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/a2a` | 0 | 9 files, 63 tests |
| consumers: `tools/a2a`, `tools/business/egress.test.ts`, `tools/autonomy-wiring.test.ts` | 0 | 5 files, 30 tests |
| consumers: `tools/vision/vision.test.ts` | 0 | 8 tests |
| `cd packages/trent-core && npm run build` | 0 | (rerun after the last comment edit: 0) |
| `npx tsc --noEmit -p apps/cli/tsconfig.json` | 0 | |
| `node scripts/ci/repo-scan.mjs` | 0 | 1252 files, 0 violations |

Every hunk in an existing file carries `[C4]` (checked per `git diff -U3` hunk). Largest file touched:
`proxied-fetch.ts` 307 lines.

## Files changed

- `packages/trent-core/src/tools/web/proxied-fetch.ts` (shared redirect rule; `redirect` honoured)
- `packages/trent-core/src/tools/web/proxied-fetch.test.ts` (new)
- `packages/trent-core/src/tools/mcp/http-transport.ts` (private rule deleted; shared rule used)
- `packages/trent-core/src/tools/mcp/http-egress.test.ts` (same-origin guard)
- `packages/trent-core/src/governance/hardline.ts` (read rule covers Trent's keys)
- `packages/trent-core/src/governance/hardline.test.ts` (7b)
- `packages/trent-core/src/a2a/client-redirect.test.ts` (new)
- `docs/sessions/2026-09-26-c4-secrets-stay-put.md` (this log)
- `a2a/client.ts` NOT changed (it already asked for `redirect: "error"`).

## For the lead

- docs/security.md (lead's): the `read-trent-env-or-ssh-keys` row (docs/security.md:312) now also
  refuses `keys/*.key` and `egress/ca.key`/`egress/tokens.json` under `~/.trent` or the profile.
- Behaviour changes to note: a cross-origin 307/308 that would re-send a body is refused (not sent
  bodiless); a stripped hop carries the own-credential marker to the proxy; the same-host
  http->https upgrade keeps credentials (MCP's documented rule, now the shared one); OAuth
  `probeChallenge` via the egress fetch no longer follows a 3xx (it asked for `manual` already).
- Hardline limit, unchanged in shape and shared with `.env`: globs and `cd`-relative spellings.
