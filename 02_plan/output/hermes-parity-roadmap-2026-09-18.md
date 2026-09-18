# Trent vs Hermes: where we stand and what we need to do

Version 2, 2026-09-18, revised after the independent review
(`02_plan/output/design-review-hermes-parity-2026-09-18.md`, verdict APPROVE WITH CHANGES; every
required change is folded in below). Branch `feature/trent-fleet-v2`, HEAD `09646aa`.
Inputs: `01_discovery/output/harness-parity-audit-2026-09-18.md`,
`01_discovery/output/fleet-brain-audit-2026-09-18.md`,
`01_discovery/output/hermes-feature-inventory-2026-09.md` (Hermes v0.21.3, 2026-09-14, 334 rows),
`01_discovery/output/agent-harness-sota-2026-09.md` (152 items, 89 sources).
Status: for Bobby's design gate. Phase A0 (defect fixes plus one design choice, A0.1, launched
early and now aligned with the review) is in flight. The next artefact after approval is
`02_plan/output/implementation-plan-hermes-parity.md`: one failing test and a cost budget per task.

## 1. Where we stand

### 1.1 Shipped and real (verified earlier; not re-audited)
Surfaces: 43-command CLI, REPL with real streaming and interrupt, Ink TUI, Tauri desktop, four
compiled binaries run on their native OS in CI, signed installer script, `trent web --start`
serving the real UI. Twelve Hermes-shaped toolsets with Hermes's exact tool names. Eight messaging
platforms with pairing, approvals by reaction, threads as sessions, double-texting policy, push
alerts. TLS credential-brokering egress proxy, Docker sandbox, policy rules over tool sequences,
prompt redaction, MCP install scan and result scrub, signed audit export, idempotency, run cap and
failed-jobs view, cron runner, HEARTBEAT.md loop, memory blocks with a real multi-process lock,
cross-seat recall, human-gated improve loop with an executing gate, evidence-checked judge,
judge-vs-human ledger, byte-exact rollback, agent versions with export and import. 1771 core+CLI
tests, 2792 web tests. CI green except one nondeterministic certificate test (being fixed).

