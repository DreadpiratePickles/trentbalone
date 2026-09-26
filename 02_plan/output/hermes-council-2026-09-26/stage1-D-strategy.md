# Council stage 1, reviewer D: the strategy to surpass Hermes Agent (2026-09-26)

Lens: strategy. Read-only pass on `feature/trent-fleet-v2` at HEAD `79fa451` plus the working tree
(54 modified, 65 untracked paths: waves S2, H3, H5, L1, S3, P3). No test suite was run (load 156-380).
Tags used below: **[landed sha]** = committed; **[tree]** = in the working tree, not landed;
**[planned]** = in a design or log only; **[absent]** = 0 hits. Hermes facts come from the local checkout
`~/.hermes/hermes-agent` (v0.21.3, last commit 2026-09-20), the GitHub API read today, and
`01_discovery/output/hermes-feature-inventory-2026-09.md` (cited `HI`).

## 1. Summary verdict (10 lines)

1. Trent has no users: no tag, 0 stars, and the default branch does not carry the code. Hermes has 249,012 stars and shipped v0.21.5 on 2026-09-24 (460 PRs; v0.21.4 had about 1,800). Out-building Hermes on breadth is not possible, so Trent should stop trying.
2. The advantages that are real and landed are governance primitives. An approval is bound to the exact arguments and an idempotency key. The audit is signed and hash-chained. A cents ledger stops a run when it hits the cap. Agents export both ways. A2A with Hermes is proven live. The egress broker only matches Hermes; it is not a lead.
3. The other headline claims are unproven:
   - Self-improvement has never recorded a before/after win. Only 2 skills ship evals, a seat's "eval suite" is just a label, and solo mode has no improvement wiring.
   - The business tools have never touched a real provider.
   - On a local 9B model the fleet failed "Say ready" after 1,022 s.
   - Solo mode has never run against a real model.
4. Hermes wins today on install, onboarding (Portal OAuth plus a free tier), model breadth, 208 skills, about 30 chat platforms, voice, a Desktop app (Simple mode, three languages) and speed of shipping. It entered business on 2026-09-15 with Hermes Business, which has per-member caps.
5. Hermes's documented weak spots are exactly Trent's primitives:
   - Its cost figures are "a local lower-bound estimate", off by default.
   - It has no way to "simulate answers on past tickets".
   - What it learns is never graded.
   - On the same Qwen, it scores 74.0% where a harness shaped for local models scores 82.6%.
6. Strategy: win on trust and proof for a business running a cheap or local model:
   - rehearse on the owner's own history before going live;
   - learn only with a held-out number;
   - send receipts that match to the cent;
   - touch a customer only after a bound yes.
7. Five investments, 4-6 weeks:
   - a public head-to-head bench against Hermes on the same model;
   - rehearsal on the owner's own history;
   - a graded learning loop in solo mode;
   - an inbound SMS front door with owner-approved bookings, live on provider sandboxes;
   - a signed weekly receipt.
8. What to cut:
   - the fleet as the default (solo becomes the default; the fleet becomes `--team`);
   - "173 agents" in the pitch;
   - more adapters, desktop work and developer-only parity items;
   - more improvement-gate machinery before a suite exists;
   - the daily parity sweeps.
9. Today Trent beats Hermes only for an operator who needs caps, bound approvals and an offline-verifiable audit around agents that touch money or customers, and for Hermes users who call Trent over A2A. For everyone else, Hermes is the right choice.
10. First, in order:
    - land the working tree and freeze new waves;
    - Bobby tags v1.0.0;
    - run the first real solo turn on qwen3.5:9b;
    - build the bench and publish its numbers, win or lose.

## 2. Why people choose Hermes (evidence)

