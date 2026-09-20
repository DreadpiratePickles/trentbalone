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

## The brain repository, and the truth rule ([C2], `brain.ts`)

The memory blocks were one set of files with one cap each and no history. The brain is the layer
underneath them: `<profile>/brain/`, a git repository when git is installed, and the blocks now
live inside it. Three independent systems landed on the same shape and the research section 4
records why — Manus calls the filesystem "the ultimate context", Letta rebuilt its memory as a git
context repository after deprecating its own block model (B7), and OpenClaw makes Markdown
authoritative with the database demoted to an index (B8). The taxonomy split across files rather
than one blob is B9.

**The truth rule, one sentence per layer.** `brain/` files are the truth for identity, standing
decisions and episodic notes. `Document` rows (`validFrom`, `validTo`, `supersedesId`) are the
truth for facts with validity windows. SQLite FTS5, the embedding cache and
`<profile>/cache/brain-index/` are indexes and never authoritative: delete any of them and one
rebuild is the whole cost. Two stores, not three — the blocks migrate in rather than becoming a
third. And the brain is **advisory**: `AGENTS.md`, the workspace context files and `config.yaml`
are normative, which is the gate against the failure mode where an agent-writable, always-loaded
store becomes a control surface.

| Path | Holds | Reaches a prompt as |
|---|---|---|
| `system/identity.md`, `decisions.md`, `facts.md`, plus the migrated blocks | what every seat must have | the STABLE `brain` block, in full, under the per-block limits |
| `memory/YYYY-MM-DD.md` | episodic notes, append-only per UTC day | a path in the tree; the body only through `brain_read` or brain recall |
| `decisions/<date>-<slug>.md` | one standing decision each, ADR-like, dated | the same |
| `seats/<seat>/notes.md` | that seat's private notes | the same, and only for that seat |
| `docs/<slug>.md` | documents the founder imported (`trent brain import`), Markdown with `sha256`, pages or sheets and `provenance: founder-import` front matter | chunk recall lines with a citation (`[lease#7 #p3 \| Office lease]`) and `brain_read {"id": ...}`; never the stable tier |
| `skills-index.md` | generated from the promoted skills | a path in the tree |

**Writes.** One module, `brain.ts`. Write-then-rename at 0600 under the SAME `mkdir` lock the
blocks use (`withMemoryFileLock`), so a brain write and a seat's `memory` append serialise instead
of racing. Notes and seat notes are appends. The only whole-file rewrite is `applyOps`, which takes
the four delta operations from `memory-ops.ts` and validates the list before applying any of it —
the C4 rule, now covering the brain. Every write commits with a message naming the writer (a seat
id, or `human`) and the run id. git is invoked with an ARGUMENT ARRAY, never a shell string, and
identity and signing are supplied per invocation so a machine with no global git identity still
commits. Without git the brain is plain files that still work, and `trent doctor` says versioning
is off rather than failing.

**Migration.** `brain-migrate.ts` moves every configured block byte-identically into
`brain/system/<file>.md` and leaves a pointer at the old path so an old reader is told where the
content went. `memoryPath()` follows a migrated block to the brain, so the `memory` tool, the
consolidation draft, promotion and rollback all keep working unchanged. It is idempotent on one
fact on disk, and it refuses a block whose file would shadow `identity.md`, `decisions.md` or
`facts.md`.

**Prompt.** `brain-prompt.ts` renders the stable block: `system/` content (minus the files the
company-memory block already carries, so nothing is paid for twice) and the file tree as paths
only, bounded. The bodies of `memory/`, `decisions/` and `seats/` are never in the prefix; a seat
fetches one with `brain_read {"path": "..."}` (`tools/memory/brain-read.ts`), which is read-only
and refuses any path that leaves the brain after resolution AND after the real path is taken, so a
symlink planted in the brain cannot serve `config.yaml`.

**Recall.** `brain-index.ts` ranks CHUNKS of `memory/`, `decisions/`, this seat's own notes and
`docs/` against the objective through the SAME seam as cross-agent recall — `scoreAgainst` with
the optional embedder, so it is lexical alone without a key and the calibrated hybrid blend with
one. Chunks come from `ingest/chunk.ts`: heading- and page-aware, 1,200 characters with a
150-character overlap, each with a stable id (`lease#7`, `decisions/<file>.md#1`) that the recall
line carries as a citation and `brain_read` takes back to return the chunk with its neighbours.
The on-disk index under `<profile>/cache/brain-index/` is keyed on the brain's version: the git
head when versioning is on (every write commits, so the head moves whenever the content does), a
digest of the indexed files' sizes and modification times when it is off, plus the index format.
Nothing here touches `store/**`.

