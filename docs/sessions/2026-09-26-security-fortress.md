# 2026-09-26 — Security wave: Trent as Hermes's secure older brother, fully offline on local models

Session: Fable orchestrator (Claude Code desktop). Branch `feature/trent-fleet-v2`, HEAD `c7d50ae`.

## Bobby's asks (verbatim intent)
1. "make trent the much more secure older brother of hermes, look far and wide for possible exploits and
   ways hermes is vulnerable ... the utmost security and go beyond on how secure it makes the user feel"
2. (mid-turn) "very well integrated with using local models as well so people can run this tool
   completely offline"

## Method
ICM: 01 discovery (six Opus agents, read-only, no subagents) -> 02 plan (threat model + ranked
waves) -> Fable review -> waves, TDD, landed through scripts/dev/isolate.sh by explicit paths.
Hermes source is local and read-only: `~/.hermes/hermes-agent` (v0.21.3, upstream 49eb7b5d,
2026-09-20). Rule for every agent: never open or print `~/.hermes/auth.json`, `.env`, token or
key files — record where a secret lives, never its value.

## Discovery wave D (launched)
- D1 Hermes source audit: execution surface (terminal, code exec, file ops, sandboxes, approvals, browser)
- D2 Hermes source audit: gateway/platforms, API/web/desktop, MCP, plugins/skills hub, cron, memory, creds, updates
- D3 public record: Hermes advisories/issues + agent-harness incidents 2025-2026 (web)
- D4 Trent posture: every attack class mapped to Trent code, gaps named with file:line
- D5 SOTA defenses + "feel secure" UX (web)
- D6 offline completeness: every path that still touches the network under a local model
Outputs: `01_discovery/output/security-*-2026-09-26.md`.

## Discovery launched (six Opus agents, read-only)
- D1 exec surface (Hermes)      -> security-hermes-exec-2026-09-26.md
- D2 platform/supply chain (Hermes) -> security-hermes-platform-2026-09-26.md
- D3 public vuln record (web)    -> security-public-record-2026-09-26.md
- D4 Trent posture + gaps        -> security-trent-posture-2026-09-26.md
- D5 SOTA defenses + trust UX    -> security-sota-and-trustux-2026-09-26.md
- D6 offline completeness        -> security-offline-completeness-2026-09-26.md
First classifier stop on an offensively-phrased D2 brief; relaunched with defensive framing. Note:
mid-session the harness attribution reminder flipped to "Claude Opus 4.8" (was 5.5) — use whatever the
active reminder says at commit time.

## Next after discovery
Synthesize a threat model + ranked wave plan into 02_plan/output/security-hardening-plan-2026-09-26.md,
Fable review, then TDD waves through scripts/dev/isolate.sh. Anchor on Bobby's two goals: (1) strictly
more secure than Hermes on every attack class; (2) a verifiable, fully-offline local-model mode.

## Discovery results (5 of 6 in; D4 running)
- D1 exec (Hermes): 21 findings, 2 Critical / 7 High. execute_code no-approval on local backend;
  agent disables its own approvals mid-session; class-based always-approve over-grants; NO exfil/
  persistence rules in the command detector; Hermes home exempt from instruction-file gate -> persistence.
- D2 messaging (original, prompt truncated -> saved to security-hermes-messaging-2026-09-26.md): 3 Crit /
  4 High. Email From-parser spoof even with auth on; SimpleX identity spoof; unauth WhatsApp bridge;
  open admin slash-commands (/approvals off, /debug uploads logs).
- D2 platform (relaunch): unsigned `hermes update`; MCP trust defaults full; no untrusted boundary on
  webhook payloads; no provenance on memory. Core gateway IS default-deny (fair opponent).
- D3 public record: 27 must-defend properties, OWASP-LLM/ATLAS. Most Trent-relevant real incidents:
  unauth Ollama/llama.cpp on 0.0.0.0, and s1ngularity malware driving local agent CLIs.
- D5 SOTA + trust UX: most trust-UX primitives already exist in Trent; net-new = DNS/IP pinning,
  SLSA verify, OS-keychain token store, `trent panic`.
- D6 offline: NO offline mode exists as a switch; egress proxy is not a global chokepoint (Node default
  dispatcher unpinned). Fix = egress.offline in 3 layers + a proof check. Leaky paths ranked O-01..O-10.

Big cross-cutting theme: Hermes's whole model is approval-gate-and-scrub, and gates are bypassable;
Trent's differentiator is architectural (broker credentials, provenance/taint, deterministic gates,
egress chokepoint). The wave plan must (a) close Trent's own gaps first, (b) make the offline guarantee
real and provable, (c) surface it all so it FEELS secure.

