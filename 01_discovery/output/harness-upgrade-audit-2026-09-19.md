# Harness upgrade audit: run engine and company-brain retrieval

Compiled 2026-09-19 on `feature/trent-fleet-v2` at `8caad65`. Read-only audit; nothing here was
executed against a live model. Every claim about our code carries a `file:line`; every claim about
the outside world carries the URL it was read from. Pages that could not be fetched are listed at
the end and nothing is asserted from them.

Inputs: rulebook principles 11, 12, 14 (`docs/development_methodology_and_coding_rulebook.md:123-180`);
the SOTA checklist sections 1(a), 1(b), 2, 3; the Hermes-parity roadmap; the 60 commits since
`4caa437`; the wrapper, the headless runtime, fleet memory, and (read-only) the app's pipeline.

## 1. Where the harness stands today

The wrapper does not run seats itself. It drains the app's job queue one job at a time
(`packages/trent-core/src/orchestrator/index.ts:149-178`), installs ports through the app's DI seam
(`index.ts:252-263`) and shapes the app's bus events (`index.ts:405-412`). Everything below is read
with that in mind: a weakness in the app's pipeline is one we can only wrap, not edit (invariant 1).

### 1.1 Run durability and resume

Strong. Every step and its mid-loop tool state are persisted rows: `StepRecord.seatLoopState`
(`apps/web/lib/orchestrator-runtime.ts:318-334`) is written when a seat loop pauses for approval
(`orchestrator-runtime.ts:340-360`) and replayed as `resumeSeed` (`orchestrator-run-phases.ts:262`).
`hydrateOrchestrationRun` (`orchestrator-run-persist.ts:14`) rebuilds a run and the app's worker
re-enqueues ready steps from it (`orchestrator-run-worker.ts:41,95,154,183`). A lost status write is
reconciled from the trace (`orchestrator-run-reconcile.ts:1-22`). Tool calls are keyed by
`{runId, stepId}` for idempotent dispatch (`index.ts:169-170`); interrupted runs stay out of the
next run's recall (`fleet-memory/recall.ts:82-90`).

Weak. The wrapper has no way to pick an existing run back up. `Orchestrator` exposes `run`,
`snapshot`, `approve`, `reject`, `answer`, `cancel` (`index.ts:476-494`) and nothing that takes a
run id and drains it. `--continue` restores the REPL transcript (`apps/cli/src/repl/index.ts:140`),
not a run; a `trent run` killed mid-step leaves a `running` job row that the next process never
sees, because `drainRun` filters on the run id it launched (`index.ts:154-157`). The app's
`hydrateOrchestrationRun` plus `selectReadyStepsForEnqueue` (`orchestrator.ts:80-87`) are exactly
the two calls a `resume(runId)` needs; neither is wired.

### 1.2 Parallelism

Strong across runs: `RunSlots` gates `runtime.max_concurrent_runs` FIFO with a queued heartbeat
(`index.ts:203,337-346`); cron, heartbeat and the gateway share the graph (`headless.ts:3-8`).

Weak inside a run, by decision. The app enqueues up to `ORC_MAX_CONCURRENCY` (default 4) ready
steps (`apps/web/lib/orchestrator.ts:47-54,80-87`) and has a DAG pool (`orchestrator.ts:91-100`),
but the drain loop takes the oldest `running` job, awaits it, then looks again (`index.ts:154-170`),
so independent steps run serially on every CLI surface. The roadmap chose this (Phase B) and the
research supports it (SOTA section 3: multi-agent wins are compute, not quality); it costs only
read-heavy fan-out, the one case the sources agree pays.

### 1.3 Interrupts and human-in-the-loop

Strong. Approval parks the run and the drain loop waits instead of closing the handle
(`index.ts:158-162,206-225`); `approve`/`reject` wake it (`index.ts:470-492`); `ask_human` answers
replay through the same waiter (`human-hook.ts:8-11`, `index.ts:493`); a parked run keeps its slot
(`index.ts:122`); held memory writes from untrusted context are durable approval rows
(`headless.ts:267-272`); autonomy floors and a hardline blocklist sit under every bypass
(`seat-wiring.ts:22-26`, commit `26e606d`). This is the interrupt/Command pattern already, with
the cursor being the app's run row rather than a thread id.

