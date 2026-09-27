# 2026-09-26 — SEC-4: two independent hardening fixes (T-08, T-09)

Delegated implementation slice. TDD, red test first. No commit/push (orchestrator commits).

## Fix A — T-08: consent-before-spawn for stdio MCP servers

Problem: an stdio MCP server is arbitrary host code. `StdioClientTransport` spawns the configured
command the moment a connect begins, and the install-time safety scan ran only *after* connecting.

Change (mirrors `hooks/consent.ts`):
- New `packages/trent-core/src/tools/mcp/consent.ts`: `mcp-consent.json` (mode 0600) in the profile
  dir, holding hashes only. `mcpLaunchSpecHash(name, config)` (name + transport + command/args or
  url), `mcpToolDefHash(tools)` (order-independent hash of each tool's name/description/inputSchema).
  `fileConsentGate(profileDir)`, `grantMcpConsent`, `revokeMcpConsent`, `mcpConsentAll()` seam.
- `client.ts`: `connectMcpServer` now resolves a consent gate (explicit `deps.consent`, else the
  profile file gate, else "nothing consented"). stdio REFUSES before the spawn seam runs when the
  launch spec is not consented. A `deps.stdioTransport` factory seam makes the spawn assertable.
  `enforceToolPin` (both transports) re-lists tools after connect and refuses on a hash mismatch
  (rug-pull defense).
- CLI `mcp add` records consent + pins the tool-def hash (the explicit operator step); `mcp remove`
  drops it silently; `mcp add`/`mcp test` connect through the `mcpConsentAll()` seam (operator-run).
- Existing core tests (`scan.test.ts`, `mcp.test.ts`) pre-consent via the seam.

Property proven: no recorded consent ⇒ no spawn; recorded consent ⇒ connects; changed tool defs ⇒
refused. Runtime (`tools/index.ts` → `createMcpAdapter`) honours the profile file gate.

## Fix B — T-09: email sender-auth fails closed without authserv_id

Per Fable review (change 12): do not add an undecidable per-mail heuristic; fail closed at config
time. `checkSenderAuth` (auth-results.ts) is unchanged.

Change (`gateway/platforms/email.ts`): `resolveSenderAuthPolicy` returns `off` /
`pinned(authservId)` / `fail-closed(reason)`. `require_authenticated_from` true + `authserv_id`
unset ⇒ fail-closed: every inbound mail is refused with a reason naming `authserv_id`, and `start()`
logs it once. `authserv_id` set ⇒ unchanged. `require_authenticated_from: false` ⇒ unchanged. This
is now the safe default (require defaults true, authserv_id has no default).

## Verification

- `npx vitest run packages/trent-core/src/tools/mcp` → 53 passed.
- `npx vitest run packages/trent-core/src/gateway/platforms/email` → 34 passed.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` → exit 0. `npm --prefix packages/trent-core run build` → exit 0.
- No config key added ⇒ no schema-split snapshot regen (consent is a profile file, not config.yaml).

Pre-existing/concurrent failures (NOT from this slice; in other agents' owned files): docs-truth
doctor "23 checks" and `trent security preset` (doctor/**, docs/security.md); `tools/a2a` and
`tools/sandbox.egress-firewall` (egress capability-model changes).