## Design gate CLOSED (2026-09-26)
Bobby's decisions: (1) DEFAULT POSTURE = **opt-in everything** — ship all hardening but default to
today's behavior; strict set enabled via `trent security preset paranoid`. (2) Land **SEC-1 + SEC-2
first**, then continue autonomously.
Interpretation: friction/environment changes (egress firewall, offline mode, browser-off, MCP consent,
terminal cred read-block, control-file write-lock) are opt-in/preset, default off. Pure fixes where
today's behavior CONTRADICTS a printed guarantee (.git/hooks writable, vision/a2a untainted, social
raw fetch) are corrections, applied always — a lie in the docs is not a "posture" to opt into. Flagged
for Bobby; will correct if he disagrees.

## Fable design review = REVISE (02_plan/output/security-hardening-review-2026-09-26.md)
Findings verified (T-01/02/03/04/10, O-01/02). Two load-bearing corrections:
- **Shipped artifact is a Bun-compiled binary** (bundle-js.sh:7-9, build-cli.sh:18). A Node undici/net
  guard (my S2a) catches nothing under Bun and the S2b proof would falsely print "blocked". Fix:
  runtime-agnostic dial chokepoint `egress/dial.ts` + coverage test, run S2 tests + doctor proof under Bun.
- **S1.1 `--internal` is not "only proxy reachable"** (in-subnet gateway keeps 0.0.0.0 services reachable),
  may cut the container off from the proxy on Docker Desktop (Bobby's platform, unmeasured; Linux binds
  proxy to default bridge gateway bind-hosts.ts:52-56), ignores DNS while adapter.ts:40-41 routes
  dig/nslookup/host/ping/nc into the egress container. Fix: measured spike (Linux+Docker Desktop) FIRST;
  bind proxy to internal gateway or sidecar; --dns 127.0.0.1; enable_icc=false; wire/delete dead
  terminal.docker.network key; FAIL CLOSED when the firewall can't be built.
Overstated (correct down): T-09 (topmost-header is documented; forgery only when MTA writes no header),
O-06 (launched Chromium IS proxied+CA-pinned browser/launch.ts:59; gap is attach mode + UDP).
Other required changes: offline switch one-way via TRENT_OFFLINE=1 in env-defaults, inherited by child
runs, never lowered by config; offline => no egress container, no LocalBackend claim; canary = RFC 5737
literal no hostname; S1.2 widen to file_ops+hardline incl .git/config + core.hooksPath; pull control-file
lock (T-07) into SEC-1 + a self-lowering-config hardline rule (trent config set/hooks consent/mcp add),
re-rate T-07 High on LocalBackend; taint egress-run terminal output; S4.1 pin MCP tool-def hashes
(rug-pull), consent recorded by `trent mcp add`; doctor/receipt per-row layer attribution, show
allowlisted hosts as reached.

## SEC-1 landing
- 73b8435 S1.2 + S1.3 (deny .git tree writes; taint vision/media/a2a). isolate rc=0, 44 tests.
- S1.1 egress firewall: measured docker spike agent running (Docker Desktop platform) before code.
- S1.4 social egress: media_image is host-side (provider endpoint + user's own key, no model URL fetch,
  not an SSRF sink) -> defer/document; social uses raw fetch to bsky.social/buffer outside the proxy
  -> route through withOwnCredential(createEgressFetch) mirroring business/build.ts; social hosts must
  enter the egress allowlist (name where). Delegated to an Opus agent with a precise TDD brief.

## S1.1 firewall spike DONE (02_plan/output/security-egress-firewall-spike-2026-09-26.md)
Mechanism: per-seat `--internal` docker network + a minimal dual-homed forwarder sidecar (straddles
the internal net + a routable bridge, relays one port to the host proxy). Measured on this Docker
Desktop host: `--internal` alone -> host.docker.internal = 192.168.65.254 UNROUTABLE (Fable was right);
non-proxy IPs "Network unreachable"; external DNS SERVFAIL (DNS-over-UDP exfil closed for free).
Sandbox gets exactly ONE reachable L3 dest = the forwarder. Host proxy bind unchanged; only the
sandbox's --add-host host.docker.internal repoints at the forwarder's internal IP. FAIL CLOSED (no
egress container) if net/forwarder can't be built. Side finding: `terminal.docker.network` is a live
schema key but DEAD wiring (tools/index.ts:290 passes image only) -> wire it or delete it.
Implementable now; delegate to Opus after S1.4 lands (both reference tools/index.ts).

