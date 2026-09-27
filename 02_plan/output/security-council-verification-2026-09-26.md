# Security council — verification & proof review (SEC wave)

Date 2026-09-26. Reviewer role: verification & proof skeptic. Read-only except this file.
Scope: `docs/security.md`, the SEC session log, the offline + hardening specs, and the shipped tests
+ code named in the brief. Where a claim's test was outside the named set I say so rather than grade
it blind. Question answered: **what is genuinely proven, how strongly, and what would make each
security property continuously provable.**

Strength ladder used below: **unit** (pure function, injected deps) < **integration** (real
in-process server / real runtime build) < **live** (real container / real daemon in CI) <
**adversarial** (fuzz / property / red-team corpus). "Proven" means a named test fails if the
property breaks; "asserted" means the doc states it and nothing executable guards it.

---

## 1. Property inventory — proven vs asserted

| # | Security property (as the docs/code claim it) | Status | Strength | Evidence (test) |
|---|---|---|---|---|
| P1 | Egress proxy refuses a host outside `intercept_domains` at CONNECT (403) | **Proven** | integration + live (CI) | `egress/EgressProxy.test.ts:118,130`; empty list fails closed `:160,177`; runs in `.github/workflows/sandbox.yml` |
| P2 | Egress sandbox cannot reach a non-proxy host at L3 (raw/`--noproxy` dial unreachable) | **Proven** | live (CI, one canary) | `tools/terminal/terminal.test.ts:111` (real container, `curl --noproxy '*' 192.0.2.1` → unreachable), gated `skipIf(!dockerAvailable)` but **forced-on and skip-asserted** in `sandbox.yml` |
| P3 | Firewall builds fail-closed (no egress container on failure; no bridge fallback) | **Proven** | unit | `tools/sandbox.egress-firewall.test.ts:148,157,166,172` + `terminal/egress-network.ts` |
| P4 | Deny-by-default token swap: no upstream connection before allowlist + token both pass | **Partial** | integration | `egress/EgressProxy.test.ts` (403 paths) + `CredentialBroker.test.ts`; the "no upstream socket before both checks" ordering is asserted in prose, not isolated as its own negative test |
| P5 | Sandbox process never holds a real provider key (token-only env) | **Partial** | unit | `egress/CredentialBroker.test.ts:187` (token in the four key vars). The load-bearing claim — docker `--env` built **only** from `SandboxEnvironment.ts`, never `process.env` merged — has **no dedicated test** in the read set |
| P6 | Offline: `trentFetch` refuses any non-loopback dial before a socket opens | **Proven** | unit (under Bun) | `egress/dial.test.ts:31` (192.0.2.1 refused, 0 socket calls); call-time read `:54`; loopback passes `:38` |
| P7 | Offline address rule survives DNS rebinding (resolve-before-decide) | **Proven** | unit | `egress/offline.test.ts:49` (`rebind.evil`→off-box refused), LAN refused `:54` |
| P8 | Offline is one-way (config cannot lower an env-set offline) | **Proven** | unit | `egress/offline.test.ts:21-28` |
| P9 | Offline config front door rejects every hosted setting, naming each | **Proven** | unit | `egress/offline-config.test.ts` (provider, escalate, embedder, OTLP, gateway + fix strings) |
| P10 | The egress surface cannot grow unregistered | **Partial** | unit (static lint) | `egress/registry.test.ts:145` source-scans for network primitives. Catches new modules by **regex on import text**, not by runtime routing — an aliased/transitive dial evades it |
| P11 | Offline: "nothing leaves" as a whole-process guarantee | **Asserted** (per-module proven) | — | No runtime proof that every registered module actually routes through `trentFetch`. P6+P10 together are the closest; the wiring of each module is not asserted by any test |
| P12 | Destructive commands hit the hardline floor, over deobfuscated spellings | **Proven** | unit | `governance/hardline.test.ts` (positive+negative per rule) + `tools/approval-floors.test.ts` (backslash/`$IFS`/env/`sh -c`/interpreter payloads) |
| P13 | The floor cannot be spelled around (completeness) | **Asserted** (by design, disclosed) | — | Docs explicitly say "a command can always be spelled another way… read as 'not even once', never 'cannot happen'." No fuzz/property test bounds the miss rate |
| P14 | An agent cannot lower Trent's own guardrails via its CLI | **Proven** | unit | `governance/hardline.test.ts:209` (`trent config set`/`hooks consent`/`mcp add`/`approvals approve`/`security preset`) |
| P15 | Untrusted read → durable memory write is held; skill_manage refused | **Proven** | integration | `governance/provenance.test.ts` + real-runtime `runtime/headless.memory-gate.test.ts`, `runtime/solo-continuity.test.ts` |
| P16 | The untrusted→durable-write invariant holds for **arbitrary** tool graphs | **Asserted** | — | Provenance is an **enumerated adapter list** (`UNTRUSTED_ADAPTERS`) + fixed cases, not a property test over generated call sequences. A new untrusted adapter that forgets the scope is untagged |
| P17 | stdio MCP: consent-before-spawn + tool-def-hash pin (rug-pull) | **Proven** | integration | `tools/mcp/consent.test.ts` (real stdio fixture; spawn seam never reached without consent; hash mismatch refused) |
| P18 | Side-effect calls bound per `{run,step,tool,args}`; one yes ≠ another call | **Asserted here** | — | Docs cite `bound-approvals.test.ts`, `gate-chain.test.ts` — **not in the read set**; cannot grade, flag for a reader |
| P19 | Signed audit export / hash chain / tamper naming | **Asserted here** | — | Docs cite `security-audit.test.ts`; not in read set |
| P20 | Signed, reproducible release (SLSA-style) | **Not implemented** (honest) | — | Docs §"Not yet implemented": workflow exists, **no tag pushed, no release** |
| P21 | Posture letter grade reflects real config/files | **Proven** (as a pure function) | unit-gradeable | `governance/security-grade.ts` pure+total. But it grades **posture**, not enforcement — see §3 |

