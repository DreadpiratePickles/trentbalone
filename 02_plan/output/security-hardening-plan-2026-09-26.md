# Security hardening plan — Trent as Hermes's secure older brother, offline-first

Date 2026-09-26. Author: orchestrator synthesis over the D1–D6 discovery wave
(`01_discovery/output/security-*-2026-09-26.md`). Status: **DESIGN GATE — awaiting Bobby**.

Bobby's ask, verbatim intent: (1) "make trent the much more secure older brother of hermes … the
utmost security and go beyond on how secure it makes the user *feel*"; (2) "very well integrated with
using local models … so people can run this tool completely offline."

This plan translates that into (A) a threat model that shows where Trent already beats Hermes and
where it does not yet, (B) ranked TDD waves that close every Trent gap and make the offline guarantee
real *and provable*, and (C) a "feel-secure" trust-UX layer composed over real enforcement — no
theater. Every wave lands through `scripts/dev/isolate.sh`, red test first, explicit-file staging.
`apps/web/**` is READ ONLY: app-side findings are report-only.

---

## 1. Threat model — Trent vs Hermes, by attack class

Hermes's security model is **approve-then-scrub**: an approval gate in front of tools, plus
process-boundary environment scrubbing. Discovery found that model has many bypasses (D1: 2 Critical
/ 7 High; D2: 3 Critical / 4 High), and Hermes's own `SECURITY.md` declares approval-bypass and prompt
injection out of scope — so they will not be fixed upstream. Trent's model is **architectural**:
broker credentials so agent code never holds a key, contain execution, taint untrusted content,
gate side effects deterministically with unliftable floors, and (new) make egress physically
impossible outside an allowlist. That is a difference in *kind*.

| Class | Hermes (worst finding) | Trent today | After this plan |
|---|---|---|---|
| Command / interpreter exec | `execute_code` no-approval on local backend (H-X-01, Crit); agent turns off its own approvals mid-session (H-X-02, Crit); no exfil/persistence rules; `c=rm;$c -rf /` beats the floor | Unliftable floors, argv-only exec, deobfuscator (NFKC/env/`sh -c`); floors can't be disabled by the agent | + interpreter-payload extraction (T-06); floors already unliftable — Trent wins decisively |
| Sandbox / egress firewall | `docker-compose` `network_mode: host` — no isolation | `--network none` default; **egress container on default bridge → allowlist is proxy-honor-only** (T-01, High) | + `--internal` egress network: non-allowlisted host is *unreachable*, not "proxy-refused". The docs' headline claim becomes true |
| File / persistence | file tools write `~/.zshenv`, `.git/hooks`, Hermes home exempt from instruction gate → persistence (H-X-04/05/09, High) | realpath confinement, `.env`/`.ssh`/`.aws` denied; **`.git/hooks/` writable** (T-02, High); **own control files writable** (T-07) | + deny `.git/hooks/*` and all `~/.trent` control-plane files. Trent wins |
| Indirect prompt injection | no untrusted boundary on webhook/HA/memory content (H-P-03/04) | provenance taint + held memory/skill writes for web/browser/mcp/inbound; **vision/media/a2a untainted** (T-03, High) | + taint vision/media/a2a. Trent has a real quarantine boundary Hermes lacks |
| Data exfiltration | markdown/tool channels, no egress control | redaction boundary, secret-in-URL block; **social/media raw fetch** (T-04); firewall gap (T-01) | + route social/media through proxy+SSRF floor; + firewall. Closed |
| Credential handling | env-scrub only; `/debug` uploads logs to a paste site (H-P/H2) | **credential broker: agent code never sees a real key** (host-bound opaque token) | unchanged — already a category Hermes has no equivalent for |
| Supply chain | unsigned `hermes update` (H-P-01); MCP trust defaults `full` (H-P-02) | plugins are data-not-code, MCP scanned; **stdio MCP = unverified host exec, scan is post-connect** (T-08) | + consent-before-spawn (hash-recorded) for stdio MCP. Signed release is Bobby's step |
| Gateway auth | email From-parser spoof even with auth on (C1, Crit); SimpleX/HA/A2A identity spoof; open admin slash-cmds | 8-char CSPRNG pairing, TTL+lockout, default-deny, webhook HMAC constant-time; **email forgeable w/o `authserv_id`** (T-09) | + email fail-closed without `authserv_id`. Trent already far ahead on pairing/binds |
| Approval / autonomy | `smart` mode auto-approves via a helper LLM; class-based always-approve over-grants (H-X-06/07) | **fail-closed, floors unliftable, bound-approvals per {run,step,tool,args}, durable** | unchanged — Trent's one Strong-rated class; the model to beat |
| Offline / data residence | n/a (cloud-oriented) | local-model mode works by *defaults*; **no enforced/provable offline mode**; proxy not a global chokepoint (O-01/O-02) | + real `egress.offline` + process-wide guard + a proof check. New capability, and the headline of goal (2) |
| Update integrity | unsigned | verify code exists, **no release cut** (T-12, report-only) | Bobby's step (tag + keys) |
| Secret in logs | `/debug` upload | CLI redactor unified; **app seat-error log unredacted** (T-11, report-only) | reported to app owner (AGENTS.md defect 8) |