| Reason | Evidence | Honest read |
|---|---|---|
| Traction and trust in the brand | GitHub API today: 249,012 stars, 52,821 forks, pushed 2026-09-26 04:30Z; Nous "in talks ... at $1.5B valuation" (https://techcrunch.com/2026/07/13/hermes-agent-maker-nous-research-in-talks-for-new-funding-at-1-5b-valuation/) | Network effects: skills, guides, answers exist for it. Trent has 0 stars (`gh api repos/DreadpiratePickles/trentbalone` -> 0) |
| Velocity | v0.21.4 (2026-09-21) "~1,800 PRs since v0.21.3"; v0.21.5 (2026-09-24) 460 PRs, 1,610 commits, 4,828 files (https://api.github.com/repos/NousResearch/hermes-agent/releases) | Trent landed 101 commits since 2026-09-19 (`git log --since=2026-09-19`). Row-by-row parity is a treadmill Trent loses |
| One-line install everywhere | curl, PowerShell (bundled MinGit, no admin), Docker, Nix, Termux (`~/.hermes/hermes-agent/README.md` Quick Install; HI §1.1) | Trent: `git tag` empty; `install.sh` 404 (README "What is not done yet") |
| No key-collecting | `hermes setup --portal`: one OAuth login gives 300+ models plus a Tool Gateway (search, images, TTS, cloud browser); Nous free tier since v0.21.2 (README "Skip the API-key collection"; HI §2) | The biggest onboarding gap. Trent: keys only (`core/connect/providers.ts:102-268`) |
| Any model, switched live | `hermes model`; ~40 providers, 10 subscription logins, managed llama.cpp, GPT-6 and Claude Opus 5.5 in catalogs within days (HI §1.7; v0.21.5 notes) | Trent: 5 providers + 4 aliases (`core/model-gateway/types.ts:19`) |
| "The self-improving AI agent" | README line 1: "the only agent with a built-in learning loop"; the background review runs on the main model by default and writes memory and skills (`website/docs/user-guide/features/memory.md:330-379`) | It is the story people repeat. It is ungraded: nothing is scored on held-out data (HI §1.6; scorecard #28) |
| Skills ecosystem | 59 bundled + 149 optional skills, 8 hub source types, agentskills.io standard, 285-entry SHA-pinned plugin catalog (scorecard #27, #36) | Trent: 14 core skills, 10 hub entries |
| Reach | ~30 chat adapters incl. personal WhatsApp, iMessage, SMS; "Run it on a $5 VPS"; Modal/Daytona hibernate (README; HI §1.3, §1.5) | Trent: 12 adapters after H4 [landed ee84083]; no VPS image (only `scripts/sandbox/Dockerfile`) |
| Moving up-market | Hermes Business, 2026-09-15: team accounts, shared balance, "per-member usage caps", shared skills, on-prem (https://www.tao.media/nous-research-launches-hermes-business-for-team-based-ai-agent-workflows/) | Takes the "caps" talking point for teams. Its caps are per member, on Nous credits: not per run, per agent or per external tool |
| Polish for non-coders | v0.21.5: Desktop Simple/Advanced mode, a Connectors page with "Connect now", FR/DE/ES catalogs, plugin SDK | Trent's Tauri app is not packaged (`release.yml:298-307` "NOT WIRED") |

**Where Hermes is weak (these are the openings):**
- Its cost figures are "a local lower-bound estimate" and are off by default (`website/docs/user-guide/configuration.md:3052`).
- A 2026-07-19 review says it has no "way to simulate answers on past tickets", calls it "not a customer support product", and bounds its memory at about 2.2-3.6K characters (https://www.eesel.ai/blog/hermes-agent-review).
- On Perplexity's 53-task local bench on Qwen 3.8 27B, Hermes scores 74.0% against Computer's 82.6% (`harness-others-2026-09-26.md:136-137`).
- It "run[s] commands directly with the user's permissions by default" (`harness-others-2026-09-26.md:143`).
- A truncated tool argument is silently replaced with `{}` (open issue #89207; `local-models-2026-09-26.md` §4).
- After 3 local failures it falls back to a cloud provider, with no preview of what leaves the machine (`local-models-2026-09-26.md` §4, Ollama guide row).
- The most-reacted open requests include backup and version control (#12238) and a remote agent with local tool execution (#18715) (GitHub search API, today).

## 3. Trent's structural advantages, each with proof of working

| # | Advantage | Status | Proof it works | What is NOT proven | Hermes |
|---|---|---|---|---|---|
| A1 | A yes covers one exact call; a replay is answered from the idempotency store | landed (`governance/bound-approvals.ts`, `idempotent-dispatch.ts`) | `bound-approvals.test.ts`, `idempotent-dispatch.test.ts`; `docs/security.md:494-540` | Never exercised against a real provider (`docs/business.md:13` "No test reaches a real provider") | Approvals cover commands; nothing binds a send to its preview (scorecard #38) |
| A2 | Signed, hash-chained audit, and rules over tool sequences | landed (`audit/signing.ts`, `governance/policy-rules.ts`) | `audit/signing.test.ts`, `policy-rules.test.ts`; `trent audit verify` | Nobody outside the repo has verified an export | None in the inventory |
| A3 | One cents ledger for model and tool spend; per-run, per-seat and daily caps that stop; exit 6 | landed (43d838d, 3061f90) | The first run prints `$0.02`, equal to the ledger's 5 rows at list price (`05_release/output/first-run-transcript-2026-09-25.txt`; P2-8 log) | Tool spend reconciled against a real invoice | Lower-bound estimate, off by default; Hermes Business caps per member only |
| A4 | Reviewer model for held calls inside a written policy; no verdict means blocked; decisions on a hash chain | landed 5bab958 (default off) | `governance/auto-review.test.ts`, `auto-review-policy.test.ts` | No live-model decision has been recorded | `approvals.mode smart` approves commands, with no bound call or chain |
| A5 | Local-only guarantee: under a local provider no model call leaves localhost; the ledger labels `local via` vs `hosted via` | landed 77373a0 (mistral leak closed) | L0-1 routing tests | No egress-log proof on a full run | Silent cloud fallback after 3 local failures |
| A6 | Escalation to a hosted model only after a bound approval that previews the prompt (keyed by SHA-256) | tree (`model-gateway/escalation.ts`, `orchestrator/port-escalation.ts`) | `escalation.test.ts` 11/11 (L1 log 01:05) | Unlanded; never run live | Automatic fallback. Only Perplexity does gated escalation (OT P14) |
| A7 | Company brain: git-versioned, truth rule, chunk-cited document import | landed (`fleet-memory/brain.ts`, `ingest/`) | `trent brain import`; recall gate | Hybrid recall@8 = 0.629 against its own 0.9 target (README "Retrieval quality") | MEMORY.md/USER.md bounded to ~2.2-3.6K characters |
| A8 | Self-improvement that cannot grade itself (different-model judge, holdout, pass^k, auto-rollback, human promote) | landed machinery (`improve/`, 70+ files) | Unit tests; a live sweep ran with 3-5 Gemini calls (`docs/sessions/2026-09-13-cs329a-batch-2.md:26`) | **No recorded before/after gain on any task.** 2 skills ship `evals.json` (`ads`, `prospecting`); a seat's suite is `evalSuiteId: seat` (`fleet/seat-capabilities.ts:144`), filled only by promoted failure goldens (`improve/seat-suite.ts:9-12`); sweep off by default (`config/sections/heartbeat.ts:32`); the app-side sweep is a no-op (AGENTS.md defect 4); **solo has no improve wiring** (0 hits in `solo/`) | Review fork on by default, ungraded |
| A9 | Business and social executors: Stripe, Square, Calendar, Twilio out; Meta, Bluesky, Buffer | landed (`tools/business/`, `tools/social/`; packs call them, ba5d2b0) | Fake-server tests only | Never live (`docs/business.md:13`, `docs/social.md:6-8`) | None built in; MCP only |
| A10 | Nine seats with per-seat cents budgets | landed (`fleet/seat-capabilities.ts`) | `trent fleet show finance` (budget 125 cents) | That the fleet beats one agent on any task class. On `qwen3.5:9b` a fleet run of "Say ready" failed at 1,022 s, 0 of 2 steps (`docs/local-models.md:144-156`). 164 specialists have `toolsCount: 0` and never run (scorecard §4 item 5) | Kanban, Bots, delegate_task with steer/stop |
| A11 | Portability both ways; A2A server and client | landed | Live Hermes import (`docs/sessions/2026-09-20-w5-hermes-codex-export.md`); Hermes v0.21.3 calls Trent over A2A v1.0 (`2026-09-20-hermes-a2a-discovery-proof.md`) | None | Imports only |
| A12 | Local clip studio (9:16 cuts, burned captions) | landed (`tools/media/`) | `docs/media.md`, tests | On this machine `whisper-cli` and `scenedetect` are missing (README packs note) | None |
| A13 | Solo mode: one agent on every surface, sharing the gate, ledger and approvals | S1 landed e0e13ab, S1.1 landed 35fd43b; S2/S3 in the tree | 84 solo tests (S1.1 log) | **Never run against a real model** (the S1.1 log says the "live smoke on the 9B is NOT measured"; nothing in S2/S3) | Hermes *is* this shape, mature |

Not an advantage: the egress proxy (Hermes has the same design, iron-proxy, HI §1.5), and the wrapped web
app. The app carries AGENTS.md defects 1-3 (fails open when `DATABASE_URL` is missing; the standalone
build ships no dependencies). It is a liability as a user surface, and valuable only as the library
the fleet runs on.

## 4. What the field requires that Trent lacks

| Requirement (who sets it) | Trent status | Matters to the three market users? |
|---|---|---|
| One-line install with auto-update (Claude Code, Codex, Hermes; AN §1.9, OA D1-D3) | Built, not published: 0 tags; the repo is public but `main` lacks the code | Yes: this is gate zero |
| A free way to start (Codex Free, Gemini CLI 1,000 a day, Nous free tier; OA D6, OT G1) | absent; local models are the plan (L2 5989ac8) | Yes |
| A harness shaped for small models: compact core, skills on demand, constrained output, gated advisor (Perplexity P14/P15; Cline compact prompt) | Solo landed; constrained output, repair and escalation in the tree (L1); **unmeasured on any real model**; doctor tool smoke 1/5 on the old format (`docs/local-models.md:152`) | Yes (cost and privacy) |
| Work continues with the laptop closed (Cowork, Routines, Codex cloud, Hermes on a $5 VPS or Modal; AN §1.1, OA §0) | absent: `trent service` is a local daemon, "not yet tried through a real reboot" (README); no deploy image | Yes, for a shop's front door |
| An auto-review model in place of most prompts (Claude auto mode, Codex auto-review) | landed 5bab958, default off, and only the `trent approvals list --review` trigger (the P3 daemon tick is in the tree) | Yes (fewer prompts) |
| Events start work (Claude Routines, Cursor Projects, Hermes webhooks) | tree (H3: signed routes; Stripe and GitHub signatures; Twilio's scheme absent) | Yes |
| Browser in the owner's logged-in session (Claude in Chrome, Manus Operator) | tree (H5, CDP attach behind the gate) | Social: yes |
| Teach it once (Codex Record & Replay OA I6; Hermes `/learn`) | absent (0 hits for `/learn`, `skills learn`) | Yes |
| Skill or plugin measured against a no-skill baseline, gating CI (`claude plugin eval`, AN §1.8) | Graders exist (`core/evals/index.ts`); no baseline-vs-skill product surface | Indirectly: it is the credibility of "self-improving" |
| Compaction that re-injects instructions, memory and plan (AN §1.1) | tree (S3, solo) | Noticed only when it fails |
| An OS-native sandbox by default (Codex Seatbelt/bwrap; Claude, with 84% fewer prompts) | absent; Docker or a scrubbed `local`, with a silent fallback (AU G12) | Developers only |
| Programmatic tool calling, orchestration scripts, computer use (OA T18, AN §1.4, F7) | absent | Developers mostly; skip for now |
| Shareable output and proof of work (Artifacts, Perplexity sites, Devin video) | partial: files to Telegram | Creators: yes, later |
| Predictable cost (the top complaints: Codex #28879 at 560 reactions, Claude #16157 at 726, #38335) | **ahead** (A3) | Yes: this is the pitch |

## 5. The five decisive investments

Common spine. Items 1-3 share one task format: a fixture of a message, fake-provider state and a
grader, built from `core/evals/index.ts` graders (`state_check`, `tool_call`, `llm_rubric`) and the
existing fake servers (`tools/business/*.test.ts` servers, `tools/social/testing/fake-platforms.ts`).
Build it once, then use it three times. Every run records cents from the ledger.

### I1. The public head-to-head: Trent solo vs Hermes, same model, same tools, same tasks
- **Demo.** `trent bench run smb-20 --harness trent-solo,hermes --model ollama/qwen3.5:9b` (and again on
  `gemini-3.5-flash-lite`) prints pass@1, pass^3, median time to first token, wall time, tokens and
  cents per task, plus cents per successful task.
  - Fairness: Hermes gets the same fake business tools through `trent mcp serve` (stdio,
    `core/mcp-server/`). It is driven by `hermes chat -q --format stream-json` (a v0.21.4 feature) at a
    pinned version (0.21.5).
  - Grading: from the fake server's end state, not from text.
  - The fleet (`--team`) runs as a third column. This is the test of whether it earns its place.
- **Metric (falsifiable).**
  - On the local 9B, Trent solo's pass rate is at least Hermes's plus 8 points. The shaped-harness
    gap measured by Perplexity is +8.6 (82.6 vs 74.0 on Qwen 3.8 27B).
  - On flash-lite, 0.5 cents or less per successful task.
  - Local plus approved escalation reaches 90% or more of the Sonnet pass rate at 10% or less of its
    cost.
  - The numbers are published whether Trent wins or loses; a loss names the failing tasks.
- **Why it is decisive.** It is the only claim a stranger can re-run. The measurable differences are
  constrained output on the main loop (Hermes uses `response_format` only for auxiliary requests,
  `agent/auxiliary_structured_output.py`), a byte-stable solo prefix, and prompt-budget refusal
  instead of truncation.
- **Files.**
  - New: `packages/trent-core/src/bench/{suite,trent-runner,hermes-runner,report}.ts`,
    `apps/cli/src/commands/groups/bench.ts`.
  - Reused: `solo/runner.ts`, `solo/parse.ts`, `model-gateway/response-format.ts` and
    `tool-call-repair.ts` [tree], `escalation.ts` [tree].
- **Size.** M: 7-10 days, one agent, plus a quiet-machine window with load under 40. The live runs are
  serial; the machine swaps under concurrent Ollama calls (handoff log).

**The local wedge, honestly (cost table).** The figures are derived. The token counts are anchored on
the measured 5,935-token seat prompt (L0-2 log). Prices are from `model-gateway/pricing.ts` (Google
2026-09, Anthropic 2026-05 list). One turn is 6,000 tokens in and 500 out; a shop runs 150 turns a
day (50 conversations of 3 turns).

| Tier | Price per 1M tokens (in/out) | Cents per turn | Per day at 150 turns | Latency evidence |
|---|---|---|---|---|
| `qwen3.5:9b` local, M1 Max 32 GB | 0 (`LOCAL_ROW`, `pricing.ts:151`) | 0 | $0 + hardware | Measured under load 170-1000: time to first token ~157 s at 5.9K tokens, 3 tok/s decode, so ~5 min per cold turn. **Unmeasured quiet**; must be measured before any claim |
| `gemini-3.5-flash-lite` | $0.30 / $2.50 (`pricing.ts:88`) | 0.31 | ~$0.46 | README first run: 15 s for a 5-call fleet run |
| `gemini-3.6-flash` | $0.75 / $3.75 (`:91`) | 0.64 | ~$0.96 | - |
| `claude-sonnet-4` | $3 / $15 (`:124`) | 2.55 | ~$3.83 | - |
| `claude-opus-4` | $15 / $75 (`:126`) | 12.75 | ~$19.13 | - |

The fleet multiplies calls: 5 ledger rows for a one-line tagline (README proof comment), and 11 cold
prefixes on a local runtime. Reading the table:
- **The local 9B is a privacy wedge for back-office work** (quotes from a price list, drafts, clips,
  transcripts) that can wait minutes. It is not a live customer front door on this hardware.
- **The practical "cheap model" is flash-lite, at about half a cent a turn.** Local becomes the
  privacy tier, and anything leaving the machine does so only after a bound yes (A5, A6).
- **The machine limits the claim.** On a 32 GB Mac the tier model (`qwen3.6:27b`, the field's
  consensus pick) is not pulled here (L2 log). The two pulled 27Bs are "chat, no tools". So the only
  local tool model tested is 9B, which the field rates "single tool calls mostly right; multi-step
  plans unreliable" (`local-models-2026-09-26.md` §6.1).

### I2. Rehearsal: run the agent on the owner's own last 50 messages before it talks to anyone
- **Demo.**
  1. `trent rehearse inbox.csv --pack small-business` (or `--from-session <id>` via
     `sessions export`) replays each customer message through solo.
  2. Every side-effecting call is parked through the adapters' `dryRun` path (`solo/hold-policy.ts`)
     and listed with its exact arguments.
  3. Each reply is graded by rubric and priced.
  4. The report shows the pass rate, a would-have-sent list, projected cents per day, and every
     failure captured as a golden (`improve/golden-capture.ts`).
  5. `trent rehearse approve` switches the channel live.
- **Metric.**
  - 100% of side effects parked, asserted by the fake-server hit count being 0 and 0 non-loopback
    egress.
  - 50 messages rehearsed in under 10 minutes on flash-lite.
  - The first live week's cost lands within 25% of the projection.
- **Why it is decisive.** It answers the objection a reviewer raised against Hermes (no simulation on
  past tickets). It also puts every Trent-only primitive on one screen: bound holds, the ledger, the
  graders and goldens. And it matches the market evidence: 89.2% of creators always review AI output,
  and 85% say the final decision stays with them (`market-agents-research-2026-09-19.md` §0).
- **Files.**
  - New: `packages/trent-core/src/rehearse/`, `apps/cli/src/commands/groups/rehearse.ts`.
  - Reused: `solo/hold-policy.ts`, `governance/bound-approvals.ts`, `governance/spend-ledger.ts`,
    `core/evals/index.ts`, `telemetry/session-export.ts`, `fleet-memory/ingest/` (CSV).
- **Size.** M: 5-7 days.

### I3. A learning loop that shows its number, for solo as well as the fleet
- **Demo.**
  1. `trent skills learn ./price-list.pdf` and a session-end review draft skills into curator
     quarantine.
  2. `trent improve sweep --suite rehearsal:<owner>` grades each draft on the held-out split with
     pass^k.
  3. `trent improve report` prints, for example: "quote-from-price-list: held-out 12/20 -> 17/20,
     pass^3 0.71, promoted by bobby" and "tone-casual: rejected, regressed 2 frozen cases". The second
     line is the draft Hermes's ungraded review fork would have kept.
- **Metric.**
  - At least one promoted skill with a held-out gain of 10 points or more and 0 regressions on the
    frozen split.
  - At least one rejected draft.
  - Every promoted artifact carries its before and after figures in the report.
  - `heartbeat.sweep.enabled` flips to default-on only for a profile that has a suite.
- **Why it is decisive.** Hermes's headline is "the self-improving agent", and Trent's machinery
  already outclasses it on paper: judge, holdout, pass^k, rollback, human promote. But it has zero
  demonstrated wins and no suites for the market packs. That fails Bobby's "self-improving loop for
  all agents" today, since solo has no wiring.
- **Files.**
  - `solo/runner.ts` (trace and golden hooks); `improve/seat-suite.ts` (a suite for seat `trent`).
  - New: `improve/session-review.ts`.
  - Also: `skills/foundry.ts`, `curator/`, `apps/cli/src/commands/groups/skills.ts`,
    `config/sections/heartbeat.ts:32`.
- **Size.** M-L: 10-14 days. It depends on I2's suite format.

### I4. The front door: answer the shop's texts, book only on the owner's yes, live on provider sandboxes
- **Demo.**
  1. A customer texts the shop's Twilio number: "Can I get a trim tomorrow at 3?"
  2. Solo reads the brain and Square sandbox availability, then replies with two slots.
  3. The customer picks one. A booking card with the exact slot lands on the owner's Telegram.
  4. The owner taps approve, and the Square sandbox booking is created.
  5. A second identical tap is answered from the idempotency store. The ledger shows cents per
     conversation.
- **Metric.**
  - First reply under 60 s at p95 on flash-lite.
  - 0 bookings without an approval (checked from the audit chain).
  - The first real-provider runs in the project's history: Square sandbox, Stripe test mode, and
    Twilio test credentials.
- **Why it is decisive.** "Answer inbound SMS and missed calls" is job #1 for mom-and-pop,
  construction and spas (`market-agents-research-2026-09-19.md` §1.1). Hermes has an SMS adapter but
  no booking tool and no bound approval. Trent has the booking tool and the approval, but no inbound
  SMS: that was removed by gate decision 4 (`02_plan/output/upgrade-round-design.md:93,168`), which
  **Bobby must reverse**.
- **Files.**
  - New: `gateway/platforms/sms.ts`. Twilio's `X-Twilio-Signature` scheme goes on
    `gateway/WebhookServer.ts` (H3 [tree]).
  - A public-intake mode in `gateway/security/PairingManager.ts`: unpaired customers get brain reads
    and availability; every write parks for the owner.
  - Also: `tools/business/{square,calendar,sms}.ts`, `gateway/ApprovalBridge.ts`,
    `config/sections/gateway.ts`.
- **Size.** M: 7-10 days, plus Bobby's gate. US production needs A2P 10DLC registration, which takes
  weeks; the demo runs on test credentials and a verified number.

### I5. The owner's weekly receipt: to the cent, signed, on their phone
- **Demo.** A cron job, Monday 08:00 local, sends to Telegram or email, for example: "37 conversations,
  9 bookings (all approved by you), 2 invoices sent, 0 refused actions, spend $1.84 at list price
  (model $1.31, Twilio $0.53), 1 skill promoted (+15 held-out), audit chain verified". The signed audit
  export is attached.
- **Metric.**
  - The receipt equals the `trent usage` sum to the cent.
  - It is within 5% of the provider invoices for the week.
  - `trent audit verify` passes offline on the attachment.
- **Why it is decisive.** It makes the invisible advantages (A1-A3, A8) visible to a non-coder once a
  week. Hermes cannot send it, because its numbers are a lower bound and off by default.
- **Files.**
  - New: `packages/trent-core/src/receipt/`, `packages/trent-core/skills/weekly-receipt/SKILL.md`.
  - Also: `governance/spend-report.ts`, `audit/export.ts`, `audit/verify.ts`, `cron/CronRunner.ts`,
    `improve/status.ts`.
- **Size.** S-M: 3-5 days.

## 6. What to cut or stop

1. **Stop the fleet being the default.** Make `agent.mode: solo` the default for every new profile.
   The fleet becomes `trent run --team` for objectives that span departments, and keeps that place
   only if I1 shows it wins a task class.
   - Evidence: 5 ledger rows for a one-line tagline, and a local fleet that cannot finish "Say ready".
   - Also: Hermes's users came for one agent (its README shape), and the solo design itself says the
     fleet is "the wrong cost on local models" (`solo-harness-design-2026-09-26.md`).
2. **Stop saying "173 agents" or "164 specialists".** All 164 have `toolsCount: 0` and are never
   scheduled (scorecard §4.5). Rewrite the launch-post title, "nine agent seats with budgets in cents"
   (`05_release/output/launch-post-draft-2026-09-25.md`), around the bench and rehearsal numbers.
3. **Stop chasing Hermes's breadth.**
   - No new chat adapters after H4 except SMS (I4).
   - No Tauri desktop packaging until there are 100 real installs.
   - No more work toward matching Hermes's slash-command count, skins, personalities or plugin
     catalog.
   - Hermes ships 460-1,800 PRs per release; matching rows only moves the goalposts.
4. **Stop developer-only parity work:** ACP session load, LSP, worktrees, an OpenAI-compatible API
   server, orchestration scripts, programmatic tool calling, and an OS sandbox beyond fixing the
   silent fallback. None of these reaches the three market users (matrix §2, "below the cut").
5. **Stop adding improvement machinery** (more gates, reranker, GEPA variants, calibration) until one
   real suite has produced one promoted, measured win (I3). The 70+ files in `improve/` are graded
   against 2 skill suites.
6. **Stop treating the wrapped Next.js app as a product surface.** It stays the library the fleet
   runs on. Keep `trent web` local-only, and do not host it until AGENTS.md defect 1 (fails open
   without `DATABASE_URL`) is fixed.
7. **Stop the daily Hermes-parity inventory sweeps and repeated landscape rewrites.** Replace them
   with I1's bench as the running scoreboard and one monthly Hermes delta.
8. **Stop launching new waves onto an unlanded tree.** Today's landing broke `tsc` through a variant
   (`docs/sessions/2026-09-26-resume-landing.md`, 04:50Z). 119 dirty paths are value nobody can use.

## 7. Honest positioning

**Where Trent is already better (for anyone willing to run from a clone):**
- Operators, agencies and bookkeepers building agents that send, charge or book. They need a yes
  bound to exact arguments, cents caps that stop a run, and an audit an outsider can verify offline
  (A1-A3). Hermes has none of the three.
- Hermes users who want a governed "money desk" they call over A2A. Proven live against Hermes
  v0.21.3 (A11). Keep this: "Trent complements Hermes" is credible, while "Trent replaces Hermes" is
  not, today.
- Creators who want local 9:16 cuts with burned captions (A12), once whisper is installed.

**Where Trent is not better:**
- Anyone who wants to install today.
- Anyone who wants a free start or a subscription login.
- Anyone on a local model today: the fleet fails, solo is unmeasured, L1 is unlanded.
- Anyone who needs personal WhatsApp, iMessage, inbound SMS, spoken replies, a desktop app, a
  non-English UI, or Windows (the PowerShell installer has never been executed).
- Anyone who wants 200+ skills, a plugin store, or an unattended learning loop that runs by default.
- Teams (Hermes Business).
- Mom-and-pop in production: **neither product is ready.** Hermes by a reviewer's account; Trent
  because no business or social tool has ever touched a live provider. That open market is the
  opportunity.

**The line to earn in 6 weeks:** "Hermes grows with you. Trent proves itself before it touches your
customers: rehearsed on your history, learning only what it can measure, and asking before every
text, booking or charge, on a model that costs half a cent a turn or nothing at all."

## 8. What I would do first, in order

1. **Today.**
   - Land S2+H3, H5, L1, S3 and P3 through the existing procedure, then freeze new waves until the
     tree is clean.
   - Fix or quarantine the `approvals.restart` flake so CI is trustworthy (handoff log).
2. **Bobby, about 1 hour.**
   - Tag v1.0.0 and point the default branch at the code (`05_release/output/release-checklist-v1.md`).
   - Reverse gate decision 4 (inbound SMS) for I4.
   - Nothing below reaches a user without the tag.
3. **First quiet window (load under 40).** Run the first real solo turn ever, on `qwen3.5:9b` with
   constrained output. Record the doctor tool-call smoke (baseline 1/5), time to first token, and
   cents. This is S4's live proof. If the smoke stays under 4/5, scope the local claim to back-office
   work.
4. **Week 1.** I1 bench with 20 tasks. Publish Trent solo vs Hermes 0.21.5 vs fleet on the 9B and on
   flash-lite, whatever the result.
5. **Week 2.** I2 rehearsal on the same task format. Then run live sandbox proofs for Stripe test
   mode, Square sandbox and Twilio test credentials: the first real-provider calls in the repo.
6. **Weeks 3-4.** I3 (solo into the graded learning loop, `skills learn`, `improve report`) and I4
   (the SMS front door).
7. **Week 5.** I5 weekly receipt. Rewrite README and the launch post around the numbers from I1, I2
   and I3, then post only after the tag.
8. **Watch.** If I1 shows Hermes ahead on the same model and tools, stop the local-wedge messaging.
   Compete on governance (A1-A3, I2, I5) as a complement to Hermes over A2A, not a replacement.
