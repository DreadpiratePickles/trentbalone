# Stage 2, Ranker 1: verification and ranking of the four stage-1 reviews

Scope: the four anonymised responses (response-1..4.md). KEY.txt was not opened. Trent read at HEAD `723ef22`
(the responses reviewed `79fa451`; `723ef22` landed after them and only touches the derive-schema test) plus
the working tree ("tree" = built, not landed). Hermes read at `~/.hermes/hermes-agent` (`49eb7b5dba`).
No test suite, no model call, no network. Every verdict below is a `git show HEAD:`, `git grep`, `grep`, `sed -n`
or `find` result that can be re-run.

## 1. Verification table

Three most consequential claims per response, plus claims that another response contradicts (marked *).

| # | Resp | Claim | Evidence | Verdict |
|---|---|---|---|---|
| 1 | R1 | B1: the egress broker injects the provider key into requests to ANY allowlisted host | `egress/CredentialBroker.ts:79-110` has no host check; `:108` sets `Bearer ${secret}` for every host that is not `*anthropic.com`/`*googleapis.com`. `ProxyTokenRecord` has no host field (`egress/TokenStorePort.ts:12-21`). The REPL token carries `{apiKey}` (HEAD `apps/cli/src/repl/tools.ts:161,191-195,216`). The browser sends that token on every request (tree `tools/browser/session.ts:61`; HEAD `:95`), as does `tools/web/proxied-fetch.ts:149`. `EgressProxy.ts:294-308` checks only allowlist + token. Hermes binds each secret to its hosts (`agent/proxy_sources/iron_proxy.py:84-87`, `:532` `"rules": [{"host": h} ...]`). Unchanged in tree (`git diff --stat packages/trent-core/src/egress` empty) | **Holds** |
| 2 | R1 | B2: fleet-mode memory writes bypass the provenance hold | `orchestrator/index.ts:192` (HEAD; tree :193) appends `deps.fleetMemory?.adapters` after the tools; the hook's adapters are `[memory, search, ...]` (`fleet-memory/orchestrator-hook.ts:433`). `provenanceAdapters` wraps only what `buildTrentTools` builds (`tools/index.ts:411`); `extraAdapters` has one non-test caller, a fixture (`mcp-server/__fixtures__/serve-fake.ts:47`). `tools/memory/index.ts` has 0 taint/provenance checks. Tree S3 `solo/memory-gate.ts` is solo-only | **Holds** (by reading; no run) |
| 3 | R1 | S1: the CI live job cannot run the live files | `vitest.config.ts:8` reads `TRENT_TEST_LIVE === "1"`; `ci.yml:390-392` sets `TRENT_LIVE_TESTS` and `TRENT_REQUIRE_LIVE_TESTS`; `git grep -l TRENT_LIVE_TESTS HEAD -- packages apps scripts` = 0 files; only `ANTHROPIC_API_KEY` is passed (`ci.yml:390`). 25 tracked `*.live.test.ts` (R1 said 26) | **Holds** |
| 4 | R1* | B3: WhatsApp, LINE, Home Assistant cannot receive at HEAD | `git grep WebhookServer HEAD -- packages/trent-core/src apps/cli/src` = class + re-export + a comment only. Tree fixes it: `servers.ts:60-62,221` (`openAdapterWebhooks`), `webhooks/serve.ts:43` | **Holds** at HEAD |
| 5 | R1 | S2: approvals.restart flake root cause only partly addressed | Superseded after the review: `723ef22` makes `derive-sqlite-schema.mjs` take `--out-root` and the test derive into a temp dir, so nothing rewrites `store/generated` mid-run. `groupOrder`/EXCLUSIVE advice is now secondary | **Partly** (overtaken by 723ef22) |
| 6 | R1 | "no LICENSE detected" | `LICENSE` (MIT) is tracked on this branch; `origin/main` lacks it (`git ls-tree origin/main`). The claim is about GitHub's default branch | **Partly** |
| 7 | R2 | `soloResponseFormat` has no production caller, so `setup --mode local` runs solo unconstrained | Only definition at `solo/prompt.ts:137`; `runner-for-mode.ts:290-310` builds `createSoloRunner` config with no `responseFormat`; `solo/runner.ts:127` forwards it only if present | **Holds** |
| 8 | R2 | No native tools, no prompt caching; Anthropic/Mistral/OpenRouter on the app streamer with no abort | `grep -rl cache_control packages/trent-core/src apps/cli/src apps/web/lib` = 0 files. `GatewayMessage = {role: system\|user\|assistant; content: string}` (`model-gateway/types.ts:24-27`). `model-gateway/index.ts:48-51` says anthropic/mistral/openrouter keep the app's streamers; `apps/web/lib/ai-client.ts:117,189` `timeout: 60_000`, 0 `signal`. Hermes: `anthropic_adapter.py:636` sends `tools`; `prompt_caching.py` has 27 `cache_control` | **Holds** |
| 9 | R2 | Seat memory is add-only (contradicting its own comment); promoted `__seat_prompt__` drafts have no live reader | `tools/memory/store.ts:174-183` refuses `replace`/`remove` for writer `seat`, while `:47-48` promises "remove and add in one batch". `defaultSeatPromptProvider` callers: `improve/sweep.ts:468`, `commands/improve-goldens.ts:336`, `groups/fleet-versions.ts:86`; no orchestrator or seat-call path | **Holds** |
| 10 | R2* | Memory row: "untrusted writes held (`tools/memory/holds.ts`); landed" (a Trent strength) | Row 2: false for the default fleet mode | **Wrong** (fleet) |
| 11 | R2 | Hermes compacts at threshold 0.5 by default; background review every 10 turns, on | `hermes_cli/config_defaults.py:777` `"background_review": {"enabled": True ...}`, `:1283` `nudge_interval: 10`; `:544-556` threshold 0.50 **but** "windows below 512K are floored at 0.75" | **Holds** (threshold partly) |
| 12 | R3* | "The egress broker only matches Hermes; it is not a lead" / "Hermes has the same design, iron-proxy" | Row 1: Trent is behind, not level. Hermes binds per host and fails closed (`iron_proxy.py:524-531` `"require": True`) | **Wrong** |
| 13 | R3 | "Solo mode has no improve wiring (0 hits in `solo/`)" | Tree `apps/cli/src/runtime/headless.ts:338-343` composes `improve.improve` into `busHook`, and `:426` passes `sinks: [busHook, traced]` to the mode runners, so solo frames reach the trace hook. Promoted skill injection (`improve/hook.ts:16` → `skill-injection.ts`) and seat prompts do not reach solo | **Partly** |
| 14 | R3 | Only 2 skills ship evals; gate decision 4 removed inbound SMS; Hermes cost is a lower-bound estimate, off by default; Hermes uses `response_format` only for auxiliary calls | `find ... -name evals.json` → `ads`, `prospecting` only. `02_plan/output/upgrade-round-design.md:93,168`. Hermes `website/docs/user-guide/configuration.md:3052`. `response_format` appears only in `agent/auxiliary_*.py`, `title_generator.py`, `plugin_llm.py`, `providers/base.py:135`, TTS/image tools | **Holds** |
| 15 | R3 | "Fleet failed 'Say ready' after 1,022 s"; 249,012 stars; Hermes Business per-member caps | The cited `docs/local-models.md:156` says "10-minute job timeout, 0 of 2 steps" (no 1,022 s). Stars/Business need the network: not verified | **Partly / unverified** |
| 16 | R4 | The gateway admits no one: every unpaired sender is told to run `trent gateway pair`, which does not exist | Message at `GatewayManager.ts:327` (tree; HEAD :259). `gateway` subcommands: `status`, `start` (`servers.ts:79,124`) plus `setup` (`gatewaySetupSpec`). `PairingManager.pair/grant` have no non-test caller outside the class (`PairingManager.ts:119-134`). Approvals need an admin (`ApprovalBridge.ts:180,222`). No allowlist in `config/sections/gateway.ts`. Hermes: `hermes_cli/subcommands/pairing.py` list/approve/revoke | **Holds** |
| 17 | R4 | No token streaming on any surface | `solo/events.ts:1-24`: "Only the 20 kinds ... no surface may be taught a new one"; no delta kind in `orchestrator/types.ts` or `repl/render.ts` | **Holds** |
| 18 | R4 | Unknown config keys accepted; a keyless setup never offers the local runtime | `config/schema.ts:231` `.passthrough()`. `setup/QuickSetup.ts:52-59` aborts naming `OPENAI_API_KEY`; `detect.ts:124` names `--mode quick --provider ollama`, not `--mode local` | **Holds** |
| 19 | R4* | H3 webhooks are "safer inbound automation, once landed" | Taint and a restart-surviving dedupe are real, but `webhooks/engine.ts:113-114` accepts `none-localhost-only` on loopback peer + listener with no Origin or Content-Type check (a page the owner visits can POST), and `signature.ts` binds a timestamp only for Stripe (`:65-68`). Hermes's in-memory dedupe: `gateway/platforms/webhook.py:184` | **Partly** |
| 20 | R4 | Hermes: 102 slash commands, 29 tags, install e2e; `--json` in 7 subcommand modules | `grep -c "CommandDef(" hermes_cli/commands.py` = 102; `git tag \| wc -l` = 29; `.github/workflows/install-e2e*.yml`, `docker.yml`, `nix.yml` (35 workflows); `grep -rl '"--json"' hermes_cli/subcommands` = 7 of 64 files | **Holds** |