**Bottom line:** Trent is already materially stronger on every class. This plan closes the four gaps
that undercut the *promises Trent already prints* (T-01, T-02, T-03, and the offline guarantee),
hardens the defense-in-depth floors, and makes all of it legible so it *feels* as safe as it is.

---

## 2. Waves (ranked; TDD; isolate.sh; explicit paths)

Ordering rule: fix the gaps that contradict a claim Trent already makes first (highest "feel-safe"
damage), then the offline guarantee (goal 2), then defense-in-depth, supply chain, and finally the
trust-UX surfaces that expose it all. Each item names a **testable property** = the red test written
first. `[report-only]` items are written up for Bobby, not coded here.

### Wave SEC-1 — Make the promises true (High) 
The four findings that most undercut "feel safe" because the docs already claim otherwise.
- **S1.1 (T-01) Egress network is a real firewall.** Create the egress sandbox network `--internal`
  (or an nftables egress policy) so the only reachable route is the proxy endpoint; drop broad
  `host-gateway`. *Property:* a command using `--noproxy '*'` or a direct-to-IP dial to a
  non-allowlisted host **fails to connect** (not "proxy refused"). Files: `tools/sandbox.ts`,
  `terminal/DockerBackend.ts`, new `ensureEgressNetwork`.
- **S1.2 (T-02) Deny `.git/hooks/*` writes.** *Property:* `resolveWorkspacePath(...,"write")` under
  `.git/` throws `PathPolicyError`. Files: `tools/file_ops/paths.ts`.
- **S1.3 (T-03) Taint vision/media/a2a.** Add to `UNTRUSTED_ADAPTERS`. *Property:* `ask_vision` →
  `memory_add` in one step returns `needs_approval` and tags the entry untrusted, mirroring
  `web_extract`. Files: `governance/provenance.ts`, `runtime/*.memory-gate.test.ts`.
- **S1.4 (T-04) Route social/media through proxy + SSRF floor.** *Property:* social/media adapters
  use `createEgressFetch`/`checkUrlSafety` and refuse when egress is absent (like `web`). Files:
  `tools/index.ts`, `tools/social/publish.ts`, `tools/social/build*`.

### Wave SEC-2 — Verifiable offline mode (goal 2; largest wave, split in two)
A single `egress.offline` intent enforced in three layers with a proof check (D6 §3). This is the
"run completely offline" capability and its receipt.
- **S2a — the switch + the global chokepoint.**
  - New `egress/offline.ts`: mode flag + a **process-wide guard** — install a global undici
    dispatcher and a `net`/`tls` connect/lookup guard so *any* module's `fetch`/socket to a
    non-loopback address throws before a packet leaves (O-02). Imported once at every entrypoint.
  - Config loader (`config/sections/terminal.ts`, `config/defaults.ts`) rejects, with one actionable
    error, a hosted `provider`, `models.escalate`, hosted `memory.embedder.provider`, non-loopback
    `telemetry.otlp_endpoint`, and enabled gateway/social routes when offline (O-01, O-04, O-08, O-10).
  - Offline replaces the effective `intercept_domains` with loopback-only (O-03); hosted escalation is
    `unavailable` before any approval row (O-04). *Property:* a direct `fetch("https://example.com")`
    from any module throws `EgressBlocked` in offline mode; a CONNECT to `api.openai.com` → `403`.
- **S2b — the registry, the proof, the tool gates.**
  - New `egress/registry.ts`: a static list of every network-capable path (module, dial mechanism,
    default-enabled, offline gate). A **coverage test** fails if a network-capable module is missing —
    the allowlist can never silently regress (O-09).
  - New `doctor/checks/offline.ts` + `trent security --offline`: prints each path as
    `blocked / loopback-only / OPEN`, **exits non-zero if any is OPEN while offline**, and *actively*
    dials a canary non-loopback address and asserts refusal. This is B11 — "prove nothing left this
    machine," with the honest caveat that it proves the proxied+guarded paths.
  - Tool gates: offline disables `browser` (O-06), refuses faster-whisper unless the model is cached
    (O-07), gates gateway/social/cron transports (O-05). Files per D6 gap list.

