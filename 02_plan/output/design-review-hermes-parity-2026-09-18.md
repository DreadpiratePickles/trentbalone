# Design review: Hermes parity roadmap (2026-09-18)

Reviewed: `02_plan/output/hermes-parity-roadmap-2026-09-18.md` (DRAFT, HEAD `09646aa`).
Reviewer: independent (rulebook principle 8). Read-only; nothing run against a live model.
Inputs read in order: `AGENTS.md`, `CONTEXT.md`, the roadmap, harness audit, fleet audit, Hermes
inventory (sections 1.2, 1.6, 2, 3, 4), SOTA research (sections 1-5), `02_plan/CONTEXT.md`, the
rulebook principles 1, 2, 7, 8, 11. Code spot-checked at every premise cited below.

**Verdict: APPROVE WITH CHANGES.** The direction (build the TypeScript harness, A before B/C/D,
seats as sequential boundaries, wrap the web memory, human-gated loop) is right. Four premises are
mis-stated, one plan item cannot be built as written, the self-improvement phase lacks six of the
gates the research lists, and the artefact does not meet the `02_plan` stage contract. Ranked
changes are in section 10.

## 1. Premises (section 1.2 of the roadmap)

| # | Holds? | What the code says |
|---|---|---|
| 1 | Holds; understated | `engine.ts:385` passes `{objective, signal}`; `repl/index.ts:150` calls `runtime.run(objective)`; the transcript is rendered lines (`engine.ts:140-142`). Understated: the messaging gateway is equally stateless (`gateway/agent-handler.ts:101` runs `message.content` alone) even though it writes sessions (`:98,104`). A0.1 fixes only the REPL. |
| 2 | Holds | `repl/index.ts:101` discards `resumeLastSession()`; `#sessions` is unused after. |
| 3 | Holds; one framing error | My own grep of `compact\|summariz\|contextWindow\|cache_control\|tokenBudget` over non-test CLI and core hits only `ui/banner.ts`, browser session/schemas, heartbeat fleet-state, `FleetManager.ts`, `MessageQueue.ts`: none is prompt compaction. Framing: the fix is nearer than the plan implies. Core already owns the provider request for seats (`orchestrator/index.ts:244-250` injects `createChatCompletion: chat`; `seat-guard.ts:95-96`), so `cache_control` on the system block, token counting and tool-history truncation are core-only changes. |
| 4 | Holds; wrong framing | `orchestrator-runtime.ts:81-90,414`; `AgentInstaller.ts:111-118`. The code comment calls it `SHRINK`, a deliberate product decision, not a defect. Invariant 1's "bug fixed deliberately" exception (`AGENTS.md:14-15`) therefore does not apply to B1. Blast radius is one file, six hits. |
| 5 | Holds; understated | `improve.ts:243-244`, `sweep.ts:192,404`, `improve-loop.ts:24-27` (no `goldenDir`), `hook.ts:33`, heartbeat has no improve call. Understated: only two skills ship `evals.json` (`apps/web/.agents/skills/{ads,prospecting}`), so after the D1 fix at most the seats listing those skills get a suite; the rest still resolve `no_suite`. |
| 6 | Holds | `lexical.ts:63`; `repl/fleet-memory.ts:39` passes no `embed`. |
| 7 | Overstated twice | (a) "real vectors": `wiki-embeddings.ts:106-108` returns sha256 hash vectors when `OPENAI_API_KEY` is unset and on any API error (`:127-130`). For an Anthropic-only profile, C1's "hybrid lexical plus vector" is lexical plus noise. (b) "unreachable": the read side of the tiers already reaches every seat via `buildMemoryPlanBlock` (`agent-runtime.ts:168-211`; fleet audit 3.4). Unreachable is the write side (`writeEpisodicMemory`, `memory-tiers.ts:248`, is called by the cycle runner) and the wiki. Also `embedMany` is module-private (`wiki-embeddings.ts:105`; exports at `:133,170,186,219`), so "pass the app's embedder" cannot be done by wrapping. |
| 8 | Holds | `model-env.ts:69`, `orchestrator-runtime.ts:1428`, `seat-wiring.ts:45-61`. The web path does tier by seat (`apps/web/lib/model-gateway.ts:105-107`); the CLI collapses it. The fix is a tier map in `model-env.ts`, not a per-seat model system. |
| 9 | Holds | `A2AServer.ts:87-92`; `ACPServer.ts:123`; `A2A.test.ts:79-81`. |
| 10 | Holds; understated | `budget.ts` has no `exceeded()`; no `run` command. `protected-prompt.ts:2-3` records "personality never touches the system prompt" as an adopted rule, so A2 must reconcile, not just wire. The app has an autonomy control plane (`orchestrator-autonomy-gate.ts`, `CompanyAutonomySettings`) the wrapper never passes; A2 should map onto it rather than add a parallel `autonomy:` key. |