**Import.** `ingest/` is `trent brain import`: `extract.ts` turns md, txt, csv, docx, xlsx
(`office.ts`, on `zip.ts` and `xml.ts`, no office dependency) and pdf (`extract-pdf.ts`,
`pdftotext` then `pdfjs-dist`) into Markdown units; `doc-file.ts` is the on-disk shape with
provenance front matter and page/sheet markers; `index.ts` writes `docs/<slug>.md` through the
brain's one write path, treats an unchanged `sha256` as a no-op and a changed one as a replacement,
and applies the app's own path blocklist so `.env` and keys are never imported. Full documentation:
`docs/brain.md`, "Importing documents".

Proof: `brain.test.ts`, `brain-migrate.test.ts`, `brain-prompt.test.ts`, `brain-index.test.ts`,
`ingest/{chunk,extract,ingest}.test.ts`, `../tools/memory/brain-read.test.ts`,
`../doctor/checks/brain.test.ts`, `../doctor/checks/brain-import.test.ts`,
`apps/cli/src/commands/__tests__/brain.test.ts`. Full documentation: `docs/brain.md`.

## Company memory in the app (C1)

The fleet's shared context used to be everything the ORCHESTRATOR produced: step outputs, run
summaries, promoted skills, playbook bullets. The company's own memory — `Document` rows the web
app has been writing for far longer — reached no seat at all. `app-tiers.ts` and `app-writes.ts`
close that, and `app-source.ts` hangs them off the port as `listAppMemory(companyId, seat)`.

**Truth rule.** `Document` rows with validity windows are the truth for FACTS; `brain/` is the
truth for identity, standing decisions and episodic notes. So facts are read from the rows, and
nothing in these two modules writes a brain file.

**Reads.** Six surfaces, each tagged with its source so the ranker and the prelude can both say
where a line was learned (`[tiers | semantic | ...]`, `[decisions | ...]`):

| Source | Read through | Scope |
|---|---|---|
| `tiers` | `memory-tiers.ts` rows (`memoryTier`) | company |
| `documents` | `active-documents.ts` `filterActiveDocuments` | company |
| `capabilities` | `capability-memory.ts` `summarizeCapability` | this seat only |
| `registries` | `seat-memory-registries.ts` `buildSeatRegistryRecall` | this seat only |
| `decisions` | the CEO decision journal's rows | company |
| `wiki` | `trench-wiki.ts` `buildWikiSources` / `buildWikiPageSummary` | company |

Every rule belongs to an `apps/web` function and is CALLED, never restated — including the wiki
path blocklist that keeps `.env` and keys out of a prompt. Exactly one rule is decided here: a
document another document supersedes is dropped even when its `validTo` is unset, because
`SemanticMemory.flush` expires the old row through `.catch(() => {})` and a silent failure would
otherwise leave a replaced fact "active". Recalling a fact that has been replaced is the one
failure this tier exists to prevent.

**Budgets.** Config `memory.app_sources`, characters of candidate text per source, spent
newest-first and clipped at the budget BEFORE the ranker sees anything. The sum (14,000) is under a
quarter of `context.ceiling_chars`. `0` turns one surface off and leaves the rest alone.

**Its own corpus.** These candidates are scored in a corpus of their own, never folded into the
run-derived one. TF-IDF weights a term by how rare it is in the corpus it is scored against, and
the app writes its own memory log and decision journal for the same run; one shared corpus dropped
the engineer's step output from above the cut-off to 0.0899 in `fleet-memory.orchestrator.test.ts`
the moment those rows joined it. A new source of context may add lines to the block; it may never
take one away.

**Writes.** Two, and deliberately only two. A seat's `memory` append is mirrored into the app's
episodic tier through the app's `writeEpisodicMemory`, filed under the cycle id `<run id>:<seat>` —
the only place a `Document` can carry the seat and the run, since the schema has no tag column and
`apps/web` is read-only. Semantic facts are written ONLY by the consolidation path, from the C4
delta operations, through `SemanticMemory.flush` with `supersedesId` set when an operation replaces
an entry; a `remove` expires the row and writes nothing, a `merge` writes one fact that supersedes
the first row and expires the others. The mirror is a DECORATOR over the adapter
(`withAppEpisodicMirror`), so `tools/memory/index.ts` keeps owning the blocks, the gate and the lock
and never learns about a store. Only a write the adapter itself COMPLETED is mirrored, so a refusal,
a read-only block and a delegated child's write all mirror nothing.

