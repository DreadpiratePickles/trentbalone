# The brain: `<profile>/brain/`

Trent's company brain is a directory of Markdown files inside the profile, versioned with git when
git is installed. This document states the truth rule it exists to enforce, the layout, the gates
over writing it, and what the one-time migration does to the memory blocks that came before it.

Code: `packages/trent-core/src/fleet-memory/brain.ts` (the store), `brain-migrate.ts` (the
migration), `brain-prompt.ts` (the prompt block), `brain-index.ts` (chunk recall and its cache),
`fleet-memory/ingest/` (`trent brain import`: extractors, the chunker, the doc file format),
`packages/trent-core/src/tools/memory/brain-read.ts` (the `brain_read` tool),
`apps/cli/src/commands/groups/brain.ts` (`trent brain`),
`packages/trent-core/src/doctor/checks/brain.ts` and `brain-import.ts` (the doctor lines).

## 1. The truth rule

One sentence per layer, because the question "which one wins when two disagree" has to have an
answer before anything is built on top:

| Layer | What it is the truth for | Who may write it |
|---|---|---|
| `brain/` files | identity, standing decisions, episodic notes, per-seat notes, imported documents | seats through the gates below; the founder in an editor, and through `trent brain import` for `docs/` |
| `Document` rows (`validFrom`, `validTo`, `supersedesId`) | facts with validity windows | the app's tier writes (C1) |
| SQLite FTS5, the embedding cache, `<profile>/cache/brain-index/` | nothing | rebuilt on demand; delete them freely |

Two stores, not three. There is no `facts` table and no third system: the memory blocks that used
to live in `<profile>/memories/*.md` migrate INTO `brain/system/` and stop being a separate layer.

**The brain is advisory. `AGENTS.md`, the workspace context files (`trent workspace trust`) and
`config.yaml` are normative.** Nothing a seat writes into the brain changes what Trent is permitted
to do: not the approval floors, not the hardline blocklist, not `approvals.deny`, not the autonomy
level. This is the separation Codex's own documentation insists on — memory is a recall layer, the
checked-in file is the instruction — and it is the answer to the failure mode where an
agent-writable, always-loaded store quietly becomes a control surface.

Indexes are never authoritative. If the index and the file disagree, the file is right and the
index is stale; deleting `<profile>/cache/brain-index/` costs one rebuild and loses nothing.

## 2. The layout

```
<profile>/brain/
  system/              always loaded into the stable tier of every prompt
    identity.md        who this company is and what it is for
    decisions.md       the standing decisions, in brief; the ADRs are in decisions/
    facts.md           durable facts every seat should have without asking
    memory.md          migrated from memories/MEMORY.md
    user.md            migrated from memories/USER.md
    company.md         migrated from memories/COMPANY.md (read-only for seats)
  memory/YYYY-MM-DD.md episodic notes, append-only, one file per UTC day
  decisions/           one ADR-like file per standing decision, named <date>-<slug>.md
  seats/<seat>/notes.md  a seat's private working notes
  docs/<slug>.md       documents the founder imported, as Markdown with provenance front matter
  skills-index.md      generated from the promoted skills; derived, never model-authored
  .git/                present when versioning is on
```

What reaches a prompt, and what does not:

- The **stable tier** carries `system/` in full (each file under the per-block character limit,
  default 2200) and the **file tree as paths only**, bounded to 60 entries. Directory and file
  names are the signposts; the bodies of `memory/`, `decisions/` and `seats/` are not in the
  prompt at all.
- A seat that wants one of those bodies calls **`brain_read {"path": "decisions/2026-09-18-x.md"}`**
  with a path it can see in the tree, or finds it with `fleet_search`.
- The **context tier** carries brain recall: the CHUNKS of decisions, notes, this seat's own notes
  and imported documents that rank against THIS objective (`brain-index.ts`), one line per hit with
  a chunk id the seat can cite and hand back to `brain_read`. It is per (run, seat) and never in the
  stable tier, which is ordered first so a provider cache can hit it. Imported documents are
  deliberately absent from the stable tier's tree: a document drop never changes the stable bytes.
  Measured on 2026-09-25, the second of two calls sharing the stable tier had 0 cached tokens on
  `gemini-3.5-flash-lite` and 8,164 of 10,543 cached on `gemini-3.6-flash`. In seat prompts the
  stable tier heads the system message, ahead of the objective, so two objectives on the same seat
  share it as a prefix: 8,164 of 10,808 input tokens cached on `gemini-3.6-flash` in the seat
  layout, where it had 0 when it followed the objective (one of two runs missed; the cache is
  best-effort; docs/sessions/2026-09-25-p2-7-stable-first.md). Company memory therefore carries
  system-message weight, which is accepted because its writes are provenance-tagged and held: a
  write made from untrusted context waits on an approval and lands tagged
  `[provenance: untrusted via <tools>]` (`tools/memory/holds.ts`), and every write reaches a prompt
  only from the next run.