**Reading of the table:** the *containment* boundary (egress proxy allowlist + L3 firewall, P1–P3)
is the most strongly proven — real container, in CI, gated so a skip fails the job. The *offline*
guarantee is proven **per-module and per-primitive** (P6–P9) but its whole-process claim (P11) rests
on a static lint (P10), not runtime wiring. The *floor* and *provenance* families are proven for
their **enumerated** cases (P12, P15) but have **no adversarial or property-based** coverage (P13,
P16), which is exactly where an attacker operates.

---

## 2. Doc truthfulness — where the prose outruns the evidence

`docs/security.md` is, on balance, **unusually honest** — it self-discloses more than most security
docs: "This is a guardrail, not a sandbox," the two deliberate hardline gaps, the offline "not a
kernel firewall" caveat, seat turns bypassing prompt redaction, the release not cut, and the four
app-side defects it cannot fix. Grade for truthfulness: **B+**. The gaps are overreach of *verb*,
not fabrication.

Claims stronger than the evidence supports:

1. **Headline (line 3-4): "cannot reach a host nobody allowlisted."** True for the **docker egress
   backend** (P1–P3). But `LocalBackend` "runs commands on the host… is not a sandbox" (line 135),
   and the sentence sits at the top as *the* property of the page with no scope qualifier. A reader
   grades the whole product by it. Fix: qualify to "the egress sandbox cannot…".

2. **Offline "`trent security --offline` … prove it" (line 160).** The command runs the proof in
   `force: true` mode (`security.ts:280`), which swaps in `createForcedOfflineDial()` — a dial that
   **always** enforces loopback-only regardless of `TRENT_OFFLINE` (`dial.ts:62`). So the canary
   necessarily fails: it proves `assertLocalTarget` refuses `192.0.2.1`, **not** that the running
   process's modules are wired through the guard. This is closer to a self-test of one function than
   a proof of the surface. The doc's own caveat ("proves the trentFetch + proxy paths… not a kernel
   firewall") is honest, but the word "prove" oversells a partly circular check. See §3.

3. **"nothing may leave the machine" (line 141).** Whole-process framing; enforcement is per-module
   opt-in through `trentFetch`, guarded only by a regex source-scan (P10/P11). A subprocess Trent did
   not spawn, a native addon, or a module dialing through an unrecognised primitive is not covered —
   partly disclosed in the caveat, but the headline sentence is absolute.

4. **"A coverage test fails if a new network-capable module is added" (line 162).** True only for
   modules whose **source text** matches `NETWORK_SIGNALS` (`registry.test.ts:22`). A dial via a
   re-exported wrapper, a dynamic import, or a dependency's fetch is invisible to it. "Cannot grow
   silently" → "cannot grow with a *recognised* primitive silently."

