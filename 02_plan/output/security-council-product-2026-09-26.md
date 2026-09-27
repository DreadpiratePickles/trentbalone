# Security wave — principal-engineer product review

Date 2026-09-26. Reviewer: principal-engineer pass over the security-fortress wave (SEC-1..SEC-5),
read-only. Scope: `docs/sessions/2026-09-26-security-fortress.md`, the hardening plan + trust-UX spec,
and the shipped code across `packages/trent-core/src/{egress,governance,tools,terminal,doctor,gateway}`
plus `apps/cli/src/commands/groups/{security,panic,mcp}.ts` and the docs.

Evidence run: `vitest run` over egress/offline, egress/registry (tree-walking coverage), egress/dial,
governance/hardline, governance/security-grade → **50/50 green** (registry coverage test really walks
`packages/trent-core/src` and holds it to the registry). The session log's final planned step — a full
clean-HEAD core+cli suite — is **not recorded as run**; that is the one open evidence gap (see R7).

---

## Verdict

This is a genuinely strong, architecture-first security wave, not theater. The differentiators are real
and enforced: a credential broker the agent never sees a key through, an L3 egress firewall (`--internal`
network + forwarder sidecar, fail-closed) that makes the flagship "cannot reach a host nobody allowlisted"
claim *true* rather than proxy-honor-only, unliftable hardline floors evaluated over deobfuscated command
variants, provenance taint on every off-machine source, and a **provable** offline mode with an enumerated
egress registry, a live canary dial, and a coverage test that breaks CI if the surface grows. Code quality
is high and consistent, the 500-line rule holds (only `tools/index.ts` at 497, deliberately refactored),
tests assert behavior not shapes, and the docs are honest — `docs/security.md` and `SECURITY.md` describe
what is and is not enforced without overclaiming. It is shippable as security-first for a technical early
audience **once** (a) the full suite is run green, (b) the `paranoid` preset ships so lockdown is one
command, (c) the per-run security receipt ships so the protection is *felt*, and (d) the founder cuts a
signed release and turns on GitHub private vuln reporting. The remaining deferred items are polish or
defense-in-depth, not blockers.

---

## 1. Completeness — deferred items, ranked by (value × feasibility)

Default posture note: the base default is already fairly hard — `egress.enabled: true`, sandbox
`backend: docker`, the L3 firewall is the default path for any networked sandbox run, `autonomy:
ask_dangerous`, stdio-MCP consent fail-closed, gateway off, browser off. "Opt-in everything" really only
leaves **offline**, **prompt redaction**, and the **paranoid bundle** off. So the deferred work is mostly
*surfacing* and *defense-in-depth*, not closing open holes.

