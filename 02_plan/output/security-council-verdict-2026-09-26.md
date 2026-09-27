# LLM Council verdict — Trent security, "prove it's secure" (2026-09-26)

Chair synthesis of four Opus reviewers (read-only): red-team cybersecurity consultant, defensive
architect, verification/proof skeptic, principal-engineer/product. Their reports:
`02_plan/output/security-council-{redteam,architect,verification,product}-2026-09-26.md`.

## The consensus, in one line
The architecture is genuinely strong and materially better than Hermes; but **it is not yet "provably
secure."** Two things must change before that claim: (a) fix the places where a doc/proof asserts more
than the code delivers, and (b) replace enumerated-sample proofs with real, adversarial, continuously-run
ones. The reviewers agreed on this almost verbatim.

## Binding decisions (ranked; implement autonomously in this order)

### Tier 1 — Truthfulness: the code must do what the docs say (do first)
- **D1 — DNS egress from the sandbox.** `terminal/egress-network.ts` asserts `--internal` closes
  DNS-over-UDP, but Docker's embedded resolver (`127.0.0.11`) forwards from the daemon netns and
  `dig/nslookup/ping/nc` are routed into the egress seat. **Test it live; if it leaks, block resolver
  egress in the seat (or drop UDP/53), and if it can't be fully closed, downgrade the doc claim to the
  truth.** A claim stronger than the code is the worst outcome for a security product.
- **D2 — `trent panic` must revoke brokered egress tokens.** Today it revokes pairings and SIGTERMs
  writers but leaves live egress tokens valid (`TokenManager`), so in-flight exfiltration survives the
  kill switch. Add `TokenManager.revokeAll()` and call it from panic.
- **D4 — Scope every "cannot reach a host" / "offline" claim to `backend: docker`.** On LocalBackend
  there is no isolation; the docs must say so and network tools should refuse (or loudly warn) there.

### Tier 2 — Make the proofs real (the core of "prove it")
- **D5 — De-circularise the offline proof.** `doctor/checks/offline.ts` fires the canary through a
  synthetic always-on guard (`createForcedOfflineDial`), proving the predicate, not that modules are
  wired through `trentFetch`. Drive the canary through each registry row's own dial seam.
- **D6 — Catch bare `fetch()` in the coverage test.** `egress/registry.test.ts` only scans imports, so a
  global `fetch(`/`node:net`/`dgram`/`https`/network-spawn that bypasses `trentFetch` is invisible. Add a
  source-scan that fails CI on an unregistered raw egress primitive.
- **D8 — Adversarial fuzz harness for the hardline floor.** Add `fast-check`; seed a corpus of the
  bypasses the red-team found (`os.system(base64.b64decode(...))`, write-script-then-run,
  bare-operand `tar -C ~ .aws`, env-indirected `$T config set`, unicode) and a property test with a
  published miss set. Fix the reachable bypasses it exposes.
- **D9 — Property-based provenance invariant.** Over arbitrary tool graphs: any untrusted read before a
  durable write ⇒ a hold. Plus a registration guard so a new off-machine adapter must declare itself.
- **D10 — Threat-map → test mapping** that fails CI if any T-/O-/OWASP threat lacks a named, present test.

### Tier 3 — Close the remaining real gaps
- **D3 — DNS-rebinding / resolve-then-connect pin** on the online egress proxy and in `assertLocalTarget`
  (one resolution used for both the allow-check and the connect).
- **D11 — Taint network-derived terminal output and untrusted workspace file reads** — the largest
  provenance gap: indirect injection via a cloned repo's files or a command's network output bypasses the
  quarantine entirely today.
- **D12 — Broaden the credential-read denylist**: `~/.kube`, `~/.config/gh`, and a bare `env` dump.
- **D13 — http MCP consent-on-first-connect** (no gate today) and a stdio artifact-digest pin against
  `npx @latest` rug-pulls.

### Tier 4 — Surface it (feel + be secure) and honest framing
- **D15 — `trent security preset paranoid|standard`** (the one-command hard posture; knobs already exist
  and are already tool-blocked by the hardline rule).
- **D16 — per-run security receipt** (compose from EgressProxy + CredentialBroker + provenance).
- **D17 — Grade honesty:** rename `egressFirewall`→`egressProxy`, add an L3-firewall-available input;
  checksum the inline forwarder-relay script and add a socket test for it.
- **D18 — a real `SECURITY.md` disclosure policy + `.well-known/security.txt`.**
- **D19 — route host-side media image-gen (reads a real key directly) through the broker, or scope the
  "brokered, never seen" claim precisely.**
- Lower: S5.4 live egress ledger, S5.6 explain-why-blocked inline + config diff.

## Founder-gated (cannot be closed in this repo — Bobby's steps)
Cut and sign a release (exercise the verify-update path) + a SLSA/reproducible-build gate; enable GitHub
private vulnerability reporting; commission an external pen-test and an SBOM before any public "provably
secure" claim; file the app-side T-11 seat-error secret log against `apps/web` (read-only here).

## Framing decision
Until D1–D10 land, the product is described as **"defense-in-depth, materially hardened, with stated
residuals and per-property proofs"** — not "provably secure." That honesty is itself a security feature.
