# Stage 2, Ranker 2: security and correctness claims

Scope: the four anonymised stage-1 responses, checked against `feature/trent-fleet-v2` at HEAD `723ef22`
(the responses read `79fa451`; the only commit between them is the approvals.restart flake fix) plus the
uncommitted tree (S2, H3, H5, L1, S3, P3 = "tree"). Hermes at `~/.hermes/hermes-agent` (`49eb7b5dba`).
Read-only: grep, `git show/diff/grep`, `gh run list/view`. No test suite was run. Paths are under
`packages/trent-core/src/` unless they start with `apps/`, `docs/`, `.github/` or `hermes:`.
Verdicts: **holds**, **partly** (true, but the scope or severity is wrong), **wrong**, **superseded** (true
when written, fixed since at HEAD).

## 1. Verification table (security first, then correctness)

| # | Resp | Claim | Evidence traced | Verdict |
|---|---|---|---|---|
| 1 | R1 | B1: the broker sends the provider API key to every allowlisted host | `egress/CredentialBroker.ts:92-109` adds `Bearer <secret>` for any host that is not `*anthropic.com`/`*googleapis.com`. `egress/EgressProxy.ts:294-308` checks only the allowlist and that a token resolves. `ProxyTokenRecord` has no host field (`egress/TokenStorePort.ts:12-21`). One token per process carries `{apiKey}` of the configured provider (`apps/cli/src/repl/tools.ts:163,193-197,218`). The launched browser sets that token on every request (`tools/browser/session.ts:61`, unchanged in the tree), and so does `createEgressFetch` (`tools/web/proxied-fetch.ts:149`). The only opt-outs are business, a2a and mcp (`OWN_CREDENTIAL_HEADER`). The only broker test on the non-provider path asserts that injection happens (`egress/CredentialBroker.test.ts:131-133`). Hermes binds each key to its own hosts, with `require: True` (`hermes: agent/proxy_sources/iron_proxy.py:84-87,527-532`) | **holds, and worse than stated** (see 1a, 1b) |
| 1a | new | B1 already leaks in the DEFAULT config | The sandbox gets the token in `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY` (`egress/SandboxEnvironment.ts:28-41`). The default allowlist is all three provider hosts (`config/sections/terminal.ts:34`). So on a Gemini profile, a sandboxed script calling `api.openai.com` sends `Authorization: Bearer <Gemini key>` to OpenAI. No allowlist change is needed | **new, holds** |
| 1b | new | B1 also breaks and leaks through web tools | `web_search` sends `Authorization: Bearer <TAVILY_API_KEY>` (`apps/web/lib/web-search-adapter.ts:104-105`), and the reader optionally sends a Jina bearer (`web-reader-adapter.ts:92`). Both go through `createEgressFetch` without the own-credential marker (`tools/web/index.ts:96-103`). Once `api.tavily.com` or `r.jina.ai` is allowlisted, the broker deletes `authorization` (it is in `TOKEN_HEADERS`, `CredentialBroker.ts:12,87`) and injects the model key. Tavily then answers 401 while holding the user's model key | **new, holds** |
| 1c | new | The code already knows the token-on-every-request pattern is dangerous | `tools/browser/attach.ts:7-9` (tree): "no broker token header is ever set on it (that would hand the token to every site the owner visits)". The launched browser does exactly that, and the broker then turns the token into the real key | **holds** |
| 2 | R1 | B2: untrusted memory writes are never held on a fleet run | `orchestrator/index.ts:193` appends `deps.fleetMemory.adapters` after the wrapped tools. `memory` is not in `IMPLEMENTED_TOOLSETS` (`tools/index.ts:265`), so `provenanceAdapters` (`:411-424`) never wraps it. The hook's adapter is built bare (`apps/cli/src/repl/fleet-memory.ts:170`), and `tools/memory/index.ts` has 0 taint checks. The only proof is `governance/provenance.test.ts:191-197`, through `extraAdapters`, whose only non-test user is a fixture (`mcp-server/__fixtures__/serve-fake.ts:47`). The tree's `solo/memory-gate.ts:4-8` states the fleet hole in its own header. `apps/cli/src/runtime/headless.ts:318-323` wires the approval side and assumes the hold side exists. Hermes at least scans memory content (`hermes: tools/memory_tool_store.py:26`); the Trent fleet has nothing | **holds** |
| 3 | R1 | B3: no production code constructs `WebhookServer`, so the webhook-only adapters cannot receive | `git grep WebhookServer HEAD` finds only the class, a re-export and a comment. The webhook-only set is whatsapp, homeassistant and line (`gateway/registry.ts:62,86,105`, tree markers). The tree mounts it (`apps/cli/src/commands/groups/servers.ts:14,59`; `webhooks/serve.ts:43`) | **holds at HEAD; fixed in the tree, unlanded** |
| 4 | R1 | S1: the live-test job cannot run the live files | The job sets `TRENT_LIVE_TESTS` (`.github/workflows/ci.yml:390-393`); vitest reads `TRENT_TEST_LIVE` (`vitest.config.ts:8,51`). `gh run list --limit 200` shows `{"push":170}`: 0 scheduled runs. HEAD run 36219816961: "live provider tests: skipped" | **holds** |
| 5 | R1 | S3: `auto_review` breaks "asks you first at every autonomy level", and its untrusted check is a string match | README.md:11-13 does not mention it (0 hits). The string match is real (`governance/auto-review-policy.ts:76,251`). But it is opt-in with safe defaults (`governance/auto-review-config.ts:23-37`: off, `max_class: read`, 0 cents, no recipients). The policy is decided in code before any model is called (`governance/auto-review.ts:12-14`), and held memory writes never reach the reviewer (`:10-11`) | **partly**: a docs-truth and taint-plumbing gap, not a blocker |
| 6 | R1 | S4: `createEgressFetch` re-sends headers and body on any redirect and ignores `init.redirect` | `tools/web/proxied-fetch.ts:187-201` sends the same `headers` and `body` on every hop. `a2a/client.ts:181` passes `redirect: "error"`, which is ignored, while `tools/a2a/build.ts:37,44` routes A2A through it. Only MCP wraps it (`tools/mcp/http-transport.ts:5-7,58-73`) | **holds** (bounded by the allowlist) |
| 7 | R1 | S5: H3 loopback routes accept a drive-by POST, and generic HMAC has no replay window | `webhooks/engine.ts:113-114` checks only peer and listener loopback: no Origin or Content-Type check, and the body is `JSON.parse`d whatever its type (`:269`). `webhooks/signature.ts:81-91` binds no timestamp for github or hmac-sha256. Hermes V2 has a 300 s window (`hermes: gateway/platforms/webhook.py:63,85-92`). Mitigations: opt-in per route (`config/sections/gateway.ts:46`), and Chrome's local-network prompt | **holds** (tree, opt-in) |
| 8 | R1 | M4: the hardline read rule misses `keys/audit.key` and the egress files | The read rule covers only `~/.ssh` and `.env` (`governance/hardline.ts:139-145`). `ca.key` and `tokens.json` are protected for writes only (`:55,136`). But `file_ops` is realpath-confined to the workspace (`tools/file_ops/paths.ts:2`), so the exposure is the terminal on the local backend | **partly** |
| 9 | R1 | Running under Node "loses every pending approval on exit" | Bound approval rows persist in `<profile>/gateway.json`, mode 0600 (`governance/bound-approvals.test.ts:152`). What is lost is store state: runs, improve drafts and the audit chain (`apps/cli/src/runtime/headless.ts:231-239`) | **wrong as worded** |
| 10 | R1 | S2: the approvals.restart root cause is only partly addressed | `723ef22` landed `--out-root`. `store/derive-sqlite-schema.test.ts:46-51` derives into a temp root, and CI 36219816961 is green | **superseded** (still needs a streak of greens) |
| 11 | R1 | Claim 21: the password-field refusal is proven only by an untracked real-Chromium test | `tools/browser/attach.test.ts:303,317` (tree) cover the refusal against a fake page, with no Chromium needed | **partly wrong** |
| 12 | R2 | Memory row: "untrusted writes held (`tools/memory/holds.ts`); landed". Ahead #1: "taint-aware inside the loop" | True only in solo, and only in the tree (`solo/memory-gate.ts`). False for the fleet, which is the default mode (row 2) | **wrong for the fleet** |
| 13 | R2 | `soloResponseFormat` has no production caller | Defined at `solo/prompt.ts:137` with 0 non-test callers. The solo runner's input (`apps/cli/src/runtime/runner-for-mode.ts:297-315`, untracked) passes no `responseFormat` | **holds** |
| 14 | R2 | No `cache_control` anywhere; anthropic, mistral and openrouter use the app streamers | `grep -rl cache_control packages apps` is empty. `model-gateway/index.ts:48-51` | **holds** |
| 15 | R2 | The seat memory writer is append-only, which contradicts the store's own comment | `tools/memory/store.ts:46-48` against `:174-183` | **holds** |
| 16 | R2 | A context-length 400 is never retried; solo has no overflow recovery | `model-gateway/retry.ts:188-195` classes any other 4xx as `validation`, not retryable. 0 overflow hits in `solo/` | **holds** |
| 17 | R2 | A promoted `__seat_prompt__` has no live reader | `readSeatPrompt` is reached only via `improve/seat-prompt.ts:40` -> `improve/sweep.ts:41` | **holds** |
| 18 | R3 | "The egress broker only matches Hermes; it is not a lead" (also the README.md:171 "same design (iron-proxy)" row) | Rows 1-1c: Trent is behind, not at parity | **wrong** |
| 19 | R3 | A1: "A yes covers one exact call" | `governance/bound-approvals.test.ts:94` ("a changed argument invalidates the approval"). The floor is additive-only: `floorClasses` = `CLASS_FLOOR` ∪ `ask_classes` (`governance/gate-config-schema.ts:31-32`), so config cannot remove it | **holds** |
| 20 | R3 | A2: signed, hash-chained audit | `audit/export.test.ts:139,168` (a flipped byte; a foreign key). But export is Bun-only (`apps/cli/src/commands/groups/audit.ts:58-64`), and `approvals-audit.ndjson` and `attach-audit.ndjson` are separate chains that are never exported | **partly** |
| 21 | R3 | A3: the cents cap stops a run | `apps/cli/src/commands/__tests__/run.test.ts:420-427`: exit 6. The cap is 15 and the run stops at 21, so it stops after crossing the cap, not before | **holds** (post-hoc stop) |
| 22 | R3 | A8: solo has no improve wiring | 0 hits for improve or golden in `solo/*.ts` | **holds** |
| 23 | R4 | Gap 1: `trent gateway pair` does not exist, so nobody can be admitted | The text is sent to every unknown sender (`gateway/GatewayManager.ts:321-329`). `PairingManager.pair()` (`gateway/security/PairingManager.ts:119-134`) and `getPairing()` (`GatewayManager.ts:181`) have no non-test caller. There is no `pair` spec in `apps/cli/src`. Approvals from chat require `isAdmin` (`gateway/ApprovalBridge.ts:180`) | **holds**: the most consequential gateway defect, missed by R1, R2 and R3 |
| 24 | R4 | Gap 6: a service daemon under Node runs `EphemeralStore` with no warning | `apps/cli/src/runtime/headless.ts:231-239`. No "durable" check in the service code. Only the REPL warns (`apps/cli/src/repl/index.ts:327`) | **holds** |
| 25 | R4 | HEAD `gateway setup` writes `<PLATFORM>_BOT_TOKEN`, a name WhatsApp and LINE never read | `git show HEAD:apps/cli/src/commands/groups/servers.ts` :102 | **holds** |
| 26 | R4 | H3 and H5 are "ahead on safety once landed" | The H5 floors hold: loopback-only CDP (`tools/browser/attach-config.ts:19-33`), secret-field refusal (`tools/browser/attach.ts:249`), no token header on an attached browser. H3 misses row 7 | **partly** |
| 27 | R4 | `mcp add/test` cannot reach http servers, so the description scan never runs | `docs/mcp.md:188-190`; `apps/cli/src/commands/groups/mcp.ts:195-200`. Results are still scrubbed at runtime (`tools/mcp/client.ts:156`) | **holds** (tool-poisoning scan gap) |