| # | Deferred item | Value to "most secure product" | Effort | Finish now? |
|---|---|---|---|---|
| 1 | **S5.5 `trent security preset paranoid`** | High — the one-command answer to the opt-in-everything default; turns a scattered set of knobs into a legible "lock it down". Already hardline-blocked from tools, so operator-only by construction. | Medium (writes documented keys + prints diff; all knobs already honored) | **Yes — ship-blocker for the story** |
| 2 | **S5.2 per-run security receipt** | High — this is the actual "feel secure" payoff. After each run: hosts reached, attempts blocked (with rule id), secrets brokered-but-never-seen (count/provider), taint holds. All sources exist (`EgressProxy` events, `CredentialBroker`, `provenance`). | Medium (compose + render; no new enforcement) | **Yes — ship to credibly claim "feel secure"** |
| 3 | **PART-A DNS/IP pinning vs rebinding (online proxy)** | High for the *online* egress claim — offline already resolves-then-classifies and the L3 firewall constrains the sandbox, but the online proxy allowlist is hostname-based and a re-resolve between allow-check and connect is the classic rebinding window. | Medium (pin the resolved IP through to connect in `EgressProxy`/`dial`) | **Yes if online egress is a headline claim; else fast-follow** |
| 4 | **S5.6 explain-why-blocked + config diff** | Medium — inline "why + fix" on a refusal is real trust UX; structured refusals already carry reasons. Config diff over the signed audit chain is audit-grade nicety. | Medium | Fast-follow (explain first, diff later) |
| 5 | **S5.4 live egress ledger (`security egress --follow`)** | Medium — power-user window; the run-end receipt (#2) covers most of the need. | Low–Medium (subscriber over existing proxy events) | Polish |
| 6 | **PART-A SLSA / signed-build verification in updater** | Medium — signature verification (minisign Ed25519 + ECDSA P-256) **already exists** in installer/`trent update`/`release.yml`; SLSA build-provenance attestation is the delta. Bigger blocker is that no signed release is cut and the repo is private. | Low (attestation verify) but **founder-gated** | Founder cuts release first; SLSA is a later increment |
| 7 | **PART-A OS-keychain TokenStorePort** | Low–Medium — defense-in-depth for at-rest secrets; broker secrets already live in-memory + `.env` at 0600. Port is already abstracted (`egress/TokenStorePort.ts`), so a keychain impl slots in cleanly. | Medium (cross-platform keychain) | Polish / later round |

Ranked order to finish: **1, 2, 3** to credibly ship security-first; **4, 5, 6, 7** as polish/defense-in-depth.

---

## 2. Code quality of the new modules

Consistently high. Observations, with files:

- **Structure & the 500-line rule:** clean. Every new module has a purposeful header explaining the
  threat and the mechanism. `tools/index.ts` at 497 was deliberately split (commit `3be38cd`); nothing in
  the target dirs breaches 500.
- **`egress/offline.ts` + `dial.ts`:** the runtime-agnostic chokepoint is the right call — a Node/undici
  dispatcher guard would be a lie under the Bun-compiled binary, and the header says so. `isOffline` read
  at *call time* (not import) is correct and testable. One-way floor (`resolveOfflineMode`) is enforced
  and inherited by child runs. DNS-rebinding is handled by resolve-then-`classifyAddress`, sharing one
  loopback definition with the SSRF floor — no drift. Good.
- **`egress/registry.ts` + `registry.test.ts`:** the standout. A static enumerated surface + a coverage
  test that greps the real tree for network primitives and fails CI on an unregistered dialer, with a
  curated `KNOWN_NON_EGRESS` allowlist that is itself kept honest (each excused module must still exist
  *and* still flag). This is real behavior-asserting testing, not shape-matching.
- **`doctor/checks/offline.ts`:** proves the guard two ways — a live `192.0.2.1` canary through a
  forced-offline dial, plus `assertOfflineConfig` — and *demotes trentFetch rows to OPEN if the canary
  is not refused*. It fails closed and its honest caveat ("not a kernel firewall; a raw socket from a
  subprocess Trent did not spawn is out of reach") is surfaced in the output, not buried.
- **`governance/hardline.ts`:** thorough and well-reasoned; 25 tests (positive + negative each). Matches
  over deobfuscated variants, quote-masks prose rules so `git commit -m 'never rm -rf /'` is a commit.
  The `lower-trents-own-guardrails` rule (blocks a tool running `trent config set|hooks consent|mcp add|
  approvals approve|connect|security preset`) is exactly the Hermes H-X-02 class closed.
- **`governance/security-grade.ts`:** pure, total, documented rubric with named weights and monotonicity
  in the finding set. Good. **One honesty nit:** the `egressFirewall` input reads `config.egress.enabled`
  (proxy on/off) but is *named* "egress firewall" — proxy-honor is precisely what S1.1 proved is not a
  firewall. The grade does not check whether the L3 `--internal` firewall is actually buildable on the
  host (only `doctor` does). Rename to `egressProxy` and add an L3-firewall-available posture input so the
  grade cannot read "firewall on" when the host can't build one. (Low sev; naming/coverage, not a bug.)
- **`apps/cli/.../security.ts` + `panic.ts`:** cohesive. `panic` is honest about its own reach — it only
  signals processes that took a live profile writer/gateway lock and *says so* ("a bare run in another
  terminal takes no writer lock — stop it there with Ctrl+C") rather than pretending to kill everything.
  `security status` (grade, exits 0, read-only) vs `security audit` (exits 1 on findings, for CI) is a
  clean split. `--offline` forces the proof so an operator can certify before flipping the switch.

### Tech debt introduced (all acknowledged in the log; flagging for the record)
- **a2a over-taint compromise:** a2a is uniformly `inbound`-tainted (adapter-level), so `a2a_list`/
  `a2a_history` are also tainted → a *send after reading a peer* is held. Conservative and consistent
  with vision/media, but it is real friction; if a2a becomes a common path, move to entry-level taint.
- **Python forwarder relay (`terminal/egress-network.ts`):** a tiny stdlib TCP relay baked into the
  pinned sandbox image, `python3 -c` inline. It is `--cap-drop=ALL` + `no-new-privileges` + `pids-limit`
  and protocol-blind, so acceptable, but it is a bespoke network component with no unit test of the relay
  script's byte-pumping itself (only the argv builders are tested). Consider a socket-level integration
  test behind the docker gate, and pin/checksum the inline script.
- **MCP consent seam (`tools/mcp/client.ts` + CLI `mcp add`):** to scan and pin a stdio server's tool
  defs at `add` time, the server is spawned once under `mcpConsentAll()` *before* consent is recorded —
  i.e. the scan executes the very host code consent gates. Inherent to "inspect before trusting" and it
  is operator-initiated at their own terminal, but it means "consent before spawn" is really "consent
  before *reuse*"; the first spawn happens during add. Document this precisely in `docs/security.md`.

---

## 3. Product / UX — does the security story hang together?

Mostly yes, with two gaps that are the difference between *being* secure and *feeling* secure:

- **Onboarding into a secure posture:** the default already lands the user in a hard posture, but nothing
  tells them that. There is no first-run "you are at grade A; here is what protects you" moment. Add a
  one-line posture summary (grade + top protections) to setup/first-run, pointing at `trent security`.
- **Understanding what's protected:** `trent security status` (grade + backing checks) and `trent
  security audit` are excellent and honest. Good.
- **Recovering (panic):** `trent panic` is real and honest about its reach. Good. Consider a
  `--dry-run`-first hint in its own help so a nervous user previews before firing (the dry-run exists).
- **Proving offline:** `trent security --offline` + the doctor check are a genuine, verifiable proof with
  an honest caveat. This is a strong, demoable trust artifact. Good.
- **Missing for trustworthiness:** (a) the **per-run receipt** (S5.2) — the single biggest felt-security
  surface still absent; (b) the **paranoid preset** (S5.5) so "make me maximally safe" is one command;
  (c) inline **explain-why-blocked** (S5.6) so a refusal teaches rather than frustrates.
- **Disclosure surface:** `SECURITY.md` is a *real* policy (scope in/out, no-secret-in-report guidance,
  one-maintainer honesty), not a stub — good. But it depends on GitHub private vulnerability reporting
  being switched on (founder action) and the repo being public. There is **no `security.txt`** and **no
  security contact email** as a fallback channel. Add `.well-known/security.txt` when there is a web
  presence, and a contact of last resort in `SECURITY.md`.

---

## 4. Defaults — is opt-in-everything right?

Half-right, and undersold. The base default is *not* wide open: egress proxy on, docker sandbox + L3
firewall on the networked path, `ask_dangerous` autonomy, MCP consent fail-closed, gateway/browser off.
For a security-first product that is a defensible secure-by-default baseline. The problems are (1) the
genuinely-off protections that a security-first user would expect on, and (2) that the strong default is
invisible.

**Recommended concrete posture:**
- **Keep off by default (correct):** offline mode (would break online use), the messaging gateway.
- **Ship the `paranoid` preset (S5.5)** as the one-command lockdown: strictest autonomy, browser off,
  MCP consent required, egress firewall required (fail if unbuildable), prompt redaction on, offline
  offered per-run. This is the real answer to "opt-in everything" — one legible switch, not N knobs.
- **Reconsider prompt redaction default:** it is off by design and deliberately un-graded, but for a
  security-first product prompt it on at onboarding (or default-on with an easy off), rather than
  silent-off. At minimum surface its state at first run.
- **Surface the grade at onboarding** so "secure by default" is a thing the user *sees*, not a thing the
  code merely does.

---

## 5. Docs truthfulness and coverage

Honest and, for the shipped surface, complete.
- `docs/security.md` "Offline mode" accurately describes the three layers, the proof, the coverage test,
  and the *limits* ("not a kernel firewall"). File-permission and audit sections match the code. The
  "Not yet implemented" section is candid: signing keys/workflow exist but no tag is pushed and the repo
  is private, so release URLs would 404 — no overclaim. README/doctor counts were reconciled (38 commands,
  24 checks).
- `SECURITY.md` is a real disclosure policy. Gaps: no `security.txt`, no fallback contact, and it presumes
  a repo setting/publicity the founder controls.
- **Fix:** document the MCP consent-seam nuance (§2) precisely, and once #3 (rebinding) lands, tighten the
  online-egress wording; today "cannot reach a host nobody allowlisted" is fully true only for the L3
  sandbox path and the offline path — the online proxy is allowlist-honored-then-connect.

---

## 6. Ranked recommendations

### A. Finish to credibly ship as security-first
- **R1. Run the full core+cli suite green and record it.** The wave's own last step; no "done" without it
  (rulebook). *(evidence gap — see R7 detail below)*
- **R2. Ship S5.5 `trent security preset paranoid`/`standard`.** One-command lockdown; the answer to the
  opt-in default. Medium effort; knobs already honored; already tool-blocked.
- **R3. Ship S5.2 per-run security receipt.** The felt-security payoff; compose from existing
  `EgressProxy`/`CredentialBroker`/`provenance`. Medium effort, no new enforcement.
- **R4. Close DNS-rebinding on the online egress proxy (PART-A A8).** Pin the resolved IP from allow-check
  through connect in `EgressProxy`/`dial`, so the online firewall claim is true, not just the sandbox/
  offline paths. Then tighten the docs wording.

### B. Polish / defense-in-depth (fast-follow, not blockers)
- **R5. S5.6 explain-why-blocked** inline (reasons already exist) + **S5.4 live egress ledger**.
- **R6. Grade honesty:** rename `egressFirewall`→`egressProxy` and add an L3-firewall-available input in
  `security-grade.ts`; add a relay-script socket integration test + checksum the inline forwarder.
- **R7. Onboarding surfaces the posture grade;** add `security.txt` + a fallback contact to `SECURITY.md`;
  document the MCP consent-seam and the a2a over-taint compromise in `docs/security.md`.
- **R8. OS-keychain TokenStorePort** (A12) as a later defense-in-depth round; the port already abstracts it.

### Needs the founder (cannot be done in-repo by an agent)
- **Cut a signed release** (push a tag; `TRENT_MINISIGN_KEY` + `TRENT_ECDSA_KEY` repo secrets; make the
  repo/release URLs reachable) so the already-built verified-update path is actually exercised (T-12).
  SLSA provenance verification (A11) is a *later* increment on top of the existing signature verification.
- **Turn on GitHub private vulnerability reporting** so `SECURITY.md`'s primary channel works.
- **Commission an external audit / pentest** before making "provably secure" a public marketing claim —
  the in-repo proofs are strong but self-attested; a third-party review is what makes "provably" credible.
- **Decide the prompt-redaction and paranoid-by-default policy** (§4) — a product call, not a code call.