Claims that are honest and well-scoped: the hardline "not even once, never cannot happen" framing
(line 366), the provenance "nothing here inspects the untrusted text for an instruction… the gate is
on the combination" (line 545), the auto-review "changes who reviews, not what is allowed" (line
637), and the whole "Reported, not fixed" section (line 761). These are model disclosures.

---

## 3. `trent security --offline` and the letter grade: evidence or theater?

**`trent security --offline` — mostly meaningful, one hollow core.**
- *Meaningful:* it runs `assertOfflineConfig` on the **actually loaded profile** (`offline.ts` proof
  §2, `security.ts:273`), so a hosted provider/embedder/escalation/OTLP/gateway that survived config
  load is a real OPEN row. That part inspects real state. The registry walk with per-row layer
  attribution is genuinely useful legibility.
- *Hollow:* the active "canary" is fired through `createForcedOfflineDial()`, which enforces the
  rule unconditionally. It can therefore **never** report the guard as broken due to a mis-wired
  module, because it does not dial through the modules — it dials through a freshly constructed
  guarded fetch. It proves the *predicate*, not the *wiring*. If every module secretly used raw
  `fetch`, this canary still turns green.

  **What would make it rigorous:** (a) fire the canary through **each registry row's own exported
  dial**, not a synthetic one — i.e. the proof imports the module's fetch seam and asserts *that*
  refuses; (b) additionally run a **live** variant (see §4b) that stands up a listener and asserts
  zero bytes arrive; (c) drop `force` for the real proof and instead relaunch the check under
  `TRENT_OFFLINE=1` so it tests the process as configured, keeping `force` only for the "preview
  before flipping the switch" affordance and labelling it as such.

**The letter grade — honest as a posture score, not a proof.** `security-grade.ts` is a pure, total,
documented-weight function (P21); a clean default scores 0 = A. That is fine *as a posture summary*.
The risk is **semantic**: an "A" grades whether knobs are set securely (egress on, sandbox not
local, a floor not lifted, hardline present), **not** whether enforcement actually holds. A profile
with a subtly bypassable floor still scores A. It is not theater, but it must never be quoted as
"proven secure." Recommend renaming the surface intent in docs to "posture grade," and adding a
single line that the grade is necessary-not-sufficient and points at `security audit --json` + the
verification suite for enforcement evidence.

---

## 4. The verification harness this product needs to say "secure"

Each item below is concrete: file, shape, and the property it pins. Ordered by proof value.

### (a) Adversarial / fuzz corpus for the hardline + approval floor
File: `packages/trent-core/src/governance/hardline.fuzz.test.ts` (+ a checked-in seed corpus
`governance/__fixtures__/floor-bypass-corpus.txt`).
- **Seed set** (concrete bypass spellings, each MUST still block `rm -rf /` / `rm -rf ~`): unicode
  homoglyphs (`ｒｍ`, `rｍ`), zero-width joiners inside `rm`, `r""m`/`r''m`, `r\m`, `${IFS}`/`$IFS`/`\t`
  separators, `$@`/`${x:-rm}` param expansion, `$(printf '\x72\x6d')`, base64 `echo cm0gLXJmIC8=|base64
  -d|sh`, nested `sh -c "$(printf ...)"` at depth 2-3, `xargs rm -rf`, `find / -delete`, `python3 -c`
  / `node -e` / `perl -e` / `ruby -e` / `awk 'BEGIN{system(...)}'` payloads, `eval` chains, locale
  tricks (`LANG=C`), and comment-mask decoys (`echo 'rm -rf /'`) that must **stay allowed**.
- **Property test** (fast-check): generate a destructive core command, apply a random stack of the
  above transforms (each individually reversible by `normaliseForDetection`), assert `floorBlock` is
  non-null; separately generate prose/quoted mentions and assert null (false-positive bound). This
  turns P13 from "asserted, by design" into "measured miss rate on a named transform algebra."
- Track a **coverage metric**: % of corpus lines blocked, printed by the test, so a regression is
  visible. Accept that completeness is unreachable — the value is a *published, monotone* bound.

