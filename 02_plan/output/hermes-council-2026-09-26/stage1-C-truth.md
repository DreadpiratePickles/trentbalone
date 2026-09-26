# Stage 1, Reviewer C: truth, quality and risk (2026-09-26)

Read-only review of `feature/trent-fleet-v2` at HEAD `79fa451` plus the uncommitted tree (70 modified files,
+1,918/-680; about 127 untracked source/doc files, ~12.8k lines, from S2, H3, H5, L1, S3, P3). Hermes source
read at `/Users/bobbymeher/.hermes/hermes-agent` (`49eb7b5dba`). No test suite was run (load ~380, by
instruction); every claim below cites a file:line, a `git show HEAD:` read, a `gh` command, or a CI job log.
"HEAD" means committed; "tree" means built, not landed.

## 1. Summary verdict (10 lines)

1. Three blockers that no document admits: the egress broker sends the user's model API key to every allowlisted host, not only the provider's.
2. "Untrusted memory writes are held" is false on every production run: the fleet's `memory` adapter is appended after the provenance gate.
3. WhatsApp, LINE and Home Assistant are counted in "12 adapters", but since 2026-09-12 no production code opens the webhook listener they need.
4. CI is green at HEAD (run 36217966870; 4,464 core tests), but 9 of the last 44 first attempts were red, and 26 live suites have never run in CI.
5. The live-test job cannot run the live files even when triggered: CI sets `TRENT_LIVE_TESTS`, and vitest reads `TRENT_TEST_LIVE`.
6. The durability claim rests on one test (approvals.restart) that failed in 3 CI runs. Its root cause is only partly addressed in the tree.
7. The README's headline promise ("asks you first at every autonomy level") is not true once `governance.auto_review` is on, and the README never mentions it.
8. Local models: `setup --mode local` writes `agent.mode: solo`, which no surface reads at HEAD. The fleet it falls back to finished 0 of 2 steps in 10 minutes.
9. Process risk: ~14k lines are unlanded across 5 waves in one shared tree, landed by regex over 1,858 wave markers. The 500-line cap is met by packing lines up to 372 characters.
10. Trent is genuinely ahead of Hermes on gating sends and money and on taint rules. Those advantages are undercut until B1 and B2 are fixed and CI proves them.

## 2. Claims checked