**Where the writes can go, decided before anything is imported.** The app's store singleton is
chosen once, at module evaluation, from `DATABASE_URL` (`apps/web/lib/store.ts:11`), and
`app-store.ts` is the one predicate that says whether it is used at all: only a postgres URL — the
app's own datasource — is. Unset or empty (in-process, rows die with the process), a `file:` SQLite
path (the wrapper's OWN store, which `apps/web/lib/db.ts`'s postgresql client cannot open) and any
other scheme mean the readers answer nothing, `loadAppMemoryModules` / `loadAppWriteModules`
refuse with `AppStoreUnusedError` before any `import("@/lib/*")`, the writers report nothing to do
and no failure, and `doctor/checks/app-memory.ts` prints the reason once. The standalone runtime
never hands its SQLite URL to the app (`apps/cli/src/runtime/headless.ts`), and `guardAppDatabase`
fills the app's `globalThis.__prisma` seam so the Postgres client — whose engine the compiled binary
does not ship — is never constructed in a process without Postgres.

Proof: `app-store.test.ts`, `app-tiers.test.ts`, `app-source.test.ts`, `app-writes.test.ts` (the
last one also drives the app's real `memory-tiers.ts` against the in-process store, with the
predicate answered by a stand-in), `app-memory.bun.test.ts` with `app-memory-runner.ts` for the
cross-run propagation under Bun and the `file:` skip, `../doctor/checks/app-memory.test.ts`,
`../doctor/app-store-isolation.test.ts` and `apps/cli/src/runtime/headless.app-store.test.ts`.
Full documentation: docs/configuration.md, "Company memory in the app".

## Provenance, and the failure channel ([C5])

Two of the failure modes the research names apply directly to a shared brain: **trust escalation**,
where a sub-agent's output is treated as higher-trust than the untrusted data it derived from, and
**memory poisoning**, where injection written into a store survives the session and reaches every
seat afterwards (`01_discovery/output/agent-harness-sota-2026-09.md` section 4). Fleet memory is
where both land, because everything here is shared and everything here outlives the run.

**The tag.** Every tool result carries `provenance: trusted | untrusted`, set once in the wrapper
chain (`../governance/provenance.ts`, wired in `../tools/index.ts`). Untrusted is the `web`,
`browser`, `mcp` and `plugins` toolsets plus any delegated child whose own calls were untrusted —
`delegate_task` reads the child's tags rather than guessing, and appends one line naming the tools,
so the parent cannot mistake a summary for a verified fact. The tags accumulate per step, keyed by
the run and step the orchestrator's `ToolCallContext` supplies; outside a seat turn they fall into
one key per build, which is B14's own granularity (a session that touched untrusted context is
untrusted until something clears it). The hook's `traceSink` carries a step's tag forward:
`withStepProvenance` decorates the source's steps with it, and `recallForObjective` renders an
`[untrusted]` marker plus one explaining line, so a line another seat recalls a run later still says
what it came from. The tag lives in the wrapper because the step rows belong to the read-only app
and have no column for it; a tag this process did not observe is simply absent, which reads as
trusted exactly as it did before the field existed.

**The write gate.** `provenance.untrusted_writes` (default `hold`) decides what a `memory` write
made in an untrusted step does. `hold` parks it as a pending `ApprovalRow` in `<profile>/gateway.json`
— the durable approval path that already exists, the same rows the heartbeat's fleet-state block
counts — with the untrusted tools named in the tool result. `approveHeldMemoryWrite`
(`../tools/memory/holds.ts`) replays the seat's own action against the UNWRAPPED adapter with
`[provenance: untrusted via <tools>]` appended to every entry, so the block itself records where the
line came from rather than laundering it at the moment of approval. `deny` refuses; `allow` writes it
tagged. `provenance.untrusted_skills` (default `deny`) refuses `skill_manage` from such a step and
names the reason; quarantining a candidate instead is the curator's job. Nothing here reads the
untrusted text looking for an instruction — that detection is unsolved — so the gate is on the
combination of untrusted input and a durable write. Proof: `../governance/provenance.test.ts`,
`../tools/memory/holds.test.ts`, `recall.test.ts`, `failures.hook.test.ts`,
`../tools/delegate/delegate.test.ts`.