Compound risk no response states: B2 plus auto-review. Run 1 reads a page and writes it to `MEMORY.md`,
unheld and with no provenance marker (`holds.ts` adds the marker only on an approved hold). Run 2 loads
it as trusted prelude. If `auto_review` allows `external_send` to a listed recipient, nothing in the string
check (row 5) sees the laundered text. The recipients list bounds it, but it is a real path around C5.

## 2. Rankings

**Accuracy: Response 1 > Response 4 > Response 2 > Response 3.**
**Decision value: Response 1 > Response 4 > Response 3 > Response 2.**

**Response 1 (first on both).**
- It found the three defects that matter most for a governed-agent product, and each holds with file:line evidence: the key leak (B1), the unheld fleet memory (B2) and the dead live-test job (S1).
- The key leak is worse than it says. It needs no user allowlisting at all (row 1a), and it silently breaks Tavily search (row 1b).
- Its errors are secondary:
  - It overstates the Node approval loss (row 9) and the auto-review severity (row 5).
  - Its flake item was overtaken by `723ef22`.
- **Most important miss:** it counted "9 of 12 adapters can receive" and discussed ntfy admin pairing, but never noticed that no command can pair anyone (row 23). The gateway's effective reach at HEAD is 0 senders unless `gateway.json` is hand-edited.

