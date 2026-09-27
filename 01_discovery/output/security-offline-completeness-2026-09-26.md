# Offline-mode completeness audit — can Trent run fully offline, with nothing leaving the machine?

Date: 2026-09-26. Auditor pass, read-only. Scope: every code path that can open a socket to a
non-local host when the operator intends to run entirely on a local model. Repo:
`/Users/bobbymeher/Desktop/trent`, `packages/trent-core/src` unless noted.

## Bottom line

There is **no "offline" / airplane / isolation mode today** — the word does not exist as a switch
(grep for `offline|airplane|air-gap|isolation.mode` finds only doc prose and unrelated identifiers).
The egress proxy (`egress/EgressProxy.ts`) is a real deny-by-default, TLS-intercepting, token-gated
proxy — but it is **not a global chokepoint**. It only governs callers that opt in by calling
`createEgressFetch` (the tool layer: `web`, `business`, `vision`, `mcp` http transport, `a2a`,
`media` image). Everything else reaches the network through Node's global `fetch`/`node:http`/
`WebSocket` and never touches the proxy: the model gateway, the recall embedder, all gateway
messaging platforms, the social publishers, cron incident alerts, `trent connect` OAuth, MCP OAuth
login, the browser tool, faster-whisper model pulls, the OTel exporter and the updater. No
`setGlobalDispatcher`/`ProxyAgent` is installed anywhere, so nothing forces stray traffic through the
proxy. The proxy's own default allowlist (`intercept_domains`) is **cloud hosts**
(`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`), not localhost.

The good news: under a **local provider** the defaults are genuinely local — model calls, the
embedder, setup detection and the doctor all point only at `127.0.0.1`, hosted escalation is
approval-gated and off, the recall corpus never falls through to a hosted embedder, tracing is off
unless an endpoint is set, the updater is a manual command, no analytics/telemetry/license/catalog
call fires on its own, no `models.dev` fetch exists, and all state lives under `<profileDir>` on
local disk with no cloud sync. So a stock local profile that never enables the gateway, browser,
social or hosted media is *effectively* offline — but nothing **proves** it or **enforces** it. A
single misconfigured base URL, an enabled platform, or an approved escalation silently leaves the
machine, and the operator has no switch that makes those hard-fail and no check that certifies the
enumerated egress surface is localhost-only.

---

## 1. Every network-capable path

Clean = stays on `127.0.0.1`/`::1` or hard-fails without leaking when the operator intends offline.
Leaky = can reach a non-local host with no gate tied to an offline guarantee (may be off by default
or approval-gated, but no single switch stops it). Unknown = needs a live run to confirm.