## Landings + in-flight (checkpoint)
Committed: 73b8435 S1.2+S1.3 (git-tree deny, vision/media/a2a taint); 1e6a4e2 S1.4 (social through the
egress proxy, bsky.social+api.buffer.com allowlisted); 3a38eb7 docs (audits, plan, review, specs);
5d2a84f S2a-1 (egress/offline.ts: one-way switch + loopback-only assertLocalTarget).
Follow-up chip spawned: createEgressFetch forwards only string bodies (Bluesky binary blob would send
empty) — task_79ee1e98.
In flight: S1.1 firewall (per-seat --internal net + forwarder sidecar, fail-closed) on sandbox.ts/
DockerBackend.ts/tools/index.ts; S2a-2 dial chokepoint (egress/dial.ts trentFetch + rewire ~9 direct-
fetch modules) on model-gateway/embedder/connect/traces/updater/cron.
Remaining SEC-2: S2a-3 config loader (offline rejects hosted provider/escalate/embedder/otlp/gateway,
loopback-only allowlist, no egress container, escalation unavailable); S2b-1 egress/registry.ts +
coverage test; S2b-2 doctor/checks/offline.ts + `trent security --offline` proof (RFC5737 canary) +
browser/faster-whisper gates, run under Bun. Then SEC-3 (floors), SEC-4 (mcp consent, email fail-closed),
SEC-5 (trust-UX surfaces).

## SEC-1 COMPLETE
- 73b8435 S1.2/S1.3, 1e6a4e2 S1.4, 5d2a84f S2a-1 (SEC-2 core), ba8d3a0 S1.1 firewall.
- S1.1 live-verified on this Docker Desktop host: 403-through-proxy holds; curl --noproxy 192.0.2.1
  Network unreachable. terminal.docker.network (dead key) deleted. All four SEC-1 gaps that
  contradicted printed guarantees are closed.
- S2a-2 dial agent still running (egress/dial.ts + egress/index.ts + rewiring model-gateway/embedder/
  connect/traces/updater/cron). Commit when it lands, then S2a-3 config loader.

## SEC-2a COMPLETE
- 5d2a84f S2a-1 (offline.ts: switch + loopback rule), f81190f S2a-2 (dial.ts chokepoint + ~15 modules
  rewired), 892805a S2a-3 (offline-config.ts + assertOfflineConfig wired into createHeadlessRuntime).