**Response 4 (second on both).**
- Every surface claim I traced holds (rows 23-27). The pairing finding is the single cheapest, highest-leverage fix in the four reviews.
- It reads as an operator's review and is precise about HEAD versus tree.
- **Most important miss:** it praises H3 and H5 as "safer once landed" and the scripting and audit contract as ahead, without tracing the egress broker. So it misses B1 and B2 entirely, and misses H3's replay and drive-by gap (row 7).
- It lists the audit export as an advantage without noting it is Bun-only and covers one of three chains.

**Response 2 (third on accuracy, fourth on decision value).**
- The loop and model-gateway claims are accurate and come with good acceptance tests (rows 13-17).
- **Most important error:** it repeats the false safety claim. Its Memory row says untrusted writes are held and landed, and its first "ahead" item says the loop is taint-aware. For the fleet, the default mode, both are false (row 12). A reader would build solo features on a security story that does not hold.
- It is ranked last on decision value because its top ten is all harness depth (caching, streaming, delegation), with no security or truth item, and would not change what ships first.

**Response 3 (fourth on accuracy, third on decision value).**
- The strategic reframe is useful: win on proof, not breadth; a bench against Hermes; rehearsal on the owner's history; stop the parity treadmill.
- Its internal proofs for A1-A3 hold (rows 19-21).
- **Most important errors:**
  - It rates the egress broker at parity with Hermes (row 18) and builds the whole pitch on governance primitives, without checking that two of them leak (B1) or are bypassed (B2).
  - Its first steps (land everything, Bobby tags v1.0.0, publish) would ship both holes publicly, under a README that claims iron-proxy parity.
