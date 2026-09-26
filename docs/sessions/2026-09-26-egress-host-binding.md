# 2026-09-26 — egress: bind a brokered secret to the host(s) it belongs to

Scope: the egress credential broker injects `record.realCredentials` into EVERY allowlisted request
that carries the proxy token, so a token minted with the model provider's key hands that key to any
other `egress.intercept_domains` host a sandboxed tool contacts (defect confirmed by the lead in
`egress/TokenStorePort.ts:12-21`, `egress/CredentialBroker.ts:79-112`, `egress/EgressProxy.ts:308`).
No subagents (lead's instruction). Edits limited to `packages/trent-core/src/egress/**`, the
token-minting callers, one paragraph of `docs/security.md`, and this log. Machine heavily loaded:
single test files / the egress directory only.

## Log (appended as I go)

- Read AGENTS.md, rulebook "Universal Coding Rules" and "Phase 4".
- Read every file in `packages/trent-core/src/egress/` and the tests.
- Minting sites (grep `\.issueToken(\|realCredentials\|new TokenManager` over
  `packages/trent-core/src` and `apps/cli/src`, excluding `egress/`):
  - PRODUCTION: `apps/cli/src/repl/tools.ts:163` `startEgressProxy` ->
    `tokenManager.issueToken("trent-repl", input.credentials ?? {}, "repl")`; the credentials come
    from `providerCredentials(config)` (`:193`), the key of `config.provider` from
    `process.env` (`PROVIDER_KEY_VARS`: openai, anthropic, google, mistral, openrouter).
    Reached from `apps/cli/src/runtime/headless.ts:280` (`wireTools`) for REPL and headless runs.
  - `apps/cli/src/commands/groups/servers.ts:311` (`trent egress start`) calls the same
    `startEgressProxy` with NO credentials: its token carries `{}`, so there is no secret to bind
    and no change is needed there (and `apps/cli/src/commands` is off limits).
  - Tests only: `tools/{a2a,business,mcp,web,terminal,browser}/*.test.ts` mint
    `{ apiKey: MODEL_KEY }` with no host. None asserts the key IS injected (they assert it is NOT
    sent to a peer/business/MCP host), so fail-closed legacy records keep them green.
- Evidence the defect is live, not theoretical: `tools/web/proxied-fetch.ts:149` sends the broker
  token as `x-trent-proxy-token` to the reader/search hosts (r.jina.ai, api.tavily.com), and
  `applyCredentials` then writes `Authorization: Bearer <model key>` onto those requests.
- Source of truth for "where a provider's model calls go": `doctor/endpoint.ts`
  `providerEndpoint(provider, env)` (mirrors `apps/web/lib/ai-client.ts:116,171-199` and the
  alias table in `model-gateway/providers.ts`, honouring `OPENAI_BASE_URL`, `GOOGLE_BASE_URL`,
  `MISTRAL_BASE_URL`, `OPENROUTER_BASE_URL` and the alias base URLs). Reused, not duplicated.
- Baseline before any edit: `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/egress`
  -> exit 0, 5 files, 42 tests.
- Coordinator evidence folded in (council verification): (1) `SandboxEnvironment.ts:27-41` puts the
  ONE token in OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY and all three
  provider hosts are on the default allowlist, so a Gemini profile's key reaches api.openai.com;
  (2) a search host (tavily/jina) allowlisted gets its caller's own Authorization stripped and the
  model key injected; (3) `tools/browser/session.ts:61` sets `x-trent-proxy-token` on every
  launched-browser request. Decision for (2): on the withheld path the broker removes ONLY what
  is its own (headers carrying the broker token, `x-trent-proxy-token`, proxy headers), the same
  rule as the P2-9 own-credential path, so a caller's own key passes without the marker. This
  grants the sandbox nothing new: it could already send the marker and get exactly this.
- Test changes that follow from the requirement change (unbound records inject nowhere), not to
  make an implementation pass: in `CredentialBroker.test.ts` the four existing injection tests now
  mint a record bound to the host they target; the three P2-9 own-credential tests now use a record
  BOUND to their target, so they still prove the marker (not the new fail-closed default) is what
  withholds the secret. `EgressProxy.test.ts` "completes an HTTPS request end to end" mints with
  `{ hosts: [ALLOWED_HOST] }`. Its recording upstream moved to `test-helpers.ts` (shared with the
  new e2e file rather than duplicated).
- RED 1: `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/egress/CredentialBroker.test.ts`
  -> exit 1, 12 failed / 17 passed. Every failure is the secret on an unbound host, e.g.
  "authorization: expected 'Bearer sk-real-secret-value' to be undefined" (A->B), "x-api-key:
  expected 'sk-real-secret-value' to be undefined" (Gemini-bound key to Anthropic), "expected
  'Bearer sk-real-secret-value' to be 'Bearer tvly-fake-caller-key'" (search key replaced),
  "expected [] to deeply equal [ { ... } ]" (no withheld report).
- RED 2: `... vitest run packages/trent-core/src/egress/provider-hosts.test.ts` (module stubbed to
  return [] so the red is an assertion) -> exit 1, 3 failed / 1 passed: "expected [] to deeply equal
  [ 'api.openai.com' ]", "[ 'llm-gateway.corp.example' ]", "[ '127.0.0.1:11434' ]".
- RED 3: `... vitest run packages/trent-core/src/egress/TokenManager.test.ts` -> exit 1, 4 failed /
  7 passed: "Invalid time value" (the options object read as a TTL: no way to bind hosts) and
  "\"*.openai.com\": expected [Function] to throw error matching /host/i".
- RED 4: `... vitest run packages/trent-core/src/egress/EgressProxy.host-binding.test.ts` -> exit 1,
  6 failed: five "Invalid time value" (as RED 3), and the legacy test failing on the leak itself over
  loopback: "authorization: expected 'Bearer fake-provider-key-for-host-bin...' to be undefined".
  Plan: land the mint side (TokenStorePort + TokenManager + binding validation) first, then re-run
  RED 4 so the bound cases fail on the key reaching the wrong host, then the broker + proxy.
- GREEN step 1 (mint side): `TokenStorePort.ts` `hosts?: string[]`; new `host-binding.ts`
  (`normalizeCredentialHosts`, `isHostBound`, `secretWithheldReason`); `TokenManager.issueToken`
  last argument is a TTL or `{ ttlSeconds, hosts }` (hosts validated before anything is stored).
  `... vitest run packages/trent-core/src/egress/TokenManager.test.ts` -> exit 0, 11 passed.
- RED 4 again, now failing on the leak itself: `... vitest run packages/trent-core/src/egress/EgressProxy.host-binding.test.ts`
  -> exit 1, 5 failed / 1 passed. A->B, Gemini->OpenAI, browser-style and legacy all
  "authorization: expected 'Bearer fake-provider-key-for-host-bin...' to be undefined"; search:
  "expected 'Bearer fake-provider-key-for-host-bin...' to be 'Bearer tvly-fake-caller-key'". The
  own-credential case passes (unchanged behaviour, as intended).
- Implementation step 2: `applyCredentials(headers, host, record, { port, onWithheld })` decides
  in the one function that can write a secret: withheld -> `ownCredential` stripping (only what
  carries the broker token + the broker's own headers) and a report; bound -> unchanged header
  conventions. `EgressProxy` passes `target.port`, takes `log?: (line) => void` (default stderr,
  like `CronRunner`), and writes ONE `egress.secret_withheld` warn line per (token, host:port)
  (bounded memory 1024), naming host, port, reason, boundHosts, agentId, toolset: never the
  secret or the token. `provider-hosts.ts` `credentialHostsForProvider` reuses
  `doctor/endpoint.ts` `providerEndpoint`, keeping an explicit URL port in the binding.
- GREEN (egress): `... vitest run packages/trent-core/src/egress/CredentialBroker.test.ts` -> exit 0,
  27 passed (first attempt failed to TRANSFORM: my parameter `target` shadowed an existing local;
  renamed `destination`). `.../EgressProxy.host-binding.test.ts` -> exit 0, 6 passed.
  `.../provider-hosts.test.ts` -> exit 0, 4 passed.
- Minting caller, RED: new `apps/cli/src/repl/__tests__/tools.egress-hosts.test.ts`;
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/repl/__tests__/tools.egress-hosts.test.ts`
  -> exit 1, 3 failed: "expected undefined to deeply equal [ 'generativelanguage.googleapis.com' ]"
  (wireTools input and minted record), "expected undefined to deeply equal [ '127.0.0.1:8000' ]".
  The key itself was already handed over (that assertion passed): the binding was what was missing.
- Minting caller, change (`apps/cli/src/repl/tools.ts`): `StartEgressInput.credentialHosts`;
  `wireTools` passes `credentialHostsForProvider(deps.config.provider, process.env)` next to
  `providerCredentials(deps.config)`; `startEgressProxy` mints with `{ hosts }` and stops the proxy
  if the mint throws (a refused binding must not leave a listener). GREEN: same command -> exit 0,
  3 passed. Regression: `... vitest run apps/cli/src/repl/__tests__/tools.test.ts` -> exit 0, 13 passed.
- Legacy-token tool tests, one file at a time (they mint `{ apiKey }` with no host):
  `packages/trent-core/src/tools/{business/egress,a2a/egress,mcp/egress,mcp/http-egress,web/web}.test.ts`
  -> each exit 0 (5, 3, 2, 3, 11 passed).
- Gates:
  - `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/egress` -> exit 0,
    7 files, 69 tests (baseline was 5 files, 42 tests).
  - `cd packages/trent-core && npm run build` -> exit 0.
  - `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
  - `node scripts/ci/repo-scan.mjs` -> exit 0 (1249 files; 3 PASS sections).
- `docs/security.md`: one paragraph under "### Tokens" (lines 65-76). NOTE for staging: the file
  also carries ANOTHER wave's uncommitted hunk near line 630 (auto-review "Limits, stated"); do not
  stage the whole file as part of this change without checking.

## Decisions and why
- Seam: the decision lives in `applyCredentials` (the one function that can write a secret), not
  only in the proxy, so no caller can bypass it; it takes `{ port, onWithheld }` so the proxy can
  log without the broker doing I/O. Binding rules are a separate pure module (`host-binding.ts`).
- Legacy records (no `hosts`) fail closed: injected nowhere, logged as `no_host_binding`. No legacy
  path needs an exception: the only production minter with a secret is the REPL/headless
  `startEgressProxy`, which re-mints per session into an ephemeral store; `trent egress start`
  (`commands/groups/servers.ts:311`) mints with NO credentials, so a durable token has no secret.
- Bindings may carry a port. Why beyond the lead's host-suffix design: a local runtime at
  127.0.0.1 shares that address with other allowlisted local services (the a2a egress test
  allowlists 127.0.0.1 for a peer), so `OPENAI_BASE_URL=http://127.0.0.1:8000/v1` binds
  `127.0.0.1:8000` only. Suffix matching is on a label boundary and never for IP literals.
- Withheld path strips like the own-credential path (caller's own key passes), per coordinator (2).
  The NO-secret path (record `{}`) is unchanged: it still strips every credential header. Not a
  leak; noted as a possible follow-up for tools that bring their own key via `trent egress start`.
- One withheld line per (token, host:port), bounded memory: a browser or web tool would otherwise
  write a line per request into the REPL's stderr.

## Left for the lead (outside my file scope) — none required
- `apps/cli/src/commands/groups/servers.ts:311`: no change needed (mints no credential).
- `packages/trent-core/src/tools/browser/session.ts:61`: no change needed; its token header is now
  stripped and nothing injected for any host the token is not bound to (covered by the
  browser-style e2e case in `egress/EgressProxy.host-binding.test.ts`).
- Optional hardening, not required by this defect: `SandboxEnvironment.ts` (inside egress/) could
  put the token only in the configured provider's key variable instead of all four
  (`DEFAULT_CREDENTIAL_ENV_NAMES`); left as is because binding already makes the other variables
  inert and narrowing changes what SDKs in the sandbox see.