| # | Claim | Source | Evidence | Holds? |
|---|---|---|---|---|
| 1 | "`trent doctor` runs 23 checks" | README.md:47 | `DEFAULT_CHECKS` in `doctor/DoctorRunner.ts:68-95` has 23 entries | Yes |
| 2 | "Messaging: 12 adapters" | README.md:175 | `registry.ts` registers 12. `git grep -n "WebhookServer" HEAD -- packages/trent-core/src apps/cli/src` finds only the class (`WebhookServer.ts:13`) and a re-export (`gateway/index.ts:13`). Nothing constructs it, so whatsapp, line and homeassistant (webhook-only) can never receive | No: 9 of 12 can receive at HEAD |
| 3 | Credential isolation is "the same design (iron-proxy)" as Hermes | README.md:171 | Trent: `CredentialBroker.ts:79-110` injects the record's secret for any allowlisted host. Hermes: `iron_proxy.py:84-87` maps each key to its own hosts, and `:532` writes `"rules": [{"host": h} for h in m.upstream_hosts]` | No |
| 4 | "Anything that sends a message, moves money or touches a customer asks you first at every autonomy level" | README.md:11-13, :195-198 | `governance/auto-review*.ts` and `docs/security.md` "Auto review" let a model approve up to `max_class: money`. `grep -n "auto.review\|reviewer" README.md` finds 0 lines | No, when `auto_review.enabled` |
| 5 | "a repeat is answered from the idempotency store instead of sent twice" | README.md:197-198 | `idempotent-dispatch.test.ts:68,96`: the key is {run, step, tool, args}. `business/stripe.ts:12,89` sends a Stripe `Idempotency-Key` | Yes, within one run and step |
| 6 | Hash-chained audit export with a detached Ed25519 signature | README.md:174 | `audit/export.ts`, `audit/signing.ts`. `commands/groups/audit.ts:58-64` refuses to export without the Bun store. `approvals-audit.ndjson` and `attach-audit.ndjson` are separate chains that are never exported | Bun only; covers 1 of 3 chains |
| 7 | "recall@8 over a golden set is a gate" | README.md:203 | `retrieval-config-schema.ts:17` sets `min_recall` 0.9. On real docs the shipped hybrid scores 0.629 (README.md:231-232), and `docs-corpus.test.ts:47-48` pins a floor of 22/35 | The gate exists; the product fails it |
| 8 | The judge runs on a different model | README.md:204-206 | `improve/judge-model.ts:83-110` refuses judge == executor, and refuses a hosted judge under a local provider | Yes (same model family allowed) |
| 9 | `--max-cost-cents` exits 6 | README.md:199-200 | `errors/TrentError.ts:40` `BUDGET: 6`; `commands/__tests__/run.test.ts:423` | Yes |
| 10 | Imports md, txt, csv, pdf, docx and xlsx | README.md:180 | `fleet-memory/ingest/extract.ts:27-30` | Yes |
| 11 | A2A client, with every send behind the gate | README.md:182 | `tools/a2a/index.ts:5-11` (`a2a_send` is `external_send`). The proof comments at README.md:183 and :249 still say "(no client)" | Yes; the proof comments are stale |
| 12 | "A reranker is decided, not landed" | README.md:233 | It landed in `0f740e6`, but `recallFromBrain` is called only from `retrieval-eval.ts:83` and `retrieval-metrics.ts:73`. `brain.rerank.mode: llm` changes no seat run | Misleading: a dead config key |
| 13 | "3953 passed, 23 skipped (404 files)" | README.md:305 | HEAD run 36217966870, job 108338230512: `Tests 4464 passed \| 23 skipped`, `Test Files 453 passed` | Stale (it is dated) |
| 14 | "`cd apps/web && npm test` -> 505 files, 2743 tests"; "root `vitest run` ... yields two phantom failures. Never use it as the gate" | AGENTS.md:40-41 | Job 108338230477: 528 files, 2829 passed and 125 skipped. `vitest.config.ts` excludes `apps/web`, and CI's core gate is the root `vitest run` (453 files, 0 failures) | No: stale and contradicted |
| 15 | The marker grep "prints 24 lines"; the anchored grep prints 0 | AGENTS.md:106-115 | The broad grep prints 28 lines (all identifier matches: `tool-names.ts:38,80`, `mcp-server/toolset-tools.ts:60`); the anchored grep prints 0 | Anchored grep holds; the count is stale |
| 16 | `@trent/core` imports at least 8 `lib/` modules | AGENTS.md invariant 3 | `wrapped-modules.test.ts:73-80` | Yes |
| 17 | A memory write made from untrusted context is held | scorecard row 25; `tools/memory/holds.ts:1-14`; `docs/getting-started.md` s.8 | See B2: the hold is proven only through the `extraAdapters` test seam (`provenance.test.ts:191-213`), which no production caller uses | No |
| 18 | "a redirect is now followed only to the same origin" (H2) | h2 log; commit 2095c7d | True in `tools/mcp/http-transport.ts:5-73` only. `createEgressFetch` (`proxied-fetch.ts:182-209`) still re-sends every header and the body on any redirect, and ignores `init.redirect` | Only for MCP |
| 19 | The nightly run makes the live provider tests mandatory | ci.yml:27-32, :366-393 | `gh run list --limit 200 --json event` gives `{"push":169}`: 0 scheduled runs. The job sets `TRENT_LIVE_TESTS`/`TRENT_REQUIRE_LIVE_TESTS`; `vitest.config.ts:8` reads `TRENT_TEST_LIVE` | No |
| 20 | "Trent can run on a model served from your own machine" | docs/local-models.md:3 | Its own table (:151-156): tool-call smoke 1/5; fleet run "0 of 2 steps" (10-minute timeout). Solo is not wired at HEAD (:84-86) | Not proven end to end |
| 21 | The password-field refusal is covered by a real-Chromium test (H5) | h5 log :113-116 | `browser.attach.chromium.test.ts` is untracked; it skips without Chromium (h5 log :14) | Not landed; not in CI |
| 22 | "LINE forged request 401 over real HTTP" (H4) | harness-landscape log :316-317 | The adapter test starts its own server. Production has no listener (row 2) | The test holds; the feature is unreachable |

