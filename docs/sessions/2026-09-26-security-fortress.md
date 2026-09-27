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