Other spot checks that held: R1 S4 (`tools/web/proxied-fetch.ts:190-201` re-sends all headers and the body on any
redirect and ignores `init.redirect`); R1 S3 (`auto-review-config.ts:17,27` allows `max_class: money`; README has 0
mentions of auto review; the untrusted check is the string list at `auto-review-policy.ts:76`); R2 (hosted solo
window is `undefined`, `runner-for-mode.ts:236-237`; `DEFAULT_SOLO_MAX_TOOL_CALLS = 25`, `solo/types.ts:28`, no
config key; todo keyed by run id, `tools/todo/store.ts:90`; reviewer only via `approvals list --review` at HEAD,
daemon tick in tree `service-daemon.ts:128-130`); R1/R4 (0 local tags; branch is 281 commits ahead of `origin/main`);
Hermes `send_message_tool.py` has 0 matches for `approv`; Hermes has no per-run cost cap (only error codes such as
`member_spend_cap_exceeded`, `agent/error_classifier.py:133`).

## 2. Ranking on accuracy

**Response 1 > Response 2 > Response 4 > Response 3**

- **Response 1 (first).** Its three blockers (B1, B2, B3) and the CI env mismatch all hold to the line, and
  each is the sort of claim that is easy to get wrong. It is also the most falsifiable: exact file:line
  references, and red tests written before the fix. It has two slips. The flake analysis was overtaken by
  `723ef22`, which landed after the review. "No LICENSE" is true of `main` only. **Got wrong or missed:** it
  audited the gateway (B3, M6) without noticing that pairing is impossible. M6 even treats "the paired admin"
  as reachable.