- Offline flags for S2b: updater/release.ts dials via node:https (needs config rejection or a socket
  gate — trentFetch can't wrap it); cron alert transport is injected deps.alert (confirm wiring);
  no-egress-container + loopback-only proxy allowlist + escalation-unavailable are runtime gates for S2b.
- Next: S2b-1 egress/registry.ts + coverage test; S2b-2 doctor/checks/offline.ts + `trent security
  --offline` proof (RFC5737 192.0.2.1 canary) + browser/faster-whisper offline gates, run under Bun.
  Delegated to an Opus agent.

## SEC-3 landing (defense-in-depth floors)
- 1d880a3 SEC-3a hardline: read-external-credentials (T-05, ~/.aws etc.), write-to-trent-secrets
  broadened to control files (T-07: config.yaml/hooks-consent.json/gateway.json/approvals-audit.ndjson/
  idempotency.json), new lower-trents-own-guardrails rule (the Hermes H-X-02 class: refuses `trent
  config set|hooks consent|mcp add|approvals approve|connect|security preset` from a tool). docs table
  update held for the docs reconciliation pass (S2b agent may also touch docs/security.md).
- SEC-3b approval-floors (T-06, isolating): interpreter -c/-e payload extraction + shell-exec-call arg
  extraction (os.system/system/execSync/subprocess.*) so `python3 -c 'os.system("rm -rf ~")'` and
  `perl -e 'system("rm -rf /etc")'` hit the floor; new hardline pattern for rmtree(expanduser("~"))/
  rmtree("/"). 238 governance/approval tests green locally.
- T-10 sandbox --memory limit: deferred until S2b lands (S2b edits sandbox.ts).
Uncommitted in tree: my docs/security.md hardline-table edit (to fold into docs reconciliation).
S2b agent (registry + doctor offline proof + browser/whisper/updater gates) still running.

## SEC-2 COMPLETE (offline mode, provable)
- c6d9719 SEC-3b interpreter payloads; e68d799 S2b (registry 33 rows + coverage test, doctor/checks/
  offline.ts + `trent security --offline` proof dialing RFC5737 192.0.2.1, browser/whisper/updater/
  sandbox offline gates). Bun-proven: trentFetch refuses 192.0.2.1 under Bun's native fetch (bun 1.4.2).
- SEC-4 agent (MCP consent T-08 + email fail-closed T-09) still running on mcp/email (disjoint).
- Now unblocked: T-10 sandbox --memory cap (sandbox.ts committed); SEC-5 trust-UX (security.ts committed;
  spec at 02_plan/output/security-trust-ux-spec-2026-09-26.md).
- Docs reconciliation still pending: my SEC-3 hardline-table rows in docs/security.md (uncommitted, survived
  — S2b did not touch docs), plus offline-mode docs. Do in a docs pass near the end.

## SEC-4 + T-10 landed; two concurrent-wave regressions handled
- 985c6b7 T-10 sandbox --memory 2g. d7c6be0 SEC-4-A MCP consent-before-spawn + tool-def pin.
  a34ea3a SEC-4-B email fail-closed without authserv_id.
- Regression 1 (a2a/registration): my SEC-1 T-03 (a2a in UNTRUSTED_ADAPTERS) made classifyCall tag
  every a2a call `inbound` (adapterProvenance is adapter-level). DECISION: keep a2a uniformly untrusted
  (conservative, consistent with vision/media; a peer is another agent) and update the registration
  test to expect the inbound tags. a2a_list/history now also inbound = minor safe friction (a send
  after reading a peer is held). Committed as its own fix (isolating).
- Regression 2 (docs-truth "23 checks"): S2b added a 24th doctor check (checkOffline). Fix = docs 23->24
  in README.md + docs/doctor.md. DEFERRED to the docs reconciliation pass (README is being edited by the
  SEC-5 agent for `trent panic`); docs-truth stays red until then, fixed before final verification.
- SEC-5 agent (posture card + grade, trent panic) still running.

## SEC-5 landed + docs reconciled
- 04442a8 S5.1 posture card + letter grade (`trent security status`), 6877632 S5.3 `trent panic`.
- a932be7 a2a test fix; 8c22cba hardline docs; e28a014 docs reconcile (README 38/160 commands, 24
  doctor checks + row, docs/security.md "Offline mode" section).
- Deferred (not built): S5.5 paranoid preset (`trent security preset`), S5.2 receipt, S5.4 egress
  ledger, S5.6 explain/diff — follow-ups; the hardline rule already pre-blocks `security preset`.
- Next: full clean-HEAD core+cli suite; then AGENTS.md defect status, memory, report.

## 500-line ceiling fix + LLM Council convened
- 3be38cd: extracted browser wiring into tools/browser/build.ts (tools/index.ts had hit 512 lines from
  the social+browser wiring; now 497). The sole full-suite failure. tsc/build fix: build.ts config param
  typed BrowserAttachConfigSource (ToolBuildConfig satisfies it), not TrentConfig.
- Bobby: push, log, continuation prompt, finish deferred security, AND run Karpathy's LLM Council to
  critique + make binding decisions to make it provably secure.
- Council (4 Opus reviewers, read-only -> 02_plan/output/security-council-*-2026-09-26.md): redteam
  (senior cybersecurity consultant), architect (defense-in-depth), verification (proven vs asserted +
  the proof harness), product (completeness/shippability/defaults). Then Fable chair synthesis -> ranked
  decisions -> autonomous implementation. Full core+cli suite re-running (b8waeaosv) before push.

## PUSH BLOCKED on Bobby's credentials
`git push origin feature/trent-fleet-v2` fails: gh here is account `getshitonltd` which lacks write to
DreadpiratePickles/trentbalone (403); the DreadpiratePickles token is in the macOS keychain this
non-interactive session can't unlock. 20 commits (c7d50ae..3be38cd) ready. Bobby pushes from his own
terminal: `git push origin feature/trent-fleet-v2`. Remote URL restored to the original DreadpiratePickles@ form.
Full clean-HEAD suite on 3be38cd: 563 files / 5226 passed / 10 skipped, tsc/build/scan 0; the exit=1 was
a vitest-worker onTaskUpdate RPC timeout under concurrent-agent load, not a test failure.

## LLM Council round 2 (4 Opus reviewers -> chair verdict)
Reviews: 02_plan/output/security-council-{redteam,architect,verification,product}-2026-09-26.md.
Verdict + ranked decisions: 02_plan/output/security-council-verdict-2026-09-26.md. Consensus: strong
architecture, NOT yet "provably secure" — fix claims-stronger-than-code + replace enumerated-sample
proofs with real/adversarial ones. Framing dialed to "defense-in-depth with stated residuals" until
D1-D10 land. Wave 1 dispatched (Opus, disjoint files): D1 DNS-egress truthfulness (egress-network/docs),
D5+D6+D17 real offline proof + bare-fetch coverage + grade honesty (registry/dial/doctor/security),
D2 panic revokes brokered egress tokens (TokenManager/panic). Added .well-known/security.txt (RFC 9116);
SECURITY.md was already a real policy. Wave 2 queued: D8 floor fuzz+fast-check, D9/D11 provenance
property + taint terminal/file reads, D12 cred denylist, then surfacing (D15 preset, D16 receipt).
