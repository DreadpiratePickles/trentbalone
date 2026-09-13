# fleet-memory: one company memory, every seat reads it

The requirement, verbatim: "make sure all the agents share memory so their work is better."

Hermes has no fleet memory scope: subagents cannot write memory, every profile is an island, and
nothing one agent learns propagates (`01_discovery/references/hermes-self-improvement.md`,
sections "What Hermes actually does" and recommendation 9). This module is that scope for Trent's
nine live seats plus installed specialists. It sits entirely in the wrapper — `apps/web` is not
touched — and plugs into `createOrchestrator({ fleetMemory })` through a delimited hook in
`../orchestrator/index.ts`.

## What is shared, and how each part is proven

| # | Shared thing | Mechanism | Proof (`fleet-memory.test.ts`, `../tools/memory/memory.test.ts`, `fleet-memory.orchestrator.test.ts`) |
|---|---|---|---|
| 1 | **MEMORY.md / USER.md** | One pair of files per profile, written only through the `memory` tool (2200 / 1375 char caps). The frozen snapshot is injected into EVERY seat's prelude for the run, delegated children included. Children read; their writes are `blocked` (`callerContext().delegated`). `thaw()` at run end makes this run's writes visible to the next. | engineer writes in run 1 -> support's prelude in run 2; not in run 1 (frozen); delegated child blocked, file unchanged; end-to-end through the real pipeline with a `[delegated]` step. |
| 2 | **Cross-agent recall** | `recallForObjective`: completed step outputs of ANY agent, consolidated run briefs, live skills (own + org) and playbook bullets, ranked against the run objective + derived task type by the semantic router's lexical TF-IDF embedder (reproduced in `lexical.ts`; the router does not export it), cut at `recallBudgetChars` (default 3000, `TRENT_FLEET_RECALL_BUDGET_CHARS`), rendered once per run and byte-identical for every seat call (Hermes `memory_tool_store.py:347-350`, prefix-cache stability). | analyst's churn output reaches a growth run about churn; an invoice run recalls nothing; 700-char budget honoured with drops counted; deterministic. |
| 3 | **Fleet-wide session search** | `fleet_search {"query","limit"}`: full text over every agent's completed step outputs and run summaries in the company store, delegated steps included and tagged `[seat, delegated]`. Hermes hides subagent sessions; we tag them. | hit carries `[analyst]` and the run id; delegated hit tagged; consolidated brief searchable; limit honoured. |
| 4 | **Shared skills** | `listSharedSkills`: the `__org__` tier's live drafts plus the seat's own, consumer copies folded by content hash; rendered as an index in every prelude; `fleet_skill_view {"skill"}` returns the body of a skill another agent earned. | org skill promoted by the engineer is listed for finance; finance views it; a quarantined engineer draft is not listed. |
| 5 | **Write discipline** | Only two writers exist: the `memory` tool (`commitOperations`: `mkdir` lock, re-read, apply the batch on the FRESH entries, cap on the merged result, write-then-rename 0600) and the improve loop's human-gated promotion path for skills. No seat ever writes free text into a shared file. | two writers against a stale view: both entries survive; two OS processes x 20 appends: all 40 land, file under cap, no `.tmp`/`.lock` left. |

## What is NOT shared, and why

- **Seat prompts.** Protected (`../improve/protected-prompt.ts`): only GEPA through the executing
  gate proposes, only a human promotes. A shared prompt would let one seat's learned bias rewrite
  another's mission; the Stanford material's warning about reward hacking of proxy judges
  (cs329a-applied section 2, L3 @31:46, L9 @36:52) applies doubly when the artifact is the prompt.
- **Per-agent GEPA frontiers.** Keyed by (company, agent) on purpose: the frontier is the
  specialisation. L9's diversity finding (multi-agent generation keeps improving where a single
  lineage collapses) argues for keeping the lineages separate and sharing only gated, promoted
  outcomes (skills) across them.
- **Secrets.** Never enter memory, recall, search or logs. Credentials live in the egress broker;
  the tools only ever see names.
- **Why memory at all, and its ceiling.** L9: memory stores are the easier branch; weights are
  needed to reason over genuinely new domains. Trent chose the memory branch (cs329a-applied,
  "Trent chose memory; ceiling acknowledged"). Within that ceiling, L8's finding is the lever: a
  model on an unseen context behaves like a contractor 5-18x slower than the maintainer. Context IS
  the fix, and this module is how one seat's context becomes every seat's.

## Wiring

```ts
const fleetMemory = createFleetMemoryHook({
  source: createAppFleetSource({ improve: store.improve() }), // runs + skills + playbook from the company's SQLite
  profileDir,                                                  // <profile>/memories/{MEMORY,USER}.md
});
createOrchestrator({ fleetMemory, tools, ... });
```

The hook contributes the `memory` and `fleet_search` adapters to seat wiring, wraps the seat
executor so the run's prelude rides in `dynamicPrompt` (after the pipeline's own "Previous step
outputs"), and is told `runStarted` / `runFinished` by the wrapper. The REPL builds the hook in
`apps/cli/src/repl/fleet-memory.ts` (`wireFleetMemory`) and passes it to `createOrchestrator`.

## Rules kept

TypeScript strict, ESM, every file under 500 lines, no emoji, no prompt body is ever logged,
budgets in characters, retrieval deterministic and offline (`InMemoryFleetSource` for tests).