| Path | file:line | Offline behavior today | Verdict |
|---|---|---|---|
| **Model calls** ||||
| Chat completion (OpenAI dialect) — every local + `openai`/`deepseek`/`groq` route | `model-gateway/openai-compat.ts:212,216` | Global `fetch` to `route.baseUrl`. Under a local alias the base is `http://127.0.0.1:11434/v1` etc. (`providers.ts:56,66`). **Not** through the proxy; nothing asserts the base is loopback. | Clean under local provider, config-dependent |
| Anthropic messages | `model-gateway/anthropic-client.ts:23,404,408` | Global `fetch` to `https://api.anthropic.com`. Unused under a local alias unless escalation names it. | Leaky if configured |
| Google-compat completion | `model-gateway/openai-compat.ts:32,112` | Global `fetch` to `generativelanguage.googleapis.com`. | Leaky if configured |
| Hosted escalation (planner/critic/step_failed) | `model-gateway/escalation.ts` (whole) | Off by default. When set, each call is held as a bound approval naming provider/model/byte-size/prompt-SHA and leaves only after `trent approvals approve`. Under a local alias only `google`/`anthropic`/`mistral`/`openrouter` reachable. | Leaky but human-gated |
| Local runtime probe / stream (ctx window, slots) | `model-gateway/local-probe.ts`, `local-runtime.ts:26-28` | `node:http` to the configured local base only. | Clean |
| **Embeddings & retrieval** ||||
| Local embedder (recall) | `fleet-memory/embedder-local.ts:57-59` | `127.0.0.1:11434`/`:1234`/`:8080`. | Clean |
| Auto/hosted embedder | `fleet-memory/embedder.ts:132,281,303` | A local chat alias **never** falls through to a hosted embedder — `localRouteFor` wins and the corpus "stays home" (`embedder.ts:281`, `embedder-local.ts:69`). Global `fetch`, not proxy. | Clean under local provider; Leaky only if `memory.embedder.provider` is explicitly `gemini`/`openai` |
| Rerank | reuses embedder route (`fleet-memory/`) | Same as embedder. | Clean under local provider |
| **Tools** ||||
| `web` / `web_extract` | `tools/web/index.ts` → `createEgressFetch` (`tools/web/proxied-fetch.ts`) | Through the proxy: deny-by-default + `intercept_domains` allowlist + token + SSRF floor. | Clean (bounded by allowlist) |
| `vision_analyze` URL fetch | `tools/vision/image-source.ts:88-91` | Through the proxy, or refuses with "configure the egress proxy, or pass a local image_path". | Clean |
| `business` HTTP adapters | `tools/business/http.ts`, `build.ts` → `createEgressFetch` | Through the proxy. | Clean (bounded by allowlist) |
| MCP remote (streamable-http/SSE) request transport | `tools/mcp/http-transport.ts` → `createEgressFetch` | Through the proxy. | Clean (bounded by allowlist) |
| `a2a` peer calls | `a2a/client.ts:5-7` | Production transport is the egress client (proxy); peer host must also be in `intercept_domains`. | Clean (bounded by allowlist) |
| `media` transcribe — whisper.cpp | `tools/media/transcribe.ts:5-6` | Local binary + local model file under `<profile>/models`. | Clean |
| `media` transcribe — faster-whisper | `tools/media/transcribe.ts:7-8` | Python lib **downloads the model from the network on first use**, outside the proxy. | Leaky (first use, uncached) |
| `media` transcribe — hosted | `tools/media/transcribe.ts:9-12` | Sends audio to the provider via the gateway. Off unless `media.hosted_transcription`; asks approval; doctor names it. | Leaky but gated + off |
| MCP OAuth login | `tools/mcp/http-oauth.ts:30-31` | Direct process `fetch` (issuer discovery, token). User action; redirect host pinned `127.0.0.1`. Bypasses proxy. | Leaky, user-initiated |
| `browser` tool | `tools/browser/launch.ts`, `session.ts` | Launches/attaches a real browser (CDP). The browser makes arbitrary requests **outside** the proxy. `createEgressFetch` only used for its own control fetches. | Leaky (full browser egress) |
| `delegate` / solo-route | `tools/delegate/`, `solo/delegate-route.ts` | Local process/model only ("cloud" hits are Ollama-cloud naming, not egress). | Clean |
| **Gateway / messaging** (all off unless `gateway.enabled`) ||||
| Slack/Telegram/Discord/WhatsApp/Signal/Matrix/Mattermost/LINE/ntfy/Teams/HomeAssistant/Email | `gateway/platforms/*.ts:*` — e.g. `slack.ts:59`, `discord.ts:61`, `telegram.ts:63` `globalThis.fetch.bind`; Slack socket-mode `WebSocket` `slack.ts:107`; IMAP/line raw sockets `email/imap.ts`, `email/lineSocket.ts` | Direct `fetch` / `WebSocket` / raw TCP to vendor hosts. **Never** through the proxy. `gateway.enabled=false`, `platforms=[]` by default (`config/defaults.ts:50-58`). | Leaky when enabled |
| Social publish (Bluesky, Buffer) | `tools/social/publish.ts:56` | Direct `fetch` to the platform / Buffer, bypasses proxy. Buffer even requires a public media URL. | Leaky when configured |
| Cron incident alert | `cron/CronRunner.ts:104-105,347` | Sends the `[CRON_FAILURE]` alert out the `gateway.owner` platform path (so, direct platform egress). | Leaky when cron + gateway configured |
| `trent connect` OAuth | `connect/flow.ts:92` | Direct `fetch` to the provider token endpoint. User action. Bypasses proxy. | Leaky, user-initiated |
| **Background / telemetry** ||||
| OTel/OTLP trace export | `traces/OTelExporter.ts:95,205`; wired only when set: `apps/cli/src/runtime/headless-wiring.ts:149-151` | Off unless `telemetry.otlp_endpoint`. Default endpoint `http://localhost:4318/v1/traces`; a remote endpoint would leave the machine. Direct `fetch`. | Clean by default; Leaky if endpoint set remote |
| Update check | `updater/release.ts:23-24` (github.com/api.github.com), `UpdateChecker.checkForUpdates` | Only from the manual `trent update` command (`apps/cli/src/commands/groups/maintenance.ts:19`). No auto/background/startup check found. | Clean (manual; egresses when invoked) |
| Analytics / crash / license / version ping | — | None found anywhere. | Clean |
| Model catalog / `models.dev` / provider_models cache | — | No `models.dev` reference in `packages`/`apps`; "catalog" refs are internal tool-search ranking, not network. | Clean |
| **Setup / doctor** ||||
| Setup runtime detection | `setup/local-detect.ts`, `setup/local-runtime.ts` | Probes only the local runtime URLs (Ollama/LM Studio/llama.cpp on loopback). `--dry-run` sends only GETs to those URLs. | Clean |
| Doctor connectivity | `doctor/checks/connectivity.ts:22-37` | For a local provider it probes the local URL and reports "no cloud host was resolved"; DNS lookup happens **only** for a hosted provider host. | Clean + honest for local |
| Doctor local-stream / embedder / local-model smoke | `doctor/checks/local-stream.ts`, `checks/embedder.ts`, `probe.ts` | Loopback only. | Clean |
| **Data residence** ||||
| Sessions, stores, memory, checkpoints, traces, audit, approvals | `checkpoints/ledger.ts:5-7`, `store/StorePort.ts:245`, `sessions/` | All under `<profileDir>` on local disk, `0600`/`0700`. No S3/GCS/cloud-sync/upload path exists. | Clean |