## 3. Findings, ranked

### Blockers

**B1. The egress broker sends the active provider's real API key to every allowlisted host.**
- Evidence:
  - `sed -n 79,110p packages/trent-core/src/egress/CredentialBroker.ts`: after the own-credential check, `out.authorization = \`Bearer ${secret}\`` (:108) runs for any host that is not `*anthropic.com` or `*googleapis.com`. The token record carries no host binding (`TokenStorePort.ts:12-21`).
  - `EgressProxy.ts:294-308`: the only checks are "host in `intercept_domains`" and "token resolves"; then `applyCredentials`.
  - One token per process carries `{apiKey: <provider key>}` (`git show HEAD:apps/cli/src/repl/tools.ts` :161 `issueToken("trent-repl", input.credentials…)`, :191-196 `providerCredentials`).
  - The Chromium toolset sends that token on every request (`git show HEAD:…/browser/session.ts` :95 `setExtraHTTPHeaders({"x-trent-proxy-token": …})`). The web and vision clients send it too (`proxied-fetch.ts:149`).
  - Only business, a2a and mcp opt out with the own-credential marker (`grep -rln "withOwnCredential\|OWN_CREDENTIAL_HEADER"`).
  - `docs/browser.md:106` tells users to add the sites they browse to `intercept_domains`.
- Impact: every page the browser toolset loads on an allowlisted site, and any allowlisted host a sandboxed command reaches with the token, receives `Authorization: Bearer <GEMINI/OPENAI key>`.
- Why the tests miss it: `browser.chromium.test.ts:57` mints the token with `{}` credentials and asserts only that the token header is absent. `CredentialBroker.test.ts:60-135` tests provider hosts only.
- Fix: bind each token record to its provider's hosts, as iron-proxy does, and inject nothing elsewhere. Write the failing test first: "a request to an allowlisted non-provider host carries no provider key".

**B2. Memory writes made from untrusted context are never held in a real run.**
- Evidence:
  - `buildTrentTools` wraps only what it builds, via `provenanceAdapters` (`git show HEAD:…/tools/index.ts` :411). `memory` is not in `IMPLEMENTED_TOOLSETS` (:265).
  - The hook's `memory` is created bare (`apps/cli/src/repl/fleet-memory.ts:171`). The runtime wires tools (`headless.ts:278`) before the hook exists (`:305`). The orchestrator then appends the hook adapters after the chain: `const allTools = [...(deps.tools ?? []), ...(deps.fleetMemory?.adapters ?? [])]` (`orchestrator/index.ts:192`).
  - `git grep -n extraAdapters HEAD` returns only a test fixture (`mcp-server/__fixtures__/serve-fake.ts:47`), yet `provenance.test.ts:191-213` proves the hold through exactly that seam.
  - The memory adapter has no taint check of its own (`git show HEAD:…/tools/memory/index.ts | grep -n "taint\|provenance"`: 0 lines).
  - S3's fix (`solo/memory-gate.ts`, tree) is solo-only by its own header. The fleet, the default mode, keeps the hole.
- Impact: a web page read in step N can plant text in the shared `MEMORY.md` that every seat loads next run. This is the exact attack the C5 design exists to stop.
- Fix: wrap `fleetMemory.adapters` with `provenanceAdapters` plus `holdMemoryWrite` at `orchestrator/index.ts:192`. Add a headless-level red test: `web_extract` then `memory add` in one step returns `needs_approval`.

**B3. Three advertised adapters cannot receive a message at HEAD, and have not since 2026-09-12.**
- Evidence:
  - The `git grep` in claim 2 above. The class was introduced in `02e9929` and never wired into `gateway start`.
  - The inbound path of `whatsapp`, `line` and `homeassistant` is `handleWebhook` only (P3 log, "Findings before code"). Telegram and Slack lose inbound in their webhook modes.
  - `docs/gateway.md` (HEAD) admits it for LINE and WhatsApp, and links `docs/webhooks.md`, which is not in HEAD (`git cat-file -e HEAD:docs/webhooks.md` fails).
  - `registry.test.ts` asserts only that the twelve are registered.