Weak. The interrupt is tool-approval-shaped only; `clarify` is a tool call (commit `8d96e17`),
so a mid-step pause always costs a model turn to reach.

### 1.4 Streaming

Strong at event granularity: the handle is an async iterable of the twenty bus kinds
(`index.ts:446-455`); `trent run --format stream-json` rides the same schema (commit `19960af`).

Weak at token granularity. `ModelGateway.stream` exists (`model-gateway/types.ts:171`) but the seat
executor the wrapper installs is the app's non-streaming `executeSeatModel`
(`index.ts:253`, `apps/web/lib/model-gateway.ts:252-261`). The only `.stream(` callers in core are
A2A task streams (`a2a/A2AServer.ts:248`). A seat's turn is silent until it returns.

### 1.5 Observability

Strong. One bus hook composes the improve loop, version pins, OTel export and alerts
(`headless.ts:287-293`); a trace sink feeds the failure channel and the spend meter
(`headless.ts:325-331`); one daily ledger across surfaces (`run-hooks.ts:87-109`, commit `fbb06ce`);
`/context` reports tier sizes and what the ceiling dropped (`orchestrator-hook.ts:134,400-411`);
provenance tags travel with recall lines (`recall.ts:29-34,174-176`).

Weak. Retrieval is not observable as retrieval: the block reports `dropped` and `chars`
(`recall.ts:37-44`) but no event names the items, scores or seat, so nothing can grade it (1.8).

### 1.6 Memory ingestion: can a founder drop a folder of PDFs, contracts and spreadsheets in?

No. What happens today, path by path:

- `trent brain` has `status`, `log`, `show` (`apps/cli/src/commands/groups/brain.ts:37,89,122`).
  No `import`, no `ingest`, no `add`.
- The brain index covers `memory/`, `decisions/`, `seats/<seat>/notes.md` only
  (`fleet-memory/brain-index.ts:8-11,68-73`); a file dropped anywhere else in `brain/` is invisible
  to recall, and a file under those directories is truncated at 4,000 characters
  (`brain-index.ts:40,97`) with no chunking, so page 3 of a contract never exists.
- `file_ops.read_file` is `head -c 5MB` decoded as UTF-8 lines (`tools/file_ops/adapter.ts:32,59,70`).
  A PDF, DOCX or XLSX read that way is binary noise; there is no parser dependency in any
  `package.json` (grep for pdf, mammoth, xlsx, docx: none).
- The app's uploads path (`Document` rows) is reachable only through the web UI; the wrapper reads
  those rows (`app-tiers.ts:1-31`) but has no writer for them.
- The `memory` tool takes `append`/`replace`/`remove`/`merge` on named blocks capped at 2,200
  characters (`memory-ops.ts:31-38`, `brain.ts:57`). It is for facts, not documents.

So the folder reaches a seat only if a human converts each file to Markdown, places it under
`brain/memory/`, and accepts the 4,000-character cut.

### 1.7 Retrieval quality

What exists: TF-IDF with a light stemmer (`lexical.ts:34-49,84-102`); an optional embedding blend
0.6/0.4 with a per-model cosine floor calibrated on the live key (`hybrid.ts:39-44`,
`embedder.ts:79-84`); content-addressed embedding cache (`embedder.ts:14-16`); two corpora scored
separately so the app tier cannot displace run-derived lines (`recall.ts:146-159`); a hard budget
of 3,000 characters and 400-character snippets (`fleet-memory/config.ts:24-27`); the block enters
the CONTEXT tier of the seat prompt, per run per seat (`orchestrator-hook.ts:343-357`), appended to
`dynamicPrompt` (`orchestrator-hook.ts:444-448`).

Gaps, in order of impact:

