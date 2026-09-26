# Stage 2, Ranker 4: the user's experience and the owner's goal

Lens: what a first-time user, a small-business owner (salon, spa, contractor) or a creator actually hits,
judged against Bobby's goal: "a better Hermes with all Trent features, a cheap or local model, every Hermes
tool, a self-improving loop", with solo mode as the base harness. This was a read-only pass. No test suite
was run, no model was called, and no port was bound. The four reviews read HEAD `79fa451`. HEAD is now
`723ef22`, which lands the derive-schema `--out-root` fix (it affects R1's S2 only). "Tree" means built,
not landed.

## 0. The first-time user's path today (each step re-checked)

1. **Install.** Nothing can be installed. `git ls-remote --tags origin` prints 0 lines, and README.md:63 admits that `install.sh` returns 404.
2. **First run, no key.** Bare `trent` runs quick setup (`commands/index.ts:337-351`). That aborts with "Set OPENAI_API_KEY" (`QuickSetup.ts:52-61`) and opens a degraded REPL that asks for a key (`degraded.ts:95`). It never probes the Ollama that `setup --mode local` finds. The only hint is a static line naming `--mode quick --provider ollama` (`detect.ts:124-125`).
3. **First run, with a key.** The fleet answers a one-line tagline with 5 ledger rows, raw JSON drafts, "Synthesized ... for Trent Local" and "ICP, Offer, Pricing, Competitors ... unconfigured" (`05_release/output/first-run-transcript-2026-09-25.txt:13-31`). "Trent Local" is `DEFAULT_COMPANY` (`headless.ts:96`), and no setup prompt asks for the business's name, hours or prices (`FullSetup.ts` asks only for toolsets, agents and caps).
4. **Local model.** `setup --mode local` writes `agent.mode: solo`. Nothing at HEAD reads that key: `runner-for-mode.ts` is untracked. The fleet it falls back to finished 0 of 2 steps in 10 minutes (`docs/local-models.md:156`). In the tree, solo still sends no constrained output (`soloResponseFormat` has no caller).
5. **Waiting.** The only progress lines are a static "Planning..." and step starts (`repl/render.ts:189`). Solo calls `complete()` (`solo/turn.ts:296`) even though the gateway's `stream()` already yields `{type:"token"}` (`model-gateway/types.ts:67-68`). Four adapters implement `sendTyping` (telegram, discord, signal, whatsapp), and nothing calls it.
6. **Chat.** An unpaired sender, which would include a shop's customer, is told "An operator can approve it with: trent gateway pair ..." (`GatewayManager.ts:327`, tree). That command does not exist and never has: `git log -S'name: "pair' -- apps/cli` finds 0 commits, and `getPairing()` has no caller.
7. **Approvals on the phone.** A card reaches `gateway.owner`, but deciding it needs an admin pairing (`ApprovalBridge.ts:180,222`). The card text is `Details: ${JSON.stringify(request.details)}` (`:267`).
8. **Staying on.** `npm run cli` is `tsx` (`package.json:17`), which runs under Node, where `openStore` falls back to `EphemeralStore` (`headless.ts:232-240`). Parked approvals die with the process.
9. **Cost.** This part works. `trent usage` reports cents per surface, seat, model, provider or tool, with estimated/unpriced flags (`groups/usage.ts`), and the REPL prints the cents for each run. This is the one thing the owner can see that Hermes cannot show.
10. **"Self-improving".** Nothing improves by default. `heartbeat.enabled` and `sweep.enabled` both default to false (`config/sections/heartbeat.ts:14,32`). Only `ads` and `prospecting` ship `evals.json`, and none of the 14 pack skills do. Solo has no improve wiring. Hermes's review is on by default (`agent/background_review.py:212`; `config_defaults.py:1283` nudge_interval 10).

## 1. Verification table (user-facing first)

| # | Resp | Claim | My check | Verdict |
|---|---|---|---|---|
| 1 | R4 | `trent gateway pair` does not exist, so the gateway admits no one | No spec in `apps/cli`. The string appears only in `GatewayManager.ts:327`, `PairingManager.ts:5,119`, `docs/gateway.md:63` and tests. 0 commits ever | Holds (HEAD and tree) |
| 2 | R4 | Chat approvals need a paired admin | `ApprovalBridge.ts:180` (buttons), `:222` (reactions) | Holds: `gateway.owner` gets cards it cannot decide |
| 3 | R4 | Keyless first run is not routed to the local model | Step 2 above. A static hint exists; there is no detection | Holds (slightly overstated: the hint is there) |
| 4 | R4 | No token streaming on any surface | `solo/events.ts:1-3` (20 frozen kinds), `turn.ts:296` `complete()` | Holds. Missed: `stream()` exists, and `sendTyping` exists with 0 callers |
| 5 | R4 | 91-157 s time to first token is what a local user sees | `docs/local-models.md:143-145`: measured at load 170-1000 with swap nearly full | Overstated: the quiet-machine number is unknown |
| 6 | R4 | `gateway setup` writes `<PLATFORM>_BOT_TOKEN` | `git show HEAD:.../servers.ts:102` | Holds at HEAD. P3 (tree) adds `gateway-setup.ts` |
| 7 | R4 | Nothing installable | 0 remote tags; README.md:63 | Holds |
| 8 | R1 | `agent.mode: solo` is read by nothing at HEAD | `git ls-files apps/cli/src/runtime/runner-for-mode.ts` is empty | Holds at HEAD; S2 (tree) wires it |
| 9 | R1 | B1: the provider key goes to every allowlisted host | `CredentialBroker.ts:98-108` has no host binding. The REPL token carries `apiKey` (`repl/tools.ts:161,191-194` HEAD). The browser sends the token (`browser/session.ts:95`). `docs/browser.md:106` tells users to add sites | Holds. A shop owner who adds their booking site leaks the key |
| 10 | R1 | B2: fleet memory writes skip the provenance hold | `orchestrator/index.ts:193` (R1 said :192). `tools/memory/index.ts` has 0 taint or provenance hits | Holds |
| 11 | R1 | WebhookServer is never constructed at HEAD | `git grep` at HEAD finds 0 constructions. Tree: `servers.ts:60-62,221` | Holds; fixed in the tree |
| 12 | R1 | The taught path is not durable | `package.json:17` `tsx`; `headless.ts:239` | Holds |
| 13 | R1 | The live CI job cannot run the live tests | `vitest.config.ts:8` reads `TRENT_TEST_LIVE`; `ci.yml:392` sets `TRENT_LIVE_TESTS` | Holds |
| 14 | R1 | The approvals.restart root cause is only partly addressed in the tree | `723ef22` landed `--out-root` after the review | Stale (moved forward) |
| 15 | R2 | Solo on local sends no constrained output | `soloResponseFormat` is defined at `solo/prompt.ts:137` with 0 production callers. The tree's `runner-for-mode.ts:300-320` config passes none | Holds in the tree too |
| 16 | R2 | The solo cap of 25 tool calls is hard-coded | `solo/types.ts:28`. No `maxToolCalls` in `runner-for-mode.ts` or `config/sections/agent.ts` | Holds |
| 17 | R2 | Memory is add-only, and solo is told about "seats" and a "founder" | `tools/memory/store.ts:174-183`, `index.ts:69-71` | Holds |
| 18 | R2 | A promoted `__seat_prompt__` has no live reader | `defaultSeatPromptProvider` is called only in `sweep.ts:468`, `fleet-versions.ts:86` and `improve-goldens.ts:336` | Holds |
| 19 | R2 | No `cache_control`; anthropic, mistral and openrouter go through the app streamers | 0 grep hits; `model-gateway/index.ts:51` | Holds |
| 20 | R2 | Solo has no compaction | True at HEAD. The tree wires `compaction: settings.compaction` (`runner-for-mode.ts:319`) | Stale for the tree |
| 21 | R3 | Inbound SMS was cut by gate decision 4 | `02_plan/output/upgrade-round-design.md:93-94,168` | Holds; Bobby's call |
| 22 | R3 | Business tools have never touched a real provider | `docs/business.md:13` | Holds |
| 23 | R3 | Only 2 skills ship evals | `find . -name evals.json` (outside worktrees): `ads` and `prospecting` only | Holds |
| 24 | R3 | The egress broker "only matches Hermes" | See row 9: Trent binds no host, while Hermes's iron-proxy binds each key to its own hosts | Wrong: it is worse |
| 25 | R3 | flash-lite costs about 0.31 cents a turn (6k tokens in, 500 out) | `pricing.ts:87` $0.30/$2.50: 0.18 + 0.125 = 0.305 cents | Holds |
| 26 | R3 | The 9B number is "unmeasured quiet" | Row 5 | Holds: the right caveat |

## 2. Rankings

**Accuracy: Response 1 > Response 4 > Response 2 > Response 3.**
**Decision value for this owner: Response 4 > Response 3 > Response 2 > Response 1.**

**Response 4 (surfaces). Accuracy 2nd, decision value 1st.** It is the only review that walked the path a real user walks. It ran 25 CLI probes, all with valid JSON. It found the defect that dead-ends every chat user: the nonexistent `gateway pair` behind a paired-admin check on every approval. It also found that keyless first run ignores a working Ollama, that the service is non-durable under Node, and that nothing is installable. Every one of these re-checked true. **Most important miss:** it has nothing on the self-improving loop, which is one of Bobby's four goals, and nothing on B1 or B2. It also reports 91 s time-to-first-token as a user fact, when it was measured under load 170-1000, and it misses that `sendTyping` already exists with zero callers, which makes its gap 3 partly an S.

**Response 3 (strategy). Accuracy 4th, decision value 2nd.** It is the only review framed around the three market users. Its demos are the ones a shop owner would understand: rehearsal on past messages, a front door that books only on the owner's yes, and a weekly receipt to the cent. Its cost table is correct, and it caveats the 9B latency honestly. **Most important miss:** its front-door plan (I4) and its "tag v1.0.0 in about an hour" step both assume the gateway can admit someone. It cannot (row 1), so a tag today ships a chat product nobody can pair. Two more problems. "Stop chasing Hermes breadth" contradicts Bobby's stated "every Hermes tool" goal without saying so. And its week-1 bench persuades developers, not a spa owner. Row 24 is also wrong.

**Response 2 (loop and model). Accuracy 3rd, decision value 3rd.** It is the deepest on what the owner's "cheap or local model" and "base harness without nine agents" goals need. Constrained output is unwired even in the tree (row 15). Solo has never answered a real model. Memory cannot be corrected. Promoted seat prompts never ship. The loop is 25 calls deep with no streaming. Its acceptance tests are the best-specified of the four. **Most important miss:** it scoped out onboarding and surfaces, so a correct, well-prompted solo loop still sits behind an unpairable gateway and a first run that asks for an OpenAI key. Its "no compaction" is now stale for the tree (row 20).

**Response 1 (truth and security). Accuracy 1st, decision value 4th.** It is the most precise review: every one of its blockers re-checked, and B1 (the key leak) is the most serious security finding of the four. **Most important miss:** it discusses ntfy pairing and approvals by a "paired admin" but never notices there is no way to pair. That is the single largest user-facing defect. Its top 10 has one user-experience item, placed last. Its CI flake analysis is partly overtaken by `723ef22`.

**Missed by all four:**
- **The card text is JSON.** `ApprovalBridge.ts:267` sends `Details: {"...":...}` to a salon owner.
- **Typing is built but never called.** `sendTyping` is implemented in 4 adapters and has 0 callers.
- **The unpaired-sender reply is operator jargon.** It names a CLI command and is sent verbatim to any stranger, such as a shop's customer (`GatewayManager.ts:327`).
- **Onboarding never asks about the business.** Setup never asks for its name, hours, services or prices. So the first answer names "Trent Local" and lists empty ICP and Pricing fields.

## 3. Disagreements resolved

- **D1. Should solo be the default now?** R3 says yes. R2 says not until it is proven live. R1 says to land S2 before advertising local.
  - Evidence: the fleet on the 9B finished 0 of 2 steps, and it spent 5 ledger rows on a tagline. Solo has zero live runs, and its constrained output has no caller (row 15).
  - Resolution: solo becomes the default for new profiles only after constrained output is wired and one quiet live run passes (action 3). Until then, `--mode local` already writes solo, and that is enough.
- **D2. Is the egress broker at parity with Hermes (R3) or worse (R1)?** R1 is right (row 9). It is a regression to fix, not a talking point.
- **D3. Does anything stream (R2) or nothing (R4)?**
  - Both are right, at different layers. Provider tokens do stream into the gateway (`types.ts:67-68`). Solo discards them via `complete()`, and no surface renders them.
  - A caveat neither raised: once constrained output lands, the raw stream is a JSON envelope. So the REPL has to stream only the `answer` field, parsed incrementally, or the user sees `{"answer":"...`.
- **D4. "9 of 12 adapters receive" (R1) or "the gateway admits no one" (R4)?** R1 counts transport and R4 counts people. For a user, R4 is right: 0 of 12 platforms admit a new sender without hand-editing `gateway.json`.
- **D5. Local latency.** R2 and R4 cite 91-157 s as fact. R3 flags contention, and R3 is right (`docs/local-models.md:143-145`). No user-facing latency claim should be made until there is a run at load under 40.
- **D6. Breadth: cut it (R3), build it (R4: REPL, ACP, operator CLI, web console), or "every Hermes tool" (Bobby)?**
  - Resolution: sequence it, do not cut it. Breadth multiplies value only after the base path works end to end.
  - The evidence supports R3 on one point: no desktop packaging before real installs (`release.yml:298-307`, not wired).
  - Bobby's goal stands, but after actions 1-9.
- **D7. Tag now (R3) or after fixes (R4)?** After actions 1, 2 and 7, which is days of work and not weeks. The compiled binaries run under Bun, so a tag also cures the Node durability hole for binary users.
- **D8. What comes first: security (R1), the loop (R2), the bench (R3) or pairing (R4)?** Order by what blocks the most users:
  1. pairing and keyless-to-local (S; they block 100% of chat users and every keyless user);
  2. the solo loop on the owner's model;
  3. B1 and B2 (S; they block only users who touch those paths, but they are silent harm).

## 4. Consolidated top 10 (ordered)

**1. Pairing that works, with a customer-safe reply.** Size S. Sources: R4 #1, plus the reply text (new).
- Problem: no user on any of the 12 platforms can be admitted, and no approval card can be decided.
- Evidence: rows 1-2; the reply text at `GatewayManager.ts:327`.
- Files: new `apps/cli/src/commands/groups/gateway-pair.ts` (`gateway pair <platform> <code> [--admin]`, `gateway pairings`, `gateway revoke`), registered beside `servers.ts`; `GatewayManager.ts` (neutral reply text for strangers); `docs/gateway.md`.
- Acceptance: with a fake Telegram, an unknown sender gets a code, and the reply contains no "trent " substring. `trent gateway pair telegram <code> --admin --json` exits 0. The sender's next message reaches the agent handler, and their reaction decides a pending card.

**2. Keyless first run finds the model on the machine.** Size S. Source: R4 #4.
- Evidence: step 2 of §0.
- Files: `setup/QuickSetup.ts:52-61` (probe `createLocalRuntime()` before aborting), `setup/detect.ts:124`, `repl/degraded.ts:95`, `doctor/checks/credentials.ts:78`.
- Acceptance: with no key and a fake Ollama on loopback listing a tools-capable model, bare `trent --json` returns `suggested: "local"` and the exact `trent setup --mode local` line. The doctor's fix hint names the same command.

**3. Solo on a local model, constrained and proven, then the default.** Size S for the wiring, M for the proof. Sources: R2 #1, R1 S7, R3 step 3.
- Evidence: row 15; the smoke test scores 1/5 unconstrained; L1 moved seats from 2/5 to 4/5 constrained.
- Files: `apps/cli/src/runtime/runner-for-mode.ts` (pass `soloResponseFormat(adapters)` under a local alias), `config/sections/agent.ts` (validate `solo.max_tool_calls`), `setup/*` (default `agent.mode`).
- Acceptance:
  - A unit test asserts that the solo request carries `response_format` under a local alias and not under a hosted one.
  - At load under 40, `trent solo` on `qwen3.5:9b` completes 3 turns, each with at least 1 real tool call. Time-to-first-token and cents are recorded in `docs/local-models.md`.
  - The solo default flips only if the doctor smoke on the solo format is at least 4/5.

**4. Show life while the model works.** Size S for typing, M for deltas. Sources: R4 #3, R2 #7, plus `sendTyping` (new).
- Evidence: step 5 of §0; D3.
- Files: `apps/cli/src/gateway/agent-handler.ts` (call `sendTyping` every 4 s while a turn runs), `solo/turn.ts` (use `stream()`), `orchestrator/types.ts` (one additive `step_delta`), `repl/render.ts`, `tui/Chat.tsx`.
- Acceptance: against a fake OpenAI-compatible server that emits 50 deltas 100 ms apart:
  - the REPL prints answer text, with no `{"answer"`, within 300 ms of the first delta and before `step_end`;
  - a fake Telegram receives `sendChatAction` at least every 5 s during a 20 s turn.

**5. Approval cards in the owner's words.** Size S. Source: new (none of the four raised it).
- Evidence: `ApprovalBridge.ts:261-271` renders the agent id, the action id and raw JSON.
- Files: `gateway/ApprovalBridge.ts`, plus a per-action `preview()` on `tools/business/*` and `tools/social/*`.
- Acceptance: a snapshot test covers every business and social action. The card for a Square booking reads "Book Maria Lopez · Trim · Tue 3:00-3:30 pm · $40". No card contains `{` or an internal id other than the Ref line.

**6. Close the two silent-harm holes.** Size S + S. Source: R1 B1, B2.
- Evidence: rows 9-10.
- Files: `egress/CredentialBroker.ts` and `TokenStorePort.ts` (bind each record to its provider's hosts); `orchestrator/index.ts:193` (wrap `fleetMemory.adapters` with `provenanceAdapters` plus `holdMemoryWrite`).
- Acceptance:
  - Through the proxy, a request to an allowlisted non-provider fake host carries no `authorization`, `x-api-key` or `x-goog-api-key`.
  - Through `createHeadlessRuntime`, `web_extract` followed by `memory add` in one step returns `needs_approval`.

**7. WhatsApp and LINE can receive, with a way to reach them from the internet.** Size S to land, M for the tunnel. Sources: R1 B3, R4 #2.
- Evidence: row 11; `webhooks.host` defaults to `127.0.0.1` (`config/sections/gateway.ts:81`).
- Files: land H3 and P3 (`servers.ts:60-62`, `gateway-setup.ts`); add `docs/webhooks.md` with one tested tunnel recipe that prints the public URL.
- Acceptance:
  - With only `LINE_CHANNEL_*` set, `gateway start` accepts a correctly signed POST to `/webhooks/line` and 401s a forged one.
  - `gateway setup whatsapp` writes the variable name the adapter actually reads.

**8. Something a stranger can install that does not forget.** Size S (Bobby's tag) + S. Sources: R3, R4 #5-6, R1 S10.
- Evidence: steps 1 and 8 of §0.
- Files: `service/install.ts`, `service/program.ts`, `.github/workflows/release.yml` (an install-e2e job).
- Acceptance:
  - Under Node, `service install --dry-run --json` reports `durable: false` and exits 3 unless `--allow-ephemeral` is passed.
  - After the tag, the published `install.sh` on clean macOS and Linux runners gives `trent --version` equal to the tag.
  - A parked approval survives a `kill -9` of the binary's daemon.

**9. "Tell Trent about your shop" onboarding.** Size S-M. Sources: new, partly R3 I3.
- Evidence: step 3 of §0.
- Files: `setup/FullSetup.ts` and `QuickSetup.ts` (name, hours, services and prices, tone, or `brain import <price-list.pdf>`), `runtime/headless.ts:96`.
- Acceptance: scripted setup prompts write the company brief. A fake-gateway solo turn asking "how much is a trim?" answers "$40" and cites the brief's chunk id. The run output contains "Trent Local" 0 times.

**10. Self-improvement the owner can see.** Size M-L. Sources: R2 #4, R3 I3.
- Evidence: step 10 of §0; row 18.
- Files: new `improve/session-review.ts`; `solo/runner.ts` (trace and golden hooks); a live seat-prompt reader in `orchestrator/index.ts`; `config/sections/heartbeat.ts:32`; suites for the 14 pack skills.
- Acceptance:
  - After 10 fake solo turns, one review files at least 1 skill draft into curator quarantine and at least 1 memory entry through the held path.
  - `trent improve report` prints held-out before/after figures for each promoted draft.
  - A promoted `__seat_prompt__` changes what a fake seat receives on the next run.
  - The sweep defaults to on only for a profile that has a suite.

### The one demo for a small-business owner within two weeks: "Book it from your phone"

1. **The request.** On Telegram, the owner sends a voice note or a typed message: "Maria Lopez wants a trim Tuesday at 3, book her and text her a confirmation." Telegram long-polls (`telegram.ts:2`, `getUpdates`), so no public URL is needed. Voice notes already transcribe locally (P2-3).
2. **The work.** Trent runs in solo mode on flash-lite and shows the typing indicator. It checks Square sandbox availability.
3. **The approvals.** It sends two plain-English cards: "Book Maria Lopez · Trim · Tue 3:00-3:30 pm" and "Text Maria: 'You're booked Tue at 3:00 - see you then'". The owner taps Approve on each.
4. **The result.**
   - The booking exists in the Square sandbox (checked through its API).
   - The text reaches a verified number through a Twilio trial account.
   - A second tap is answered from the idempotency store, and 0 duplicate bookings are made.
   - `trent usage --since 1d` shows the exchange in cents.
5. **Pass criteria.**
   - The first card arrives within 60 s at p95.
   - The whole exchange costs under 2 cents at list price.
   - It is the first real-provider call in the repo's history (`docs/business.md:13`).
6. **Prerequisites.** Actions 1, 3 (hosted solo, S2 landed), 4 (typing) and 5.
7. **Why this demo.** It puts on one phone screen the three things Hermes lacks: a yes bound to the exact call, idempotency, and cents.
8. **Why not the others (yet).**
   - R3's inbound-SMS front door is the natural week 3-5 sequel. It needs gate 4 reversed, a public-intake pairing mode that does not exist, public ingress (action 7) and 10DLC for production.
   - R3's bench convinces developers, not a spa owner.
9. **Local variant.** Show the 9B only if the quiet run in action 3 measures a first token under about 30 s. Otherwise say "about a third of a cent a turn on flash-lite; local for back-office work" (R3's cost table).

**Bobby's gates:**
- Tag v1.0.0 after actions 1, 2 and 7.
- Decide on gate 4 (inbound SMS).
- Create Square sandbox, Stripe test-mode and Twilio trial credentials for the demo, and record where they are stored, never their values.