- Fix: land P3's `openAdapterWebhooks` (tree `servers.ts:50-62`) with an end-to-end test: `gateway start` plus a signed POST to `/webhooks/whatsapp` reaches the handler. Until it lands, the README must say 9 of 12 receive.

### Serious

**S1. Live provider tests have never run in CI, and could not.**
- Evidence: 26 `*.live.test.ts` files (`git ls-files … | grep -c live`). `ci.yml:390-393` sets `TRENT_LIVE_TESTS` and `TRENT_REQUIRE_LIVE_TESTS` but not `TRENT_TEST_LIVE`, the variable `vitest.config.ts:8` reads. The job passes only `ANTHROPIC_API_KEY`, while the proven live path is Gemini. There have been 0 scheduled runs, because the schedule fires only on `main`, which lacks the workflow.
- Fix: set `TRENT_TEST_LIVE=1` and `GEMINI_API_KEY` in the job, and trigger it by `workflow_dispatch` until `main` carries the workflow.

**S2. The approvals.restart flake is the only proof of "approvals survive a restart".**
- Evidence: see section 4. The analysis:
  - `derive-sqlite-schema.test.ts` runs `prisma generate` into the shared `src/store/generated` (`scripts/derive-sqlite-schema.mjs:155`, HEAD).
  - vitest 3.2.7 runs the "exclusive" and "parallel" projects together: `sequence.groupOrder` defaults to 0 for every project (`node_modules/vitest/dist/chunks/coverage.*.js`: `groupOrder ?? 0`).
  - Two Bun-spawning suites that load the generated client remain in "parallel": `improve/store.test.ts:37` (via `sqlite-scenario.ts` → `store/createStore.ts:8`) and `audit/export.test.ts:223` (via `store/scenarios.ts:11`).
  - The tree's in-flight fix (`derive-sqlite-schema.mjs --out-root`) removes the in-place rewrite. It does not make "exclusive" exclusive.
- Fix: land `--out-root`, set `sequence: {groupOrder: 1}` on the exclusive project, move both Bun suites into `EXCLUSIVE`, then run CI five times.

**S3. `auto_review` contradicts the README, and its untrusted check is a string match.**
- Evidence:
  - Claim 4 above.
  - `auto-review-policy.ts:76,252` escalates only when the preview or arguments contain `[provenance: untrusted` or `[untrusted]`.
  - `docs/security.md` "Limits, stated": "A bound row does not record whether its step read untrusted text". Meanwhile the reviewer model is fed attacker-influenced preview text.
  - P3 (tree) stamps `untrusted_inbound` for solo only: "The policy ring of a fleet run is private to the PolicyDispatcher … `tools/index.ts` is at 500 lines and not this agent's" (p3 log, "Findings before code").
- Fix: expose the fleet ring and refuse auto-review of any row from a tainted step. Name `auto_review` in README.md:11-13 and :195-198.

**S4. `createEgressFetch` re-sends every header and the body on a redirect to any host and ignores `init.redirect`.**
- Evidence: `proxied-fetch.ts:188-201` (HEAD). `a2a/client.ts:181` passes `redirect: "error"`, which is ignored, so an A2A peer's bearer follows a redirect. Only MCP wraps it (`http-transport.ts:40-73`).
- Bound: the target must be in `intercept_domains`.
- Fix: honour `redirect`, and drop `authorization`, the token and the body on a cross-origin hop, inside `createEgressFetch` itself.

**S5. H3 webhooks (tree) accept a browser page's POST, and generic HMAC has no replay window.**
- Evidence:
  - `webhooks/engine.ts:113-114` accepts `none-localhost-only` when the peer and the listener are loopback, with no `Origin`, `Host` or `Content-Type` check. Any site the owner visits can `fetch("http://127.0.0.1:<port>/…", {method:"POST", mode:"no-cors"})` and start a run.
  - `signature.ts:81-91`: the `github` and `hmac-sha256` variants bind no timestamp, so after the 24 h dedupe a captured delivery starts a new run. Hermes binds a timestamp in HMAC V2 (`gateway/platforms/webhook.py:7-8,85`).