**Failures get a channel.** The fleet-brain audit's finding was flat: "failures have no channel at
all" (3.5) — a failed step surfaced only as a step output inside recall, which usually ranked it
away, so the next seat with a related objective lost the same hour again. `failures.ts` is that
channel. A step that failed, was blocked, or whose critic escalated becomes ONE redacted line —
objective, seat, the tool that failed, the failure tags, a one-line reason — appended through
`Brain.appendNote` into `brain/memory/YYYY-MM-DD.md` and tagged `[failure]`, so it takes the brain's
own lock, its 0600 write-then-rename and its commit trail, and nothing new appears on disk. Every
field goes through `redactTranscript` first: a failure reason is usually an error message, which is
the likeliest place in the system for a credential to appear, and this file is durable, committed and
loaded into later prompts. `recallFailures` ranks them against the next run's objective through the
same `scoreAgainst` seam as cross-agent recall, inside a third of `recallBudgetChars`, and the hook
renders them as the last CONTEXT block — last to be trimmed, because it is the smallest block here
and the only one that says what NOT to try. Every line keeps the `[failure]` marker in the prompt: an
unmarked line saying what another seat tried and lost reads as advice. Proof: `failures.test.ts`,
`failures.hook.test.ts`.

**Propagation of skills, asserted.** A skill promoted to the `__org__` tier reaches every seat as one
index line — task type, tier and the skill's own first heading — and its body is fetched with
`fleet_skill_view` / `skill_view` and nowhere else. `sharedSkillIndexLine` is now the single
rendering, and recall uses it too: a skill is RANKED against its whole body (`scoreText`) and
RENDERED as its index line, which closes the back door where a relevant skill's body was clipped into
the prelude at `recallSnippetChars`. The org tier is in the STABLE tier, so the bytes are identical
for every seat of a run. Proof: `shared-skills.test.ts`.

## Interrupted runs ([G2])

**A stopped turn's text is never handed to the next run as an answer.** The REPL already refused to
thread an interrupted turn back into the conversation (`apps/cli/src/repl/conversation.ts`), and the
live proofs recorded what that left open: recall and the app's company memory could still carry it.
Ctrl+C is not a clean stop — the drain loop only checks between jobs, so the step that was in flight
finishes in the background and lands a `completed` step row, while the run itself never reaches a
settled status and nobody ever saw the answer. So the RUN row is the honest signal: `isSettledRun`
(`completed`, `failed`, `cancelled`) gates the step outputs and the consolidated summary that recall
collects, and `guardInterrupted` adds what THIS process watched — a step whose seat call threw, or
had not returned when the run closed — as a `FleetStep.interrupted` tag, drops the app-memory rows
filed under such a run (the episodic `cycle:<runId>` row quotes every step's output), and hands
`fleet_search` the same view with those steps removed, because it renders whatever it is given.
The failure channel is deliberately separate: what was tried and lost still reaches the next seat as
`[failure]` lines, marked as failures, because excluding an OUTPUT is about not passing a fragment
off as an answer, not about hiding that the attempt happened.

Two more doors, on the write side. The app-memory mirror now HOLDS a seat's episodic append for the
step that made it and writes the row only once that step's seat call returns; a step that never
finished takes its episodes with it, and their text is quarantined for the life of the process so
the consolidation path refuses to promote a fact that carries it (`AppWriteOutcome.skipped`). And a
daily note offered for a step still in flight is refused (`FleetMemoryHook.stepFailed`), since the
brain's notes are read back into the next run's prelude.

Two boundaries, stated rather than implied. The seat's own `memory` append lands in the block on
disk at tool time even inside a turn the user stopped — the write completed, the seat was told so,
and the block is append-only truth about what the seat did; what is stopped is its promotion into
the company's episodic and semantic tiers. And a step this process never watched is judged by its
run row alone, so a stopped run whose row some other process later marks `completed` would be
recalled: the tag lives in the wrapper because `apps/web` owns the schema. Proof:
`interrupted.test.ts`, `interrupted.orchestrator.test.ts`.
