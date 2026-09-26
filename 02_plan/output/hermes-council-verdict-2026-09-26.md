# LLM Council verdict: Trent against Hermes Agent (2026-09-26)

Chair, stage 3. Inputs: four stage-1 reviews (A core, B surfaces, C truth, D strategy), four stage-2 rankings,
`AGENTS.md`, and the lead's log `docs/sessions/2026-09-26-resume-landing.md`. Trent is at HEAD `eaeedbd`, plus the unlanded
tree: S2, H3, H5, L1, S3, P3 and the egress fix, 166 dirty paths. Hermes is at `~/.hermes/hermes-agent` `49eb7b5dba`
(v0.21.3; GitHub is at v0.21.5). I re-checked every anchor below with read-only commands (grep, sed, git) at 07:00Z.
Paths are under `packages/trent-core/src/` unless they start with `apps/`, `docs/`, `.github/`, `README.md` or
`AGENTS.md`. `apps/web/` stays read-only throughout.

**Stage-2 standings.** On accuracy, all four rankers put C first and D last. On decision value they split: A
(ranker 1), C (rankers 2 and 3), B (ranker 4). Evidence outweighs assertion here, so the plan draws on each review
for what it proved:
- C's blockers go first.
- A's loop gaps make up the harness tier.
- B's pairing and keyless items make up the user tier.
- D supplies the cut list and the bench.

## 1. Verdict

1. Today Trent is worse than Hermes for anyone who wants to install it, chat with it, or run one agent on a local model.
2. The reasons are concrete: 0 tags, a 404 installer, no command that can pair a chat user, and a solo mode that has never answered a real model.
3. As a harness it is a generation behind. Tool calls are a text protocol, Anthropic gets no prompt caching, nothing streams, memory is add-only, and a context overflow ends the run.
4. Trent's one real, landed lead is governance around side effects. A yes is bound to exact arguments and an idempotency key, cent caps stop a run, the audit is signed and hash-chained, and taint rules cover tool sequences. Hermes has none of these four.
5. Two silent defects undercut that lead, and the docs deny both. The egress broker gives the model key to hosts that are not the provider, although README.md:171 claims iron-proxy parity. And a fleet run writes untrusted web text into shared memory without holding it.
6. Hermes ships 460 to 1,800 PRs per release and has 249k stars. Matching it row by row cannot be won, and the council rejects that race unanimously.
7. Trent can surpass Hermes on one axis it can own. It can be the agent that is provably safe and exact to the cent around money and customers, on a cheap or local model, with a same-model bench anyone can re-run.
8. The order: close the leaks and the false claims (C1-C6), make chat and first run reachable (C7-C10), prove solo live (C11), deepen the loop (C12-C15), then publish the bench (C16).
9. Eleven of the sixteen items are size S. C1 is being built now, C8's listener is in the landing queue, and 723ef22 plus eaeedbd have already removed the CI flake's root cause.
10. No tag, launch post or README headline until C1-C11 pass, CI has five consecutive green runs, and one live-suite run has passed.
11. Today Hermes is the right choice for breadth: providers, about 27 chat platforms, 208 skills, voice, desktop, and a learning loop that is on by default.
12. If C16 shows Hermes ahead on the same model and tools, stop saying "a better Hermes". Sell Trent as the governed money desk that Hermes calls over A2A.

## 2. What the council agreed on, and what it rejected

### Agreed: verified by two or more rankers (ranker numbers in the last column)

