# Security council — architecture & defense-in-depth review

Date 2026-09-26. Lens: **architecture and defense-in-depth soundness** (a red-teamer covers exploit
hunting separately). Read-only pass over the shipped code in `packages/trent-core/src/{egress,
governance,tools,terminal,doctor}` and `apps/cli/src/commands/groups/{security,panic}.ts`, against the
three SEC specs and the three discovery docs. Verdict: the layered model is coherent and, unusually,
mostly *honest* — every trust-UX surface I checked traces to a real enforcement fact. The weaknesses
are at the **seams between layers** and in the **verification architecture**, not in any single layer.

---

## 1. Is the layered model coherent?

The stack is: **credential broker** → **egress chokepoint** → **provenance taint** → **deterministic
floors** → **approval gate** → **audit chain**. Each layer is real and independently testable. The
coherence problem is that two of these layers exist in *two disjoint copies* that do not share policy,
and the boundary between the copies is where assurance leaks.

### 1a. The egress layer is actually two chokepoints with different policies
There is not one egress chokepoint; there are two, governing two different populations of traffic:

- **Sandbox subprocess egress** (a `curl` an agent runs) → the L3 Docker firewall
  (`terminal/egress-network.ts`) → the TLS-intercepting `EgressProxy` → the `intercept_domains`
  allowlist + broker. This is the strong path: post–SEC-1 it is a real `--internal` network whose only
  route is a forwarder to the proxy, so a non-allowlisted host is *unreachable*, not "proxy-refused."