---

## 2. Gaps, ranked (O-nn) — each with a testable property and the files

**O-01 — There is no offline switch at all.** Nothing lets an operator declare "nothing may leave
this machine," so every "Leaky" row above is governed only by its own default or its own approval,
never by one intent.
*Property:* with `egress.offline: true` (new), a run refuses to open any socket whose resolved
address is not loopback (or the configured local base URL), from **any** code path, and the config
loader rejects a hosted `provider`, hosted `models.escalate`, hosted `memory.embedder.provider`,
non-loopback `telemetry.otlp_endpoint`, and any enabled `gateway.platforms`/social route with a
single actionable error.
*Files:* new `egress/offline.ts` (mode + address guard); `config/sections/terminal.ts` (schema),
`config/defaults.ts`; wired at `apps/cli/src/runtime/headless-wiring.ts`.

**O-02 — The egress proxy is not a global chokepoint.** Model gateway, embedder, gateway platforms,
social, connect, MCP-OAuth, browser, faster-whisper and OTel all use global `fetch`/`node:http`/
`WebSocket`; no `setGlobalDispatcher`/`ProxyAgent` pins Node's default dispatcher, so a new or
refactored caller silently bypasses the proxy.
*Property:* in offline mode a process-wide dispatcher/socket guard denies any connection to a
non-loopback address, so a direct `fetch("https://example.com")` from *any* module throws before a
packet is sent; a test that calls each direct-fetch module with offline on asserts a refusal.
*Files:* `egress/offline.ts` installing a global undici dispatcher + a `net`/`tls` `lookup`/connect
guard; import it once at every entrypoint (`apps/cli/src/index.ts`, service/gateway boot).