### 1.2 Hollow at the core: the findings that decide everything else
| # | Finding | Evidence |
|---|---|---|
| 1 | There is no conversation. Each REPL line starts a fresh orchestration run; a follow-up has nothing to refer to. | `apps/cli/src/repl/engine.ts:378-406` |
| 2 | `--continue` restores nothing; the REPL never writes a session. | `apps/cli/src/repl/index.ts:101` |
| 3 | No context management: no compaction, token counting, prompt ceiling or prompt caching. A step's prompt grows until the provider errors. | harness audit A.1 |
| 4 | Only five of nine seats can run. This is a deliberate product decision in the wrapped app (`SHRINK`, `orchestrator-runtime.ts:77-80`), not a bug: analyst, finance, escalation are remapped to ceo and sales to growth. The CLI roster also lists `browser`, which has no execution seat, while `sales` executes but is invisible to `trent fleet`. | `apps/web/lib/orchestrator-runtime.ts:81-90,414`; fleet audit 1.1 |
| 5 | No seat can promote an improvement: suites resolve through `getCatalogAgent(seatId)`, which never matches a seat, so every seat is `no_suite`. GEPA never reflects (`skipLLM: true`), goldens are never captured (no `goldenDir`), the sweep is uncapped, the heartbeat has no improve call. Only two `evals.json` suites exist in the repo. | `apps/cli/src/commands/improve.ts:243-244`; `improve/sweep.ts:192,404`; `repl/improve-loop.ts:24-27` |
| 6 | Shared recall is TF-IDF over step outputs plus two Markdown files; the `EmbedFn` seam is never given an embedder; propagation is next-run only; failures have no channel; the prelude is memoised with the first seat's scope so per-seat scoping is defeated. | `fleet-memory/lexical.ts:63`; `orchestrator-hook.ts:127`; fleet audit 3.2, 3.5 |
| 7 | The web app's memory stack is mostly unreachable from the CLI. Tier reads already reach seats (`agent-runtime.ts:168-211`, substring match, six documents); tier writes (`memory-tiers.ts` working, episodic, semantic with supersedes), the wiki, the vault, capability memory, seat registries and the CEO decision journal are not wrapped. `wiki-embeddings.ts` is not "real vectors": its `embedMany` is module-private and returns sha256 hash vectors without an OpenAI key. | fleet audit 3.4; review section 1 |
| 8 | Per-seat model, budget and tools are theatre: one model in all three tier variables, a seat budget rendered into the prompt but never compared to spend, identical tool adapters for all nine seats. | `model-env.ts:69`; `orchestrator-runtime.ts:1428`; fleet audit 1.5 |
| 9 | Invariant 2 is violated on two advertised surfaces: ACP `agent/chat` and A2A `POST /a2a/tasks` answer with canned strings, and `A2A.test.ts:79-81` asserts the canned shape. Both wire layers are also non-standard (ACP over HTTP, A2A payload not the spec's). | harness audit C.6; review section 8 |
| 10 | Daily-use gaps: no budget stop, no `trent run`, no provider retry or 429 handling, ollama/deepseek/groq accepted by the wizard and routed nowhere, personality never reaches a prompt (by a recorded rule in `protected-prompt.ts:2-3`), no user hooks, no autonomy level in the wrapper although the app has an autonomy gate, no `AGENTS.md`/`CLAUDE.md`/`.trent/` loaded from the cwd. | harness audit D |

New defects the review surfaced (to be registered in `AGENTS.md`): `apps/web/lib/model-gateway.ts:283-295`
seat-result cache key omits `dynamicPrompt`, so injected conversation or memory is ignored on a
repeated objective; `writesOnFinish` (`seat-manifest.ts:277`) is rendered but never executed; under
Node every durable layer is `EphemeralStore` (`headless.ts:110-119`), so durability claims hold
under Bun only; two divergent skill stores (`tools/skills/store.ts:1-9`); the lock bypass at
`memory-draft.ts:109-114`; the dead `TRENT_FLEET_RECALL_BUDGET_CHARS` reader.

### 1.3 Hermes parity today
Against the September snapshot we built to: 54 rows, 31 REAL, 13 PARTIAL, 10 ABSENT. Against Hermes
v0.21.3 the gap is wider: in three weeks Hermes shipped Bot Mode and `hermes peer`, a multi-agent
Kanban, a curator with an append-only skill ledger, a counter-triggered background review fork,
goals with shell quality gates and `verify_on_stop`, live delegation steer/stop, a credential vault,
a context-engineering stack (micro-compaction, three-tier prompt, `tool_search`), eight memory
providers, `import-agent`, sixteen more platforms, an API server, `mcp serve`, checkpoints with
`/rollback`, worktree isolation (inventory section 2). Where Trent is ahead: nine role seats with
an orchestrator, critic and consolidator; the executing gate, evidence-checked judge and
judge-vs-human ledger; policy rules over tool sequences; signed audit export; agent versions; the
164-specialist catalog; the web app's tiered memory, vault and wiki once wrapped.

## 2. What "better than Hermes" means

Feature count is the wrong target (rulebook principle 1). Trent is better than Hermes when five
things are true and measured:
1. A harness core that is not hollow: conversation, sessions, context management, budget stop,
   retries, one-shot. Without this nothing above it counts.
2. Nine seats that are genuinely nine roles: all reachable, each with its own tools, floors,
   budget, model tier, memory scope and verifier. The compute-normalised 2026 evidence (research
   section 3) is against splitting one objective across agents by job title: single-threaded
   loops match or beat fixed multi-agent systems, MAST's cheap wins are verification (+15.6 points)
   and role clarity (+9.4), and Anthropic's later guidance rejects division by title. So a seat is
   a capability, permission and accountability boundary that one run steps through in sequence,
   which is the rulebook's own ICM (principle 2: one agent switches roles by loading stage
   context). Parallelism across objectives (cron, gateway, heartbeat, `max_concurrent_runs`) is
   already real and stays; parallelism within one objective is not built until a measured,
   compute-normalised win justifies it. The critic stays a separate agent.
3. A shared brain with one truth rule per layer: the web app's tier writes wrapped, a
   git-versioned brain for identity, decisions and episodic notes, hybrid recall through a core
   embedder, delta writes gated by layer, memory advisory and `AGENTS.md` plus config normative.