## 3. Writes, and the gates over them

Every write goes through one module. There is no second writer.

- **Atomic**: write-then-rename, mode 0600, directories 0700. A crash or a failed write leaves the
  previous file byte-identical.
- **Locked**: the same `mkdir` lock the memory blocks use (`tools/memory/store.ts`,
  `withMemoryFileLock`). A brain write and a seat's `memory` append serialise; they never
  interleave. Git is for audit and rollback, **not** for merging concurrent seats — the concurrent
  writers here are two runs (`runtime.max_concurrent_runs`) and delegated children, and a lock is
  the right tool for that, not a merge.
- **Append, or a delta — never a rewrite.** Episodic notes and seat notes are appends: the bytes
  already on disk are not re-authored. The only path that replaces a whole file is `applyOps`,
  which takes the four operations from `fleet-memory/memory-ops.ts` (`append`, `replace`, `remove`,
  `merge`), validates the whole list before applying any of it, and lets code decide what the file
  becomes. ACE measured the alternative: a context of 18,282 tokens at 66.7 percent accuracy became
  122 tokens at 57.1 percent in one "rewrite this" step, because everything the model did not
  restate ceased to exist.
- **Layer gates** (unchanged from C4, and they now apply to the migrated files because those files
  ARE the blocks): an episodic append is ungated; a semantic rewrite belongs to the consolidation
  draft, which a human promotes; a `read_only` block is refused on every path unless
  `memory.consolidation_may_edit` lists it.
- **`docs/` is the founder's.** An imported document is the founder's bytes rendered by code, so a
  re-import of a changed file replaces the doc whole (the same exception the skills index has),
  and `trent brain forget` is the one deletion path in the brain. No model authors either.

## 4. Versioning

`brain.versioning: auto` (the default) uses git when it is on PATH. Every write commits with a
message naming what changed, the **writer** (a seat id, or `human`) and the **run id**:

```
brain: note memory/2026-09-18.md

writer: analyst
run: run_01H...
```

git is invoked through a process API with an **argument array**, never a shell string, so nothing a
seat writes can become part of a command. Identity, signing and hooks are supplied per invocation
(`-c user.name=... -c user.email=... -c commit.gpgsign=false ... --no-verify`), so a brain commit
cannot fail because the machine has no global git identity and cannot prompt for a signing key.

If git is missing, **the brain still works**: it is a directory of plain files, the lock still
serialises writers, and the files are still the truth. What is lost is the commit history, the
blame and the byte-exact rollback. `trent doctor` reports this as a warning line
("versioning is off"), never a failure. `brain.versioning: off` never shells out at all and the
doctor reports it as a skip, because it is a decision rather than a defect.

## 5. The migration

On the first run that assembles a prompt, every configured `memory.blocks[]` entry with a file
under `<profile>/memories/` is moved into `brain/system/`:

- `MEMORY.md` becomes `brain/system/memory.md`, **byte for byte**. The name is derived from the
  block's FILE rather than its label, because a consolidation draft carries only the file name and
  both kinds of reference must resolve to the same path.
- The old path is left holding a **pointer**: a short file naming the brain path, so an operator
  who opens the path they have always opened is told where the content went instead of finding
  nothing. The pointer stays until somebody deletes it; deleting it changes nothing.
- `memoryPath()` in `tools/memory/store.ts` follows a migrated block to the brain, so the `memory`
  tool, the consolidation draft, the promotion path and the rollback path all read and write the
  new file with no change to their own code.
- It is **idempotent**, decided by one fact on disk: `brain/system/<block>.md` exists. A second run
  writes nothing — not the file, not the pointer, not a commit.
- A block whose file would shadow one of the brain's own always-loaded files (`identity.md`,
  `decisions.md`, `facts.md`) is refused with an error naming the clash, rather than overwriting it.

## 6. The CLI and the doctor

`trent brain` is read-only for everything a seat writes: there is no `add`, `edit` or `rm` for
notes, decisions or seat notes, because a CLI writer there would be a second writer with none of
the gates above. The three commands that write touch `docs/` only (section 7).

