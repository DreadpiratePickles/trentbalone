# SEC-2 — verifiable offline mode: implementation spec

Date 2026-09-26. Finalizes wave SEC-2 of `security-hardening-plan-2026-09-26.md` after the Fable
review (`security-hardening-review-2026-09-26.md`, required changes 3–6) and confirmation that the
shipped artefact is a **Bun-compiled binary** (`scripts/build/bundle-js.sh:7-9`, `build-cli.sh:18`;
`bun build --compile`, no Node fallback). Evidence: `security-offline-completeness-2026-09-26.md`.

## The crux: why a Node dispatcher guard is wrong
Every outbound module defaults to the platform global `fetch`
(`model-gateway/openai-compat.ts:212`, `anthropic-client.ts`, `fleet-memory/embedder.ts`,
`tools/social/publish.ts:56`, `gateway/platforms/*`, `connect/flow.ts`, `tools/mcp/http-oauth.ts`,
`traces/OTelExporter.ts`, `updater/release.ts`). Under Bun, `setGlobalDispatcher`/`ProxyAgent`
(undici) does not intercept Bun's native fetch, and a `node:net`/`node:tls` connect hook is not
guaranteed to sit under Bun's fetch either. So the chokepoint must be **Trent's own code**, not a
runtime interceptor. This is runtime-agnostic by construction and testable under Bun.

## Design

### 1. `egress/offline.ts` — the mode + the address rule
- `isOffline(): boolean` reads `TRENT_OFFLINE` (truthy = on). The switch is **one-way**: set in
  `apps/cli/src/env-defaults.ts` so it is inherited by every child run (delegate, cron, gateway),
  and **never lowered by config** — config may turn offline ON, never OFF (Fable change 4). A run
  started offline stays offline for its whole tree.
- `class EgressBlocked extends Error` with the attempted host and the reason.
- `assertLocalTarget(url: string | URL, allow?: {baseUrls: string[]}): void` — resolves the target;
  throws `EgressBlocked` unless the host is loopback (`127.0.0.0/8`, `::1`, `localhost`) or exactly
  one of the configured local base URLs. Reuses the SSRF classifier already in
  `tools/web/url-safety.ts` (loopback/RFC1918/link-local detection) rather than a second copy.

### 2. `egress/dial.ts` — the one chokepoint
- `export const trentFetch: FetchLike` = `(url, init) => { if (isOffline()) assertLocalTarget(url, …); return platformFetch(url, init); }`.
- Every module that today writes `fetchImpl ?? ((u,i)=>fetch(u,i))` changes its fallback to
  `fetchImpl ?? trentFetch`. Test seams (explicit `fetchImpl`) are unchanged — tests still inject.
- Subprocess/native network (a `curl` in the sandbox, faster-whisper's Python HF download, a
  launched browser) cannot be caught by `trentFetch`; those are handled by tool gates in §4.

### 3. `egress/registry.ts` — the enumerated surface + coverage test
- A static array: `{ id, module, dials: "trentFetch"|"proxy"|"subprocess"|"socket", defaultEnabled,
  offlineGate: "loopback-only"|"disabled"|"cached-only"|"config-rejected" }` covering every path in
  `security-offline-completeness-2026-09-26.md` §1 table.
- **Coverage test** (`egress/registry.test.ts`): a source-scan asserting every module that imports a
  fetch/socket/spawn primitive appears in the registry. A new network-capable module that is not
  registered **fails the test** — the allowlist cannot silently regress (O-09).

### 4. Config loader + tool gates (offline ⇒ …)
At config load, when offline (`config/sections/terminal.ts`, `config/defaults.ts`, wired at
`apps/cli/src/runtime/headless-wiring.ts`), reject with one actionable error each:
- a hosted model `provider`, a `models.escalate` target, a hosted `memory.embedder.provider`, a
  non-loopback `telemetry.otlp_endpoint`, and any enabled `gateway.platforms`/social route (O-01,
  O-04, O-05, O-08, O-10).
- Replace the effective `intercept_domains` with the **loopback-only** set (O-03).
- **No egress container and no LocalBackend "allowlisted" claim** (Fable change 5): offline means the
  egress sandbox network is not created; a run that needs network tooling says so honestly.
- Hosted escalation is `unavailable` *before* any approval row is created (O-04).
- Tool gates: `browser` disabled (launched Chromium is proxied+CA-pinned per `browser/launch.ts:59`,
  but attach-mode + UDP are not — so offline disables it and the doctor reports it; correct O-06's
  stated reason so the S5.6 "explain" text is true); faster-whisper refused unless the model is
  already cached, naming the cache path (O-07); whisper.cpp with a local model allowed.

### 5. The proof — `doctor/checks/offline.ts` + `trent security --offline`
- Prints each registry row as `blocked / loopback-only / OPEN`, with **per-row layer attribution**
  (which gate covers it) — Fable change 13. Allowlisted hosts that *were reached* are shown as
  reached, not hidden.
- Actively proves the guard: `trentFetch` dials a **canary literal `192.0.2.1` (RFC 5737 TEST-NET-1),
  never a hostname** (Fable change 6) and asserts `EgressBlocked`; CONNECTs `api.openai.com` to the
  proxy and asserts `403 host_not_allowlisted`.
- **Exits non-zero if offline is on and any row is OPEN.** Honest caveat surfaced: this proves the
  `trentFetch` + proxy paths and the disabled tools; it is not a kernel firewall.
- Runs under **Bun** in CI (the shipped runtime), not only Node (Fable change 3).

## Wave split (land in order, each isolate.sh green, explicit paths)
- **S2a-1** `offline.ts` (mode + `assertLocalTarget` + `EgressBlocked`), env-defaults one-way switch,
  unit tests incl. the one-way property and the inheritance-by-child property.
- **S2a-2** `dial.ts` + rewire each module's fallback to `trentFetch`; a per-module test that an
  offline dial to `192.0.2.1` throws `EgressBlocked` while a loopback dial passes.
- **S2a-3** config loader rejections + loopback-only allowlist + no-egress-container + escalation
  unavailable; snapshot regen for any new config key (`scripts/dev/regen-snapshot.mjs`).
- **S2b-1** `registry.ts` + coverage test.
- **S2b-2** tool gates (browser/faster-whisper) + `doctor/checks/offline.ts` + `trent security
  --offline`; the canary proof; run the S2 suite + the proof under Bun.

Default posture: OFF (Bobby's "opt-in everything"); enabled per run (`--offline` / `TRENT_OFFLINE=1`)
or by the `paranoid` preset (SEC-5). Nothing here changes online behavior unless offline is set.
