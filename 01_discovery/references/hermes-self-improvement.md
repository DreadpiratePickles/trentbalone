# Self-improvement: Hermes vs Trent, from source (Layer 3 reference)

## Verdict
Hermes is write-and-hope with a good janitor. Trent is a well-designed gated loop whose four pipes
are disconnected.

## What Hermes actually does
Every learning path ends in one of two file stores: `SKILL.md` files or `MEMORY.md`/`USER.md`.
- A background fork replays the transcript every turn with >=10 tool iterations, instructed:
  **"Be ACTIVE — most sessions produce at least one skill update... A pass that does nothing is a
  missed learning opportunity"** (`agent/background_review.py:368-371`). No outcome metric enters.
- **No quality gate before a learned artifact goes live.** Structural validation, an OPTIONAL regex
  scan (off by default for agent-created skills), an advisory linter. Memory writes have no gate.
- **No prompt or policy optimisation. Not present.** SOUL.md is protected even under yolo.
  Personality never touches the system prompt. No equivalent of GEPA anywhere.
- **No failure learning as a store.** Failed trajectories are written only with an opt-in flag and
  nothing reads them back.
- The `/goal` judge decides done/blocked/continue/wait per turn; nothing from it persists.
- The curator marks skills stale after 14 days UNUSED and archives at 30, with tar.gz backups and a
  hash ledger enabling `hermes curator rollback`. Staleness is time-since-view only; there is no
  concept of a skill DEGRADING.
- Memory is hard-capped at write time (2200/1375 chars) and injected as a FROZEN snapshot at session
  start for prefix-cache stability.
- Subagents cannot write memory; they can write skills. No fleet memory scope, no cross-agent promotion.

## What Trent has, and why it does nothing today — the four disconnected pipes
| pipe | designed | reality |
|---|---|---|
| traces | `TraceRecord` with critique verdict, eval score, human correction, skill applied | **`deriveTraceRecord` has no production caller.** The AgentTrace table is never written. |
| sweep | Foundry -> skill health -> cascade -> eval gate -> GEPA | **`heartbeat.ts:334-337` builds fresh in-memory stores**, so it reads zero rows. |
| eval gate | `promoteCandidate`: delta >= 0 and no new failure cluster | **Scores pre-baked `actual`s; the candidate is never executed.** `gepa.ts:264` scores a prompt without running it, so the score is independent of the proposal. `llm_rubric` returns a flat 0.75. |
| goldens | failure -> quarantined fixture -> human-promoted blocking test | **`captureOrchestrationFailureGolden` has no caller.** |

Also: `SKILL_INJECTION_ENABLED` defaults off (`orchestrator-runtime.ts:53`), so even a promoted skill
reaches no agent, and `skillApplied` can never be non-zero.

## Recommendations, ranked by leverage
1. **Write the traces.** Every completed/failed step -> `deriveTraceRecord` -> durable store. Until this
   lands, everything downstream computes over zero rows.
2. **Fix the sweep's stores.** Real durable stores, a persisted GEPA frontier keyed per agent, the
   seat's real prompt passed in.
3. **Make the eval gate EXECUTE the candidate.** Run the frozen suite with the candidate (skill injected
   or prompt swapped) through the live gateway, then grade. Deterministic gates first; LLM judge only
   when they pass. Store verdicts for audit.
4. **Wire golden capture** on `run_failed` and on critic `escalate`/`replan`.
5. **Enable skill injection** once 1-3 are green.
6. **ADOPT from Hermes: retirement, ledger, rollback.** stale/archived states, a before/after hash
   ledger on every promotion, and `trent improve rollback <iteration>`. Trent can promote a bad fix
   with no way back today.
7. **ADOPT from Hermes: frozen snapshot + write-time budget** for injected context.
8. **ADOPT from Hermes: protected-file rule.** Agents never write their own seat prompt; only GEPA via
   the gate proposes, only a human promotes.
9. **Fleet scoping (neither has it).** Traces keyed by (company, agent, taskType); per-agent GEPA
   frontier; an org skill tier promotable by running the gate against every consuming agent's suite;
   a fleet curator across all agents; a delegation hook so subagent outcomes append to the parent's
   task type. **Nine seats improve continuously; a specialist only while installed and only once its
   traces clear the distill threshold.**
10. **Do NOT adopt** the "Be ACTIVE" bias — it manufactures skills without an outcome signal. Do not
    adopt time-since-view as staleness; keep `skill-health.ts`.

## Where the wiring lives
`apps/web` is read-only. Every pipe can be connected from the WRAPPER: the orchestrator wrapper
already subscribes to the event bus and sees every `step_end` (with toolCalls and critique) and every
`run_failed`. The sweep wrapper is fully dependency-injected. So the loop is built in
`packages/trent-core` off the bus, with real stores, without touching the web app.
