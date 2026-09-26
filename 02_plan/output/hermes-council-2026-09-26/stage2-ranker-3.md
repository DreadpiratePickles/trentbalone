# Stage 2, Ranker 3: the Hermes side of every comparison

Scope: the four anonymised stage-1 responses (R1 to R4). Emphasis: every claim about Hermes, checked in
source or public record. Read-only. No tests run, no subagents, KEY.txt not opened.

- **Hermes source:** `~/.hermes/hermes-agent` at `49eb7b5dba` (2026-09-20), `pyproject.toml` 0.21.3.
- **Hermes public record:** `gh api repos/NousResearch/hermes-agent` (read 2026-09-26).
  - 249,019 stars, 52,821 forks, MIT.
  - 58 tags and 36 releases.
  - v0.21.4 (2026-09-21) and v0.21.5 (2026-09-24) are both newer than the checkout. The checkout is
    therefore **two** patch releases behind, not one (R2 said one).
  - Every claim about a v0.21.4 or v0.21.5 feature rests on release notes only.
- **Trent:** HEAD `723ef22`, plus the tree. The responses read `79fa451`. `723ef22` landed
  `derive-sqlite-schema.mjs --out-root` (the first part of R1's S2 fix); nothing else they cite has moved.
- **Verdicts:** "holds", "partly" or "wrong". Hermes paths are relative to the checkout.

## 1. Verification table (Hermes side first, then the Trent claims each ranking depends on)

| # | Resp | Claim | Evidence (file:line, command or URL) | Verdict |
|---|---|---|---|---|
| 1 | R2 | Hermes sends native tool schemas on every provider | `agent/turn_request_assembly.py:197` `tools_for_api = agent.tools`; `agent/anthropic_adapter.py:635-636` `kwargs["tools"]`. The only `<tool_call>` text protocol is the trajectory-export prompt (`agent/agent_runtime_helpers.py:89-100`), not the live loop | holds |
| 2 | R2 | Four Anthropic cache breakpoints, 5m/1h TTL | `agent/prompt_caching.py:3-5` ("Default layout: 4 cache_control breakpoints", "5m or 1h"), `:84-86`. On whenever `_use_prompt_caching` is set (`agent_runtime_helpers.py:1270-1278`) | holds |
| 3 | R2 | `memory` tool does add, replace and remove | `tools/memory_tool.py:293` enum `["add","replace","remove"]`; dispatch at `:83-87`; limits `config_defaults.py:1280-1281` (2,200 and 1,375 characters) | holds |
| 4 | R2, R3 | Learns every 10 turns by default | Background review `enabled: True` (`config_defaults.py:777`); `nudge_interval: 10` (`:1283`). The memory review counts user turns (`turn_context.py:685`); the skill review counts tool iterations (`agent_init.py:1328`, `codex_runtime.py:608`). The review writes straight to the stores (`background_review.py:1-6`) | holds (skills: every 10 tool iterations) |
| 5 | R2 | Compaction at threshold 0.5, on by default | `config_defaults.py:544-556`: `enabled: True`, `threshold: 0.50`, but "windows below 512K are floored at 0.75". `context_compressor.py` is 5,299 lines | partly: effective 0.75 on most models |
| 6 | R2 | 8 parallel tool workers; unlimited turns; 250 iterations per child | `tool_executor.py:124`; `config_defaults.py:52` (`max_turns: None`); `:1322` (`max_iterations: 250`) | holds |
| 7 | R2 | Todo list per session, re-injected after compaction | `tools/todo_tool.py:1-4` | holds |
| 8 | R2 | Hermes system prompt: identity, tool-use enforcement, completion, parallel-call, platform and environment hints | `agent/prompt_builder.py` :158, :345, :380, :408, :634, :1056: each line is exactly the cited constant | holds |
| 9 | R2 | 41 provider plugins | `ls plugins/model-providers` finds 39 directories | partly (39) |
| 10 | R3 | `response_format` is used only for auxiliary calls | `grep -l response_format agent/*.py`: `auxiliary_client`, `auxiliary_structured_output`, `plugin_llm`, `title_generator`; none in `conversation_loop.py` or `turn_request_assembly.py` | holds |
| 11 | R3 | 208 skills (59 bundled + 149 optional) | `find skills -name SKILL.md` gives 58; `optional-skills` gives 150; total 208 | holds (split is 58/150) |
| 12 | R3, R4 | Portal OAuth and a free tier; R4: "guest free tier minted at boot", "Hermes users start with zero credentials" | README.md:124-137 (`hermes setup --portal`, "300+ models"). The zero-credential guest needs `HERMES_GUEST_ONBOARDING=1` (`hermes_cli/anon_auth.py:145-149`; desktop `electron/guest-onboarding.ts:1-21` has an opt-in flag). The v0.21.2 notes say free inference "with one command to sign in", and the guided first launch sits "behind `HERMES_GUEST_ONBOARDING=1`". The public docs home shows the Portal OAuth path only | R3 holds; R4 partly: a free tier exists, but by default it needs a sign-in |
| 13 | R3 | Cost is "a local lower-bound estimate", off by default | `website/docs/user-guide/configuration.md:3052`, verbatim. The only caps are server-side Nous member caps (`hermes_cli/nous_account.py:52-55`); a grep of agent, CLI, tools and gateway finds no local per-run cap | holds |
| 14 | R3 | Hermes Business on 2026-09-15 with per-member caps | tao.media article dated 2026-09-15: "shared credit balance while assigning per-member caps" | holds |
| 15 | R3 | v0.21.5 on 2026-09-24: 460 PRs, 1,610 commits, 4,828 files; v0.21.4 about 1,800 PRs; Desktop Simple mode; FR/DE/ES | GitHub release bodies for `v2026.9.24` and `v2026.9.21` (the latter says 1,812 merged PRs) | holds |
| 16 | R3 | 249,012 stars | `gh api` shows 249,019 today | holds |
| 17 | R3 | Weak spot: "no way to simulate answers on past tickets" (eesel) | The quote is real (eesel.ai, 2026-07-19). The author works at eesel, and the article sells eesel's support product. `grep -ril "rehears\|shadow_mode"` over agent, CLI, gateway and tools: 0 hits | holds as a fact about the code; the source is a competitor |
| 18 | R3 | On Qwen 27B, Hermes scores 74.0% and a local-shaped harness 82.6% | Perplexity's own self-reported bench, "to be open-sourced" (`harness-others-2026-09-26.md:134-136`), on 27B, not 9B | partly: a vendor claim, not re-runnable |
| 19 | R3 | Silent cloud fallback after 3 local failures | `website/docs/guides/local-ollama-setup.md:252-262` ("Set Up Fallbacks (Optional)", `fallback_providers`), `:314`. At `:273`, Hermes *refuses* to fall back to a cloud key when no local endpoint is configured | partly: opt-in, not silent by default |
| 20 | R3 | Open issues #89207 (truncated arguments become `{}`), #12238 and #18715 | `gh api .../issues/N`: all open; 38 and 36 reactions | holds |
| 21 | R3 | "The egress broker only matches Hermes; it is not a lead" | Hermes binds each key to its own hosts (`agent/proxy_sources/iron_proxy.py:82-87`, `:532` `"rules": [{"host": h} …]`) and checksum-verifies the binary (`:37-43`). Trent injects the key for any allowlisted host (`egress/CredentialBroker.ts:101-108`) | **wrong: Trent is behind** (R1's B1) |
| 22 | R1 | Webhooks: Hermes HMAC V2 binds a timestamp; dedupe is in memory | `gateway/platforms/webhook.py:6-8` ("V2 binds a timestamp"; "body-only V1 is deprecated but accepted with a warning"); `:184-185` (in-memory dict, 1 h TTL); `:442-446` (size cap before read). No `untrusted` or `provenance` in the file | holds (Hermes V1 is still replayable) |
| 23 | R1 | `send_message` is never approval-gated | `grep -ci approv tools/send_message_tool.py` gives 0 of 808 lines. It appears only in the stall-guard lists (`agent/tool_guardrails.py:28-31,62-65`) | holds |
| 24 | R1 | Untrusted results are delimiter-wrapped only; no sequence or taint rules | `agent/tool_dispatch_helpers.py:407-415`. Grepping "taint" finds no session taint (only env-scope comments) | holds |
| 25 | R1 | Model-blind vault autofill bound to an exact origin | `tools/browser_vault_tool.py:1-14` | holds |
| 26 | R1, R3, R4 | Hermes has no signed or hash-chained audit export | Grepping `hash.chain\|prev_hash\|ed25519` finds only ssh-key filename patterns | holds |
| 27 | R1 | Plugin catalog has 223 entries (R3: 285) | Checkout: 215 `plugin-catalog/*.yaml`. The inventory's later row gives 285 (`hermes-feature-inventory-2026-09.md:883`) | R1 stale; R3 plausible, not checked in source |
| 28 | R4 | 102 slash commands | `grep -c 'CommandDef(' hermes_cli/commands.py` gives 102, including platform-only ones (such as `start`) | holds |
| 29 | R4 | About 30 platforms (R3); "22 plugins plus 6 core" (R4); "24+" (R1) | `plugins/platforms`: 22 directories, including `a2a`. Core `gateway/platforms`: bluebubbles, signal, whatsapp_cloud, weixin, yuanbao, qqbot | holds (~27 chat platforms) |
| 30 | R4 | Install tests on three OSes; 3,949-line installer; 35 workflows; installer URL returns 200 | `install-e2e.yml:177,192,209` call the Linux, Windows and macOS runs; `wc -l scripts/install.sh` gives 3,949; 35 workflow files; `curl` returns 200 (Trent's returns 404) | holds |
| 31 | R4 | 29 tags | 29 is the local tag count; GitHub shows 58 tags and 36 releases | wrong (stale) |
| 32 | R4 | TUI 43,407 lines; desktop about 380k; web about 51k | Non-test `.ts`/`.tsx`: `ui-tui/src` 43,407; `apps/desktop/src` 324,648 plus `electron` 56,557; `web/src` 50,910 | holds |
| 33 | R4 | Trent is ahead on scripting because Hermes has `--json` in 7 of 62 modules | 7 of 63 subcommand files, but 8 more `hermes_cli/*.py` define `--json`. `--format stream-json` is already in the checkout (`hermes_cli/_parser.py:247`) | partly: Trent is ahead on uniformity only |
| 34 | R4 | Hermes: pairing list/approve/revoke; services on systemd, launchd, Windows and s6; config "did you mean"; ACP permissions and session load | `subcommands/pairing.py:10-28`; `service_manager.py:1,14`; `config.py:3193`; `acp_adapter/permissions.py:78-95`; `acp_adapter/server.py:537` (`load_session=True`) | holds |
| 35 | R4 | Hermes imports from Claude Code and Codex but exports only its own profiles | `hermes_cli/agent_import.py:1`; `subcommands/profile.py:115` | holds |
| 36 | R1 | B1: the provider key goes to every allowlisted host | Code read: `CredentialBroker.ts:101-108`; `repl/tools.ts:161,191-196` (HEAD) puts `apiKey` in the REPL token; `browser/session.ts:95` sends the token on every request | holds |
| 37 | R1 | B2: fleet memory writes skip the provenance hold | `orchestrator/index.ts:193` (tree) appends `fleetMemory.adapters` after the chain that `tools/index.ts:411-415` wraps; `tools/memory/index.ts` has 0 taint/provenance hits | holds (code read, no test run) |
| 38 | R1 | The live CI job cannot run live files | `ci.yml:391-392` sets `TRENT_LIVE_TESTS`, while `vitest.config.ts:8` reads `TRENT_TEST_LIVE` | holds |
| 39 | R4 | `trent gateway pair` does not exist | `GatewayManager.ts:327` names it. The gateway subcommands in `servers.ts` are `status` and `start` only; `getPairing()` (`:181`) has no caller | holds: blocks every adapter |
| 40 | R2 | Trent sends no `cache_control`; messages are string-only; solo sends no `responseFormat` | 0 grep hits for `cache_control`; `model-gateway/types.ts:24-27`; `soloResponseFormat` has no production caller; `runner-for-mode.ts` is untracked and has 0 `responseFormat` hits | holds |
| 41 | R2 | "Untrusted memory writes held; landed" is a Trent strength | Contradicted for the fleet by row 37. The solo gate is tree-only (`solo/memory-gate.ts`) | wrong for the default mode |
| 42 | R1, R2, R3 | `auto_review` can approve up to money | `auto-review-config.ts:17` `["read","write","external_send","money"]`. README.md:11-13 says "asks you first at every autonomy level" | holds |

## 2. Rankings

**Accuracy: Response 1 > Response 2 > Response 4 > Response 3.**
**Decision value: Response 1 > Response 3 > Response 2 > Response 4.**

**Response 1 (security, CI, truth): first on both.**
- Every Hermes claim it makes holds in source: iron-proxy host binding, HMAC V2, in-memory dedupe, `send_message` ungated, delimiter-only defence, vault.
- Its Trent blockers hold on code read: B1, B2, the dead live-CI variable, the missing listener.
- It is the only response that shows a README claim ("the same design (iron-proxy)") to be false *against Hermes*.
- **Most important miss:** the absent `trent gateway pair` (row 39). R1 says "9 of 12 can receive"; in practice no unknown sender can be admitted by any adapter without hand-editing `gateway.json`.
- **Smaller slips:** Hermes still accepts replayable V1 HMAC (row 22), and the "223" catalog count is stale.

**Response 2 (loop): second on accuracy, third on decision value.**
- Its Hermes citations are the most precise of the four: every `prompt_builder.py` and `config_defaults.py` line it names is exact (rows 1-8).
- **Slips:** 41 providers (39); a 0.5 compaction threshold that is 0.75 in practice; "one patch behind".
- **Most important miss:** it lists "untrusted writes held (landed)" as a Trent strength. On the default fleet path that is false (row 41).
- **Security blind spot:** it never looks at egress or pairing.
- **Why it is useful:** it is the best map of *harness* parity (solo live proof, compaction, native tools and caching, correctable memory).
- **Why it ranks third on decision value:** it treats breadth after depth but never asks whether the loop should be built at all before a head-to-head.

**Response 3 (strategy): last on accuracy, second on decision value.**
- Its public-record numbers all hold: stars, release sizes, Hermes Business, lower-bound cost, issues (rows 13-16, 20).
- It gives the only falsifiable route to *surpass* Hermes: a same-model bench, rehearsal and graded learning.
- **Most important error:** "the egress broker only matches Hermes" (row 21). It is behind.
- **Other weak evidence:**
  - It anchors targets on a competitor-authored review (row 17) and on Perplexity's self-reported, unpublished bench (row 18).
  - It overstates Hermes's cloud fallback (row 19).
- **Sequencing error:** its first moves are "land the tree, Bobby tags v1.0.0". That would publish B1, B2 and the unpairable gateway.

**Response 4 (surfaces): third on accuracy, last on decision value.**
- Its Hermes size and ops counts hold to the line: 102 commands, 43,407 TUI lines, 3,949-line installer, three-OS install e2e, service backends (rows 28-35).
- It alone found the pairing blocker.
- **Wrong or partly:**
  - "29 tags" (58 on GitHub).
  - "Guest free tier minted at boot" (opt-in flag, row 12).
  - "Ahead on the scripting contract" (Hermes has `--format stream-json` and `--json` in 15 modules, row 33).
  - It calls signed webhooks "parity in tree" without noticing that Trent's generic HMAC has no timestamp.
- **Most important miss:** it ranks REPL depth, ACP, operator CLI and a web console. That is the breadth treadmill the verified numbers show Trent cannot win: 102 commands, 381k desktop lines, about 1,800 PRs per release.
- It never reaches the key leak or the memory hole.

## 3. Disagreements resolved

1. **Egress.** R3 says "matches Hermes"; R1 says Trent leaks.
   - R1 is right. Hermes maps each key to its hosts (`iron_proxy.py:82-87,532`); Trent's `applyCredentials` injects the key for any host (`CredentialBroker.ts:101-108`).
   - README.md's "the same design (iron-proxy)" is false until B1 lands.
2. **Memory holds.** R2 says landed; R1 says bypassed.
   - R1 is right for the fleet (row 37). R2 is right only for solo, and only in the tree.
3. **Adapters.** R1 says 9 of 12 can receive; R4 says none can admit a sender.
   - R4 is right in effect: inbound arrives, then `handleInbound` answers with a non-existent command and drops every later message (`GatewayManager.ts:321-331`).
4. **Auto-review.**
   - R3 counts it as an advantage, and R2 wants it inline; R1 says it breaks the README promise.
   - All three are right about different parts. It is an advantage only if the schema caps `max_class` at `write`, which is also R2's own condition ("money, sends and customer actions stay human-only").
5. **Solo as default.** R3 says now; R1 and R2 say prove it first.
   - Prove first. Solo has zero live-model runs, and its surface wiring is untracked with no `responseFormat` (row 40).
   - Change the default only after the live proof and the bench.
6. **Breadth.** R4 wants Hermes's surfaces; R3 says cut them.
   - Keep R4's cheap blockers: pairing, listener, keyless-to-local, durable daemon.
   - Defer REPL, ACP and console parity until the bench shows where Trent loses. The Hermes volumes in rows 15 and 28-32 make row-for-row parity unwinnable.
7. **Free tier.** R4 says zero-credential; R3 says Portal plus free tier.
   - R3 is right. The guest is opt-in (row 12), so Hermes's default first run still needs a sign-in. "Works with no account on the model already on your machine" is a real Trent opening.
8. **The local-only guarantee as a differentiator** (R3 A5).
   - Weaker than claimed: Hermes's cloud fallback is opt-in and refuses a stray cloud key (row 19).
   - Trent's real edge is the *bound, previewed* escalation (tree), not "no silent fallback".

## 4. Consolidated top 10 for the owner, in order

Rule for 1-5: no tag, launch post or README headline until each has a red test turned green, and CI has run
green five times in a row.

**1. Host-bind broker credentials. Size S. Source: R1 (B1), confirmed against Hermes.**
- Problem: the model API key is sent as a Bearer token to every `intercept_domains` host the browser, web or vision clients reach.
- Evidence: `CredentialBroker.ts:101-108`; `repl/tools.ts:161,191-196`; `browser/session.ts:95`. Hermes: `iron_proxy.py:82-87,532`.
- Files: `egress/CredentialBroker.ts`, `TokenStorePort.ts`, `EgressProxy.ts`, `apps/cli/src/repl/tools.ts`.
- Acceptance: a request through the proxy to an allowlisted non-provider host carries no `authorization`, `x-api-key` or `x-goog-api-key`; the provider host still gets the key. Then correct README.md:171.

**2. Hold fleet memory writes from tainted steps. Size S. Source: R1 (B2); corrects R2.**
- Problem: a web page read in step N can write `MEMORY.md`, which every seat loads on the next run.
- Evidence: `orchestrator/index.ts:193`; `tools/index.ts:411-415`.
- Files: the same, plus `tools/memory/holds.ts`.
- Acceptance: through `createHeadlessRuntime`, `web_extract` then `memory add` in one step returns `needs_approval`, and nothing is written.

**3. Make the gateway admit people. Size S. Source: R4 (gap 1) and R1 (B3).**
- Problem: no pair command exists, and at HEAD webhook-only adapters have no listener.
- Evidence: rows 39 and 38 (`git grep WebhookServer HEAD`). Hermes: `pairing.py:10-28`.
- Files: `apps/cli/src/commands/groups/servers.ts`, `gateway/GatewayManager.ts:327`, `docs/gateway.md:61`. Land P3's `openAdapterWebhooks`.
- Acceptance: with a fake Telegram, an unknown sender gets code X; `trent gateway pair telegram X --admin --json` exits 0; the next message reaches the handler; the sender's reaction decides an approval. Under `gateway start`, a signed POST to `/webhooks/line` is accepted and a forged one returns 401.

**4. CI that proves what the README claims. Size S. Source: R1 (S1, S2).**
- Evidence: `ci.yml:391-392` vs `vitest.config.ts:8`. `723ef22` landed `--out-root`.
- Still to do:
  - `TRENT_TEST_LIVE=1` and a Gemini key in the live job, with a `workflow_dispatch` trigger;
  - `sequence.groupOrder` on the exclusive project;
  - move `improve/store.test.ts` and `audit/export.test.ts` into EXCLUSIVE.
- Acceptance: one dispatched live job that runs at least one `*.live.test.ts` and does not skip it; five consecutive green runs.

**5. Keep the headline promise true. Size S. Source: R1 (S3, S5), R4 (§5).**
- Problem: `auto_review` may approve `external_send` and `money`, which contradicts README.md:11-13.
- Files: `governance/auto-review-config.ts` (enum at `:17`), `README.md`, `docs/security.md`, and `webhooks/signature.ts` (tree).
- Changes:
  - cap `max_class` at `write` in the schema;
  - refuse auto-review of rows from tainted steps;
  - before H3 lands, add a timestamped HMAC scheme, beating Hermes's V2 plus its replayable V1.
- Acceptance:
  - a config with `max_class: money` fails validation;
  - a replayed HMAC delivery older than 5 minutes gets 401;
  - `docs-truth` covers every `docs/*.md`.

**6. Land the tree wave by wave, then give solo its first live run. Size S plus a quiet window. Source: R2 (#1), R1 (S7), R3 (step 3), R4 (gap 4).**
- Problem: `setup --mode local` writes a mode no HEAD surface reads, and solo sends no `responseFormat`.
- Files: `apps/cli/src/runtime/runner-for-mode.ts`, `solo/prompt.ts:137`, `core/setup/QuickSetup.ts:53-61`, `doctor/checks/credentials.ts`.
- Acceptance:
  - a unit test: solo requests carry `response_format` under a local alias and not under a hosted one;
  - live, with `TRENT_TEST_LIVE=1`: a 3-turn session with at least one real tool call per turn on `qwen3.5:9b` and on flash-lite, printing tokens and cents;
  - keyless `trent setup --json` with a fake Ollama suggests `--mode local`.

**7. Solo sessions that last. Size M. Source: R2 (#2, #5, #10). Hermes bar: rows 3, 5 and 7.**
- Scope: compaction, a hosted window, recovery from a context-length 400, a todo list keyed by session, and `replace`/`remove` for the owner's memory writer (holds unchanged).
- Files: `solo/compaction.ts`, `solo/turn.ts`, `tools/todo/store.ts:90`, `tools/memory/store.ts:174-183`.
- Acceptance:
  - with a fake gateway, a session over the threshold compacts before the next call, with the frozen prefix byte-identical;
  - a fake 400 produces one compaction and one successful retry;
  - a todo list from turn 1 survives to turn 3 and a forced compaction;
  - `memory replace` succeeds untainted and is held when tainted.

**8. Token streaming. Size M. Source: R2 (#7), R4 (gap 3).**
- Why: on the 9B, time to first token is 91-157 s, and every surface is silent until the step ends. Hermes: `hermes_cli/cli_stream_mixin.py`.
- Files: a `step_delta` kind in `orchestrator/types.ts`, `solo/events.ts:1-24`, `cli/repl/render.ts`.
- Acceptance: with a fake server sending 50 deltas 100 ms apart, the first text renders within 300 ms of the first delta and before `step_end`.

**9. Anthropic on the wrapper client, with native tools and caching. Size M-L. Source: R2 (#3). Hermes bar: rows 1-2.**
- Files: a new wrapper Anthropic client beside `model-gateway/openai-compat.ts`; `model-gateway/types.ts` (tool role and calls); `solo/parse.ts`; `pricing.ts`.
- Acceptance, against a fake Anthropic server:
  - the request carries `tools` and a `cache_control` breakpoint on the system block;
  - a `tool_use` block becomes a call;
  - the ledger prices `cache_read_input_tokens` at the cached rate.

**10. Public same-model bench against Hermes, feeding the graded learning loop. Size M. Source: R3 (I1, I3), R2 (#4).**
- Feasibility: Hermes is installed (`~/.local/bin/hermes`), with `-q` (`_parser.py:214`) and `--format stream-json` (`:247`).
- Setup: the same fake business tools via `trent mcp serve`; grading from the fake server's end state; Hermes pinned at v0.21.5.
- Acceptance: `trent bench run` prints pass@1, pass^3, time to first token and cents per successful task for trent-solo, hermes and fleet, on the 9B and on flash-lite. The results are published whatever they show.
- Only after this: session review through held paths, a live seat-prompt reader, and changing the default mode.

Just below the cut:
- R3 I2 rehearsal (no equivalent in Hermes, row 17; reuses item 10's format);
- R4 service durability (`durable: false` under Node);
- Bobby's gates: tag v1.0.0, merge to `main` (282 commits behind), LICENSE (currently `null`), and reversing gate decision 4 on inbound SMS.