1. No chunking anywhere on the wrapper side. A candidate is a whole step output, a whole brain
   file (cut at 4,000 chars) or a whole `Document` (`app-tiers.ts:48-55` budgets per source, not per
   chunk). Embedding input is cut at 8,000 chars (`embedder.ts:107`). Long documents are ranked by
   their first page.
2. No reranker. Ranking is one blended cosine; the top of the list is rendered as-is
   (`recall.ts:160-182`).
3. No citation a seat can act on. A recall line is `- [label] snippet` (`recall.ts:176`); the label
   carries a run id prefix or a brain path, but no chunk id, page or offset, and only brain paths
   are fetchable (`brain_read`). The app's own convention is better: `SOURCE DOCUMENTS (cite by id
   when you use one)` with `[id] title` headers (`apps/web/lib/source-coverage.ts:160-171`) and
   `citationRequired: true` in the search contract (`trench-search.ts:23-28`).
4. Two retrieval paths reach every seat, ranked two ways. Besides the wrapper's recall, the app's
   pipeline builds `sourceDocuments` for the planner (`orchestrator-runtime.ts:610-619`) and for
   every seat (`orchestrator-runtime.ts:1307-1317`) through `buildGroundedSourceContext`
   (`source-grounding.ts:66-89`): `Document` rows by substring hit-count
   (`source-coverage.ts:120-140`) plus wiki chunks by `semanticSearch` from `wiki-embeddings.ts`,
   which returns deterministic HASH vectors whenever `OPENAI_API_KEY` is unset
   (`wiki-embeddings.ts:105-108`). On a Gemini-only profile the wiki half of that block is ranked
   by hash. The roadmap's "wiki-embeddings.ts is not used" (C3) is true of the wrapper's recall
   and false of the pipeline the wrapper drains.
5. Brute-force scoring per call: `scoreAgainst` embeds the whole candidate list plus the query
   (`lexical.ts:112-120`). Fine at hundreds of candidates; the cache makes it cheap; it does not
   scale to a corpus of chunks without an index.

### 1.8 Evaluation of recall

None. The improve loop grades seat OUTPUTS: goldens are captured from runs
(`improve/golden-capture.ts`), frozen into suites (`golden-suite.ts:47-65`), gated deterministically
before a judge (`goals`, commit `a171904`). No suite, fixture or gate names a retrieval query and
the chunk ids it should return; `recall.test.ts` and `hybrid.test.ts` pin ordering on synthetic
sentences. The live embedder test measures two cosines (`embedder.ts:80-82`), not recall@k.

## 2. LangGraph.js: three options

What LangGraph.js is, from its own docs. A `StateGraph` of nodes and edges over a reduced state,
executed in super-steps where active nodes run in parallel; `Send` for map-reduce fan-out;
`Command` to update state and route in one return
(https://docs.langchain.com/oss/javascript/langgraph/graph-api). A checkpointer (`put`, `getTuple`,
`list`, `putWrites`) persists a snapshot per super-step under a `thread_id`; `MemorySaver`,
`SqliteSaver`, `PostgresSaver` ship
(https://docs.langchain.com/oss/javascript/langgraph/persistence). `interrupt()` pauses anywhere in
a node; `Command({ resume })` resumes, and the node re-executes from its start, so side effects
before the interrupt must be idempotent
(https://docs.langchain.com/oss/javascript/langgraph/interrupts). Durability modes `exit`, `async`,
`sync` control when checkpoints are written; resume replays the node, so non-deterministic work is
wrapped in `task()` (https://x.com/sydneyrunkle/status/1950934319888785498; the JS durable-execution
page itself redirected to the persistence page in this pass, see Sources not reached). Subgraphs
are compiled graphs passed to `addNode`, with per-thread or stateless checkpointing
(https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs). The Functional API is
`entrypoint` plus `task` with results saved into one checkpoint
(https://docs.langchain.com/oss/javascript/langgraph/functional-api). MIT; peer dependency
`@langchain/core` (https://github.com/langchain-ai/langgraphjs).

What it would replace or duplicate here. Our run engine is the app's queue of `plan`,
`execute_step`, `consolidate` jobs (`orchestrator-run-queue.ts:9-18`), persisted per step with
resume seeds (1.1), parked on approvals (1.3), with idempotent tool dispatch (`index.ts:169`) and a
delegate port for child runs (`delegate-port.ts`). That is a checkpointer, an interrupt and a
subgraph, keyed by run id instead of thread id, living in a directory we may not edit.

### Option (i): adopt LangGraph.js as the run engine under the wrapper

Shape: a `StateGraph` whose nodes call the app's phase functions (`generateOrchestrationPlan`,
`runSeatAgent`, the consolidator) with `SqliteSaver` on `trent.db`, replacing `drainRun`.

Per-unit cost: two new runtime dependencies (`@langchain/langgraph`, `@langchain/core`, plus a
checkpoint package) in a CLI that ships as a single install; roughly two to three agent-weeks to
rebuild plan, execute, approve, delegate and consolidate as nodes and re-prove the eleven wrapper
behaviours listed in `index.ts:14-37`; every run now has two persisted truths, LangGraph's
checkpoint and the app's run row, which is precisely the split-brain `orchestrator-run-reconcile.ts`
exists to repair; the app's dashboards, `hydrateOrchestrationRun`, the version pins and the
improve hook all read the app's rows and would see a run LangGraph is driving as stalled.

What is gained: intra-run parallel super-steps, `interrupt()` anywhere, a replayable checkpoint
history, `Send` fan-out.

What is lost: invariant 1 in spirit (the graph restates the app's phase order and gating);
the frozen-source guarantee (`orchestrator-hook.ts:24-27`) and the delegate caps must be rebuilt;
every `apps/web` change to a phase signature breaks the graph.

### Option (ii): borrow the patterns without the dependency

Three patterns are worth having and are small:

- A checkpointer-shaped `resume(runId)` on `Orchestrator`: hydrate through the app, re-enqueue
  ready steps with `selectReadyStepsForEnqueue`, drain with the existing loop. Cost: one method,
  one test, half a day. No new truth; the app's rows stay the checkpoint.
- A typed `Command`: today `approve`, `reject` and `answer` are three methods; a single
  `resume(runId, { decision | answer })` is the same waiter with one entry, which A2A and ACP
  already want (commit `e98cf97`). Cost: a refactor of `index.ts:470-494`, one day.
- A `task()`-style idempotency rule written down: side effects before a pause must be keyed. We
  already key tool calls (`governance/idempotent-dispatch.ts`); the rule needs stating for hooks
  and memory writes. Cost: a paragraph in `fleet-memory/README.md` and one test.

Not worth borrowing: `Send` fan-out (1.2), `StateGraph` reducers (the app owns state), a second
checkpoint store.

### Option (iii): leave the engine and invest elsewhere

Cost: zero. Loss: the three small items in (ii).
### Recommendation

(ii), limited to `resume(runId)` and the unified `Command`, and otherwise (iii). Principle 11
lists six conditions that justify a workflow engine: real-time agent-to-agent interaction, high
concurrency or many simultaneous users, complex runtime branching, long-running distributed work
with leases, strict transactional guarantees, low-latency external coordination
(`rulebook:123-136`). None is present: one operator, one SQLite file, a DAG the planner fixes at
plan time, approvals that already park and resume, spend in a local ledger. Principle 11 also
says to "document the requirement that forces the escalation"; there is none to document. The
one durable-execution property we lack (resume after process death) is a wiring gap over calls
the app already exports, not an engine gap. LangGraph's own docs make the strongest case against
adoption here: resume re-executes the node from its start, so every seat turn before an interrupt
would have to be made idempotent or wrapped in `task()`, a discipline the app's seat loop was not
written under and which we cannot edit into it.

## 3. What a company-brain ingestion and retrieval upgrade should be

Constraints kept: files are truth, indexes disposable (`brain-index.ts:3-7`); recall lives in the
CONTEXT tier because it depends on the objective (`orchestrator-hook.ts:7-16`); a document drop
must not change the stable tier's bytes; untrusted-derived text is data (`recall.ts:67-69`); the
embedder is the existing `EmbedFn` seam on the operator's key (`embedder.ts:1-18`).

### 3.1 Ingestion pipeline

Entry: `trent brain import <path...>` (new subcommand in `commands/groups/brain.ts`) and a
`brain_import` tool gated `file_ops.write`; both call `ingestDocuments()` in a new `fleet-memory/ingest/`.

Formats and extractors, cheapest local first, all producing Markdown:
- `.md`, `.txt`, `.csv`: as-is (CSV rendered as a Markdown table, one chunk per N rows).
- `.pdf`: `pdftotext -layout` when poppler is present (`doctor` reports it), else `pdfjs-dist`
  text extraction; scanned pages without a text layer are flagged, not OCRed, in this round.
- `.docx`: `mammoth` to Markdown. `.xlsx`: SheetJS to one Markdown table per sheet. `.html`:
  `turndown`.
- Anything else: refused with the extension named, never binary-read.

Output: `brain/docs/<slug>/<file>.md` with a front-matter block (`source_path`, `sha256`,
`ingested_at`, `pages`, `provenance`, `valid_from`, `valid_to`, `supersedes`). The Markdown is the
truth; git versioning already commits brain writes (`brain-index.ts:17-19`). Re-import of the same
sha256 is a no-op; a changed file supersedes the old one by front-matter, mirroring the
`Document` row semantics `app-tiers.ts` already follows (`supersedesId`, `validTo`).

Provenance: a founder-dropped file is company-held but externally authored (a vendor's contract,
a bank statement). Default tag `untrusted` unless `--trusted` is passed at import; the seat prompt
already renders the marker and the note (`recall.ts:67-69,184`). Instructions inside a PDF are
therefore data. This is the trust-escalation failure mode the SOTA doc names (section 4).

Chunking: heading-aware for Markdown (split on `#`/`##`, then at ~800 tokens with 100-token overlap,
the app's 1,200/200-character constants in `wiki-embeddings.ts:22-23` are too small for prose);
page-aware for PDF (chunk never crosses a page, so a citation can name the page); row-group for
tables. Chunk id: `<sha8>#p<page>c<n>`. Contextual prefix: for each chunk, a 50-100 token
"where this sits in the document" line generated by the bulk tier (Gemini Flash on the existing
key) and prepended before embedding and before BM25. Anthropic measured this at 35% fewer
retrieval failures alone, 49% with contextual BM25, 67% with a reranker, and $1.02 per million
document tokens with caching on Haiku (https://www.anthropic.com/news/contextual-retrieval);
our cost on Flash is in the same order and is a one-time cost per chunk, cached by content hash.
Contextual prefixing is the cheap version of what late chunking buys with a long-context embedder
(https://arxiv.org/abs/2409.04701) and needs no new model.

Embeddings: the existing embedder, unchanged (`gemini-embedding-001`, 3,072 dims, per-model floor,
content-addressed cache, `embedder.ts:65-84`). Index: extend `brain-index.ts` entries from
one-per-file to one-per-chunk, keep the version key (git head), store vectors alongside in
`cache/brain-index/` so the index remains disposable. Brute-force cosine is adequate to roughly
50k chunks in-process; an ANN index is a later decision, not this one.

### 3.2 Retrieval

Stage 1, candidates: the existing hybrid (`scoreAgainst`, TF-IDF plus embedding, `lexical.ts:112`)
over chunks, top-40. The lexical half is what gets a customer name or an invoice number right
(`hybrid.ts:19-21`); keep it.

Stage 2, rerank to top-8. Three options that fit our constraints:
- (a) Local cross-encoder via `@huggingface/transformers` ONNX: `Xenova/bge-reranker-base` is
  small (a ~23 MB mini variant exists; `bge-reranker-v2-m3` is 571 MB and multilingual)
  (https://huggingface.co/mogolloni/bge-reranker-v2-m3-onnx,
  https://dev.to/zeeshan56656/your-nodejs-rag-is-grabbing-the-wrong-sources-heres-a-4mb-cross-encoder-fix-1iff).
  Cost: model download on first use, ~1 s per 40 pairs on CPU, no key, no egress.
- (b) LLM pointwise rerank on the bulk tier of the existing key: one Flash call scoring 40
  chunks 0-3 against the objective. Google's dedicated ranking API (`semantic-ranker-default`) is a
  Vertex/Cloud endpoint on `aiplatform.googleapis.com`, not the Gemini developer API on
  `generativelanguage.googleapis.com` that the key is proven on
  (https://docs.cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/retrieval-and-ranking,
  https://ai.google.dev/api/all-methods), so "reranker on the Gemini key" means an LLM call.
  Cost: roughly 3-5k input tokens per recall, cents per run, one round trip.
- (c) No reranker when the candidate set is under 12 chunks.

Recommendation: (a) as default with (c) as the floor, (b) opt-in by config for machines that cannot
hold the model. ColBERT-style late interaction (https://arxiv.org/abs/2112.01488) is the better
first stage in principle, but there is no maintained JS runtime for it and it multiplies index
size 6-10x even compressed; not this round. GraphRAG (https://arxiv.org/abs/2404.16130) targets
corpus-wide "what are the themes" questions and needs an LLM pass over every document to build
community summaries; our seats ask objective-scoped questions, so it is the wrong shape until a
founder asks for a corpus summary, at which point one scheduled consolidation pass is the cheap
form of it.

Citations into the seat prompt: each recalled line becomes
`- [doc:<sha8>#p<page>c<n> | <title> p.<page>] snippet`, in the CONTEXT tier at
`orchestrator-hook.ts:343-357`, with the instruction line the app already uses ("cite by id when
you use one", `source-coverage.ts:165`). `brain_read` takes a chunk id and returns the chunk with
its neighbours, so a seat can expand what the 400-character snippet cut. The consolidator's brief
and step outputs then carry ids the next run can recall by, closing the loop the app's
`citationRequired` contract asked for (`trench-search.ts:23-28`). Anthropic's Citations API
(https://platform.claude.com/docs/en/build-with-claude/citations) gives char-level citations for
free on Anthropic providers only; it is a provider-specific bonus, not the mechanism.

Long context is not the alternative: Anthropic's "just put it in the prompt" threshold is 200k
tokens and our injection ceiling is 60,000 characters (`tiers.ts:75-76`). Retrieval wins where
evidence is sparse and loses where it is spread across a corpus (https://arxiv.org/abs/2501.01880);
a curated 20-40k tokens beats a filled window (https://arxiv.org/pdf/2509.21865). Both point at
rerank-then-cite over a small budget.

The app's second path (1.7 item 4): set nothing in `apps/web`; instead the wrapper can route
`wiki-embeddings.ts` to the same provider by exporting `OPENAI_API_KEY` and `OPENAI_BASE_URL`
pointing at Gemini's OpenAI-compatible surface (`wiki-embeddings.ts:110-113` honours both), IF
`model-env.ts` confirms no other app module reads `OPENAI_API_KEY` as "OpenAI is configured". That
is a one-hour investigation with a live test; until then `doctor` should say the wiki half of the
planner's sources is hash-ranked.

### 3.3 Evaluation

A retrieval golden set: `<profile>/goldens/retrieval/*.json`, each `{ query, seat,
expected_chunk_ids[], forbidden_chunk_ids[] }`, authored by the founder from real objectives and
grown from misses the same way output goldens grow (`golden-capture.ts`). Metrics computed with no
judge: recall@8, id-based precision@8 (RAGAS names this `IDBasedContextPrecision`,
https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/), and
mean reciprocal rank. RAGAS's LLM-judged metrics (faithfulness, context precision with reference)
are not needed for the gate and would violate "deterministic checks before model judgement"
(SOTA consensus 10). The gate: `trent improve sweep` refuses to promote any change under
`fleet-memory/` when recall@8 on the promoted set drops, exactly as goal gates run before the judge
(commit `a171904`). A `recall` event on the bus (`step_note` kind, like context pressure,
`run-hooks.ts:143-163`) carries the chunk ids and scores per seat so the sweep can compute the
metric from traces as well as from the suite.

### 3.4 Reuse from the app's wiki and document modules

Adopt verbatim: the citation block and "cite by id" instruction (`source-coverage.ts:160-171`);
the validity window and supersedes-chain rules (`active-documents.ts`, `app-tiers.ts:22-26`); the
`buildWikiSources` path blocklist (`app-tiers.ts:18`) so `.env` and keys can never be imported;
`SearchCorpusEntry.citation` (`trench-search.ts`) as the shape of the `recall` bus event. Take the
idea only: chunk-and-overlap from `wiki-embeddings.ts` (not its constants, hash fallback or 384-dim
truncation). Do not port: the substring ranker (`source-coverage.ts:120-140`).

## 4. Upgrade items, ranked by user impact per unit cost

1. `trent brain import` for Markdown, text and CSV, chunked, with citations. Files:
   `fleet-memory/ingest/{extract,chunk,index}.ts` (new), `brain-index.ts` (chunk entries),
   `recall.ts` and `brain-index.ts:205-216` (line format with chunk id), `tools/memory/brain-read.ts`
   (chunk id lookup), `commands/groups/brain.ts`. Failing test: `ingest.test.ts` imports a
   12,000-character Markdown file with a fact on its last heading, `recallFromBrain` for an
   objective about that fact returns a line whose id names that chunk, and `brain_read` on that
   id returns the paragraph. Cost: two days. Impact: the founder's notes and exports become
   knowledge today.
2. PDF, DOCX and XLSX extractors behind the same import. Files: `ingest/extract.ts`, `doctor`
   probe for `pdftotext`, `package.json`. Failing test: a three-page fixture PDF imports to three
   page-tagged chunks and a query about page 3 returns `#p3`; a two-sheet XLSX yields two tables.
   Cost: two days plus dependency review. Impact: contracts and spreadsheets, the folder the
   question asked about.
3. Retrieval golden set and the recall gate. Files: `improve/golden-store.ts` (a `retrieval` kind),
   `improve/gate.ts` (recall@8 as a deterministic gate), `fleet-memory/orchestrator-hook.ts`
   (emit the `recall` note), `commands/improve-sweep.ts`. Failing test: a suite of five queries
   over a fixture brain scores recall@8 = 1.0 with the shipped ranker, and a ranker patched to
   return reversed order fails the gate with the metric named. Cost: one and a half days.
   Impact: every later retrieval change has a number; without it items 4 and 5 cannot be judged.
4. Local cross-encoder rerank behind `memory.reranker: local | llm | none`. Files:
   `fleet-memory/rerank.ts` (new), `recall.ts:160` (rerank the top-40 before the budget cut),
   `config/sections/memory.ts`, `doctor`. Failing test: a fixture where the lexical-plus-vector top
   hit is a keyword collision and the correct chunk sits at rank 6; with the reranker it is rank
   1; recall@8 on item 3's suite does not drop. Cost: one day plus first-run model download.
   Impact: the difference between "the right document" and "a document with the right words".
5. Contextual chunk prefixes on the bulk tier. Files: `ingest/contextualise.ts`, cache key on
   chunk hash, spend on the ledger. Failing test: a chunk that reads "the fee is 2.5%" under a
   heading about card processing is recalled for "card processing fee" only with the prefix.
   Cost: one day and cents per document. Impact: measured 35-49% fewer misses upstream.
6. `orchestrator.resume(runId)`. Files: `orchestrator/index.ts` (one method using
   `hydrateOrchestrationRun` and `selectReadyStepsForEnqueue` through `libs`), `libs.ts`,
   `commands/groups/run.ts` (`trent run --resume <id>`). Failing test: a run with two steps is
   killed after step one completes (abort signal), a new orchestrator resumes it, step two runs
   once and the snapshot is `completed`. Cost: one day. Impact: a cron or heartbeat run that dies
   no longer needs a human to notice.
7. Route the app's wiki grounding to the configured provider, or say it is hash-ranked. Files:
   `orchestrator/model-env.ts`, `doctor`. Failing test: with a Gemini key and no OpenAI key,
   `doctor` reports the planner's wiki sources as `hash` or `gemini`, never silent. Cost: half a
   day plus a live proof. Impact: honesty on a path every plan already uses.

## 5. What not to do, and why

- Do not adopt LangGraph.js, the OpenAI Agents SDK or the Claude Agent SDK as the run core. The
  first duplicates a checkpointer the app already has and cannot own the app's rows (section 2).
  The OpenAI Agents SDK's loop, `needsApproval`, `RunState.toString()/fromString()` and
  `run(agent, state)` (https://openai.github.io/openai-agents-js/guides/human-in-the-loop/) are
  the same shape as ours and provider-agnostic through a `Model` interface
  (https://openai.github.io/openai-agents-js/), but it would run seats outside the app's plan,
  critic and consolidate phases, so every dashboard and golden would stop seeing them. The Claude
  Agent SDK is Claude Code as a library, Anthropic-only auth, governed by Anthropic's commercial
  terms, and forbids offering claude.ai login
  (https://code.claude.com/docs/en/agent-sdk/overview); it is the wrong shape for a Gemini-first
  fleet and would replace, not wrap, the seat loop.
- Do not add intra-run parallelism to chase LangGraph's super-steps: the decision is recorded
  (roadmap Phase B) and the compute-normalised evidence is against it (SOTA section 3).
- Do not build a vector database or ANN index this round; brute-force cosine over cached vectors
  holds to tens of thousands of chunks and keeps the index disposable.
- Do not do GraphRAG or a temporal graph for documents: front-matter validity windows answer
  "which contract is current", and the graph pays an LLM pass per document for an unasked query.
- Do not OCR scanned PDFs this round; flag them (principle 12: the expensive tier does no bulk work).
- Do not use an LLM judge for the retrieval gate; ids in, ids out, a number.
- Do not put retrieved chunks in the stable tier or the memory blocks: objective-dependent, cache
  breaking, and a poisoned chunk would become standing instruction.
- Do not edit `apps/web` to fix the hash-vector path; route it from the wrapper or report it.

## Sources

LangGraph.js: https://docs.langchain.com/oss/javascript/langgraph/graph-api ·
https://docs.langchain.com/oss/javascript/langgraph/persistence ·
https://docs.langchain.com/oss/javascript/langgraph/interrupts ·
https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs ·
https://docs.langchain.com/oss/javascript/langgraph/functional-api ·
https://github.com/langchain-ai/langgraphjs · https://x.com/sydneyrunkle/status/1950934319888785498.
Alternative cores: https://openai.github.io/openai-agents-js/ ·
https://openai.github.io/openai-agents-js/guides/human-in-the-loop/ ·
https://github.com/openai/openai-agents-js · https://code.claude.com/docs/en/agent-sdk/overview.
RAG: https://www.anthropic.com/news/contextual-retrieval · https://arxiv.org/abs/2409.04701 ·
https://arxiv.org/abs/2112.01488 · https://arxiv.org/abs/2404.16130 ·
https://platform.claude.com/docs/en/build-with-claude/citations ·
https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/ ·
https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/ ·
https://arxiv.org/abs/2501.01880 · https://arxiv.org/abs/2510.09106 · https://arxiv.org/pdf/2509.21865.
Rerankers: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/retrieval-and-ranking ·
https://ai.google.dev/api/all-methods · https://huggingface.co/mogolloni/bge-reranker-v2-m3-onnx ·
https://dev.to/zeeshan56656/your-nodejs-rag-is-grabbing-the-wrong-sources-heres-a-4mb-cross-encoder-fix-1iff.

Sources not reached: the LangGraph.js durable-execution page (redirected to the persistence page;
a mirror returned 404), so the three durability modes rest on a LangChain engineer's announcement
and a search summary; the OpenAI Agents SDK licence page (MIT read from the repository footer);
Vertex ranking API per-request pricing; the RAGAS non-LLM context-recall class name; an explicit
Gemini developer API statement that no rerank method exists (inferred from the method list).