- **Response 2 (second).** Every loop claim I checked holds: unwired constrained output, no `cache_control`,
  text-only messages, add-only memory, no live seat-prompt reader, a hosted window of `undefined`. The Hermes
  defaults it quotes are accurate apart from the 0.75 floor. **Got wrong:** its memory row credits Trent with
  "untrusted writes held; landed". In the default fleet mode that is exactly the hole Response 1 found (B2),
  and it sits inside this response's own lens.
- **Response 4 (third).** Its claims come from executed CLI probes, which makes them strong. The pairing
  dead-end, the missing listener, no streaming, the config passthrough and the Hermes counts all hold.
  "Installed from Node, it silently runs a non-durable store" is only partly right: `headless.ts:236-239` says
  the caller prints a warning, and whether the daemon surfaces it was not shown. **Got wrong:** it rates H3
  webhooks and H5 browser attach as "ahead on safety once landed". It missed H3's loopback drive-by and
  HMAC-replay gaps, and B1, where the browser toolset hands the model key to every allowlisted site.
- **Response 3 (fourth).** The facts it checks locally hold: 2 skill evals, gate decision 4, the Hermes
  cost-estimate wording, `response_format` used for auxiliary calls only. But its positioning rests on one
  wrong claim, that the egress broker matches Hermes, when Trent is behind it (B1). It counts "12 adapters"
  as reach although none can pair. It says solo has 0 improve wiring, while the tree routes solo frames to the
  improve trace hook. A "1,022 s" figure is not in its cited source. Much of its evidence is external and
  cannot be checked here: stars, funding, Hermes Business, the Perplexity bench.

## 3. Ranking on decision value (how much acting on it changes Trent's standing against Hermes)

**Response 2 > Response 1 > Response 4 > Response 3**

- **Response 2 (first).** It targets the axis on which Hermes users actually compare agents: the everyday
  loop. That means a solo turn that works on a real model, context that survives a long session, native tools
  and caching on Claude, memory the agent can correct, and learning that reaches the live path. Each gap comes
  with a Hermes file, Trent files and an acceptance test. Acting on it moves Trent from "unproven harness" to
  "comparable harness", which is the precondition for any "surpass" claim. **Missed:** the security defects
  (B1, B2), which make its "ahead on governance" section partly untrue today.