| # | Claim | Evidence | Verified by |
|---|---|---|---|
| 1 | The broker injects the provider key into any allowlisted host, so README.md:171 "same design (iron-proxy)" is false | `egress/CredentialBroker.ts:79-112` (`:108`), `TokenStorePort.ts:12-21` (no host), `EgressProxy.ts:294-308`; Hermes binds keys to hosts at `agent/proxy_sources/iron_proxy.py:84-87,532` | 1, 2, 3, 4 and the lead |
| 2 | Fleet memory writes skip the provenance hold | `orchestrator/index.ts:193` appends `fleetMemory.adapters` after the wrapped tools; `tools/index.ts:265,411-424`. The only proof, `governance/provenance.test.ts:191-213`, goes through a seam whose one caller is a fixture | 1, 2, 3, 4 |
| 3 | `trent gateway pair` does not exist, so no new chat sender can ever be admitted | `gateway/GatewayManager.ts:327`; gateway subcommands are `status` and `start` (`apps/cli/src/commands/groups/servers.ts:79,124`) plus `setup`; `PairingManager.ts:119-134` has no production caller; chat approvals need an admin (`ApprovalBridge.ts:180,222`) | 1, 2, 3, 4 and the lead |
| 4 | At HEAD nothing constructs `WebhookServer`, so WhatsApp, LINE and Home Assistant are deaf. P3 in the tree fixes it | `git grep WebhookServer HEAD`; tree `servers.ts:59-62,221` | 1, 2, 3, 4 |
| 5 | The CI live job cannot run the live files, and it has never been scheduled | `.github/workflows/ci.yml:390-392` sets `TRENT_LIVE_TESTS`; `vitest.config.ts:8` reads `TRENT_TEST_LIVE`; 0 scheduled runs | 1, 2, 3, 4 |
| 6 | Solo sends no constrained output, even in the tree | `solo/prompt.ts:137` has no production caller; `apps/cli/src/runtime/runner-for-mode.ts:297-320` | 1, 2, 3, 4 |
| 7 | No `cache_control` anywhere; messages are strings only; anthropic, mistral and openrouter go through the app's streamers | `model-gateway/types.ts:24-27`, `model-gateway/index.ts:48-51` | 1, 2, 3, 4 |
| 8 | Seat memory is add-only, against its own comment, and solo is told about "seats" and a "founder" | `tools/memory/store.ts:46-48` against `:174-183`; `tools/memory/index.ts:68-72` | 1, 2, 4 |
| 9 | Promoted `__seat_prompt__` drafts have no live reader | callers only in `improve/sweep.ts:468`, `groups/fleet-versions.ts:86`, `commands/improve-goldens.ts:336` | 1, 2, 4 |
| 10 | No surface streams tokens, and `sendTyping` has 0 callers | `solo/turn.ts:296` calls `complete()`; `solo/events.ts:1-24` | 1, 4 (the chair re-checked `sendTyping`) |
| 11 | A keyless first run never offers the local runtime | `setup/QuickSetup.ts:52-61`; `setup/detect.ts:124` | 1, 4 |
| 12 | Solo has no overflow recovery, no hosted window and a fixed tool-call cap, and its todo list is keyed by run | `model-gateway/retry.ts:188-195`; `runner-for-mode.ts:236-240`; `solo/types.ts:28`; `tools/todo/store.ts:90` | 1, 2, 4 |
| 13 | `auto_review` may approve up to `money`, and the README headline does not mention it | `governance/auto-review-config.ts:17`; README.md:11-13 | 1, 2, 3 (ranker 2: the defaults are safe) |
| 14 | `createEgressFetch` re-sends headers and body on any redirect and ignores `redirect` | `tools/web/proxied-fetch.ts:187-201`; `a2a/client.ts:181` | 1, 2 |
| 15 | H3 loopback routes accept a drive-by POST, and generic and GitHub HMAC carry no timestamp | `webhooks/engine.ts:113-114`; `webhooks/signature.ts:81-91` | 1, 2 (3 confirms that Hermes V2 binds one) |
| 16 | Under Node the daemon runs `EphemeralStore` and says nothing | `apps/cli/src/runtime/headless.ts:231-239`; only `apps/cli/src/repl/index.ts:327` warns | 2, 4 |
| 17 | Two skills ship evals, no business tool has touched a real provider, and no before/after improvement win has been recorded | `find -name evals.json` finds `ads` and `prospecting`; `docs/business.md:13` | 1, 4 |
| 18 | Hermes facts that stand: native tools on every provider, 4 Anthropic cache breakpoints, memory add/replace/remove, a background review every 10 turns, `send_message` ungated, `response_format` for auxiliary calls only, cost a lower-bound estimate that is off by default, no signed audit | `turn_request_assembly.py:197`, `prompt_caching.py:3-5`, `memory_tool.py:293`, `config_defaults.py:777,1283`, `configuration.md:3052` | 1, 3 |

### Rejected or corrected

| # | Claim | Who made it | Finding (ranker, evidence) |
|---|---|---|---|
| 1 | "The broker only matches Hermes" / "the same design (iron-proxy)" | D; README.md:171 | **Wrong.** Trent is behind: iron-proxy binds each key to its hosts with `require: True` (all four rankers; `iron_proxy.py:524-532`) |
| 2 | "Untrusted memory writes are held (landed)", listed as a strength | A | **Wrong for the fleet**, the default mode. Only solo holds them, and only in the tree (`solo/memory-gate.ts`) (rankers 1, 2, 3) |
| 3 | "12 adapters" of reach | D; README.md:175 | **Wrong.** 9 of 12 listen at HEAD, and 0 can admit a new sender (rankers 1-4) |
| 4 | "The fleet failed 'Say ready' after 1,022 s" | D | **Not in the source.** It hit the 10-minute timeout with 0 of 2 steps done (`docs/local-models.md:156`; ranker 1) |
| 5 | "Under Node every pending approval is lost on exit" | C | **Wrong as worded.** The rows persist in `gateway.json`; runs, drafts and the audit chain are what vanish (ranker 2; `bound-approvals.test.ts:152`) |
| 6 | "Hermes users start with zero credentials" | B | **Partly.** The guest needs `HERMES_GUEST_ONBOARDING=1`; the default path is a Portal sign-in (ranker 3; `anon_auth.py:145-149`) |
| 7 | "Hermes silently falls back to the cloud after 3 local failures" | D | **Partly.** `fallback_providers` is opt-in, and Hermes refuses a stray cloud key (ranker 3; `local-ollama-setup.md:252-273`) |
| 8 | "Trent is ahead on scripting; Hermes has `--json` in 7 of 62 modules" | B | **Partly.** Hermes has `--json` in 15 modules plus `--format stream-json`. Trent is ahead on uniformity only (ranker 3) |
| 9 | "Solo has no improve wiring" | D | **Partly.** Solo frames reach the improve trace hook (tree `headless.ts:338-343,426`), but promoted skills and seat prompts never reach solo (rankers 1, 2) |
| 10 | "The approvals.restart root cause is only partly fixed" | C | **Superseded** by 723ef22 (the writer) and eaeedbd (the exclusive project is now truthful) (all rankers and the lead) |
| 11 | "Hermes compacts at 0.5 by default" | A | **Partly.** The threshold is floored at 0.75 below 512K-token windows (rankers 1, 3) |
| 12 | "The password-field refusal is proven only by an untracked Chromium test" | C | **Partly wrong.** `tools/browser/attach.test.ts:303,317` covers it against a fake page (ranker 2) |
| 13 | "91-157 s to the first token is what a local user sees" | A, B | **Measured at load 170-1000.** No quiet-machine number exists (ranker 4) |
| 14 | "`auto_review` is a blocker" | C | **Downgraded.** It is off by default: `read`, 0 cents, no recipients. The README headline is still false once it is enabled (ranker 2) |
| 15 | Counts: 41 providers, "one patch behind", 29 tags, 223 catalog entries | A, B, C | **Stale.** 39 providers, two patches behind, 58 tags on GitHub, 215 entries locally (ranker 3) |