- Many of its market figures (stars, funding, Hermes Business) cannot be checked from the repo.

## 3. Disagreements, resolved

1. **Egress credential isolation.**
   - README.md:171 and Response 3 call it parity. Response 1 calls it a leak.
   - **Resolved for Response 1:** rows 1-1c. Trent injects; iron-proxy swaps per host with `require: True`. Trent is behind until the records are bound to hosts.
2. **Are untrusted memory writes held?**
   - Response 2 (Memory row) and the docs say yes. Response 1 says not on real runs.
   - **Resolved for Response 1, for the fleet:** row 2. Solo is fixed only in the unlanded tree (`solo/memory-gate.ts`).
   - One consequence cuts in Response 3's favour: making solo the default would close B2 for default users, but only once S3 lands.
3. **How many messaging adapters work at HEAD?**
   - Response 3 says 12, Response 1 says 9 of 12, Response 4 says none can admit a sender.
   - **Resolved:** Responses 1 and 4 are both right, at different layers. Transport: 9 of 12 listen, 12 of 12 in the tree. Admission: 0 without a hand edit (row 23). The effective answer is 0.
4. **H3 webhooks.**
   - Response 4 says safer than Hermes. Response 1 says there is a replay and drive-by gap.
   - **Both hold, on different axes:**
     - Trent is ahead on persistent dedupe (Hermes keeps `_seen_deliveries` in memory, `hermes: gateway/platforms/webhook.py:184`) and on taint seeding (`webhooks/taint.ts`).
     - It is behind on the replay window and loopback CSRF (row 7).
     - Fix row 7 before H3 lands.
5. **Durability under Node.**
   - Response 1 says every approval is lost. Response 4 says the daemon is silently non-durable.
   - **Resolved:** approval rows survive (row 9); store state does not, and the service never says so (row 24). Response 4 has the precise version.