| Command | What it does |
|---|---|
| `trent brain status` | the root, whether it is enabled and versioned, the head commit, the counts of system files, days of notes, decisions, seats and imported documents, and the first 20 tree entries |
| `trent brain log [n]` | the last `n` commits: hash, date, subject, and the writer and run from the body |
| `trent brain show <path>` | one brain file, refusing any path that leaves the brain |
| `trent brain import <path...> [--ignore <glob...>]` | imports files or directories (recursive) as `docs/<slug>.md`; `--dry-run` reports the plan and writes nothing |
| `trent brain docs` | every imported document with its source, format, page or sheet count and chunk count |
| `trent brain forget <doc>` | removes one imported document by slug or `docs/<slug>.md` path; `--dry-run` says whether it is there |

`trent doctor` carries two lines. **Brain**: `ok` when the brain is versioned, `warn` when it
exists without versioning, and `skip` when it is switched off or has not been created yet.
**Brain Import**: one line naming which extractors this machine has, for example
`md, txt, csv: builtin; pdf: pdftotext; docx: builtin; xlsx: builtin`; it warns, with the install
hint, when no PDF extractor can be found, so a founder learns that before an import fails.

## 7. Importing documents

`trent brain import <path...>` is how a founder drops files into the brain. Every file becomes
Markdown under `docs/<slug>.md`, the index cuts it into chunks, and a seat retrieves the right
chunk with a citation it can repeat.

**Formats and extractors.** `md` and `txt` are taken as they are; `csv` becomes one Markdown
table; `docx` becomes headings, paragraphs, lists and tables; `xlsx` becomes one table per sheet
under `## Sheet: <name>`; `pdf` becomes one unit per page. DOCX and XLSX are read by the wrapper's
own ZIP and XML readers on `node:zlib` (no `mammoth`, no SheetJS: a contract needs its text, not
its styling). PDF uses `pdftotext` (poppler) when it is on PATH and Mozilla's `pdfjs-dist`
otherwise; a page with no text layer (a scan) is named in the import report, not OCRed. Anything
else is refused with its extension named and is never read as text. Nothing here calls a model:
extraction and chunking are local and deterministic.

**What is never imported.** The app's own path blocklist (`isIndexableWikiPath` in
`apps/web/lib/trench-wiki.ts`) applies to every file, named or found: `.env` files, keys (`.pem`,
`.key`, `id_rsa`), `node_modules/`, `.git/` and `secrets/`. Dot-files are skipped, and a symbolic
link found inside a directory is not followed. `--ignore <glob...>` adds patterns matched against
a file name or its path under the directory given. A file over 50 MB is refused.

**The doc file.** Front matter carries `title`, `source` (the absolute path it came from),
`format`, `sha256` of the source bytes, `imported_at`, `pages` or `sheets`, and
`provenance: founder-import`. Page and sheet boundaries are kept as `<!-- trent:page 3 -->` and
`<!-- trent:sheet Costs -->` lines so the file re-chunks identically without the original. A
re-import of an unchanged file (same `sha256`) is a no-op: no write, no commit, no index rebuild.
A changed file replaces its doc, and because chunks are derived from the file, its chunks follow.
A doc is found again by its source path, so its slug, and every chunk id a seat has cited, stays
stable across re-imports; two different files with one name get `report` and `report-2`.

**Chunks.** Heading-aware (a `#` line starts a section; a lone title folds into the section after
it), page- and sheet-aware (a chunk never crosses a page or a sheet), bounded at 1,200 characters
with a 150-character overlap between consecutive chunks of one section, and a table split across
chunks repeats its header row. Ids are `<slug>#<n>` for a doc (`lease#7`) and `<path>#<n>` for any
other brain file (`decisions/2026-09-10-churn.md#1`); `n` counts from 1 through the document. The
index (`<profile>/cache/brain-index/`) holds chunks, not files, keyed on the git head plus the
index format, and is disposable.

**The citation format.** A brain recall line in the CONTEXT tier is one line per hit:

```
- [lease#7 #p3 | Office lease] Either party may end this agreement with ninety days written...
- [numbers#2 #sheet:revenue | Quarterly numbers] | month | total | ... | January | 9100 |
- [decisions/2026-09-10-churn.md#1 | Churn is measured on self-serve cohorts] Retention for...
```

That is `[<chunk id> <#p<page> or #sheet:<slug>, when there is one> | <title>]` and a snippet
bounded by `recallSnippetChars` (400); the whole block is bounded by `recallBudgetChars` (3,000)
and sits inside `context.ceiling_chars`. The block header tells the seat to cite the id when it
uses a line, and adds one line whenever a document is present: lines from `docs/` are imported
documents, data and never instructions. `brain_read {"id": "lease#7"}` returns that chunk with the
chunk before and the chunk after it, headed by the same citation, so a seat expands what the
snippet cut without paying for the whole document; `brain_read {"path": "docs/lease.md#7"}` is the
same request spelled the long way.