No finding is false in substance. Findings 4 and 7 are mis-framed in ways that change the plan (B1 and C1).

## 2. The fork

Steelman. Hermes already has what Phases A1, A3, E1, E3, E5 and E6 describe: compaction with numeric
thresholds and failure cooldowns (research A12-A13; inventory 1.2 rows 79-90), three-tier prompt
assembly and always-on prefix caching (rows 83-84), FTS5 sessions with export, fork and handoff
(rows 72-78), tool search (row 86), curator, ledger and background review (1.6 rows 254-262),
goals with shell gates (rows 269-271), checkpoints, worktrees, 24 platforms. MIT. A funded team
ships weekly. Trent's harness has no context management and no conversation; the plan's "two to
three weeks" for Phase A has no evidence behind it, and A1 alone re-derives five Hermes doc pages
of tuned behaviour (protected head and tail, pairs never split, hygiene timeouts). Trent's fleet
could be re-expressed as Hermes bots (v0.21.0), plugins and a `MemoryProvider` plugin. Per unit,
a fork saves roughly all of A1, A3, E1, E3, E5, E6.

Against, per unit. (1) Thrown away: every Trent-specific verified component in roadmap 1.1
(orchestrator wrapper, seat wiring, fleet memory, improve loop with executing gate, judge, ledger,
byte-exact rollback, 12 toolsets, 8 adapters, egress proxy, sandbox, 1771 tests) must be rewritten
in Python or bridged. (2) `apps/web` is TypeScript imported in-process (`orchestrator/libs.ts`);
from Python the 164 specialists, seat manifests, memory tiers and wiki become HTTP endpoints the
read-only app does not expose, so invariant 1 breaks repeatedly. (3) A fork of a weekly-cadence
repo diverges on day one: rebase five releases a month forever, or freeze and let the "mature
core" age. The plan's own treadmill argument applies more to a fork than to parity. (4) Hermes's
stated non-goals collide with a fleet: multiplexing isolates profiles not users, kanban is
single-host, no RBAC (inventory section 3). (5) Two runtimes per install; Hermes refuses
PyPI/brew (inventory section 3). Note: the roadmap cites "single Bun-compiled binary, one runtime"
as standing invariants. Neither is in `AGENTS.md:13-27`, and `design-doc.md:90` says the desktop
claim is explicitly "not single binary". Do not argue from invariants that do not exist.

Omitted third option: Hermes as a sidecar, unmodified, via `hermes mcp serve`, A2A or its Sessions
API, with Trent delegating long conversational sessions and keeping the fleet in TypeScript. No
rewrite, no rebase treadmill; costs a second runtime and a split session store. A Phase E
experiment, not a foundation.

Verdict: build (agree), on (1)-(3). Replace the time estimate with per-task budgets after A1 is
decomposed. Rework risk: A1 must be built on the seams that already own the request
(`orchestrator/index.ts:244-250`, `guardSeatModel` at `seat-guard.ts:87-103`, the model gateway).
If it is built by editing `apps/web` prompt assembly (`agent-runtime.ts:60-152`,
`model-gateway.ts:301-330`), invariant 1 breaks and the fork question reopens.