6. **Auto-review.**
   - Response 1 calls it a promise break. Response 3 lists it as an advantage. Response 2 wants it consulted inline.
   - **Resolved:** the defaults are safe (row 5).
   - Response 2's expansion should wait until fleet bound rows carry the step's taint (`docs/security.md` "Limits, stated"). Otherwise the compound B2 path widens.
7. **Solo as the default now (Response 3) or after a live proof (Response 2).**
   - **Resolved for Response 2's order:** solo has never answered a real model, and constrained output is unwired (row 13).
   - Make it the default only after one recorded live session, and after S3's memory gate lands.
8. **The flake.**
   - Response 1 says partly fixed in the tree. Response 3 says fix or quarantine.
   - **Superseded:** the fix landed at `723ef22` and CI is green. What remains is proof by a streak of green runs, not a fix.

## 4. Consolidated top 10 for the owner (ordered)

**1. Bind broker credentials to their provider's hosts (B1). Size: M. Source: Response 1, extended here.**
- **Problem:** the model key reaches any allowlisted host, and crosses providers in the default config.
- **Evidence:** rows 1-1c.
- **Files:**
  - `egress/TokenStorePort.ts`: add `hosts` to the record.
  - `egress/CredentialBroker.ts`: inject only when the host matches; otherwise strip the token and add nothing.
  - `apps/cli/src/repl/tools.ts:163`: issue the token with the provider's hosts.
  - `tools/web/index.ts:99`: wrap with `withOwnCredential` so Tavily and Jina keep their own bearer.
  - `tools/browser/session.ts:61`.
- **Acceptance (red first):**
  - A token minted as `{apiKey:K, hosts:[generativelanguage.googleapis.com]}` is sent through a real `EgressProxy` to `api.openai.com`, `api.tavily.com` and an allowlisted `example.test`. No request carries K in any header.
  - The Tavily request keeps its own `Authorization`.
  - The Google request carries `x-goog-api-key: K`.
  - A Chromium navigation to an allowlisted non-provider host sees no `authorization`.
- **Also:** change README.md:171 until this lands.

**2. Hold untrusted memory writes on fleet runs (B2). Size: S. Source: Response 1.**
- **Problem:** web or inbound text can be written into the shared `MEMORY.md` that every seat loads next run.
- **Evidence:** row 2.
- **Files:**
  - `apps/cli/src/repl/tools.ts`: expose `buildTrentTools`' `provenance` ledger on `ToolWiring`.
  - `apps/cli/src/runtime/headless.ts`: pass it through.
  - `orchestrator/index.ts:193`: wrap `fleetMemory.adapters` with `provenanceAdapters({ledger: <that same ledger>, hold: holdMemoryWrite})`. The ledger's taint map is per instance (`governance/provenance.ts:185-208`), so a new ledger would see no taint.
- **Acceptance:** through `createHeadlessRuntime` with a fake seat, `web_extract` then `memory {"action":"add"}` in one step returns `needs_approval`, files one pending row in `gateway.json`, and leaves `MEMORY.md` unchanged.

**3. Ship `trent gateway pair|pairings|revoke`. Size: S. Source: Response 4.**
- **Problem:** no sender can be admitted, so chat, chat approvals and voice notes are all unreachable.
- **Evidence:** row 23.
- **Files:** `apps/cli/src/commands/groups/servers.ts`, `gateway/GatewayManager.ts:327`, `docs/gateway.md`.
- **Acceptance:**
  1. A fake Telegram sender gets code X.
  2. `trent gateway pair telegram X --admin --json` exits 0.
  3. The sender's next message reaches the agent handler.
  4. Their reaction decides an approval card.

**4. Land P3's listener and harden H3 before it lands. Size: S+M. Source: Responses 1 and 4.**
- **Problem:** webhook-only adapters are deaf at HEAD, and H3 has a replay and drive-by gap.
- **Evidence:** rows 3, 7, 25.
- **Files:**
  - `webhooks/engine.ts:113`: refuse any `Origin` header, and require `content-type: application/json`, on `none-localhost-only`.
  - `webhooks/signature.ts`: an `hmac-sha256-ts` variant with a tolerance window.
  - `apps/cli/src/commands/groups/servers.ts`, `gateway-setup.ts`.