### Wave SEC-3 — Defense-in-depth floors (Medium/Low)
- **S3.1 (T-05)** Hardline read-block on `~/.aws`, `~/.config/gcloud`, `~/.netrc`,
  `~/.git-credentials`, `~/.npmrc`, `~/.docker/config.json` (file_ops parity). `hardline.ts`.
- **S3.2 (T-06)** Extract `python -c` / `node -e` / `perl -e` / `ruby -e` payloads into
  `detectionVariants` (depth-bounded like `sh -c`) so destructive spellings hit the floor.
  `tools/approval-floors.ts`.
- **S3.3 (T-07)** Write-protect Trent control-plane files (`config.yaml`, `hooks-consent.json`,
  `gateway.json`, `approvals-audit.ndjson`, `idempotency.json`) via a broadened
  `TRENT_CONTROL_FILES`. `governance/hardline.ts`.
- **S3.4 (T-10)** Default `--memory` limit on the sandbox. `tools/sandbox.ts`, `DockerBackend.ts`.

### Wave SEC-4 — Supply chain + gateway auth (Medium)
- **S4.1 (T-08)** Consent-before-spawn for stdio MCP servers: an explicit hash-recorded consent (like
  `trent hooks consent`) required before the command is spawned; refuse otherwise. `tools/mcp/client.ts`,
  `tools/mcp/config.ts`, `apps/cli/.../mcp add`.
- **S4.2 (T-09)** Email fail-closed without `authserv_id`: an inbound mail carrying a self-authored
  `Authentication-Results` header is refused, not trusted. `gateway/platforms/email/auth-results.ts`.

### Wave SEC-5 — The "feel-secure" trust-UX layer (composed over real enforcement)
Every feature maps to a primitive that already exists (D5 PART B verified against the tree), so it
ships as fact. Highest value first:
- **S5.1 `trent security` dashboard + posture letter grade** (B1) over `governance/security-audit.ts`
  + `doctor` + config; shows the exact checks behind the grade.
- **S5.2 Per-run "security receipt"** (B2): hosts reached, blocked attempts, secrets brokered-but-never-
  seen, taint holds — composed from `EgressProxy` events + `CredentialBroker` + provenance.
- **S5.3 `trent panic`** (B6): one umbrella that kills running work and revokes **all** pairings (today
  `gateway revoke` is per-sender). New batch revoke over `PairingManager`.
- **S5.4 Live egress ledger** (B3): `trent security egress --follow` tailing proxy decisions.
- **S5.5 "Paranoid mode" preset** (B8): `trent security preset paranoid` writes a bundle of knobs the
  gate chain already honors (offline optional, autonomy `ask_dangerous`→stricter, no browser, MCP
  consent required) — a preset, not a fake mode.
- **S5.6 "Explain why blocked"** (B4) + **security config diff** (B10) over structured refusals + audit.

### Report-only (Bobby / app owner)
- **T-11** app seat-error log unredacted + seat turns bypass prompt redaction (`apps/web`, READ ONLY) —
  report to app owner; already AGENTS.md defect 8.
- **T-12** cut a signed release (tag, keys, public URLs) so the verified-update path is exercised —
  Bobby's release step (`05_release/output/release-runbook.md`).

---

## 3. Decisions for the design gate (Bobby)

1. **Default posture.** Should the new hardening ship **on by default for new profiles** (strongest
   "feel-safe" signal, some added friction), or opt-in via `paranoid` preset? *Recommendation:*
   S1–S4 (gap closures) default ON — they close real holes with little friction and make printed
   claims true; **offline mode and browser-off default OFF** (opt-in per run/profile) since forcing
   them would break online use; `paranoid` preset bundles the strict set.
2. **Egress firewall (S1.1) rollout.** `--internal` network changes docker behavior. *Recommendation:*
   default ON for the egress backend, with `trent doctor` detecting and explaining if the host's
   docker can't create an internal network, and a clear one-line override.
3. **Scope confirm.** SEC-1 + SEC-2 first (they carry both of Bobby's goals), then SEC-3/4, then the
   UX wave? *Recommendation:* yes, in that order.

## 4. Method
`scripts/dev/isolate.sh` with `TRENT_DEV_SCRATCH` = session scratchpad; red test first, watch it fail
for the right reason, minimal green, commit by explicit paths; regenerate `schema-split.snapshot.json`
on any config-key commit; no push/deploy without authorization; secrets never in logs/commits.
Fable review of this plan before any code (design gate). Session log:
`docs/sessions/2026-09-26-security-fortress.md`.