## 3. Ordering, critical path, gold-plating

A before B before C before D is right in the large. Critical path to the five criteria:

- Criterion 1: A0.1, A0.3, A0.4, A1 (ceiling, estimate, compaction). A2 hooks and A3 are not on it.
- Criterion 2: B1, B2 (manifests as data, budget abort, tier map in `model-env.ts`), plus suites
  from D1. B3 and B4 are not.
- Criterion 3: C1 write side plus `Document` read, C3 delta writes. C2 needs the truth rule
  (section 5) first. C4 and C6 are not.
- Criterion 4: D1 (suite resolution, `goldenDir`, `skipLLM: !live`, cap), then D4. D2, D3, D5 not.
- Criterion 5: A1 three-tier plus caching, A2 context files, A3 tool search, E1 checkpoints.

Premature, gold-plating, or against "simplicity first" (research 2.1; rulebook principles 1, 11):

- B4 work board: a new `work_items` table duplicates `Task`, `Goal`, `Cycle`, which already exist in
  the core SQLite (66 models byte-identical to the app's, fleet audit 2.3). Two truths for one
  concept. The DAG scheduler exists (`orchestrator-run-queue.ts:21-32`). Defer.
- B3 child worktrees, list/steer/stop, per-delegation cost: parity items behind no criterion.
- B's "parallel when the planner marks steps read-only": the plan schema is the app's Zod plan
  (read-only) and has no such flag, so the clause is unimplementable without an app change. Drop it;
  keep the serial drain loop (`orchestrator/index.ts:148-164`) until a compute-normalised measurement
  says otherwise.
- C4 facts table: `Document` already has `memoryTier`, `validFrom`, `validTo`, `supersedesId`
  (`schema.prisma:402-420`; `memory-tiers.ts:192-240`). Add contradiction-invalidation there. No table.
- C6 mem0 and Letta adapters: vendor-run numbers only; Letta deprecated its own block pattern
  (research section 3). Drop.
- D1 multi-objective Pareto: nothing has ever passed the gate. Make one seat promote first.
- D5 tool-description proposals: real evidence (research D4) but after D1 and D4.
- A3: keep `todo` (recitation, A16; cheap). `ask_human` already exists (audit B.1); `session_search`
  waits for A0.1.
- Phase E almost entirely (section 7).

Two ordering defects. (a) E5 "context-file prompt-injection scanning" ships three phases after A2
loads `AGENTS.md` and `.trent/*.md` into the prompt. Research F22 and Hermes (inventory row 267:
startup files scanned, a hit blocks a project file) say scanning and trust-before-load ship with
loading. Move into A2. (b) D1 suites "drawn from real failures" (research G15) cannot be authored
in weeks 5-6 if golden capture first turns on in the same phase. Capture is one argument
(`improve-loop.ts:24-27`); turn it on in A so goldens exist by D.

## 4. The multi-agent question

The plan reads research section 3 correctly for the case the sources measure: one task split among
agents by title. All five compute-normalised results concern producing one artifact. Trent's seats
are business functions with different data, tools and approval floors, so two statements to the owner:

1. Within one objective, the evidence rejects fan-out by role. Step seats sequentially over shared
   ground truth, keep the critic separate (research C7-C8; `orchestrator-runtime.ts:969-1005`
   already does), fan out only for read-heavy breadth that returns a finding (C1, C4). The plan
   says this and is right. It should also cite rulebook principle 2 (ICM: one agent changes roles
   by loading stage context), which is the same design.
2. Across independent objectives (a support thread on Telegram while finance runs a cron job),
   parallelism is not what the evidence warns about. It is already supported by run slots
   (`orchestrator/run-slots.ts`, `max_concurrent_runs`) and shares nothing but the brain. The plan
   does not distinguish this case; it should, because it is how nine roles are genuinely nine in
   daily use.

Two corrections. Tran and Kiela's theory says multi-agent becomes competitive when a single agent's
context is degraded; Trent is in that regime today because of finding 3, and the fix is A1, after
which the fan-out case weakens further. And today's code cannot fan out anyway
(`orchestrator/index.ts:148-164` serialises), so "the parallelism is earned" is not a design
choice yet, it is the status quo.

Tell the owner: "nine roles" is met by nine distinct capability, permission, budget and verifier
boundaries; "nine agents on one task at once" is what the evidence rejects.

## 5. The shared brain

Not the smallest design, and the truth rule is missing.

- A third memory system. Today: `memories/*.md` blocks (`tools/memory/blocks.ts`) and `Document`
  rows in SQLite (`memory-tiers.ts`, `active-documents.ts`). C2 adds `<profile>/brain/`. Research
  section 3 ("where is the source of truth") calls this unresolved and says it "matters most where a
  store and a file can disagree". The plan never says which wins. Required: one sentence per layer
  (recommend `brain/` files for identity, decisions and episodic notes; `Document` rows for facts
  with validity windows; blocks migrated into `brain/system/`), plus the migration.
- Wrapping the embedder is impossible as written (premise 7). Options: (i) `semanticSearch`
  (`wiki-embeddings.ts:186`) over wiki notes only; (ii) an invariant-1 exception to export
  `embedMany`; (iii) a core embedder behind the existing `EmbedFn` seam using the configured
  provider. Only (iii) works for Anthropic-only users; (i) and (ii) return hash vectors without
  `OPENAI_API_KEY`. Pick one and say so.
- Invariant 1 on the read side: respected. `createAppFleetSource` already lazy-imports two app
  modules (`app-source.ts:43,63`); adding `memory-tiers` and `active-documents` is the same pattern.
  On the write side it bends: `SemanticMemory.flush` and `writeEpisodicMemory` write through the
  app's `store` singleton (`memory-tiers.ts:224,256`), which is Prisma when `DATABASE_URL` is set
  (`apps/web/lib/store.ts:11`) and the CLI points it at `<profile>/trent.db` (`headless.ts:210`).
  Under Node the CLI store is ephemeral (`headless.ts:110-119`; fleet audit 2.1). State that C1 is
  Bun-only and its acceptance test runs under Bun.
- Per-seat scope is defeated by the hook. `run.prelude ??= buildPrelude(run, input.subtask.seat)`
  (`orchestrator-hook.ts:127`) memoises the first seat's `listSharedSkills(..., seat)` and
  seat-scoped recall for every later seat; `fleet-memory.test.ts:226` asserts that as intended. B2
  "memory scope per seat" and C5 "reaches every seat as an index entry" build on a hook that ignores
  the seat after the first call. Decide: shared stable part plus per-(run, seat) part, or drop scope.
- C3 is right (`consolidate.ts:6` confirms today's default is a whole-block rewrite). But "conflicts
  are git merges" is theatre for one sequential seat loop; the real concurrent writers are two runs
  (`max_concurrent_runs` 2) and delegate children. Letta's rule (research B6: append is safe, one
  owner for rewrites) suffices; keep git for audit and rollback. Close the lock bypass at
  `memory-draft.ts:109-114` (fleet audit 3.3) and the dead `TRENT_FLEET_RECALL_BUDGET_CHARS` reader
  (`fleet-memory/config.ts:34-38`).
- Missing gates from research section 4's five failure modes: trust escalation of sub-agent output
  (nothing); memory as a control surface (nothing: state that `brain/` is advisory and `AGENTS.md`
  plus config are normative, per Codex B13). Poisoning (C5 untrusted-context rule) is covered.
- Unmentioned: `writesOnFinish` (`seat-manifest.ts:277`, rendered at `agent-runtime.ts:209`, never
  executed; fleet audit 2.5). Implement or delete.

## 6. Self-improvement

Not safe as written. Mechanism mostly right; gates incomplete. Against research section 5:

Present: execute before promote, human promotion, byte-exact rollback with lineage, judge separate
from generator with a separate family (D4), agent-skill scan (D3), deterministic before judge, cost
cap (D1).

Missing:
1. Frozen surface. Nothing names the paths the loop may never write: suites (`BUNDLED_SKILLS_DIR`),
   goldens, the judge prompt (`judge.ts:19-25`), gate code. D2's fork proposes memory deltas, and
   `MEMORY.md` is in every prompt the judge's inputs derive from. Required: a do-not-modify list
   enforced by path (autoresearch, DGM), and `read_only` on every block the judge sees.
2. Held-out fixtures. With `skipLLM: !live`, reflection optimises against the fixtures that grade
   it. Required: optimise/holdout split per suite; promotion needs the holdout.
3. Post-promotion regression trigger. Rollback exists (`lifecycle.ts:276-313`); nothing calls it
   automatically. Required: metered holdout re-run after every promotion, auto-rollback on regression.
4. Anti-pattern veto (research D6). Rejections are ledgered (`lifecycle.ts:135-136`); nothing stops
   re-proposing the same content hash. Required before D2.
5. Judge calibration as TPR and TNR (research G9). `status.ts:59-68` reports raw agreement; D4
   "judge weighted by the ledger" would reward a judge that always says yes.
6. pass^k (research G12). One trial per fixture promotes coin flips. Require k >= 3.
7. Suites do not exist (two `evals.json` files). Either goldens accumulate from Phase A or Bobby
   authors 20-50 tasks per seat from real failures (G15). A human task; schedule it.
8. D2 "replays on the same prompt prefix" needs the cache-stable prefix A1 has not built. After A1.

SkillAxe means D3's curator should only age and archive in its first cut; "LLM consolidation into
umbrella skills" is the raw LLM-authored skill that measured at zero gain. Defer consolidation.

## 7. Phase E

Five that matter daily: (1) checkpoints and `/rollback` with the agent-write ledger (E1 first half);
(2) `AGENTS.md` and `.trent/` context files with injection scanning (A2, plus E5's scan moved in);
(3) `/context` and pressure warnings (A1); (4) `trent run` with `stream-json` and `--continue`
(A0.4 plus A0.1); (5) `approvals.deny` globs and `trent security audit` (E5 second half).

Drop or defer indefinitely: E2 bots, rooms, `trent peer` (needs a spec A2A transport first, and
Hermes says multiplexing is not a user boundary); E3 API server, `mcp serve`, `import-agent`; E4
capability negotiation and sixteen platforms; E5 browser credential vault (the agent handling
passwords; the egress broker already covers API credentials); E6 llama.cpp, MoA, credential pools,
Langfuse (A0.3's base-URL path covers local models); E7 desktop HUD, in-app browser, MCP centre.
E1's worktree isolation: when a coding user asks.

## 8. A0 in flight

- A0.1 is a design choice, not a defect (`02_plan/CONTEXT.md`: no code until approved). Rework
  risks: (a) "after the frozen prelude, volatile tier": the prelude already holds objective-dependent
  recall (`orchestrator-hook.ts:97-103`), so it is not a stable prefix and A1 will reorder. Fine only
  if turns are carried as a message list (the session schema already is one, `sessions/schema.ts:18-58`),
  not flattened text, because compaction must keep tool call/result pairs together (research A12).
  (b) Continuity belongs in `runtime.run` (`OrchestratorRunOptions`, `types.ts:222-231`), not the
  REPL, so the gateway gets it too. (c) Do not persist a partial assistant turn after Ctrl+C (A18).
- A0.2 keeps two non-standard transports: ACP over HTTP on 7890 while editors and Hermes speak stdio
  ACP (audit B.3; inventory row 360), and an A2A payload (`taskId/originAgent/targetAgent`) that is
  not the spec's Agent Card, Task lifecycle and `message/send` (research C14; Hermes speaks the spec,
  inventory row 143). Not wasted if the runner port is the tested contract and the wire shape is not.
  Mark the A2A wire layer for replacement before any Hermes interop; honest refusal is acceptable now.
- A0.3 is a defect fix. Retry must be abort-aware (in-flight fetch is not cancelled; model-gateway
  contract trap 5). Ollama, groq and deepseek via `OPENAI_BASE_URL` (`ai-client.ts:116`) is
  env-level, but the app's `ModelProvider` stays five values, so doctor and pricing must treat them
  as `openai` with a base URL, not as providers.
- A0.4 is a defect fix. Require the same `OrcEvent` serialisation the gateway, A2A and sessions
  use (one event schema), and `--continue` from day one.
- The budget stop is computed from costs wrong by up to 10x for non-Anthropic models (audit A.6);
  A0.3's pricing rows must land before the stop is trusted.

## 9. Omissions the evidence requires

1. Durability cliff: under Node every durable layer is `EphemeralStore` (`headless.ts:110-119`;
   fleet audit 2.1). Sessions, brain and ledger sit on it. Acceptance must run under Bun.
2. Two divergent skill stores (`tools/skills/store.ts:1-9`; audit B.2). C5 and D3 build on skills.
3. Per-seat prelude memoisation (`orchestrator-hook.ts:127`), section 5.
4. `cacheKeyForSeatModel` (`apps/web/lib/model-gateway.ts:283-295`) hashes objective, input and
   contextBundle but not `dynamicPrompt`. Once `analyst` is unshelved (B1), conversation and memory
   appended to `dynamicPrompt` are invisible to the cache and a repeated objective returns a stale
   answer. Pre-existing `apps/web` defect; report it under `AGENTS.md:53`.
5. `writesOnFinish` never executed (`agent-runtime.ts:209`; fleet audit 2.5).
6. All 16 `*.live.test.ts` files are gated behind `TRENT_TEST_LIVE=1` (fleet audit 4.10 note).
   None of the plan's real-model claims runs in the standard gate; name one live proof per phase.
7. Compaction as an auditable event (research 2.5, A14): A1 must record forgotten ids and the summary.
8. Personality is outside the prompt by recorded rule (`protected-prompt.ts:2-3`); A2 must resolve.
9. The autonomy gate already exists in the app (`orchestrator-autonomy-gate.ts`); A2 should wrap it.
10. Stage contract: `02_plan/CONTEXT.md` requires 2-3 approaches per major decision, `design-doc.md`
    plus an `implementation-plan.md` with a failing test per task, and spikes for untested
    assumptions before approval. The roadmap gives one approach for A1, B2, C2 and D2 and no task
    list. Approving it does not yield what `03_implementation` consumes.

## 10. Verdict and required changes

**APPROVE WITH CHANGES.** Ranked.

CRITICAL
1. C1: choose the embedder strategy (recommend a core embedder behind `EmbedFn`, provider-agnostic);
   stop describing `wiki-embeddings` as real vectors; state that C1 writes are Bun-only.
2. C2/C4: write the memory truth rule per layer and the block migration; two stores, not three; no
   `facts` table.
3. D: add the frozen surface, holdout split, pass^k, post-promotion auto-rollback, content-hash veto
   and TPR/TNR reporting before `skipLLM: !live`; defer curator consolidation; schedule suite authoring.
4. A2: move context-file injection scanning and trust-before-load in from E5; start golden capture in A.

MAJOR
5. B1: invariant 1's bug exception does not cover `SHRINK`; ask Bobby for a scoped exception (one
   file, six hits) and add omission 4 to the defect register.
6. Delete or defer B3, B4, C6, D1 multi-objective frontier, E2-E4, E6, E7; drop the "parallel when
   read-only" clause.
7. A0.1 carries turns as messages through `OrchestratorRunOptions` so the gateway gets continuity;
   A0.2 tests the runner port and marks the A2A wire layer non-spec; A0.4 uses one event schema.
8. Resolve the per-seat prelude memoisation and the two skill stores before B2 and C5.
9. Produce the stage-contract artefacts: options for A1, B2, C2, D2; a task list with failing tests;
   per-task budgets in place of "two to three weeks".

MINOR
10. Fork paragraph: remove the invented invariants, add the sidecar option, cite rulebook principle 2,
    and separate "parallel across objectives" from "parallel within one".