- Fix: refuse any request carrying an `Origin` header or a non-JSON content type on loopback routes, and add a timestamped HMAC scheme before landing H3.

**S6. A fresh clone cannot run the suite from the documented steps.**
- Evidence:
  - `postinstall` generates only the core client (`package.json:11`). The web Prisma client is required, or suites die with "@prisma/client did not initialize yet" (`ci.yml:228-230` comment).
  - Bun is required: `improve/store.test.ts:24` and `audit/export.test.ts:41` throw "bun not found"; they do not skip.
  - `CONTRIBUTING.md:51` lists only `npx vitest run packages/trent-core apps/cli`.
- Fix: add the web `prisma generate` to `postinstall` and turn missing Bun into a skip with a reason, or document both in `CONTRIBUTING.md`.

**S7. The local-model path at HEAD sets a mode nothing reads.**
- Evidence:
  - `docs/local-models.md:81-86`: setup writes `agent.mode: solo`; "until it lands, every surface runs the fleet".
  - Measured: fleet 0 of 2 steps in 10 minutes; tool-call smoke 1/5 (:151-156).
  - L1's constrained-output A/B (`seat-constrained.live.test.ts`, tree) and S1.1's "new format's live smoke on the 9B is NOT measured" (harness-landscape log :270-271) are unrun.
- Fix: land S2 before advertising `setup --mode local`, then record one live solo turn on `qwen3.5:9b`.

**S8. The landing process is itself a defect source.**
- Evidence:
  - 1,858 wave markers, 67 distinct tags, in `packages/trent-core/src` and `apps/cli/src`, tests included (`grep -rhoE "\[(S[0-9]…)\]" … | wc -l`). They are load-bearing for `scripts/dev/hunks.py` and dropmarks landing.
  - Recorded mis-assemblies: L0-1's first attempt "carried L0-5's unlanded embedder import"; S1's "failed at regen-snapshot"; L0-1 "still red on docs-truth" (harness-landscape log :175, :230-231, :291).
  - Several agents edit one tree at once. P3's baseline has a foreign red (`boot.test.ts`).
- Fix: one worktree per agent, land in dependency order, and delete markers once a wave lands.

**S9. Duplicated concepts.**
- Evidence:
  - `solo/` is 42 files and ~3,900 non-test lines. It re-implements the loop, holds (`solo/holds.ts` beside `governance/bound-approvals.ts`), park and resume, compaction (`solo/compaction.ts` beside `sessions/compaction.ts`), delegate (`solo/delegate.ts` beside `tools/delegate`) and a session store (`solo/session-store.ts` beside `sessions/SessionStore`).
  - Approval truth lives in `gateway.json` and, under Bun, in SQLite.
  - There are three audit chains.
- Fix: before S4, write down which module owns each concept, and delete the loser within the next wave.

**S10. The taught path (`npm run cli`, Node) is not durable.**
- Evidence: AGENTS.md defect 9 is still open (`headless.ts` `openStore` → `EphemeralStore`). Under Node: `trent audit export` refuses; improve drafts, runs and the audit chain vanish on exit. The spend ledger is file-based and does survive (`governance/spend-ledger.ts` header). `docs/getting-started.md:18,44` wrongly say budget does not survive.
- Fix: a Node SQLite driver (node:sqlite) behind `StorePort`, or make `cli` the Bun path and say so.

### Minor

- **M1. Line-packing to meet the 500-line cap.**
  - Near-cap files: `tools/index.ts` 499 lines (:94 is 322 characters), `improve/sweep.ts` 499, `fleet-memory/orchestrator-hook.ts` 499, `repl/engine.ts` 496, `model-gateway/index.ts` 491 (:242 is 291 characters), `headless.ts` 487 (:426 is 372 characters).
  - 31 non-test files are at or above the rulebook's 400-line review trigger. `headless.test.ts` has 600 lines.
  - The cap already blocked a security fix (S3).
  - Fix: split `tools/index.ts` (build, wrap, exports) and `headless.ts` first.