- **Response 1 (second).** B1 and B2 are cheap (S) and existential: Trent's only real lead is trust, and both
  defects contradict published claims (README.md:171, the C5 memory hold). Fixing the live-test env makes CI
  able to prove anything live. Its value is mostly defensive, though. It restores parity and truth rather than
  creating new advantage, and it says little about loop quality or distribution. **Missed:** pairing.
- **Response 4 (third).** It has the single highest-leverage S fix in the council: add
  `gateway pair|pairings|revoke` and all 12 adapters, chat approvals and voice notes become reachable. It adds
  keyless-to-local routing and streaming. Most of its remaining list is breadth parity (ACP, REPL depth,
  operator CLI, web console, desktop), which Response 3 rightly calls a treadmill Trent loses. **Missed:** B1
  and B2, and H3's holes.
- **Response 3 (fourth).** It is the only response that proposes a way to *surpass* rather than match. It has
  a falsifiable public bench against Hermes on the same model, rehearsal on the owner's history, a cut list,
  and "tag the release". That direction is valuable. But its trust-first positioning would launch on a broker
  that leaks the model key and a memory hold that does not fire. Its SMS front door (I4) depends on a pairing
  path it did not notice is missing, and its investments are M-L new products stacked on unproven parts.

## 4. Disagreements resolved

1. **Credential isolation.** The README says "the same design (iron-proxy)", Response 3 says "only matches
   Hermes", and Response 1 says "leaks the key". **Response 1 is right.** See verification row 1: Trent
   injects the record's key for any allowlisted host. Hermes scopes each secret to named upstream hosts and
   requires the token. Trent is behind on this row, and README.md:171 is false.
2. **Are untrusted memory writes held?** Response 2 (row "landed") and the scorecard say yes; Response 1 says
   not in a real fleet run. **Response 1 is right** for fleet, the default mode (row 2). Solo gets a gate only
   in tree S3 (`solo/memory-gate.ts`).
3. **How many adapters work?** Response 3 counts "12 after H4, landed". Response 1 says 9 of 12 can receive.
   Response 4 says none admits anyone. **Response 4 is right at HEAD:** default-deny pairing
   (`PairingManager.authorize`) plus no grant path means no unpaired sender gets through on any platform. On
   top of that, 3 adapters have no listener until P3 lands.
4. **H3 webhook safety.** Response 4 calls it ahead; Response 1 calls it unsafe on loopback and replay.
   **Both are partly right.** The provenance taint, cost cap and restart-surviving dedupe beat Hermes
   (`webhook.py:184` is in memory). The loopback route has no Origin/Content-Type refusal
   (`engine.ts:113-114`), and generic/GitHub HMAC has no timestamp. Fix both before H3 lands.
5. **Make solo the default now?** Response 3 says yes. Response 2 says no doc should call solo usable until a
   live proof exists. Response 1 says land S2 before advertising local. **Response 2 is right on order:** solo
   has 0 live runs and sends no constrained output (row 7). Flip the default only after the live acceptance in
   top-10 item 6 passes.
6. **Extend the auto-reviewer inline?** Response 2 wants it consulted before parking. Response 3 lists it as
   an advantage. Response 1 says the README hides it and its untrusted check is a string match.
   **Response 1's precondition stands.** The reviewer reads attacker-influenced previews, and taint reaches it
   only through a marker string (`auto-review-policy.ts:76`). Make taint structural, and name auto_review in
   the README, before widening it.
7. **The approvals.restart flake.** Response 1 says partly addressed; Response 3 says fix or quarantine first.
   **Resolved after both reviews** by `723ef22` (`--out-root`; the test no longer rewrites the shared client).
   Still to show: consecutive green CI runs.
8. **Improvement reach.** Response 3 says solo has no improve wiring. Response 2 says solo is outside the
   loop. **Partly both.** Solo traces reach `improve.improve` in the tree (row 13). Promoted skills and seat
   prompts never reach solo, and seat prompts reach no live seat at all (row 9). No before/after win has ever
   been recorded (Response 3, which holds).
9. **Breadth.** Response 4 lists ACP, REPL depth, an operator CLI and a web console. Response 3 says stop
   developer parity. **Response 3 is right** for ACP, desktop and the web console now. But Response 4's
   pairing, streaming, keyless-to-local and service-durability items are not breadth: they block the very
   market users Response 3 targets.