## 3. The ordered action plan

**Status tags:**
- IN PROGRESS: being built now.
- QUEUED: named in the lead's log.
- PARTLY DONE: part has landed.
- NEW: not started.

**Sizes:** S up to 1 day, M 2-5 days, L more than 5 days, one Opus agent each.

**Every item follows the rulebook:**
- The failing test comes first and is watched failing for the right reason; then the minimal fix.
- Files are staged explicitly, each item is its own commit, and it lands through `scripts/dev/isolate.sh`.

**Landing queue (lead's log):** S2+H3 (isolate run 4) -> H5 -> L1 -> P3 -> S3 -> P3's one-liners.

### Tier 1: public claims that are false, and secrets that leak

**C1. Bind every brokered secret to its provider's hosts.** IN PROGRESS · M · deps: none (`egress/**` is in no wave)
- **Problem:** the broker writes the model key onto any allowlisted request that carries the proxy token. With the default config this includes a sandboxed call to another provider, and every browser or web-tool request to an allowlisted site.
- **Evidence:** Injection: `egress/CredentialBroker.ts:108`; no host binding: `TokenStorePort.ts:12-21`; minted at `apps/cli/src/repl/tools.ts:163,193`. The sandbox exports the token as all four provider variables (`egress/SandboxEnvironment.ts:28-41`), and all three provider hosts are allowlisted by default (`config/sections/terminal.ts:34`). The Tavily/Jina bearer is replaced by the model key (`tools/web/index.ts:99`, no own-credential marker); the browser sends the token on every request (`tools/browser/session.ts:61`).
- **Files:** Commit 1, in progress: `egress/{TokenStorePort,CredentialBroker,EgressProxy,provider-hosts}.ts` and `apps/cli/src/repl/tools.ts` (mint with the hosts from `doctor/endpoint.ts` `providerEndpoint`). A record with no hosts injects nothing. Commit 2, after H5 lands: `tools/web/index.ts` (`withOwnCredential`), `tools/browser/session.ts`, `docs/security.md`, README.md:171.
- **Red first:** a token minted with `{apiKey:K}` for google, sent through a real `EgressProxy` to allowlisted `api.openai.com`, `api.tavily.com` and `example.test`, carries K in some header today.
- **Accept:** none of those three requests carries K. Tavily keeps its own `Authorization`. `generativelanguage.googleapis.com` still gets `x-goog-api-key: K`.
- **Proof:** README.md:171 says "host-bound, as iron-proxy" and cites this test. Metric: 0 of 3 foreign hosts receive the key.
- **Status:** see the log `docs/sessions/2026-09-26-egress-host-binding.md`; `provider-hosts.ts` and `EgressProxy.host-binding.test.ts` are untracked in the tree.

**C2. Hold untrusted memory writes on fleet runs.** NEW · S · deps: S3 landed
- **Problem:** in a fleet run, `web_extract` followed by `memory add` writes the shared `MEMORY.md` with no hold, and every seat loads it as trusted on the next run. That is the exact attack the provenance hold was designed to stop.
- **Evidence:** `orchestrator/index.ts:193`; `tools/index.ts:265,411-424`; `apps/cli/src/repl/fleet-memory.ts:170`; the header of `solo/memory-gate.ts:4-8` (tree) names this fleet hole itself.
- **Files:** Move `solo/memory-gate.ts`'s wrapper to a shared `tools/memory/gate.ts`, so one gate serves both modes. `orchestrator/index.ts:193` wraps `fleetMemory.adapters` with it. `apps/cli/src/repl/tools.ts` exposes `buildTrentTools`' provenance ledger on `ToolWiring`, and `apps/cli/src/runtime/headless.ts` passes it on. It must be the same instance, because taint is per instance (`governance/provenance.ts:185-208`).
- **Red first:** through `createHeadlessRuntime` with a fake seat, `web_extract` then `memory {"action":"add"}` in one step completes and changes `MEMORY.md` today.
- **Accept:** that step returns `needs_approval`, files one pending row in `gateway.json`, and leaves `MEMORY.md` byte-identical. Approving the row writes the entry tagged `[provenance: untrusted via web_extract]`.
- **Proof:** `docs/security.md` cites this headless test for both modes.

**C3. Keep "asks you first at every autonomy level" true: auto-review never approves a send or money.** NEW · S · deps: P3 landed
- **Problem:** a reviewer model may approve `external_send` and `money` rows, which contradicts README.md:11-13. Its untrusted check is a string match that B2's laundering path defeats.
- **Evidence:** `governance/auto-review-config.ts:17,29`; `governance/auto-review-policy.ts:76,251`; `grep -n "auto.review" README.md` finds nothing.
- **Files:** `governance/auto-review-config.ts`: the approvable ceiling becomes `read|write`, and the error names the README promise. `governance/auto-review-policy.ts`, `docs/security.md` "Auto review", and one clause in README.md:11-13.
- **Red first:** a profile config with `governance.auto_review.max_class: money` loads without error today.
- **Accept:** loading that config fails validation naming the key, and a policy-eligible `external_send` row is escalated with no model call.
- **Proof:** the headline sentence cites the schema test.

**C4. Secrets stay put: redirects strip credentials, and the model cannot read Trent's own keys.** NEW · S · deps: none
- **Problem:** Outside MCP, a redirect re-sends `authorization`, the proxy token and the body to any origin, so an A2A peer's bearer follows a 302. The hardline read rule does not cover the audit key or the egress key and token files.
- **Evidence:** `tools/web/proxied-fetch.ts:187-201`. `a2a/client.ts:181` passes `redirect:"error"`, which is ignored. `governance/hardline.ts:139-145` protects reads of `.env` and `~/.ssh` only; `ca.key` and `tokens.json` are guarded for writes only (`:55,136`).
- **Files:** `tools/web/proxied-fetch.ts`: honour `redirect`, drop credentials and the body on a cross-origin hop, and delete the MCP copy of that rule (`tools/mcp/http-transport.ts:40-73`). `governance/hardline.ts`: add `keys/audit.key`, `egress/ca.key` and `egress/tokens.json` to the read rule.
- **Red first:** with `redirect:"error"`, a fake peer's 302 is followed today.
- **Accept:** `redirect:"error"` throws, a cross-origin 302 arrives with no `authorization`, no token and no body, and a terminal `cat <profile>/keys/audit.key` is refused.
- **Proof:** the A2A client test shows the peer's bearer never reaches the redirect target.

**C5. CI proves live claims.** PARTLY DONE (723ef22 root cause, eaeedbd exclusive project) · S · deps: none; Bobby adds the Gemini secret
- **Problem:** the live job sets a variable nobody reads and passes only an Anthropic key. It has never fired. The green badge proves nothing live.
- **Evidence:** `.github/workflows/ci.yml:363,390-392` against `vitest.config.ts:8`; 0 scheduled runs (the schedule fires only on `main`).
- **Files:** `.github/workflows/ci.yml` live job: `TRENT_TEST_LIVE: "1"` and `GEMINI_API_KEY`. `workflow_dispatch` already exists at `:30`. `apps/cli/src/commands/__tests__/vitest-config-truth.test.ts`. `CONTRIBUTING.md`: web `prisma generate`, and Bun.
- **Red first:** a new case in `vitest-config-truth.test.ts`, "the live-gate variable the CI live job sets is the one `vitest.config.ts` reads", fails today.
- **Accept:** one dispatched run's log shows more than 0 of the 25 `*.live.test.ts` files executed and passing. Then 5 consecutive green `all-checks-pass` runs after the last landing.
- **Proof:** record the run ids in the session log and the README CI row. Bobby records where the secret lives, never its value.

**C6. The docs tell the truth, and a test keeps them honest.** NEW · S · deps: the test goes in now; each row is corrected with its fix
- **Problem:** the docs-truth test reads 4 of 31 pages. Rows a ranker proved wrong are still published, and commands that do not exist are named to users.
- **Evidence:** `apps/cli/src/commands/__tests__/docs-truth.test.ts:36`. The wrong or stale lines: README.md: `:171` (iron-proxy), `:175` (12 adapters), `:28` (says exit 1; `run.ts:170` returns 5), `:183` and `:249` ("(no client)"), `:305` (counts). AGENTS.md: `:40-41` (gate numbers), and a defect list that lacks B1, B2, B3 and pairing. docs: `docs/getting-started.md:457` ("private"), `docs/desktop.md:67`, `docs/configuration.md:1234-1238` (voice), `docs/checkpoints.md:114`, `docs/mcp.md:75-77` against `:189-190`. code text: `apps/cli/src/commands/groups/fleet.ts:25` ("164-specialist"), and `improve.ts:6`, where promoted seat prompts in fact reach no live seat.
- **Files:** the pages above and the test.
- **Red first:** extend `DOCUMENTS` to every `docs/*.md`, and check that every `trent <cmd> <sub>` a page names exists in `COMMAND_SPECS`. It fails today on `trent gateway pair` and `trent checkpoints`.
- **Accept:** the extended test exits 0 over every page, and no README comparison row is one that section 2 rejected.
- **Proof:** every README comparison row names the test a stranger can re-run.

### Tier 2: unblock users

**C7. A chat user can be paired, and the owner can decide cards in plain words.** QUEUED (lead 05:52Z, item a) · S · deps: S2+H3 and P3 landed (`servers.ts` carries their hunks)
- **Problem:** every stranger is told to have an operator run a command that does not exist, so none of the 12 adapters admits anyone. Cards arrive as raw JSON, and only an admin who cannot exist may decide them.
- **Evidence:** `gateway/GatewayManager.ts:327` (the hint) and `:181` (`getPairing()` has no caller); `gateway/security/PairingManager.ts:119-134`; `gateway/ApprovalBridge.ts:180,222` (admin only) and `:267` (`Details: ${JSON.stringify(...)}`).
- **Files:** New `apps/cli/src/commands/groups/gateway-pair.ts`: `gateway pair <platform> <code> [--admin]`, `gateway pairings` and `gateway revoke`, registered beside `servers.ts`. `GatewayManager.ts:327`: a neutral reply to the stranger; the operator sees the code in `gateway pairings`. `ApprovalBridge.ts:261-271` (one plain line per action plus a Ref), `docs/gateway.md:61-63`.
- **Red first:** with the real `GatewayManager` and a fake Telegram, `trent gateway pair telegram <code> --admin --json` answers "unknown command" today.
- **Accept:** The stranger's reply contains no `trent ` substring, and pairing exits 0. That sender's next message reaches the agent handler. Their reaction decides a pending card whose text contains no `{`.
- **Proof:** a live check on Bobby's own bot: pair from the phone, then approve a held `write_file` by reaction.

**C8. Webhook-only adapters listen, and they cannot be forged or replayed.** Listener IN THE LANDING QUEUE (P3); hardening NEW · S · deps: S2+H3 then P3; hardening before the tag
- **Problem:** at HEAD WhatsApp, LINE and Home Assistant cannot receive, and `gateway setup` writes a variable they never read. H3's loopback routes accept a drive-by page's POST, and generic HMAC can be replayed after the 24 h dedupe.
- **Evidence:** `git grep WebhookServer HEAD` finds only the class, a re-export and a comment; HEAD `servers.ts:102` writes `<PLATFORM>_BOT_TOKEN`. `webhooks/engine.ts:113-114`; `webhooks/signature.ts:81-91`. Hermes V2 binds a timestamp: `gateway/platforms/webhook.py:63,85-92`.
- **Files:** Land P3: `servers.ts:59-62,221` (`openAdapterWebhooks`), `gateway-setup.ts`, `webhooks/serve.ts:43`. Then `webhooks/engine.ts`: 403 on any `Origin` header or a non-JSON body on loopback routes. `webhooks/signature.ts`: an `hmac-sha256-ts` variant using `tolerance_seconds`. `docs/webhooks.md`: one tested tunnel recipe.
- **Red first:** a loopback POST carrying `Origin: https://evil.test` to a `none-localhost-only` route starts a run today.
- **Accept:** with only `LINE_CHANNEL_*` set, `gateway start` accepts a signed POST to `/webhooks/line`, answers a forged one with 401, the `Origin` POST with 403, and a timestamped delivery 301 s old with 401.
- **Proof:** the README messaging row counts only the adapters that have an end-to-end `gateway start` test.

**C9. A keyless first run finds the model already on the machine.** NEW · S · deps: none
- **Problem:** bare `trent` with no key says "Set OPENAI_API_KEY", while the Ollama and 9B model that `setup --mode local` finds sit unused. The Hermes guest is opt-in, so "no account needed" is an open lane for Trent.
- **Evidence:** `apps/cli/src/commands/index.ts:337-351`, `setup/QuickSetup.ts:52-61`, `setup/detect.ts:124` (points at `--mode quick --provider ollama`), `doctor/checks/credentials.ts:78`, `apps/cli/src/repl/degraded.ts:95`. The Hermes guest flag: `hermes_cli/anon_auth.py:145-149`.
- **Files:** the four above.
- **Red first:** with no key and a fake Ollama on loopback listing a tools-capable model, `trent setup --json` returns `reason: no-key` and no local suggestion.
- **Accept:** the same run exits 3 with `suggested: "local"` and the exact line `trent setup --mode local`, and doctor's credential hint names that same command.
- **Proof:** on this Mac, a keyless `trent` offers local setup on its first screen.

**C10. The always-on service says when it will forget.** NEW · S · deps: none
- **Problem:** a daemon installed from the taught Node path runs `EphemeralStore`, and runs, improve drafts and the audit chain vanish on exit without a word. The plist also pins whichever node binary was found at install time.
- **Evidence:** `apps/cli/src/runtime/headless.ts:231-239`; `service/program.ts:30` (`node-entry`); `service/install.ts` has no durability check; only the REPL warns (`apps/cli/src/repl/index.ts:327`).
- **Files:** `service/install.ts`, `service/program.ts`, `apps/cli/src/commands/groups/service-daemon.ts`, `docs/service.md`, `docs/getting-started.md:18,44`.
- **Red first:** under Node, `service install --dry-run --json` today exits 0 and says nothing about durability.
- **Accept:** under Node it reports `durable: false` and exits 3 unless `--allow-ephemeral` is passed. Under Bun or the binary it reports `durable: true`.
- **Proof:** after the tag, a parked approval survives `kill -9` of the binary's daemon (release gate).

### Tier 3: the solo and local proof

**C11. Solo runs constrained, and is proven on a real model.** NEW (L1 constrained seats are in the tree) · S plus one quiet hour · deps: S2, L1, S3 landed; C5 for the CI copy
- **Problem:** `setup --mode local` writes solo, but solo sends no `response_format` and has never answered a real model. The tool-call smoke test scores 1/5 unconstrained, and `agent.solo.max_tool_calls` is never passed through.
- **Evidence:** `solo/prompt.ts:137` (no caller); tree `runner-for-mode.ts:297-320`, while `solo/runner.ts:121,127` accepts both settings. `docs/local-models.md:152`; the L1 log (seats went from 2/5 to 4/5 with constrained output).
- **Files:** `apps/cli/src/runtime/runner-for-mode.ts`: `soloResponseFormat(adapters)` under a local alias only, plus `maxToolCalls`. `config/sections/agent.ts` (validate `solo.max_tool_calls`); the doctor local smoke on the solo format. New `solo/solo.live.test.ts`; `docs/local-models.md`.
- **Red first:** a unit test that a solo request under a local alias carries `response_format` (and one under a hosted provider does not) fails today.
- **Accept:** under `TRENT_TEST_LIVE=1`, a 3-turn solo session on `qwen3.5:9b` (load under 40) and one on `gemini-3.5-flash-lite` each make at least 1 real tool call per turn and print tokens and cents.
- **Proof:** transcripts, time to first token, cents and the 9B solo-format smoke score are published in `docs/local-models.md`. That score decides the default (section 7, item 4).

### Tier 4: harness depth

**C12. Solo sessions that last.** Compaction BUILT (S3, landing queued); the rest NEW · M · deps: S3 landed, C11
- **Problem:** a context-length 400 is a dead run. With no hosted window, S3 compacts at a fixed 64,000 characters. The todo list resets every message, and the 25-call cap stops a run with no warning.
- **Evidence:** `model-gateway/retry.ts:188-195` (classed `validation`, never retried); `runner-for-mode.ts:236-240`; `solo/compaction.ts:39,96-99`; `tools/todo/store.ts:90` (S3 log line 73); `solo/types.ts:28`. Hermes: `agent/turn_overflow.py`, `tools/todo_tool.py:1-4`, `agent/iteration_budget.py`.
- **Files:** `model-gateway/retry.ts`: a `context_overflow` class. `solo/turn.ts`: one compaction then one retry, plus a wrap-up notice at 80 percent of the cap. `runner-for-mode.ts`: a per-model hosted window. `tools/todo/{index,store}.ts`: keyed by session when bound; `solo/prompt.ts`: the plan in the context tier.
- **Red first:** a fake provider's context-length 400 ends the solo run `run_failed` today.
- **Accept:** that 400 causes exactly one compaction and one successful retry. A todo from turn 1 is listed unchanged in turn 3 and after a forced compaction. The model receives one wrap-up notice at 80 percent of `max_tool_calls`.
- **Proof:** a scripted 60-turn session on a fake gateway finishes with no provider 400 and a byte-identical frozen prefix.

**C13. Show life while the model works: typing, then token streaming.** NEW · M (typing alone S) · deps: C11
- **Problem:** every surface is silent until the step ends, and on a local 9B that is minutes. The gateway already streams tokens, and four adapters already implement typing; nothing uses either.
- **Evidence:** `solo/turn.ts:296` (`complete()`); `model-gateway/types.ts:68` (`{type:"token"}`); `solo/events.ts:1-24`; `apps/cli/src/repl/render.ts:189`; `sendTyping` at `gateway/platforms/{telegram.ts:247,discord.ts:237,signal.ts:182,whatsapp.ts:123}`, 0 callers.
- **Files:** `apps/cli/src/gateway/agent-handler.ts`: typing every 4 s during a turn. `solo/turn.ts`: `stream()`; `orchestrator/types.ts` and `solo/events.ts`: one additive `step_delta`. `apps/cli/src/repl/render.ts`, `apps/cli/src/tui/Chat.tsx`, and an incremental parser that emits only the envelope's `answer` field.
- **Red first:** against a fake server emitting 50 deltas 100 ms apart, the REPL prints nothing before `step_end` today.
- **Accept:** the first answer text appears within 300 ms of the first delta and before `step_end`, and never shows `{"answer"`. A fake Telegram receives `sendChatAction` at least every 5 s of a 20 s turn.
- **Proof:** time to first visible text on the 9B and flash-lite, published next to C11's numbers.

**C14. Claude gets native tools, prompt caching and abort.** NEW · L (M for the Anthropic client plus caching alone) · deps: C11
- **Problem:** the strongest and most expensive tool model gets no tool schemas, no `cache_control`, no cached-token accounting, a 60 s timeout and no abort. The same prefix is billed in full on every turn.
- **Evidence:** `model-gateway/index.ts:48-51`; `apps/web/lib/ai-client.ts:117,189,434-460` (read-only, so the fix goes in the wrapper); `model-gateway/types.ts:24-27`; 0 `cache_control` hits in the repo. Hermes: `agent/anthropic_adapter.py:635-636`, `agent/prompt_caching.py:3-5,84-86`.
- **Files:** New `model-gateway/anthropic-client.ts` beside `openai-compat.ts`, routed in `model-gateway/index.ts`. `model-gateway/types.ts`: tool definitions, a tool role, and tool calls on the completion. `solo/parse.ts`: accept native calls; local keeps the text protocol with constrained output. `model-gateway/pricing.ts`: cache write and read rates. Then native tools on the openai-compat route.
- **Red first:** against a fake Anthropic server, a solo turn's request has no `tools` and no `cache_control` today.
- **Accept:** The request carries `tools` and a `cache_control` breakpoint on the system block. A `tool_use` block becomes a call. The ledger prices `cache_read_input_tokens` at the cached rate, and an abort signal cancels the request.
- **Proof:** in a live 5-turn Claude solo session, the ledger shows cached tokens above 0 from turn 2, and the cents saved are printed.

**C15. Memory the agent can correct, and a prompt written for solo.** NEW · S (two S pieces) · deps: S3 landed, C2
- **Problem:** "I moved to York" gets a refusal. Once the block fills, the agent stops learning until a heartbeat that is off by default runs. And the solo model is told fleet facts (seats, a founder, nightly consolidation) that are false in solo.
- **Evidence:** Memory: `tools/memory/store.ts:174-183` against its own comment at `:46-48`; `tools/memory/index.ts:68-72`; `config/sections/heartbeat.ts:14`. Prompt: a 4-sentence persona (`solo/prompt.ts:33`), and the prompt's size has never been measured. Hermes: `tools/memory_tool.py:83-87,293`, `agent/prompt_builder.py:158,345,380,408,634`.
- **Files:** `tools/memory/store.ts`: an `owner` writer for solo may replace and remove in its own block; holds unchanged. `tools/memory/index.ts`: a per-mode description. `solo/prompt.ts`: tool-use enforcement, no fabrication, parallel calls, when to save, and a platform hint. `apps/cli/src/gateway/agent-handler.ts`: the platform hint.
- **Red first:** in solo, `memory {"action":"replace","old_text":"Leeds","content":"York"}` is refused today.
- **Accept:** that replace succeeds on an untainted session and is held on a tainted one. A snapshot of the default solo system prompt contains "seat" and "founder" 0 times and estimates under 6,000 tokens.
- **Proof:** saying "I moved to York" in a live solo session updates `MEMORY.md` in one turn.

### Tier 5: the benchmark

**C16. A public head-to-head: Trent solo, Hermes and the fleet, on the same model, tools and tasks.** NEW · M plus quiet windows · deps: C11-C15
- **Problem:** "surpass Hermes" cannot be falsified today; there is no claim a stranger can re-run.
- **Evidence:** `packages/trent-core/src/bench` does not exist. Hermes applies `response_format` only to auxiliary calls (`agent/auxiliary_structured_output.py`; none in `conversation_loop.py`), so constrained output on the main loop is Trent's measurable local edge. Hermes runs headless with `-q --format stream-json` (`hermes_cli/_parser.py:214,247`).
- **Files:** New `bench/{suite,trent-runner,hermes-runner,report}.ts` and `apps/cli/src/commands/groups/bench.ts`. 20 fixtures built from the `evals/index.ts` graders and the fake business and social servers. Hermes gets the same tools through `trent mcp serve`.
- **Red first:** a grader test that a fake-server end state without the booking fails the task, written before any runner exists.
- **Accept:** `trent bench run smb-20 --harness trent-solo,hermes,trent-fleet` on `qwen3.5:9b` and on `gemini-3.5-flash-lite` prints pass@1, pass^3, median time to first token, wall time and cents per successful task. Grading uses the fake-server end state, and the Hermes version is recorded.
- **Proof:** published win or lose. Pre-registered targets: Solo's pass@1 is at least Hermes's on the same model. At most 0.5 cents per successful task on flash-lite. The fleet keeps `--team` only if it wins a task class. Perplexity's +8.6 is a vendor claim, so it is not a gate.

## 4. What to stop, and what not to build yet

**Stop now:**

1. **The breadth race** (D; rankers 1, 3 and 4 agree, ranker 4 as "sequence, don't cut"). Hermes has 102 slash commands, a 43k-line TUI, about 381k desktop lines and 1,812 PRs in one release (ranker 3, rows 15 and 28-32). So: no new adapters, slash commands, TUI, desktop, web console, skins, plugin catalog or ACP session load until C16 names a lost task that needs one.
2. **Launching waves onto an unlanded tree, and landing by regex over markers** (C S8, D; the lead's 04:50Z `tsc` break). Give each agent its own worktree and land in dependency order. Strip the `[S2]`-style markers from each wave once it lands (1,858 today).
3. **"164 specialists" and "173 agents" in help or pitch** (D; B §5.13): `apps/cli/src/commands/groups/fleet.ts:25`, and all 164 have `toolsCount: 0`.
4. **More improvement machinery before one measured win** (D). Delete `brain.rerank` from the schema or wire it (C M2): `recallFromBrain` is called only from eval code.
5. **Daily Hermes-parity sweeps and landscape rewrites** (D). C16 becomes the scoreboard, with one Hermes delta a month.
6. **Any tag, release, launch post or README headline before section 6's gate** (rankers 1, 2, 3).
7. **The wrapped Next.js app as a product surface.** Never host `trent web` while AGENTS.md defect 1 is open.
8. **Widening auto-review inline** (A gap 9). It stays capped by C3 until bound rows carry structural taint.

**Not yet** (the trigger that unlocks each):
- **Graded-learning reach.** Session review through the held paths, a live `__seat_prompt__` reader, the sweep on by default for profiles that have a suite, and `trent improve report`. Trigger: after C16. First target: one promoted skill gaining 10 or more held-out points.
- **Rehearsal on the owner's history, and the signed weekly receipt** (D I2, I5). Trigger: after C16; they reuse its task format.
- **The inbound SMS front door** (D I4). Trigger: Bobby reverses gate decision 4 (`02_plan/output/upgrade-round-design.md:93,168`). It also needs a public-intake pairing mode built on C7, and C8.
- **Structural taint on fleet bound rows** (ranker 2 #7). Trigger: before anyone raises C3's cap.
- **Audit export over the approvals and attach chains; a Node SQLite store.** Trigger: after the tag, since the binaries run Bun.
- **Operator and editor surfaces.** ACP permissions, REPL depth, the operator CLI (logs, send, backup, profile, webhook), a web console, Docker/Nix, a Windows service, desktop signing. Trigger: after C16, or 100 real installs.
- **Capability breadth.** Code-execution tool RPC, native image parts, TTS, OAuth/subscription logins, credential pools, a managed local runtime, MCP include/exclude. Trigger: C16 shows a task lost for the lack of one.
- **Business onboarding** ("tell Trent about your shop", ranker 4 #9). Trigger: together with the phone demo in section 6.

## 5. Honest positioning

**What Trent can say today:**

> Trent is a governed agent you run from a source checkout. Every send, charge or booking waits for a yes bound to
> its exact arguments, and a repeat is answered from the idempotency store. Spend is counted in integer cents, and a
> cap stops the run. The audit export is signed and hash-chained. Trent works alongside Hermes (Hermes calls it over
> A2A) rather than replacing it. It is not packaged yet, chat users cannot be paired yet, and its single-agent mode
> has not yet run against a real model.

It must not say today: iron-proxy parity, "untrusted memory writes are held", "12 working adapters", "runs on your
local model", or "self-improving".

**What Trent can say after C1-C8:**

> Trent is the agent that asks before it touches money or customers, and proves it. A yes covers one exact call, and
> spend is capped to the cent. A provider key reaches only that provider. Text from the web or an inbound message
> cannot write memory or trigger a send without you. The audit is signed. Pair it from Telegram, Slack, Discord,
> WhatsApp, LINE and seven more, and approve from your phone. Every README row names the test that proves it, and CI
> runs the live suite.

**After C16, only if the numbers support it:** "On the same model and tools, Trent solo completes N of 20
small-business tasks to Hermes's M, at X cents per success." Otherwise: "Trent is the governed money desk Hermes calls."

## 6. Release gate for v1.0.0

The owner tags v1.0.0 only when all of the following hold:

1. **Items.** C1-C11 are done. Each is a red-then-green commit whose session log records the command and its exit code.
2. **The tree is landed.** S2, H3, H5, L1, S3 and P3 are each in their own commit, `git status --short` lists no source
   path, and the markers are stripped from every landed wave.
3. **CI.** Five consecutive green `all-checks-pass` runs after the last landing, with 0 approvals.restart failures among them. One `workflow_dispatch` live-job run with more than 0 `*.live.test.ts` files executed, all passing.
4. **Live proofs, recorded in `docs/sessions/` with commands and exit codes:** (a) C11's hosted solo session: 3 turns, at least 1 real tool call each, tokens and cents. (b) C11's `qwen3.5:9b` session at load under 40, with the smoke score and time to first token; the README's local claim is scoped to that score. (c) C7's live pairing, and one approval decided from Bobby's phone. (d) C8's signed LINE or WhatsApp delivery through the documented tunnel.
5. **Docs.** C6's docs-truth test passes over every `docs/*.md`. No README row is one that section 2 rejected.
6. **Bobby's gates (his alone):** The default branch carries the code and the LICENSE. The release signing keys are in place (record where they live, never the values). The installer URL returns 200. The post-tag install-e2e prints `trent --version` equal to the tag on macOS and Linux. Windows stays "experimental" until its run passes. A parked approval survives `kill -9` of the binary's daemon (C10).

**Not required for v1.0.0:** C12-C16. They are v1.1. The launch post waits for C16's first published numbers.

**Recommended, not gating:** ranker 4's "book it from your phone" demo, the repo's first real-provider call.
- Telegram, solo on flash-lite, Square sandbox, a Twilio trial, plain-English cards, and an idempotent second tap, for under 2 cents.
- It needs Bobby's sandbox credentials (record where they live).
- It is required before any marketing mentions bookings or payments.

## 7. Open disagreements, and the chair's call

1. **Security before pairing?** Ranker 4 puts pairing and the keyless first run first, because they block every chat user and every keyless user. Rankers 1-3 put B1 and B2 first. **Call: C1 and C2 first.** They are silent harm that contradicts published claims, C1 is already being built, and both block the tag anyway. C7 and C9 touch different files and run in parallel, so the order only decides which item blocks the tag. Both do.
2. **Harden H3 before it lands** (rankers 1, 2), or land S2+H3 as staged now (the lead)? **Call: land it as staged.** Routes are opt-in, and none is configured by default (`config/sections/gateway.ts:46`). Re-staging 71 files would cost another isolate cycle at load 380 or more. C8's hardening lands before the tag, and before any doc recommends a loopback route.
3. **Auto-review:** document it (ranker 1), give bound rows structural taint (ranker 2), or cap it at `write` (ranker 3)? **Call: cap it (C3).** It is size S, keeps README.md:11-13 literally true, and closes ranker 2's B2-laundering path with no new plumbing. Nobody loses anything: the feature is off by default, and A's own condition was that money and sends stay human-only.
4. **Solo as the default:** now (D), or after a live proof (A and every ranker)? **Call: after C11, not after C16.** Flip new profiles to solo when the 9B solo-format smoke scores 4/5 or better; otherwise flip hosted providers only. The fleet's own evidence is already worse than an unproven solo: 0 of 2 steps on the 9B, and 5 ledger rows for a tagline. S3 closes B2 for solo. The fleet stays available as `--team`, and C16 decides whether it keeps that place.
5. **When to tag?** D said today; ranker 1, after B1, B2 and the gateway; ranker 4, after pairing, keyless and the listener; ranker 3, after its items 1-5 plus five greens. **Call: section 6.** Ranker 4 is wrong to leave B1 out: a tag with the key leak publishes a README row that is false.
6. **The flake:** set `groupOrder` and move two Bun suites into EXCLUSIVE (C, ranker 3), or keep the lead's eaeedbd? **Call: the lead's.** The writer that caused the flake is gone (723ef22), so moving suites would treat a symptom that no longer exists. C5's five-green streak is the proof. Revisit only on a new red.
7. **The bench or the phone demo** (ranker 4: the bench persuades developers, not a spa owner)? **Call: both.** The bench stays the last plan item and the demo sits outside the plan. The bench is the only claim to surpass Hermes that anyone can falsify, and it is only a fair fight after C11-C15. The demo proves the product to a user, and it waits on Bobby's credentials, not on engineering.
8. **Breadth:** cut it (D), build it (B), or "every Hermes tool" (Bobby's goal)? **Call: sequence it with a rule.** A Hermes tool gets built when a bench task or a market-user demo fails for its lack, and not before. That honours Bobby's goal without the treadmill.
9. **The local wedge.** D sells "no silent cloud fallback", but ranker 3 shows that Hermes's fallback is opt-in. **Call: drop that line.** Sell the bound, previewed escalation (L1, `model-gateway/escalation.ts`) and the cent caps instead. Local stays a privacy tier for back-office work until a quiet-machine time to first token under about 30 s is measured.
10. **Size of C1:** S (rankers 1, 3) or M (ranker 2)? **Call: M.** Ranker 2's extensions hold on the chair's own check. The sandbox exports the token under all four provider variables, with all three provider hosts allowlisted by default (`egress/SandboxEnvironment.ts:28-41`, `config/sections/terminal.ts:34`). The web tools lose their own bearer to the model key (`tools/web/index.ts:99`).