- **Acceptance:**
  - `gateway start` with only `LINE_CHANNEL_*` set accepts a signed POST to `/webhooks/line` and answers a forged one with 401.
  - A loopback POST carrying `Origin: https://evil.test` answers 403.
  - A timestamped delivery 301 s old answers 401.

**5. Make `createEgressFetch` honour `redirect` and strip credentials across origins. Size: S. Source: Response 1.**
- **Evidence:** row 6.
- **File:** `tools/web/proxied-fetch.ts:187-201`: move MCP's same-origin rule into it.
- **Acceptance:**
  - With `redirect:"error"`, a 302 throws.
  - A cross-origin 302 is followed with no `authorization`, no token and no body.
  - An A2A peer's bearer never reaches the redirect target.

**6. Make CI tell the truth. Size: S. Source: Response 1.**
- **Evidence:** rows 4 and 10.
- **Files:** `.github/workflows/ci.yml:388-393`:
  - set `TRENT_TEST_LIVE=1`;
  - pass `GEMINI_API_KEY` (the proven live path);
  - run by `workflow_dispatch` until `main` carries the workflow.
- **Acceptance:**
  - One dispatched run shows the `*.live.test.ts` files executed (not skipped) in the job log.
  - Five consecutive green pushes after `723ef22` close the flake.

**7. Give auto-review the fleet's taint. Size: M. Source: Response 1 (S3).**
- **Problem:** a fleet bound row does not record that its step read untrusted text. The reviewer relies on a string marker, which B2 laundering removes.
- **Evidence:** row 5 and the compound note.
- **Files:** `governance/bound-approvals.ts` (store the step's taint sources on the row), `governance/auto-review-policy.ts:251` (refuse when the row is tainted), README.md:11-13 (name `auto_review`).
- **Acceptance:** a fleet step that ran `web_extract` and then a policy-eligible `external_send` produces a row that the auto reviewer escalates with `untrusted_provenance`, and no model call is made.

**8. Docs and README truth pass. Size: S. Source: Responses 1 and 4.**
- **Problem:** stale or false rows:
  - the iron-proxy row;
  - "12 adapters";
  - "untrusted writes held";
  - test counts;
  - the pairing text;
  - `getting-started` "private repo";
  - the AGENTS.md gate numbers.
- **Files:** README.md, `docs/*.md`, AGENTS.md (add B1, B2, B3 and the missing pairing command as defects).
- **Acceptance:** extend `apps/cli/src/commands/__tests__/docs-truth.test.ts:36` from 4 pages to every `docs/*.md`, with a check that every command a page names exists in `COMMAND_SPECS` (it would catch `gateway pair`).

**9. First live solo proof, with constrained output wired. Size: S plus one quiet hour. Source: Responses 2 and 3.**
- **Evidence:** row 13.
- **File:** `apps/cli/src/runtime/runner-for-mode.ts:307-313`: pass `responseFormat: soloResponseFormat(adapters)` on a local alias.
- **Acceptance:**
  - A unit test asserts the solo request carries `response_format` under a local alias and not under a hosted one.
  - Under `TRENT_TEST_LIVE=1`, a three-turn `qwen3.5:9b` session makes at least one real tool call per turn and prints the ledger cents.
  - Only after this, and after S3's memory gate lands, consider solo as the default.

**10. Durability and key hygiene. Size: S-M. Source: Response 1 (S10, M4) and Response 4 (gap 6).**
- **Evidence:** rows 8, 20, 24.
- **Files:**
  - `service/install.ts`: report `durable:false` under Node and exit 3 without `--allow-ephemeral`.
  - `governance/hardline.ts:139-145`: add `keys/audit.key`, `egress/ca.key` and `egress/tokens.json` to the read rule.
  - `audit/export.ts`: include or cross-sign `approvals-audit.ndjson` and `attach-audit.ndjson`.
- **Acceptance:**
  - `service install --dry-run --json` under Node reports `durable:false` and exits 3.
  - A terminal `cat <profile>/keys/audit.key` is refused by the hardline.
  - `trent audit verify` fails when one line of `approvals-audit.ndjson` is edited.

**After these ten:** Response 3's public bench (Trent solo against Hermes on the same model and tools) and Response 2's solo compaction with overflow recovery. Neither should be published or pitched while items 1-2 are open, because the pitch is "trust and proof".