10. **Local fleet evidence.** Response 3 says "1,022 s"; Responses 1 and 4 say "10-minute timeout, 0 of 2".
    **Responses 1 and 4 are right** per the cited `docs/local-models.md:156`.

## 5. Consolidated top-10 for the owner (ordered)

Order logic: close what falsifies Trent's published claims (1-2), make the shipped surfaces reachable and CI
honest (3-5), make the harness real (6-8), then distribute and prove (9-10). A tag before items 1-3 would ship
the key leak.

1. **Host-bind broker credentials (B1).** Size S. From: Response 1; corrects Response 3 and the README.
   - Problem: any allowlisted host, including every site the browser toolset visits, receives
     `Authorization: Bearer <provider key>`.
   - Evidence: row 1.
   - Files: `egress/CredentialBroker.ts`, `egress/TokenStorePort.ts` (add `hosts` to the record),
     `apps/cli/src/repl/tools.ts` (`providerCredentials` bound to that provider's hosts),
     `tools/browser/session.ts` and `tools/web/proxied-fetch.ts` (own-credential marker), README.md:171.
   - Acceptance (red first): with `intercept_domains: [api.openai.com, example.test]` and a token minted with
     `{apiKey}`, a proxied request to `example.test` carries no `authorization`, `x-api-key` or
     `x-goog-api-key`, while a request to `api.openai.com` still carries the Bearer.
2. **Gate fleet memory writes (B2).** Size S. From: Response 1; corrects Response 2.
   - Problem: `web_extract` then `memory add` in a fleet run writes the shared MEMORY.md with no hold.
   - Evidence: row 2.
   - Files: `orchestrator/index.ts:193` (wrap `fleetMemory.adapters` with `provenanceAdapters` plus
     `holdMemoryWrite`, sharing the run's provenance ledger), `fleet-memory/orchestrator-hook.ts:433`.
   - Acceptance: through `createHeadlessRuntime` with a fake gateway, an untrusted read followed by
     `memory add` in one step returns `needs_approval`, writes one row to `gateway.json`, and leaves MEMORY.md
     byte-identical.
3. **Make the gateway admit a user.** Size S. From: Response 4 (pairing); Response 1 B3 and Response 4 gap 2
   (listener).
   - Problem: no unpaired sender can ever be paired. There is no `trent gateway pair`, and webhook-only
     adapters have no listener at HEAD.
   - Evidence: rows 4 and 16.
   - Files: `apps/cli/src/commands/groups/servers.ts` (`pair`, `pairings`, `revoke` calling `PairingManager`;
     land P3's `openAdapterWebhooks`), `gateway/GatewayManager.ts:327`, `docs/gateway.md`.
   - Acceptance: a fake Telegram sender gets code X; `trent gateway pair telegram X --admin --json` exits 0;
     that sender's next message reaches the agent handler, and its reaction decides an approval card; under
     `gateway start`, a signed POST to `/webhooks/line` is accepted and a forged one gets 401.
4. **CI that can prove live claims.** Size S. From: Responses 1 and 3.
   - Problem: the live job sets the wrong env var and passes only an Anthropic key, and the schedule never
     fires off `main`.
   - Evidence: row 3.
   - Files: `.github/workflows/ci.yml:388-393` (add `TRENT_TEST_LIVE: "1"` and the Gemini/Google key;
     `workflow_dispatch`).
   - Acceptance: one dispatched run whose log shows more than 0 of the 25 `*.live.test.ts` files executed;
     then 5 consecutive green `all-checks-pass` runs at or after `723ef22` with 0 approvals.restart failures.
5. **Harden H3, then land the tree in dependency order and freeze new waves.** Size M. From: Responses 1, 3
   and 4.
   - Problem: about 150 dirty paths across 6 waves in one shared tree. The recorded mis-assemblies show that
     landing by regex over markers is itself a defect source. H3 has a loopback drive-by and a replay gap.
   - Evidence: `git status --short | wc -l` = 152 (81 untracked); row 19.
   - Files: `webhooks/engine.ts:113-114`, `webhooks/signature.ts`; each wave from its own worktree.
   - Acceptance: a POST carrying an `Origin` header, or a non-JSON content type, to a
     `none-localhost-only` route returns 403; an `hmac-sha256` delivery with a timestamp outside tolerance
     returns 401; then each wave lands as its own commit with CI green, and `git status` shows no source paths.
6. **Wire constrained output into solo and record the first live solo sessions.** Size S, plus one quiet
   window. From: Response 2 gap 1; Response 3 step 3; Response 1 S7.
   - Problem: `setup --mode local` writes solo, but solo sends no `response_format` and has never answered a
     real model.
   - Evidence: row 7; `docs/local-models.md:152` (tool smoke 1/5).
   - Files: `apps/cli/src/runtime/runner-for-mode.ts` (pass `soloResponseFormat(adapters)` under a local
     alias), `config/sections/agent.ts` (validated `solo.max_tool_calls`), a new solo `*.live.test.ts`.
   - Acceptance: a unit test shows the solo request carries `response_format` under a local alias and not
     under a hosted one; under `TRENT_TEST_LIVE=1`, a three-turn solo session on `qwen3.5:9b` and one on a
     hosted model each make at least one real tool call per turn and print tokens and cents.
7. **Solo context survives a long session.** Size M. From: Response 2 gaps 2 and 10.
   - Problem: the hosted window is `undefined`, a context-length 400 is a dead run (`retry.ts` has no overflow
     class), and the todo list resets every turn.
   - Evidence: `runner-for-mode.ts:236-237`, `tools/todo/store.ts:90`; tree `solo/compaction.ts` is untracked.
   - Files: `solo/compaction.ts`, `solo/turn.ts`, `model-gateway/retry.ts`, `tools/todo/{index,store}.ts`.
   - Acceptance: with a fake gateway, a session past threshold compacts before the next call with a
     byte-identical frozen prefix; a fake context-length 400 triggers exactly one compaction and a successful
     retry; a todo added in turn 1 is listed in turn 3 and after a forced compaction.
8. **Anthropic transport parity: native tools and prompt caching.** Size M (L with the OpenAI-compatible
   native tools). From: Response 2 gap 3.
   - Problem: the strongest tool model gets no tool schemas, no `cache_control`, no cached-token accounting and
     no abort.
   - Evidence: row 8.
   - Files: a wrapper-side Anthropic client beside `model-gateway/openai-compat.ts`, `model-gateway/types.ts`
     (tool definitions and a tool role), `solo/parse.ts`, `model-gateway/pricing.ts`.
   - Acceptance: against a fake Anthropic server, a solo turn sends `tools` and a `cache_control` breakpoint on
     the system block; a `tool_use` block becomes a call; the ledger row prices `cache_read_input_tokens` at the
     cached rate; an abort signal cancels the request.
9. **Something a stranger can install, and a keyless path to local.** Size S, plus Bobby's tag. From:
   Responses 4 (gaps 4-5), 3 and 1.
   - Problem: 0 tags, the installer 404s, and a keyless setup names `OPENAI_API_KEY` although Ollama is
     running.
   - Evidence: row 18; `git tag | wc -l` = 0.
   - Files: `setup/QuickSetup.ts:52-59`, `setup/detect.ts:124`, `doctor/checks/credentials.ts`; an install-e2e
     job in `.github/workflows/release.yml`. The tag itself is Bobby's call, after items 1-3.
   - Acceptance: with no key and a fake Ollama listing a `tools` model, `trent setup --json` exits 3 with
     `suggested: "local"` and the exact `trent setup --mode local` line; after the tag, install-e2e shows
     `trent --version` equal to the tag on macOS, Linux and Windows.
10. **A public head-to-head bench against Hermes.** Size M, plus quiet windows. From: Response 3, I1.
    - Problem: there is no claim a stranger can re-run. "Surpass" is unfalsifiable today.
    - Evidence: no bench code (`ls packages/trent-core/src/bench` fails); Hermes uses constrained output only
      for auxiliary calls (row 14), which is Trent's measurable local edge once item 6 lands.
    - Files: new `packages/trent-core/src/bench/`, `apps/cli/src/commands/groups/bench.ts`.
    - Acceptance: `trent bench run smb-20 --harness trent-solo,hermes` on `qwen3.5:9b` and on flash-lite prints
      pass@1, pass^3, time to first token and cents per successful task. Grading uses fake-server end state.
      Results are published win or lose.

**Just below the cut:**
- Streaming deltas (Responses 4 and 2).
- Memory replace/remove plus a solo prompt rewrite with a measured size (Response 2, gaps 5-6).
- Structural taint for auto-review, and naming it in README:11-13 (Response 1, S3).
- `createEgressFetch` same-origin redirects (Response 1, S4).
- Node service durability flagged at install (Responses 4 and 1).
- README, AGENTS.md and docs truth pass (Responses 1 and 4).
