# SEC-5 — the "feel-secure" layer: implementation spec

Date 2026-09-26. Finalizes wave SEC-5 of `security-hardening-plan-2026-09-26.md`. Source: D5
(`01_discovery/output/security-sota-and-trustux-2026-09-26.md`, PART B) verified against the tree.

Bobby's second emphasis: "go beyond on how secure it makes the user *feel*." The rule for this wave:
**every surface reflects a real enforcement fact — no theater.** Each feature below names the primitive
that already enforces the thing it shows, so it ships as fact, not reassurance. Default posture stays
opt-in (Bobby); these are read/observe surfaces plus one preset and one panic command, none of which
change enforcement on their own.

Order by value. Land smallest-first, each TDD + isolate + explicit paths.

## S5.1 — `trent security` posture card + letter grade  (highest value)
- **User sees:** a one-screen card — an overall grade (A–F) and the exact checks behind it: autonomy
  level, egress firewall on/off, offline mode, hardline rule count, deny globs, hook consents, MCP
  consent state, workspace trust, prompt redaction, signed-audit chain intact, profile file modes.
- **Surface:** extend the existing `trent security` group (`apps/cli/src/commands/groups/security.ts`,
  which already has `audit`). Add a default/`status` view that renders the grade; `--json` supported.
- **Backing (real):** `governance/security-audit.ts` (`auditProfileSecurity`, severity-sorted
  findings + `SECURITY_SECTION_IDS`), `doctor` checks, `egress/*`, `hooks/consent.ts`,
  `governance/hardline.ts` (rule count). The grade is a pure function of the audit findings +
  posture booleans — a deterministic rubric, documented, no hidden weighting.
- **Property:** the grade is a total function of enumerated inputs; a profile with a known finding set
  yields a known grade; `--json` carries every input so nothing is invented for display.
- NOTE: coordinate with SEC-2b — it also edits this file for `--offline`. Land after S2b.

## S5.2 — per-run "security receipt"
- **User sees:** at the end of a run: hosts reached (allowlisted, shown as reached), attempts blocked
  (with the rule that blocked each), secrets brokered-but-never-seen (count + which providers), taint
  holds raised, tools used. A short honest ledger of what the run was allowed to touch.
- **Surface:** `trent run` footer + `trent run-output <id> --receipt` (or the run's JSON).
- **Backing (real):** `egress/EgressProxy.ts` per-request decisions, `egress/CredentialBroker.ts` +
  `host-binding.ts` ("brokered, never seen" is true by construction), `governance/provenance.ts`
  holds, the spend/trace ledger. Compose, don't invent.
- **Property:** every host in the receipt corresponds to a real proxy decision event; the
  brokered-secret count equals the CredentialBroker's issuance count for the run; blocked entries each
  carry a real rule id.

## S5.3 — `trent panic`  (kill + revoke all)
- **User sees:** one command that stops running work and revokes ALL gateway pairings at once, printing
  what it revoked. The big red button.
- **Surface:** new `trent panic` umbrella wrapping the existing per-pairing `trent gateway revoke`.
- **Backing (real):** `gateway/security/PairingManager` `revoke` (today per-sender) + a new batch
  `revokeAll`; the run/session stop path. No new trust machinery — it composes revoke + stop.
- **Property:** after `trent panic`, `PairingManager.list()` is empty and any in-flight run is asked to
  cancel; a dry-run lists what would be revoked without doing it.

## S5.4 — live egress ledger
- **User sees:** `trent security egress --follow` tails the proxy's allow/deny decisions in real time
  (host, verdict, rule). A window into what is actually leaving.
- **Backing (real):** `EgressProxy` already emits per-request decisions; this is a subscriber + render.
- **Property:** each printed line is one real proxy decision; an allowed and a denied request each
  appear with the correct verdict.

## S5.5 — `paranoid` preset  (the strict bundle, one command)
- **User sees:** `trent security preset paranoid` writes a bundle of knobs the gate chain already
  honors and prints the diff; `trent security preset standard` restores defaults. `trent security`
  shows the active preset.
- **Bundle:** offline optional (a separate `--offline` flag stays per-run), autonomy → the strictest
  ask level, browser toolset off, MCP consent required, egress firewall on, prompt redaction on. A
  preset of existing settings — NOT a new "mode" that pretends to enforce.
- **Backing (real):** `config/sections/*`, `governance/autonomy.ts`, the SEC-1..4 knobs.
- **Property:** applying the preset writes exactly the documented keys; the gate chain's behavior after
  applying equals hand-setting those keys; `preset` refuses to run from a tool (it is in the
  `lower-trents-own-guardrails` hardline list — good, an operator-only action).
- NOTE: since `trent security preset` is now hardline-blocked from inside a tool call (SEC-3a), it can
  only be run by the operator at their own terminal — which is the intent.

## S5.6 — "explain why blocked" + config diff
- **User sees:** when a tool call is refused, an inline "why" with the rule and the fix; `trent
  security explain <event-id>` for detail; `trent security diff [--since <ref>]` shows what changed in
  the security config, from the signed audit chain.
- **Backing (real):** `governance/policy-dispatch.ts`/`deny-globs.ts`/`hardline.ts` already produce
  structured refusals with reasons; `security.ts` already prints `fix` lines; the audit chain records
  config actions. Correct O-06's stated reason (attach-mode/UDP, not "browser is unproxied") so the
  explain text is true.

## Deferred / report-only from D5 PART A (net-new, not this wave)
DNS/IP pinning against rebinding in the proxy (A8 — partly covered by offline's resolve-then-classify
and the L3 firewall), SLSA provenance verification in the updater (A11), an OS-keychain-backed
TokenStorePort (A12). These are follow-ups tracked for a later round, not part of the "feel-secure"
surfacing wave.

## Method
TDD, isolate.sh, explicit paths. S5.1/S5.5/S5.6 touch `apps/cli/src/commands/groups/security.ts` — do
them AFTER SEC-2b lands (it edits the same file for `--offline`). S5.3 (`trent panic`) and S5.4 (egress
ledger) are more independent and can go earlier. Everything opt-in; no enforcement changes here.