4. A self-improvement loop that actually runs and cannot grade or rewrite itself: every seat has a
   suite with a held-out split, goldens are captured, reflection is on and capped, promotion needs
   pass^k on the holdout, regressions auto-roll back, the judge is calibrated as true and false
   positive rates. Human promotion stays the gate.
5. Hermes parity on what a daily user touches (five items, Phase E), plus Hermes's design
   principles: prompt stability, three-tier prompt assembly, bounded memory that refuses to
   silently forget, provenance-gated curation, evidence before judgment, a safety floor below every
   bypass, progressive disclosure.

The fork. Three options: (a) keep building the TypeScript harness and add Hermes interop through
the A2A specification; (b) fork Hermes (Python, MIT) and put Trent's fleet on it as bots and
plugins; (c) run Hermes as a sidecar process that Trent's seats call over A2A for its tools and
platforms. Per unit: (a) costs Phase A (two to three weeks of specified work) and keeps everything
verified so far; (b) discards the orchestrator, seats, improve loop, gateway, egress and 100+
verified commits, contradicts invariant 1 (`AGENTS.md`: wrap `apps/web`), and adds a Python runtime
to every install for a harness core we can build; (c) costs one extra process and a spec-compliant
A2A layer, gives Hermes's platforms and tools without rewriting, and is compatible with (a).
Recommendation: (a) now, (c) as the interop path when Phase E reaches it, never (b). Bobby's call.

## 3. The plan

Each task is one Opus agent with a written brief (section 5), failing test first, its own commit,
acceptance as a command and an exit code. Durable-layer acceptance runs under Bun. One live proof
per phase runs a `*.live.test.ts` with `TRENT_TEST_LIVE=1` on Bobby's key. Waves of at most six
agents with disjoint files. Where a phase has a major design choice, two or three approaches are
listed with a recommendation, as `02_plan/CONTEXT.md` requires.

### Phase A. Harness core truth (weeks 1-2)
A0 (in flight). A0.1 conversation and sessions: turns travel as a message list through
  `OrchestratorRunOptions` so the REPL and the gateway both get continuity; `--continue` restores;
  a real budget stop; no partial assistant turn persisted after Ctrl+C; the seat-result cache key
  defect fixed under the invariant 1 bug exception if it is live on the CLI path; `sessions export`.
  A0.2 ACP and A2A run the real runtime through a runner port; tests target the port; the wire
  layers are marked non-standard and honest refusal replaces canned success. A0.3 abort-aware
  bounded retry with backoff, `Retry-After` and error classes; ollama, lmstudio, deepseek and groq
  as `openai` with a base URL, never new provider identities; pricing rows and `model_overrides`;
  unknown models flagged `unpriced`. A0.4 `trent run` with `--format text|stream-json` on the one
  existing event schema, documented exit codes; README and troubleshooting corrected.
A0.5 Golden capture on: pass `<profileDir>/goldens` as `goldenDir` (one argument,
  `repl/improve-loop.ts:24-27`) so suites can grow from real failures from this week.
A1 Context management. Options: (i) drop oldest tool-history entries past a ceiling; (ii) a
  memory-flush turn then summarise the middle of the transcript, keeping tool call and result pairs
  together, recorded as an auditable compaction event with the forgotten ids and the summary;
  (iii) the provider's context-editing API (`clear_at_least`, `exclude_tools`) where it exists.
  Recommendation: (ii) with (i) as the floor and (iii) opportunistic. Plus: character and token
  estimate of every assembled prompt, a configured ceiling with pressure warnings, three-tier
  assembly ordered stable, context, volatile (objective-dependent recall moves out of the stable
  prefix), `cache_control` on the stable tier for Anthropic, a `/context` inspector.
A2 Harness hygiene: `AGENTS.md`, `CLAUDE.md` and `.trent/*.md` from the cwd loaded into the stable
  tier only after the existing prompt-injection scanner has passed them and the workspace is
  trusted (trust before load); user hooks (pre and post tool call, session start and stop, shell
  hooks with consent); an `autonomy: ask_always | ask_dangerous | never` key that wraps the app's
  existing `orchestrator-autonomy-gate.ts` with the approval floors and a hardline blocklist below
  every bypass; `verify_on_stop`; the personality rule in `protected-prompt.ts` resolved (wire it
  into the volatile tier or delete the module); `apps/cli/src/slash/` merged or deleted (Bobby).