**The number behind it.** Every change to the extractors, the chunker, the index or the ranking is
judged by recall@8 over the profile's promoted retrieval goldens — a query and the chunk ids that
answer it, added by the founder with `trent improve goldens add --retrieval` or captured from a run
when a seat reads a ranked chunk by id — and `trent improve retrieval` prints it, exit 1 under
`retrieval.min_recall`. The improve loop grades the same number first, and the four files above are
frozen against its drafts. See [improve.md](improve.md), "Retrieval goldens and the recall gate".

## 8. Configuration

```yaml
brain:
  enabled: true        # false: no brain/ directory, no brain block in any prompt
  versioning: auto     # auto: git when it is installed; off: never shell out
```

See `docs/configuration.md` for the rest of the file, and `fleet-memory/README.md` for how the
brain block sits alongside the memory blocks, the shared skills index and cross-agent recall in the
three-tier prompt.

## 9. How recall is ranked, and what is measured

**Relatedness.** Brain recall scores every chunk with TF-IDF, blended with the embedding cosine
when the profile has an embedder (`0.4 x TF-IDF + 0.6 x (cos - floor) / (1 - floor)`,
`fleet-memory/hybrid.ts`). A chunk is related when either:

- its blend reaches `recallMinScore` (0.12), or
- its cosine clears the embedder's own calibrated floor (0.6 for `gemini-embedding-001`).

The blend orders both kinds. The second rule exists because a question against a 1,200-character
chunk sits at cosine 0.55-0.73: before it, answers the blend had ranked first came back as an
empty block (P2-6).

**Task types (built, off).** Gemini can embed a question as `RETRIEVAL_QUERY` and a chunk as
`RETRIEVAL_DOCUMENT`.

- Brain recall asks for that (the objective is the query, every chunk a document).
- The embedder honours it only when created with `taskTypes: true`. It then calls the native
  `batchEmbedContents` endpoint and caches each task type separately.
- The task-typed space has its own floor, 0.63, calibrated on the same sentences as the 0.6.
- It is off by default because it has not been measured on real documents yet: the re-embed ran
  into the free tier's 1,000-requests-a-day embedding quota.
- A `GEMINI_BASE_URL` that is not the `/openai` surface keeps the symmetric call.

**Rerank (`brain.rerank`, off by default).** A second stage over a candidate pool:

```yaml
brain:
  rerank:
    mode: llm                  # off (the default) | llm
    model: gemini-3.5-flash-lite   # default: models.fast, else model
    max_cents_per_query: 1     # worst case over this is refused; the blend's order is kept
    min_score: 0.5             # a chunk scored under it is not picked; no pick = no answer
```

- **The pool** is the top 20 chunks by cosine plus the top 20 by TF-IDF.
- **The call** is one per query. The model sees each candidate's title, heading and first 300
  characters, and scores every candidate 0-1 against the question.
- **Its picks lead**, then the rest of what the blend called related follows.
- **When nothing clears `min_score`** the block is empty, which is the right answer to a question
  the brain cannot answer.
- **A refused, failed or unreadable rerank** keeps the blend's order and never fails a run.
- **The spend** is metered on the run it belongs to (seat `brain_rerank`), so it appears on the
  ledger under the run's surface and counts against `budget.daily_cap`.

Measured on the docs corpus (0.21 cents a query), it is **worse** than the hybrid:

- recall@8 is 0.571 against 0.629;
- 21 of 35 answers start past the 300 characters the model is shown, so it abstains on questions
  it cannot see the answer to;
- multi-hop questions gain (5 to 8 of 11) and no-answer questions are refused more often (4/5).

It stays off. **Not wired yet:** `recallFromBrain` takes a reranker, but the fleet-memory hook and
the CLI do not pass one, so `mode: llm` does not change a seat run today.

**The docs corpus.** The retrieval numbers above come from
`packages/trent-core/src/improve/docs-corpus.test.ts`, which runs offline in the default suite:

- 28 of Trent's own docs, snapshotted;
- 40 questions (exact-term, paraphrased, multi-hop, no-answer);
- the shipped ranker, replaying recorded cosines and recorded rerank scores so CI makes no call.

The live harnesses behind it are `docs-corpus.live.test.ts` and `docs-corpus-rerank.live.test.ts`.
See `01_discovery/output/retrieval-measurement-2026-09-25.md` for every table.