**O-03 — Default `intercept_domains` allows cloud hosts even under a local provider.** The proxy
ships allowing `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`
(`config/defaults.ts:42-46`, `config/sections/terminal.ts:34`), so tool egress to those is permitted
regardless of the model provider.
*Property:* offline mode replaces the effective allowlist with loopback-only; a proxy `/health` in
offline mode reports `interceptDomains` = the loopback set, and a CONNECT to `api.openai.com` returns
`403 host_not_allowlisted`.
*Files:* `egress/EgressProxy.ts:134-135,230` (allowlist source), `config/defaults.ts:42`.

**O-04 — Model calls are never asserted local.** `openai-compat.ts:216` / `anthropic-client.ts:408`
dial whatever `route.baseUrl` says; a local profile whose `OLLAMA_BASE_URL` was edited to a remote
host, or a `models.escalate`, leaves the machine with no offline block (escalation is approval-gated
but the approval still permits egress).
*Property:* in offline mode the gateway refuses to build a route whose base URL is not loopback, and
hosted escalation is `unavailable` before any approval row is created.
*Files:* `model-gateway/openai-compat.ts:212`, `anthropic-client.ts:404`, `escalation.ts`.

**O-05 — Gateway platforms, social publish and cron alerts bypass the proxy entirely.** Direct
`fetch`/`WebSocket`/raw TCP (`gateway/platforms/*`, `tools/social/publish.ts:56`,
`cron/CronRunner.ts:104`). Off by default, but nothing stops them once enabled while "offline."
*Property:* offline mode refuses to start the gateway/cron-alert/social path, or routes their
transport through the same guard so a non-loopback dial throws.
*Files:* `gateway/platforms/transport/http.ts` (shared `httpRequest`), `tools/social/publish.ts:56`,
`cron/CronRunner.ts:347`, gateway boot in `apps/cli/src/gateway/`.

**O-06 — The `browser` tool is unrestricted network egress.** A launched/attached browser makes
arbitrary requests outside the proxy (`tools/browser/launch.ts`, `session.ts`).
*Property:* offline mode disables the `browser` toolset (or launches it behind the proxy with a
loopback-only allowlist) and the doctor lists it as blocked.
*Files:* `tools/browser/launch.ts`, `tools/browser/index.ts`.

**O-07 — faster-whisper pulls models from the network outside the proxy.** First use downloads from
HuggingFace via the Python lib (`tools/media/transcribe.ts:7-8`).
*Property:* offline mode refuses the faster-whisper engine unless the model is already cached
locally, with an error naming the cache path; whisper.cpp with a local model file is allowed.
*Files:* `tools/media/transcribe.ts`, `tools/media/backend.ts`.

**O-08 — OTel exporter can post to a remote endpoint with no offline guard.**
`traces/OTelExporter.ts:95` honours `telemetry.otlp_endpoint`/`OTEL_EXPORTER_OTLP_ENDPOINT`.
*Property:* offline mode rejects a non-loopback `otlp_endpoint` at config load.
*Files:* `config/telemetry-schema.ts:9-14`, `apps/cli/src/runtime/headless-wiring.ts:149-151`.

**O-09 — The doctor has no offline-egress proof.** `doctor/checks/connectivity.ts` reports whether a
host resolves; it never enumerates the network-capable surface or asserts it is localhost-only.
*Property:* a `doctor`/`trent security` check enumerates every network-capable path (the table
above, as a static registry), reports each as blocked/loopback-only/open, and **fails** if any path
can reach a non-loopback host while offline mode is on.
*Files:* new `doctor/checks/offline.ts` + a static egress registry the check and the guard share.

**O-10 — Hosted embedder still reachable by explicit config.** If `memory.embedder.provider` is set
to `gemini`/`openai` the corpus is embedded off-machine (`fleet-memory/embedder.ts:303`), bypassing
the local-provider guard.
*Property:* offline mode forces the embedder to a local route or lexical-only and rejects an explicit
hosted embedder provider.
*Files:* `fleet-memory/embedder.ts:281-303`.

---

## 3. Spec — a verifiable "offline mode"

### 3.1 The switch
Add `egress.offline: boolean` (default `false`), settable by `trent setup --mode local --offline`
and by a top-level `--offline` launch flag. When on it is the highest-precedence egress rule; no
other setting can widen it. `setup --mode local` should offer to turn it on, since a local profile is
its natural home.