A3 Progressive disclosure: `tool_search`, `tool_describe`, `tool_call` so MCP, plugin and catalog
  tools cost no context until used; `todo` and multi-question `clarify`; `session_search` over FTS5.

### Phase B. Nine seats for real (week 3)
Sequential by default: a run steps through seats one at a time over shared ground truth. No
intra-objective parallelism in this phase.
B0 Prerequisites: fix the per-seat prelude memoisation (`orchestrator-hook.ts:127`: shared stable
  part plus a per-run-per-seat part); unify the two skill stores; implement or delete
  `writesOnFinish`; register the cache-key defect.
B1 Unshelve analyst, finance, escalation and sales. The shrink is a recorded product decision, so
  this needs a scoped exception from Bobby (one file, six hits) rather than the bug clause; the
  alternative is a core-side override at the plan chokepoint. Roster: recommendation is that
  `sales` is the ninth seat and `browser` is a toolset every seat may use.
B2 Seats as different capabilities. Options: (i) a second roster of YAML manifests in core; (ii)
  the app's `seat-manifest.ts` and `SLOT_ENVIRONMENTS` stay the single source and core adds only
  enforcement; (iii) both. Recommendation: (ii), because a second roster is what produced today's
  browser/sales mismatch. Enforcement in core: per-seat tool adapters and approval floors, budget in
  integer cents enforced by aborting the seat loop when spend exceeds it, model tier mapped from
  config tiers rather than one model name, verifier suite per seat.
Deferred: delegation steer/stop and child worktrees (B3), a work board (B4). Cron, the gateway and
  the run cap already give parallelism across objectives; a board waits for a demonstrated need.

### Phase C. The shared brain (weeks 4-5)
Truth rule, one sentence per layer: `brain/` files are the truth for identity, standing decisions
and episodic notes; `Document` rows (with `validFrom`, `validTo`, `supersedesId`, already in the
schema) are the truth for facts with validity windows; memory blocks migrate into `brain/system/`
with a one-time migration and the block writers retired; SQLite FTS5 and the embedder are indexes
and never authoritative. Two stores, not three; no new `facts` table. The brain is advisory;
`AGENTS.md`, the cwd context files and config are normative.
C1 Wrap the tier writes: extend `createAppFleetSource` to `memory-tiers.ts` (working, episodic,
  semantic with supersedes), `active-documents.ts`, `capability-memory.ts`, `seat-memory-registries.ts`,
  `ceo-decision-journal.ts`, `trench-wiki.ts` reads. Writes go through the app's store singleton
  and are therefore Bun-only in standalone mode; acceptance runs under Bun.
C2 Brain repository. Options: (i) a git-versioned `<profile>/brain/` with `system/` always loaded
  and the file tree in the stable tier as signposts (Letta context repositories, OpenClaw); (ii)
  extend memory blocks (the pattern Letta has deprecated); (iii) SQLite as the only truth (Hermes).
  Recommendation: (i) with FTS5 as the index; blocks migrate in.
C3 Hybrid recall: a core embedder behind the existing `EmbedFn` seam using the configured
  provider's embedding endpoint (Gemini on Bobby's key, OpenAI, or none), with lexical recall as the
  fallback and a doctor check that says which is active. `wiki-embeddings.ts` is not used.