### (b) Live network-egress integration test (no packet escapes) in CI
File: `packages/trent-core/src/egress/offline.live.test.ts`, added to the `sandbox.yml` suite list
(it already forces `TRENT_DOCKER_AVAILABLE=1` and asserts nothing skipped).
- **Shape:** stand up an in-process **sink listener** on a non-loopback-bound interface (or a
  throwaway container on the routable bridge) that records every TCP connect and every byte. Point a
  fixture module (one that uses `trentFetch` as its real fallback, plus one deliberately using raw
  `fetch` as a **negative control**) at the sink's address. Run under `TRENT_OFFLINE=1`. Assert: the
  `trentFetch` module produces **zero** connects at the sink; the raw-`fetch` control **does** reach
  it (proving the sink works and the guard is what stops the other). Extend the existing
  `terminal.test.ts:111` L3 test beyond one IP/one spelling: a table of {raw IP, UDP/53 DNS exfil,
  ICMP, a second RFC5737 literal, `nc`, `/dev/tcp`} all asserted unreachable.
- This is the test that lets the founder say "here is the command; the packet counter is zero."

### (c) Property-based provenance invariant
File: `packages/trent-core/src/governance/provenance.property.test.ts`.
- **Invariant:** *for any* generated sequence of tool calls ending in a durable write (`memory add`,
  `skill_manage`), if **any** prior call in the same step was tagged untrusted, the write's status is
  `needs_approval`/`blocked` and its summary names the untrusted source. Generator: random adapters
  drawn from a pool that mixes `UNTRUSTED_ADAPTERS` and trusted ones, random step boundaries, random
  write positions. This closes P16 (arbitrary graphs) rather than the current fixed cases.
- Add a **registration guard test**: every adapter built by `buildTrentTools` whose scope or tool
  family matches the inbound/web/mcp/plugin/vision/media/a2a families MUST be in `UNTRUSTED_ADAPTERS`
  — a static+runtime cross-check so a new untrusted adapter cannot ship untagged (the provenance
  analogue of the egress registry test, but checked at wrapper-build time, not by regex).

### (d) Signed / reproducible-build (SLSA) gate
Files: extend `.github/workflows/release.yml`; add `05_release/verify-provenance.test.ts` and a
`scripts/release/verify-slsa.mjs`.
- **Gate:** on tag, build twice on clean runners and assert **bit-identical** `SHA256SUMS`
  (reproducibility); generate SLSA provenance (`actions/attest-build-provenance`); the installer
  test verifies both the minisign (Ed25519) and ECDSA P-256 signatures **and** the provenance
  attestation before accepting an artifact. A CI job re-runs the installer's verify path against a
  **tampered** `SHA256SUMS` and asserts refusal (negative control). This converts P20 from "workflow
  exists, no release" into an exercised, gated path — but the tag push itself is the founder's call
  (§5).

### (e) Threat-model → test mapping (every threat has a named test)
File: `docs/security-threat-map.md` + an enforcing test `governance/threat-map.test.ts`.
- A checked-in table: `{ threat-id (T-01…T-12, O-01…O-10, the OWASP-LLM/ATLAS ids from D3), status,
  test-file::test-name }`. The enforcing test parses the table and asserts every row marked "covered"
  names a test file that **exists** and a test name that is **present** in that file (grep the source
  the way `registry.test.ts` scans). A threat with no named test, or a stale reference, fails CI.
  This makes coverage a **build artifact**, not a claim in a plan doc, and is the single highest-
  leverage addition for "prove the product is secure" because it makes every other gap *visible*.

---

## 5. External / third-party validation the founder must arrange (cannot be done in-repo)

1. **Independent penetration test / security audit** of the egress broker, the sandbox escape
   surface, and the offline guarantee. In-repo tests prove the properties the authors thought of;
   only an external red team probes the ones they didn't (P13/P16 are exactly this). Scope it to the
   containment boundary, not the app.
2. **SBOM + dependency provenance** (`cyclonedx`/`syft` in CI, published per release) and continuous
   advisory scanning (`osv-scanner`/Dependabot). The offline and egress guarantees assume no
   transitive dep opens its own socket; an SBOM + the (d) reproducible build make that auditable.
3. **Published `SECURITY.md` + coordinated disclosure policy** at the repo root (currently absent),
   naming a contact, a scope, and an SLA — and a `.well-known/security.txt` on any public endpoint.
   Hermes's `SECURITY.md` declaring injection out-of-scope is cited as a differentiator; Trent should
   ship the honest counterpart.