- **Host-process JS egress** (a `fetch` Trent's own code makes) → `egress/dial.ts` `trentFetch`. When
  online this is a **transparent pass-through to platform `fetch` with no allowlist, no SSRF floor, no
  broker** (`dial.ts:42-48`). It only does anything when `TRENT_OFFLINE` is on, and then only
  loopback-gates.

The consequence: the `intercept_domains` allowlist and `checkUrlSafety` SSRF floor govern *tool*
egress (web, business, social, a2a, vision-url, mcp-http all ride `proxied-fetch` → proxy per
`registry.ts:66-72`), but **model calls, the embedder, media image generation, `connect` OAuth, MCP
OAuth, OTel export, and the updater dial the network directly via `trentFetch`/`node:https` with no
allowlist when online** (`registry.ts:57-88`). That is defensible — those are first-party destinations
Trent chose, not agent-chosen sinks — but it means "the egress allowlist is the global chokepoint" is
false: it is the *tool* chokepoint. A reader of `docs/security.md` should not conclude host-side
provider calls are allowlist-bounded. This is a seam, not a hole, but it is under-documented.

### 1b. The credential layer is also two paths
`applyCredentials` (`CredentialBroker.ts:92`) is genuinely the *single* function that swaps an opaque
`trent-proxy-*` token for a real secret bound to a host — for the **sandbox** population. But the
host-process population injects real keys itself: `media/image.ts:225` reads `env[OPENAI_API_KEY]` and
writes `authorization: Bearer ${key}` directly; `connect/flow.ts` and `mcp/http-oauth.ts` hold real
tokens in-process. See §4. So "brokered, never seen" is an invariant of *sandboxed tool* egress, not a
universal one.

### 1c. Single points of failure (one layer silently depending on another)
- **The whole side-effect line leans on one seam**: the per-call bound-approval check inside `execute`
  (`bound-approvals.ts`). A single "always approve" grants the seat loop; the hardline floor and
  provenance holds are what actually hold the line if that seam is ever miswired. This is called out in
  the posture doc (class 10) and is correct-but-load-bearing.
- **Offline enforcement depends entirely on two things staying in sync**: every network module keeping
  `trentFetch` as its fallback, *and* the `registry.ts` coverage test catching any new module that does
  not. The `node:https` paths (`local-runtime`, `updater`) and `socket` paths (gateway platforms) are
  **not** caught by `trentFetch` at all — they are covered only by manual registry enumeration plus a
  `disabled`/`config-rejected` gate. A new `node:net`/`node:dgram` module that the source-scan does not
  recognize would be an OPEN offline path that no test flags. The registry is the keystone; harden it
  (§6d).
- **The offline proof depends on the canary being the same dial the modules use.** It is
  (`createForcedOfflineDial` shares `assertLocalTarget` with `trentFetch`), so this dependency is sound.

**Coherence verdict:** the model is sound and the layers compose in the right order (deterministic
floors before approval, taint before shared-write, broker before egress). The redundancy that matters
— two egress chokepoints, two credential paths — is *intentional* (trusted host vs untrusted sandbox)
but the security narrative treats them as one. Name the boundary explicitly.

---

## 2. The offline chokepoint is application-level (`trentFetch`) — is that right?

`trentFetch` is app-level by *deliberate, correct* reasoning (spec "The crux"): the shipped artefact is
a Bun-compiled binary, and `undici`'s `setGlobalDispatcher`/`ProxyAgent` does not intercept Bun's
native `fetch`, nor is a `node:net` connect hook guaranteed to sit under it. So a runtime interceptor
would be a false floor. Trent's own code is the only runtime-agnostic chokepoint available. That
reasoning is right, and the honest caveat is surfaced (`doctor/checks/offline.ts:32`).

**Compared to the SOTA alternatives (D5 A8, public-record §5.2):**

- **OS network namespace / seccomp / host egress firewall.** This is the *strong* design, and Trent
  already applies it — to the **sandbox** (`--internal` network, SEC-1). The gap is that the **host
  process itself** has no equivalent; `trentFetch` is the only thing standing between Trent's own code
  and the network offline. A subprocess Trent did not spawn, or any code path that bypasses the
  fallback, is out of `trentFetch`'s reach (the caveat admits this).
- **Capability tokens / CaMeL.** These defend *injection*, not egress; they are not the offline lever.

**The right long-term design:** extend the L3-firewall philosophy from the sandbox to the host process.
When offline, put Trent's own process under an OS network jail whose only route is loopback — the same
"unreachable, not refused" property the sandbox now has, applied one level up. On Linux this is
`unshare`/nftables with an owner rule; on macOS there is no clean per-process equivalent, and under Bun
this is genuinely hard, so it stays a *belt over* `trentFetch`, not a replacement.

**Pragmatic next step that materially raises assurance without a rewrite:** do not touch the mechanism
— *prove* it continuously and defend its completeness. Two cheap moves (both in §6) raise assurance far
more than a partial OS-jail: (a) a CI job with `TRENT_OFFLINE=1` that runs the live canary under Bun,
and (b) hardening the registry coverage test so a new egress module cannot silently open a path. The
mechanism is as good as it can be under Bun; the assurance gap is that nothing *continuously proves* it.

---

## 3. Provenance/taint is adapter-level and coarse

`UNTRUSTED_ADAPTERS` (`provenance.ts:46`) now taints whole toolsets: `web, browser, mcp, plugins,
inbound, vision, media, a2a`. SEC-1 T-03 correctly closed the vision/a2a hole, but by the coarsest
possible mechanism — **membership by adapter name**. The over-taint the brief cites is real and
visible: `media_transcribe` of the operator's **own local audio file** is tainted exactly as a remote
clip is, and an `a2a` call to a *trusted* peer taints the step as if it read the open internet. That
produces held writes and refusals on trusted local work — alert-fatigue pressure (D5 A13), which
*erodes* the very "feel-safe" goal because users learn to approve reflexively.

**What a data-flow-aware / capability-scoped design looks like (CaMeL, D5 A2):** taint lives on the
*value*, not the adapter. Every tool argument carries a capability set; a pure, total `canFlow(source,
sink)` predicate gates a sensitive sink (shared-write, recipient, egress) only when a value actually
derived from untrusted bytes reaches it. Local file → trusted; remote URL → untrusted; the sink, not
the toolset, decides. That is the correct end state and it is a rewrite.

**The incremental step worth taking now (low effort, removes the over-taint, keeps the invariant):**
move the taint decision from adapter *membership* to a per-call classifier. The machinery already
exists — an adapter can tag its own result untrusted (`provenanceOf` / `worstProvenance`,
`provenance.ts:290`), and `adapterProvenance` already takes the tool name and scopes. Extend
`adapterProvenance` (or have `media`/`vision`/`a2a` tag their own result) to inspect the argument: a
`media` call on a `file://`/local path returns `trusted`; on a URL, `untrusted`. Same for `vision`
(local image vs remote). Keep `web`/`browser`/`mcp`/`inbound` as blanket-untrusted (they are always
external). This is a handful of lines per adapter, deletes the false holds, and the taint invariant is
unchanged. Worth it — it directly serves the feel-safe goal by making every hold *earned*.

---

## 4. Secret handling — is "brokered, never seen" airtight?

**No — and the code is honest about the mechanism, but the trust-UX language is not yet scoped to it.**
The broker guarantees the **sandbox / agent context** never holds a real key. It does *not* make every
credential path go through the broker. Three host-side paths read a real secret directly:

- `media/image.ts:90,140,225` — reads `env[apiKeyEnv]` (default `OPENAI_API_KEY`) and writes the real
  key into the request header itself, then dials `trentFetch`. Real key in host-process memory and on
  the wire; never brokered.
- `connect/flow.ts` — the OAuth token endpoint exchange holds the real provider token host-side.
- `tools/mcp/http-oauth.ts` — issuer discovery + token exchange, same shape.

For keeping keys out of the *agent/sandbox*, these are fine — they run in Trent's trusted host process,
not in agent-controlled code, and the key never enters the model context or the transcript. But the
S5.2 receipt language and B12 badge ("value brokered at the boundary — never entered … secrets
brokered-but-never-seen") describe an invariant these paths do not satisfy. Two honest options:

1. **Preferred (one seam):** route host-side provider calls (starting with `media/image`) through the
   proxy + broker too — the sandbox already does this for every other provider call. Then there is
   *one* credential-injection function, the egress ledger/receipt captures these hosts, and the
   invariant is universal. `connect`/`mcp-oauth` are harder (interactive OAuth) and can stay host-side.
2. **Cheaper (scope the claim):** qualify the receipt/grade to say "brokered for sandboxed tool
   egress," and add these host-side `env[…KEY…]` reads to the `security-audit` config-cred scan surface
   so the operator can see every place a real key is read.

Either is acceptable; shipping the badge unqualified while (1) is undone would be the one place the
"no theater" rule is at risk.

---

## 5. Trust-UX — real enforcement or theater?

Mostly real, and impressively disciplined. Specific reads:

- **Posture grade (`security-grade.ts`)** — genuinely honest. Pure, total function of the audit
  findings + posture booleans; monotonic in the finding set; every weight a named constant; `--json`
  carries every input so the display invents nothing. This is the model to keep. One design note:
  prompt-redaction and MCP-scrubbing are weighted 0 (defensible — default-off by design), but that
  means a profile sending prompts to a hosted provider is not graded down for it; fine as long as the
  card *shows* the state (it does).
- **Panic (`panic.ts`)** — the revoke (`PairingManager.revokeAll`) and the SIGTERM to live lock holders
  are both real, and it honestly says it cannot reach a bare `run` in another terminal. **But it does
  NOT revoke brokered egress tokens**, though the spec (S5.3) and D5 B6 both promise "invalidates
  brokered egress tokens / denies the next brokered request." `TokenManager` already has
  `revokeToken`/`revokeAllForAgent` (`TokenManager.ts:106,113`); panic imports neither. This is the one
  place the shipped surface under-delivers against its own spec. A panicked operator who believes
  in-flight egress is dead is wrong until the run's tokens expire. **Highest-value real-assurance fix in
  this wave.**
- **Offline proof (`doctor/checks/offline.ts` + `trent security --offline`)** — real: it walks the
  registry, fires a live canary to the `192.0.2.1` literal through the actual guard, checks the config,
  and exits non-zero on any OPEN row. Not theater. Its honesty (the kernel-firewall caveat) is a
  feature.
- **Not yet shipped (spec'd, absent from `security.ts`):** the per-run **security receipt** (S5.2), the
  **live egress ledger** (S5.4), the **paranoid preset** (S5.5), **explain/diff** (S5.6). `security.ts`
  exposes only `status` + `audit` + `--offline`. The receipt and ledger are the two that would give
  *per-run, genuine* assurance (they compose real proxy/broker/provenance events), so they are the
  highest-value additions after panic-token-revocation.

**Highest-value addition for genuine (not perceived) assurance:** wire token revocation into panic, then
ship the per-run receipt (S5.2) assembled from real `EgressProxy` decisions + `CredentialBroker`
issuances + provenance holds. Those turn "we enforce" into "here is the enforced envelope, per run."

---

## 6. Testing / verification architecture — how to CONTINUOUSLY prove the properties

This is the weakest part of the posture, and it is where the credibility gap is largest. The
properties are strong; the *proofs* are mostly example-based and, for the single most load-bearing
claim, mock-only.

**Findings:**
- **The egress-firewall property (T-01, the headline "unreachable, not refused") is proven only by
  construction.** `sandbox.egress-firewall.test.ts` injects a mock `DockerRunner` and asserts the
  *argv* is right (`--network <internal>`, `--add-host …:<forwarder ip>`, never `host-gateway`). No
  test anywhere stands up the real `--internal` network and asserts that `curl --noproxy '*'
  https://192.0.2.1` from inside the egress sandbox *fails to connect*. The most important security
  claim in the product is unverified against a real kernel.
- **No property-based testing at all** (no `fast-check` in any manifest). The taint invariant, the
  host-binding matcher, the `isHostAllowed` allowlist matcher, and the floor deobfuscation are all
  example-based — exactly the matchers where an adversary lives in the cases you did not enumerate.
- **The offline canary is not run in CI.** `doctor/checks/offline.ts` only engages when
  `TRENT_OFFLINE=1`; no CI job sets it, so the live guard is never continuously exercised under Bun
  (the shipped runtime).
- The registry coverage test (source-scan) is a genuinely good idea and exists — but only catches
  modules importing a *fetch* primitive, not `node:net`/`node:dgram`/`child_process`-with-a-network-
  binary.

**Concrete design (each names a file):**

- **(a) Live egress-firewall integration test** — `tools/sandbox.egress-firewall.live.test.ts`, gated
  by `TRENT_REQUIRE_DOCKER_TESTS`, added to the `sandbox.yml` egress suite. Real daemon: build the
  network via `ensureEgressNetwork`, run the egress `DockerBackend`, and assert three behaviors, not
  argv: `curl --noproxy '*' --max-time 5 https://192.0.2.1` → non-zero (no route); `curl` to a
  non-allowlisted host *through* the proxy → HTTP 403 `host_not_allowlisted`; a raw
  `python3 -c 'socket.create_connection(("1.1.1.1",443),3)'` → timeout. This converts T-01 from
  "argv-correct" to "kernel-proven."
- **(b) Offline canary CI job** — a `sandbox.yml`/`ci.yml` job with `TRENT_OFFLINE=1` running the
  `checkOffline` doctor check under **Bun**, asserting `proof.ok` and `canary.blocked`. Proves the
  loopback-only guard on the real runtime every push.
- **(c) Property-based tests (add `fast-check` dev-dep)** —
  `governance/provenance.property.test.ts`: for all interleavings of (adapter, provenance) calls, if
  any untrusted precedes a shared-write, the result is `held`/`blocked` and the held record contains
  none of the untrusted bytes. `egress/host-binding.property.test.ts`: for all (host, pattern),
  `isHostAllowed` is never true unless `host` is exactly the pattern or a strict subdomain of a `*.`
  suffix (kills `evilexample.com` vs `*.example.com`); `assertLocalTarget` never resolves a
  non-loopback address to "allowed."
- **(d) Harden the registry coverage test** — `egress/registry.test.ts`: extend the source-scan to also
  fail when a module imports `node:net`/`node:tls`/`node:dgram`/`node:https` or spawns a known network
  binary and is absent from `EGRESS_PATHS`. Makes the offline guard's completeness self-defending
  against the very import shapes `trentFetch` cannot see.
- **(e) Adversarial floor fuzz harness** — `tools/approval-floors.fuzz.test.ts`: a generated corpus of
  obfuscated destructive spellings (NFKC, `$IFS`, env-unwrap, and the interpreter payloads T-06 added)
  asserting `hardlineBlock`/`floorBlock` fires. Runs in CI as a regression net for the deobfuscator.
- **(f) Reproducible-build / SLSA gate** — `release.yml`: after the existing minisign/ECDSA signing,
  add a cosign/SLSA provenance attestation and an updater-side verify step (D5 A11), so the
  verified-update path is exercised, not just present. Report-only until a release is cut (T-12).

---

## Ranked recommendations (assurance gained × effort)

### Structural must-haves for a credible security posture
1. **Live egress-firewall integration test** (§6a, `tools/sandbox.egress-firewall.live.test.ts`) — the
   headline claim is today mock-only; prove it against a real kernel. *High assurance, low-med effort.*
2. **Panic revokes brokered egress tokens** (§5, `apps/cli/.../panic.ts` + `TokenManager.revokeAll`) —
   close the shipped-vs-spec gap; the big red button must actually cut in-flight egress. *High, low.*
3. **Offline canary CI job under Bun** (§6b) — continuously prove the loopback-only guard on the shipped
   runtime; today it is proven only when someone runs doctor. *High, low.*
4. **Harden the registry coverage test to `node:net`/`dgram`/`https` + spawn** (§6d,
   `egress/registry.test.ts`) — the offline keystone must self-defend against the import shapes
   `trentFetch` cannot see. *Med-high, low.*
5. **Property-based tests for the taint invariant + allowlist/loopback matchers** (§6c, add
   `fast-check`) — the matchers where the adversary lives in the un-enumerated case. *Med-high, med.*

### Nice architectural improvements
6. **Per-call provenance (local path vs URL) to end the media/a2a over-taint** (§3,
   `governance/provenance.ts` + the three adapters) — a value-level step toward CaMeL that deletes false
   holds and serves feel-safe by making every hold earned. *Med, med.*
7. **Route host-side provider calls through the broker/proxy, or scope the "brokered" claim** (§4,
   `tools/media/image.ts`; `governance/security-audit.ts`) — make "brokered, never seen" a universal
   invariant or say precisely where it holds. *Med, med.*
8. **Ship the per-run security receipt + live egress ledger** (§5, S5.2/S5.4 in `security.ts`) —
   compose real proxy/broker/provenance events into per-run evidence; the strongest genuine
   assurance-per-run surface still unbuilt. *Med, med.*

Further out: an OS-level host egress jail when offline (§2, the right long-term but Bun/macOS-hard),
an adversarial floor fuzz harness (§6e), and the SLSA/cosign release gate (§6f, unblocked once a
release is cut).