- **M2.** `brain.rerank` is a user-settable key that does nothing (claim 12). Fix: wire it or remove it from the schema.
- **M3.** AGENTS.md drift.
  - Defect line numbers moved: `rate-limit.ts:22` (not :21); the golden `writeFile` is at `orchestration-golden-capture.ts:109` (not :112).
  - Defect 8's "logs the raw objective text" is unproven: `model-gateway.ts:268-269` logs `error.message` only.
  - AGENTS.md:105 ("nothing deferred") contradicts the "Open" lists in the h2, h3, h5 and p3 logs.
  - Fix: re-verify each defect and add B1-B3.
- **M4. Secrets reachable by the local backend.**
  - The audit signing key is in the profile it signs (`audit/signing.ts:4`).
  - The hardline read rule covers only `.env` and `~/.ssh` (`hardline.ts:140-146`). It does not cover `keys/audit.key`, or `egress/tokens.json`, which holds `realCredentials` when the file store is used (`TokenStorePort.ts:101`).
  - Fix: add both to the read rule.
- **M5.** `node <scratch>/dead.mjs` finds 421 of 2,859 exports named in no other file and 267 named only in tests. This is an upper bound, since `export *` barrels can hide uses.
- **M6.** ntfy approvals reduce to the secrecy of the topic name: the reply topic is the paired admin (`docs/gateway.md` HEAD, the ntfy bullet).
- **M7.** With `OPENAI_API_KEY` present, the app's embeddings send objectives to OpenAI whatever `provider` is (`apps/web/lib/wiki-embeddings.ts:106-115`, `semantic-router.ts:90-97`). This is Bobby's decision item; name it in `docs/security.md` until then.

### AGENTS.md defect list: status re-checked

| Defect | Status | Evidence |
|---|---|---|
| 1 | Open | `lib/session.ts:51` still reads `if (!process.env.DATABASE_URL) return true` |
| 2 | Open | `lib/rate-limit.ts:22` (was listed as :21) |
| 3 | Open | `next.config.ts:37` |
| 4 | Open | `lib/heartbeat.ts:335-336` still passes `InMemoryTraceStore` and `InMemorySkillDraftStore` |
| 5 | Open | `lib/session.ts:75` |
| 6 | Open | `lib/outbound/sequences.ts:22` still returns `step: input.steps[0]`, and `.sort` still mutates the caller's array |
| 7 | Open | `lib/worker.ts:29-38` allowlist lacks `weekly_capability_sweep`; `middleware.ts:10-21` has no Stripe bypass while `app/api/marketing/stripe/webhook/route.ts` exists |
| 8 | Open | `cacheKeyForSeatModel` (`model-gateway.ts:283-300`) omits `toolLoopContext`; `writesOnFinish` is only rendered (`agent-runtime.ts:209`) |
| 9 | Open | See S10 |

Newly wrong: nothing is closed. Newly missing: B1, B2, B3 and S4 belong on this list.

## 4. CI and flake analysis

**HEAD run 36217966870 (79fa451): all 22 jobs succeeded.**

| Suite | Result |
|---|---|
| core | 453 files; 4,464 passed, 23 skipped (job 108338230512) |
| web | 528 files (13 skipped); 2,829 passed, 125 skipped (job 108338230477) |
| docker | 36 files; 268 passed (job 108338230560) |
| binaries | 4 built, and each run on its own OS |

Skips in core, all capability-gated: `terminal.test.ts` 8/9, `file-ops.test.ts` 10/20, and 1 each in `voice-notes`, `web`, `units`, `desktop` and `code-execution`. Live suites: 26 files excluded, and the live job was skipped (S1).

**First-attempt reds since 36190034393: 9 of 44 runs** (3 of the 44 were cancelled).