### 3.2 The single guarantee
> **When offline mode is on, the process may open a socket only to a loopback address
> (`127.0.0.1`, `::1`) or to the exact host:port of a configured local base URL. Every other egress —
> from any module, tool, platform, exporter or library — hard-fails before a byte leaves, with an
> error that names the path and the host it refused.**

Enforced in three layers so no single bypass defeats it:
1. **Config gate (fail fast, at load).** Reject, with one actionable message each: a non-loopback
   `provider` base URL; any `models.escalate`; a hosted `memory.embedder.provider`; a non-loopback
   `telemetry.otlp_endpoint`; any enabled `gateway.platforms` / social routes / hosted media; and
   collapse `egress.intercept_domains` to the loopback set. (O-03, O-04, O-05, O-08, O-10.)
2. **Process-wide socket guard (defense in depth).** Install one undici `setGlobalDispatcher` plus a
   `net`/`tls` connect/`lookup` hook at every entrypoint that, in offline mode, throws
   `EgressBlocked(host)` for any resolved non-loopback address. This catches the direct-`fetch`
   paths (model gateway, embedder, platforms, social, connect, MCP-OAuth, OTel, updater) and any
   future caller for free. (O-01, O-02.)
3. **Tool gates.** In offline mode disable `browser`, refuse faster-whisper unless cached, and keep
   the proxy allowlist loopback-only so the tool-layer `createEgressFetch` paths also refuse. (O-06,
   O-07.)

### 3.3 The check that proves it
A shared **static egress registry** (`egress/registry.ts`) lists every network-capable path in the
table above, each with: id, module, how it dials (proxy / global-fetch / socket / subprocess),
default-enabled, and the offline gate that covers it. Two consumers:

- **`doctor` / `trent security --offline`** prints the registry: for each path, `blocked` /
  `loopback-only` / `OPEN`. It **exits non-zero** if offline mode is on and any path is `OPEN`, and
  it actively proves the guard by attempting a dial to a canary non-loopback address through the
  global dispatcher and asserting the refusal, and by CONNECTing `api.openai.com` to the proxy and
  asserting `403`. It reports the effective `intercept_domains` (must equal the loopback set) and the
  configured local base URLs it treats as allowed.
- **A test** iterates the registry and, with offline mode on, drives each direct-fetch module
  (`openai-compat`, `anthropic-client`, `embedder`, one gateway platform, `social/publish`,
  `connect/flow`, `OTelExporter`, `updater/release`) against a non-loopback URL and asserts
  `EgressBlocked`; and drives each proxy path and asserts `403 host_not_allowlisted`. A new
  network-capable module that is not in the registry fails a coverage test — so the allowlist can
  never silently regress.

### 3.4 What already enforces this vs what is missing
- **Already enforced:** deny-by-default TLS proxy with token + SSRF floor and no-wildcard bind
  (`egress/EgressProxy.ts:79,230,326`); local provider → loopback base (`providers.ts:56`); recall
  never falls through to a hosted embedder under a local alias (`embedder.ts:281`); escalation off +
  approval-gated (`escalation.ts`); tracing off unless configured (`headless-wiring.ts:150`); updater
  manual only; hosted media off + approval-gated (`transcribe.ts:9-12`); doctor honest for local
  (`connectivity.ts:26-37`); all state on local disk (`checkpoints/ledger.ts:5-7`); no analytics /
  license / catalog / `models.dev` calls exist.
- **Missing:** the `egress.offline` switch (O-01); a process-wide dispatcher/socket guard so
  non-proxy callers cannot bypass (O-02); loopback-only allowlist in offline mode (O-03); a
  localhost assertion on model + embedder base URLs and an offline hard-block on escalation (O-04,
  O-10); offline gating of gateway/social/cron, browser and faster-whisper (O-05, O-06, O-07);
  offline rejection of a remote OTLP endpoint (O-08); and the enumerated registry + `doctor`/
  `security` proof check (O-09).