C4 Write gates by layer, delta updates only: itemised append or targeted replace, never a
  whole-block rewrite (`consolidate.ts` is today's risky default; ACE measured the collapse).
  Episodic append ungated; semantic facts through consolidation; skills through the executing gate
  and human promotion; read-only blocks only by a human or the scheduled consolidation. Append is
  safe, rewrites have one owner (Letta's rule); git is for audit and rollback, not for merging
  concurrent seats. Close the lock bypass and the dead env reader. A write past a limit returns the
  current entries and usage so the agent consolidates in the same turn.
C5 Propagation and trust: a promoted skill reaches every seat as an index entry fetched on demand;
  failures get their own recall class; memory writes never re-enter the prompt mid-session; output
  derived from untrusted context (MCP, web, delegated children) keeps an untrusted provenance tag
  and cannot be written to shared layers without approval (research section 4's trust-escalation
  and poisoning failure modes).
Deferred: external memory providers (C6).

### Phase D. Self-improvement that runs and cannot grade itself (weeks 5-6)
D0 Gates first, before any reflection is switched on: a frozen do-not-modify surface enforced by
  path (bundled suites, goldens, the judge prompt, gate code) and `read_only` on every block the
  judge's inputs derive from; an optimise/holdout split per suite with promotion decided on the
  holdout only; pass^k with k at least 3 per fixture; a metered holdout re-run after every
  promotion with automatic rollback on regression; a content-hash veto so a rejected draft cannot
  be re-proposed; judge calibration reported as true and false positive rates against the
  judge-vs-human ledger, never raw agreement.
D1 Every seat can promote: resolve suites from `SLOT_ENVIRONMENTS[role]` for seat ids; suites from
  Phase A goldens plus 20-50 tasks per seat authored by Bobby from real failures (a human task,
  scheduled); reflection on (`skipLLM: !live`) under a cap defaulted from `budget.per_run_cap`.
D2 Automatic runs. Options: (i) a counter-triggered forked review agent replaying the session on
  the cache-stable prefix (Hermes); (ii) a metered sweep from the heartbeat behind
  `heartbeat.enabled` with quiet hours; (iii) both. Recommendation: (ii) first (both pieces exist),
  (i) after A1 delivers the stable prefix. Deltas are append entries into quarantine; `/refine`.
D3 Curator, first cut: skill lifecycle active, stale, archived; append-only mutation ledger with
  content-addressed blobs and single-mutation rollback; only `created_by: agent` skills eligible for
  autonomous curation; agent-authored skills scanned as a separate gate. No LLM consolidation into
  umbrella skills (SkillAxe measured raw LLM-authored skills at zero gain).
D4 Goals with deterministic shell quality gates that must exit 0 before the judge runs; a separate
  model family for the judge.
D5 Tools improve too: tool-health signals become gated proposals to rewrite tool descriptions.
Deferred: multi-objective Pareto frontier.

### Phase E. Hermes parity that a daily user touches
E1 Checkpoints and `/rollback` with an agent-write ledger.
E2 `approvals.deny` globs and `trent security audit`.
E3 Hermes interop through the A2A specification (Agent Card, Task lifecycle, `message/send`), which
  also replaces A0.2's non-standard wire layer; stdio ACP for editors.
The other three daily items live in earlier phases: context files with scanning (A2), `/context`
and pressure warnings (A1), `trent run` with `--continue` (A0).
Deferred indefinitely unless Bobby asks: bots, rooms and `trent peer`; API server, `mcp serve`,
`import-agent`; capability-negotiated adapters and sixteen platforms; browser credential vault;
llama.cpp runtime, Mixture of Agents, credential pools, Langfuse; desktop HUD, in-app browser, MCP
centre; worktree isolation until a coding user asks; external memory providers.

### Phase F. Release (needs Bobby)
Repo public, tag on main, signed release, `agent.let-trent.uk` serving the installer.

## 4. Decisions needed from Bobby
1. Design gate: approve Phase A1 onward on option (a), with (c) as the interop path.
2. The ninth seat: `sales` as the seat and `browser` as a toolset (recommended), or `browser` kept
   as a seat with an execution role added in `apps/web`.
3. A scoped invariant 1 exception for the `SHRINK` decision in `apps/web/lib/orchestrator-runtime.ts`
   (one file, six hits, own commit, tests), or the core-side override.
4. Eval authoring: 20-50 tasks per seat from real failures is a human task; accept the slower
   goldens-only path if not.
5. `apps/cli/src/slash/`: delete or merge its live commands into the REPL.
6. Budget defaults for the loop (sweep cap in cents) and which key serves the judge model family;
   whether the embedder may use the Gemini embedding endpoint on the existing key.
7. Release: when the repo goes public.

## 5. How the work runs
Fable plans, decides, reviews and synthesises; it does no bulk reading or implementation. Every
task is one Opus agent with a brief that states: objective in one sentence; the files it owns and
the files it must not touch; inputs to read first; the failing test to write first and the
behaviour it must prove; verification commands with expected exit codes; "do not spawn subagents";
"do not commit or stage"; the report format. At most six agents at once with disjoint files. The
orchestrator isolates each commit (`git stash --keep-index`, typecheck, tests) before committing
with explicit paths, pushes to the branch, watches CI, and writes the session log as it goes. Each
phase ends with a clean-worktree verification of HEAD and one live proof on a real key.
