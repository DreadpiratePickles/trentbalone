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
| 1 | **Named memory blocks** (`MEMORY.md` / `USER.md` / `COMPANY.md` by default) | One set of files per profile, listed in config `memory.blocks[] {label, file, description, limit, read_only}` (`../tools/memory/blocks.ts` holds the defaults: `memory` 2200, `user` 1375, `company` 1500 read-only), written only through the `memory` tool (`block` = label, default `memory`). The frozen snapshot renders every block with its label, description, limit and characters in use and is injected into EVERY seat's prelude for the run, delegated children included. Children read; their writes are `blocked` (`callerContext().delegated`). A `read_only` block is `blocked` for every seat, naming the label; the founder edits the file, or the heartbeat does. `thaw()` at run end makes this run's writes visible to the next. | engineer writes in run 1 -> support's prelude in run 2; not in run 1 (frozen); delegated child blocked, file unchanged; seat write to `company` blocked naming the label; a configured `product` block (800) appears in the prelude and refuses the 801st char; end-to-end through the real pipeline with a `[delegated]` step. |
| 2 | **Cross-agent recall** | `recallForObjective`: completed step outputs of ANY agent, consolidated run briefs, live skills (own + org) and playbook bullets, ranked against the run objective + derived task type by the semantic router's lexical TF-IDF embedder (reproduced in `lexical.ts`; the router does not export it), cut at `recallBudgetChars` (default 3000, `TRENT_FLEET_RECALL_BUDGET_CHARS`), rendered once per run and byte-identical for every seat call (Hermes `memory_tool_store.py:347-350`, prefix-cache stability). | analyst's churn output reaches a growth run about churn; an invoice run recalls nothing; 700-char budget honoured with drops counted; deterministic. |
| 3 | **Fleet-wide session search** | `fleet_search {"query","limit"}`: full text over every agent's completed step outputs and run summaries in the company store, delegated steps included and tagged `[seat, delegated]`. Hermes hides subagent sessions; we tag them. | hit carries `[analyst]` and the run id; delegated hit tagged; consolidated brief searchable; limit honoured. |
| 4 | **Shared skills** | `listSharedSkills`: the `__org__` tier's live drafts plus the seat's own, consumer copies folded by content hash; rendered as an index in every prelude; `fleet_skill_view {"skill"}` returns the body of a skill another agent earned. | org skill promoted by the engineer is listed for finance; finance views it; a quarantined engineer draft is not listed. |
| 5 | **Write discipline** | Only two writers exist: the `memory` tool (`commitOperations`: `mkdir` lock, re-read, apply the batch on the FRESH entries, cap on the merged result, write-then-rename 0600) and the improve loop's human-gated promotion path for skills. No seat ever writes free text into a shared file. | two writers against a stale view: both entries survive; two OS processes x 20 appends: all 40 land, file under cap, no `.tmp`/`.lock` left. |

## Sleep-time consolidation (T1.4, `consolidate.ts`)

By night the memory blocks carry duplicates, near-duplicates and facts a later entry superseded.
`consolidateMemory({ profileDir, companyId, gateway, store, blocks?, meter?, now? })` makes ONE
model call (temperature 0, every block and its own cap in the prompt, the body never logged)
asking for a deduplicated, merged rewrite of each block that keeps every fact still true, as
strict JSON `{ memory, user, dropped }` validated with zod — plus one key per extra block when
`blocks` (`config.memory.blocks`) configures any. `memory` and `user` are always in the turn;
every other configured block joins it under its OWN `limit`, and a `read_only` block is never
sent to the model and never rewritten. One draft carries the whole set, so one promotion (or one
rollback) moves every block together. The outcome is one of three, and the files are never
touched here:

| Outcome | When | What is written |
|---|---|---|
| `rejected` (`reason`) | reply is not JSON / not the schema, a block is over its cap, the call failed or the `SweepMeter` budget is spent | nothing |
| `unchanged` | the canonical rewrite equals the current files byte-for-byte | nothing |
| `drafted` | anything else | a `SkillDraftRow` `kind: "memory"`, agent `__fleet__`, task type `memory_consolidation`, status `quarantine`; an iteration (`pending_approval`) and a `stage` ledger row whose `before` is the current bytes |

The draft's `content` is the JSON payload `{ profileDir, memory, user, dropped }`
(`memory-draft.ts`), so the founder sees exactly which entries were removed, and every ledger
row for a memory artifact carries enough to put the files back on its own.