| Cause | Runs | Detail |
|---|---|---|
| Windows EBUSY on rmdir | 36190034393, 36190113663, 36192189402, 36192624798, 36193704901, 36193812293 | Job 108265608140: `FAIL a project .env.local … EBUSY: resource busy or locked, rmdir …trent-verify-dotenv-cwd…`. Fixed by 4c05f65 and 04c0983; none since. |
| approvals.restart | 36191653032 (7eb7502, job 108257994441, parallel project), 36194277396 (a23efa5, job 108266915277, parallel), 36217278037 (5989ac8, job 108336057865, exclusive, i.e. after 68894ea's serialisation) | Each: `error: Cannot find module './internal/class' from '…/store/generated/client.ts'`. The file shows `(3 tests \| 3 skipped)` because `beforeAll` died. Green on rerun each time. Causes: S2. |
| Earlier: `browser.chromium.test.ts` | 35905708927 attempt 1 (job 107332800916) | 2 failed, "navigates through the proxy tunnel". Addressed by daab6e6 and 981218c. |

Cancelled (superseded) runs: 36203988050, 36198212636, 36193931038.

**Local-only flakes named in today's logs:** none of these has run in CI yet.
- `repl/__tests__/boot.test.ts`, a wall-clock "no prompt appeared" (p3 log baseline).
- `runtime/headless.app-store.test.ts`, "static graph" hitting 60 s under load (l1 log 01:52).
- `improve/golden-capture.test.ts` under load.
- The H5 attached-Chromium click timeout (h5 log :117).

**What a fresh clone must do to get a green core run:**
1. Node 22 (`apps/web/package.json` engines; Node 26 warns).
2. `npm install`.
3. `npx prisma generate --schema apps/web/prisma/schema.prisma` (not in postinstall).
4. Bun 1.4.x on `PATH` or `TRENT_BUN_BIN`, or two suites fail.
5. Unset `REDIS_URL`, `TRENT_EVAL_SYNC_QUEUE` and the Upstash variables.
6. Run nothing else in the same checkout: the derive test rewrites the shared generated client until `--out-root` lands.
7. Docker, Chromium and ffmpeg are optional; without them their suites skip.

## 5. Security comparison with Hermes

**Where Hermes prevents what Trent allows**

| Area | Trent today | Hermes | Consequence in Trent |
|---|---|---|---|
| Credential broker | Any allowlisted host gets the provider key (B1) | iron-proxy host-bound secrets (`iron_proxy.py:84-87,532`), pinned and checksum-verified binary (:37-43) | Browsing an allowlisted site leaks the model key |
| Webhook replay | Generic and GitHub HMAC have no timestamp; loopback routes have no Origin check (S5, tree) | HMAC V2 binds a timestamp (`webhook.py:7-8,85-90`); body-size cap checked before reading (:445) | A replay after 24 h, or a drive-by page, starts a paid run |
| Secret storage | Plaintext `<profile>/.env` (0600); no vault source | `agent/secret_sources/{bitwarden,onepassword,command}.py`; credential pools | Keys sit on disk. Hermes defaults to `.env` too, but can avoid it |
| Browser logins | Refuses to type into a password field (H5, tree) | `tools/browser_vault_tool.py`: model-blind autofill bound to an exact origin | Trent cannot log in at all, which is safe but useless for the social and mom-and-pop users |
| Command screening | Hardline list plus deny globs | Hardline, smart classifier (`tools/approval_smart.py`), Tirith (`tools/tirith_security.py`), `website_policy.py` | Similar floor; Hermes has more layers |
| Redirects | Header and body re-sent cross-origin outside MCP (S4) | Not verified in this review | Unverified in this review |

**Where Trent prevents what Hermes allows**

| Area | Trent | Hermes | Consequence in Hermes |
|---|---|---|---|
| Sends and money | Class floor asks at every autonomy level; approval bound to exact arguments and to a Stripe `Idempotency-Key` (`governance/bound-approvals.ts`, `business/stripe.ts:12`) | `grep -c approv tools/send_message_tool.py` finds 0; YOLO skips all but the hardline | An injected instruction can message anyone the gateway reaches |
| Taint rules | Send-after-untrusted and read-secret-then-send in `governance/policy-rules.ts` (fleet); session taint in solo | Delimiter-wrapping of untrusted tool results only (`agent/tool_dispatch_helpers.py:409-415`) | No sequence rule stops exfiltration after an injected read |
| Webhook dedupe | Survives a restart (H3, tree: `deliveries.jsonl`) | `_seen_deliveries` is an in-memory dict (`webhook.py:184`) | A redelivery after a restart runs twice |
| Audit | Ed25519-signed, hash-chained export (Bun only) | No signed export found in the inventory | No offline-verifiable trail |
| Attach to the owner's Chrome | Loopback CDP only; approval per action bound to site, element and occurrence; no JS evaluation | `gateway/browser_control_broker.py` (not deep-read) | Not compared in depth |

**Careless user in Trent.** A careless user can:
- enable `auto_review` with `max_class: money` and a broad `recipients` list, believing the README's "always asks";
- add a site to `intercept_domains` for the browser toolset and leak the model key (B1);
- run on Node and lose every pending approval on exit;
- pair an ntfy topic with a guessable name, which makes anyone who guesses it an admin.

**Attacker against Trent.** An attacker can:
- plant instructions in a web page so a seat writes them into shared memory, where every seat reads them next run (B2);
- post to a loopback webhook route from a page the owner visits (S5).

## 6. What would embarrass Trent in a public side-by-side

1. "The same design (iron-proxy)", but Trent hands the model key to every allowlisted host and Hermes does not (B1).
2. The flagship "truth rule" memory has an injection path the docs say is closed (B2).
3. "12 adapters", but 3 have had no listener for two weeks (B3). Hermes lists 24+ platforms that receive.
4. No release: `gh release list` is empty, there are 0 tags, the installer URL returns 404, and the default branch is 280 commits behind with no LICENSE detected (`gh api …` license: null). Hermes is `curl | bash`.
5. The CI badge is green, while 26 live suites have never run and the nightly job has never fired (S1).
6. `npm run cli` forgets approvals on exit, and the test that proves Bun durability flakes (S2, S10).
7. The local-mode setup writes a mode nothing reads; the 9B finished 0 of 2 steps; the doctor's tool-call smoke scores 1/5 (S7).
8. Retrieval scores 0.629 against its own 0.9 gate, and the reranker config does nothing (claims 7 and 12).
9. Hermes has voice replies, a packaged desktop app, a 223-entry plugin catalog and model-blind password autofill; Trent has none of them (README.md:186-187 admits this).
10. The repo root and the tree show the process, not the product: 1,858 `// [S2]`-style markers in source, 499-line files with 372-character lines, and ~14k unlanded lines.
11. The docs contradict themselves: README test counts, AGENTS.md's gate numbers, and "(no client)" proof comments next to an A2A client row.

## 7. What I would do first, in order

1. B1: host-bind broker tokens.
   - Red test: Chromium through the proxy to an allowlisted non-provider host receives no `authorization`, `x-api-key` or `x-goog-api-key`.
   - Also mint the browser's and web's tokens with the own-credential marker.
2. B2: wrap `fleetMemory.adapters` with `provenanceAdapters` plus `holdMemoryWrite` at `orchestrator/index.ts:192`.
   - Red test: through `createHeadlessRuntime`, `web_extract` then `memory add` returns `needs_approval`.
3. Land P3's adapter listener with a `gateway start` end-to-end test (B3). Until then, correct README.md:175.
4. CI truth:
   - Land `--out-root`, add `groupOrder: 1`, and move `improve/store.test.ts` and `audit/export.test.ts` into `EXCLUSIVE`.
   - Fix the live job's env (`TRENT_TEST_LIVE=1`, Gemini key) and dispatch it once.
   - Then five green CI runs in a row.
5. README and AGENTS.md truth pass:
   - README: name `auto_review`; correct the adapters row, the iron-proxy row, test counts and proof comments.
   - AGENTS.md: correct the gate numbers; add B1-B3 and S4 to the defect list.
6. Egress hygiene: move MCP's same-origin redirect rule into `createEgressFetch`, and honour `redirect`.
7. Before H3 lands: an Origin and Content-Type refusal on loopback routes, and a timestamped HMAC option.
8. Stop the shared-tree landing. Land S2+H3, H5, L1, S3 and P3 one at a time from per-agent worktrees, then strip the markers.
9. Split `tools/index.ts` and `headless.ts` below 400 lines, then expose the fleet policy ring so auto-review refuses tainted rows (S3).
10. Only then S4: the live solo proof on `qwen3.5:9b` and the docs. Leave Bobby's release, `main` and tag decisions to Bobby.