4. **Cut and sign a real release** (the founder-only step behind P20/(d)): push a tag, populate the
   `TRENT_MINISIGN_KEY` / `TRENT_ECDSA_KEY` secrets, make the repo/release URLs reachable so the
   verified-update path is exercised by real users, not only by tests.
5. **Third-party reproducible-build attestation** (an outside party rebuilds and matches the hash) —
   the credible version of "the binary you run is the source you audited."

---

## 6. Ranked: the smallest set that lets the founder say "here is the command that proves X"

Ordered by (proof value ÷ effort). Each is one file, implementable now.

1. **Live egress "zero packets" test** → `egress/offline.live.test.ts` in `sandbox.yml`. Proves the
   #1 marketing claim ("nothing leaves") at the strongest level, with a negative control. (§4b)
2. **De-circularise the offline proof** → change `security.ts` / `doctor/checks/offline.ts` to fire
   the canary through each registry row's **own** dial seam, not `createForcedOfflineDial`. Turns a
   self-test into a wiring proof. Small, high truth-value. (§3)
3. **Provenance property test** → `governance/provenance.property.test.ts` + the untrusted-adapter
   registration guard. Closes P16 across arbitrary tool graphs. (§4c)
4. **Hardline fuzz corpus + property test** → `governance/hardline.fuzz.test.ts` + seed corpus.
   Converts P13 into a measured, monotone miss-rate. (§4a)
5. **Threat-map enforcing test** → `governance/threat-map.test.ts` + `docs/security-threat-map.md`.
   Makes every T-/O-/OWASP threat name a real test or fail CI. Highest visibility-per-line. (§4e)
6. **`SandboxEnvironment` "no real key" test** → assert the docker `--env` argv is built **only**
   from `SandboxEnvironment.ts` output and that merging `process.env` is caught (a negative test that
   fails if a real key variable appears in the child env). Closes P5's load-bearing gap. (P5)
7. **Egress "no upstream before both checks" negative test** → in `EgressProxy.test.ts`, assert with
   a connection spy that **zero** upstream sockets open when the token does not resolve (not just a
   403 response). Closes P4's ordering gap. (P4)
8. **SLSA + tamper-refusal gate** → extend `release.yml` + `verify-slsa.mjs` with a
   reproducible-build diff and a tampered-`SHA256SUMS` refusal test. Exercises P20 ahead of the tag
   push. (§4d)

---

### Verdict (one paragraph)

The **containment** boundary is genuinely proven: the egress allowlist (403 at CONNECT) and the L3
firewall (raw dial to `192.0.2.1` unreachable) run against a real container in a dedicated CI job
that fails if the tests skip — that is the product's strongest and most honest claim. Everything
else is proven only for its **enumerated** cases: the offline guarantee is airtight per-module
(`trentFetch` refuses before a socket, under Bun) but its whole-process "nothing leaves" claim rests
on a **regex source-scan**, not runtime wiring, and the `trent security --offline` canary is partly
**circular** (it dials a synthetic always-on guard, proving the predicate, not the wiring); the
hardline floor and provenance gate are proven for fixed spellings and fixed adapters but have **no
adversarial or property-based** coverage — exactly where an attacker lives — and the docs candidly
admit the floor "cannot happen" is really "not even once." The documentation is above-average honest
(B+), overreaching mainly in absolute headline verbs ("cannot reach," "nothing leaves," "prove it")
that a scoping clause would fix. Net: **containment is proven; offline and the floors are asserted-
with-strong-samples, not yet proven as invariants; supply chain is unshipped.** Top 8 additions, one
line each: (1) a live "zero-packets-escape" egress test in the docker CI job; (2) de-circularise the
offline proof so the canary fires through each module's real dial; (3) a property-based provenance
test over arbitrary tool graphs + an untrusted-adapter registration guard; (4) a hardline
bypass-fuzz corpus + property test with a published miss-rate; (5) a threat-map test that fails CI
if any T-/O-/OWASP threat lacks a named test; (6) a `SandboxEnvironment` test proving no real key
enters the child `--env`; (7) an `EgressProxy` negative test asserting zero upstream sockets open
before both checks pass; (8) a SLSA reproducible-build + tamper-refusal release gate.