`promoteMemoryDraft({ store, draftId, actor: "human" })` is the only door to disk: it checks both
blocks against the files as they are now, keeps a live `memory` row mirroring the current bytes,
calls the improve loop's `promoteDraft` (human only; the live row is archived and the ledger gets
a `fix` row with the prior bytes), then writes both files through the memory tool's commit path
(`commitOperations`: lock, re-read, replace the entries, cap-check, write-then-rename 0600), the
second reverting the first if it fails. The existing `rollback(iterationId)` restores the previous
bytes: `improve/lifecycle.ts` applies a memory row's `before` payload to disk before it reverts
the rows, so a refused file write leaves the ledger untouched. The one call is metered under the
`candidate` phase when a `SweepMeter` is passed. Scheduling (once a day inside quiet hours) is the
heartbeat's job, not this module's. Proof: `consolidate.test.ts`.

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
  profileDir,                                                  // <profile>/memories/<block file>
  blocks: config.memory.blocks,                                // optional; the three defaults when omitted
});
createOrchestrator({ fleetMemory, tools, ... });
```

The hook contributes the `memory` and `fleet_search` adapters to seat wiring, wraps the seat
executor so the run's injection rides in `dynamicPrompt` (after the pipeline's own "Previous step
outputs"), and is told `runStarted` / `runFinished` by the wrapper. The REPL builds the hook in
`apps/cli/src/repl/fleet-memory.ts` (`wireFleetMemory`) and passes it to `createOrchestrator`.

## Three tiers, and what "frozen" means now

`tiers.ts` assembles the injection as STABLE (memory blocks, the `workspace-context` seam, the
org-tier skills index), then CONTEXT (this seat's own skills, this objective's recall), then
VOLATILE (the transcript, the active personality's tone stance). The STABLE tier is byte-identical
across runs of the same profile, so a provider could cache it; the CONTEXT tier is per (run, seat).
Until 2026-09-18 the whole prelude was memoised with the FIRST seat's scope, which gave every later
seat of a run the first seat's recall and skills. The run's *view of the company* is still frozen
(`freezeFleetSource`), so a seat that calls later cannot recall runs the first seat could not see.

The whole injection is measured against `context.ceiling_chars` (docs/configuration.md, "Context
management"): over it the context and volatile blocks are dropped oldest-first and the stable tier
never is, and at 80 percent one `context_pressure` notice is emitted per run.

## Hybrid recall (C3, `embedder.ts` + `hybrid.ts`)

Ranking used to be lexical and only lexical: `EmbedFn` was a seam nothing ever passed
(fleet-brain audit 3.2). It is now filled by a core embedder on the provider the operator already
pays for — `apps/web/lib/wiki-embeddings.ts` is not an option, being module-private, wiki-scoped
and returning hash vectors without `OPENAI_API_KEY` (design review section 5, option iii; plan
decision 7).

`createEmbedder(config, secrets)` resolves `memory.embedder` to one of three outcomes and reports
which: `gemini` (Google's OpenAI-compatible `/v1beta/openai/embeddings`, which is what the existing
key is proven on), `openai` (`/v1/embeddings`, or an alias's own base URL through
`model-gateway/providers.ts`), or `none`. It batches under `batch_size`, retries under the
gateway's bounded policy (`model-gateway/retry.ts`), carries a deadline on every request, and
caches vectors under `<profile>/cache/embeddings/` (0700) keyed by sha256 of endpoint, model and
text — so a recall over a run window that has not changed re-embeds nothing. No key is ever logged,
thrown, cached or put in a doctor details bag.

`embedderForProfile(configManager)` is the whole wiring surface: it returns an `EmbedFn`, or
`undefined` when nothing is configured, so a profile with no key gets the byte-identical lexical
recall it had before.

**The blend.** `scoreAgainst` without an embedder is unchanged. With one, each candidate scores

```
0.4 * lexicalTfIdf  +  0.6 * credit(cosine)
credit(c) = c <= floor ? 0 : (c - floor) / (1 - floor)
floor = gemini 0.60, openai 0.30, default 0.35
```

The weights sum to 1, so `recallMinScore` (0.12) keeps meaning what it meant. The vector term is
the majority because the case it exists for — an objective about churn and a step output about
retention, against a sentence that merely repeats "monthly subscription tier" — needs the vector
to outweigh a full-strength lexical hit on its own. It is not the only term because TF-IDF is what
gets an exact identifier, an error code or a customer name right, and an embedding flattens those.

The **floor** is the part that has to be measured. Embedding spaces are anisotropic: unrelated text
does not score near zero. `embedder.live.test.ts` measured `gemini-embedding-001` on Bobby's key at
**0.529 for an unrelated sentence and 0.754 for a paraphrase** of the same objective, so a naive
raw-cosine blend would hand every candidate a free 0.3 and turn "this run recalls nothing" into
"this run recalls whatever exists". Hence a per-model floor, carried on the `EmbedFn` itself
(`CalibratedEmbedFn.vectorFloor`) so the hook's seam stays a bare `EmbedFn`, with the band above it
rescaled onto 0..1. It is absolute rather than a min-max over the corpus, because a relative scale
gives the best of an entirely unrelated corpus full marks and every run would then recall
something. OpenAI's 0.30 is not measured on this machine — there is no OpenAI key here — and the
live proof re-measures whichever key is present and asserts the floor still separates the two.

An embedder that throws is caught: recall degrades to the lexical order rather than failing the
run. Proof: `hybrid.test.ts` (both orders over one corpus, one input changed), `embedder.test.ts`
(offline), `embedder.live.test.ts` (`TRENT_TEST_LIVE=1`).

## Rules kept

TypeScript strict, ESM, every file under 500 lines, no emoji, no prompt body is ever logged,
budgets in characters, retrieval deterministic and offline (`InMemoryFleetSource` for tests) unless
an embedder is configured, in which case only the vector term is not.

## Memory writes are deltas, and the layer decides who may write ([C4])

A memory change is an itemised delta over the entries of ONE block, never a new copy of the block.
Asking a model to write a block out again is what collapses a context: ACE measured a context of
18,282 tokens at 66.7 percent accuracy becoming 122 tokens at 57.1 percent in a single step,
because everything the model did not restate ceased to exist. The consolidation turn therefore
shows the model every entry with an id (`[e1] ...`) and accepts only four operations over those
ids (`memory-ops.ts`):

| Operation | Shape | Means |
|---|---|---|
| `append` | `{"op":"append","text":"..."}` | a fact the block does not carry yet |
| `replace` | `{"op":"replace","entry_id":"e2","text":"..."}` | that entry stays, worded differently |
| `remove` | `{"op":"remove","entry_id":"e2"}` | that entry is no longer true |
| `merge` | `{"op":"merge","entry_ids":["e1","e2"],"text":"..."}` | those entries say the same thing; this one stands for them |

The reply is `{"ops": {"<block label>": [operation, ...]}}` and a block that needs no change is
simply left out. Everything is checked before anything is applied, and a proposal is
all-or-nothing: an unknown operation, an id the block does not have, an entry addressed twice, a
block that is not in this turn, or a shrink past the per-turn cap rejects the WHOLE list.
The cap is the collapse guard — `memory.consolidation_max_removal_ratio`, default 0.3, floored at
one entry so a three-entry block can still lose its duplicate — and a proposal over it is refused
and written to the ledger as a `reject` row, so a model that keeps proposing collapses is visible
instead of silently retried every night. Code applies what survives, so an entry the model never
mentions is kept by construction, and `dropped` is derived from the applied operations rather than
taken from the model's word for it. The draft carries the operations AND the text they produced,
which is why promotion and rollback stay byte-exact while the founder can still see why.

Writes are gated by layer (`../tools/memory/store.ts`, `checkMemoryWriteGate`), Letta's rule: an
append is safe from anyone, a rewrite has exactly one owner.

| Layer | Who writes | Rule |
|---|---|---|
| Episodic append | any seat, through the `memory` tool | ungated; the tool advertises `add` and nothing else |
| Semantic rewrite | the consolidation draft only | `replace` / `remove` from a seat are `blocked`, naming the consolidation |
| `read_only` block | nobody | refused on every path, seat and consolidation alike, unless `memory.consolidation_may_edit` names the label — and then only the scheduled consolidation, still promoted by a human |

Two defects the audit named are closed with it. `replaceBlock` used to write a block holding
byte-identical duplicate entries with NO lock at all, so a seat's append could vanish between that
function's read and its rename; every write path now goes through the same `mkdir` lock
(`commitReplaceAll`), proven by holding the lock and watching the write wait and refuse.
`TRENT_FLEET_RECALL_BUDGET_CHARS` (row 2 above) was advertised and dead — its only reader was
called from nowhere — and the env read is deleted rather than wired up: the only place that could
honour it is `orchestrator-hook.ts`, and a budget the prelude must prove offline and identically
on every provider belongs in the config file. `resolveFleetMemoryConfig(overrides)` remains as the
one place overrides merge onto the shipped budgets. Proof: `memory-ops.test.ts`,
`memory-draft.test.ts`, `config.test.ts`, `consolidate.test.ts`, `../tools/memory/memory.test.ts`.
