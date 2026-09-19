# The brain: `<profile>/brain/`

Trent's company brain is a directory of Markdown files inside the profile, versioned with git when
git is installed. This document states the truth rule it exists to enforce, the layout, the gates
over writing it, and what the one-time migration does to the memory blocks that came before it.

Code: `packages/trent-core/src/fleet-memory/brain.ts` (the store), `brain-migrate.ts` (the
migration), `brain-prompt.ts` (the prompt block), `brain-index.ts` (recall and its cache),
`packages/trent-core/src/tools/memory/brain-read.ts` (the `brain_read` tool),
`apps/cli/src/commands/groups/brain.ts` (`trent brain`),
`packages/trent-core/src/doctor/checks/brain.ts` (the doctor line).

## 1. The truth rule

One sentence per layer, because the question "which one wins when two disagree" has to have an
answer before anything is built on top:

| Layer | What it is the truth for | Who may write it |
|---|---|---|
| `brain/` files | identity, standing decisions, episodic notes, per-seat notes | seats through the gates below; the founder in an editor |
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
- The **context tier** carries brain recall: the decisions, notes and this seat's own notes that
  rank against THIS objective (`brain-index.ts`). It is per (run, seat) and never in the cacheable
  prefix.

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

`trent brain` is read-only. There is no subcommand that writes, because a CLI writer would be a
second writer with none of the gates above.

| Command | What it reports |
|---|---|
| `trent brain status` | the root, whether it is enabled and versioned, the head commit, the counts of system files, days of notes, decisions and seats, and the first 20 tree entries |
| `trent brain log [n]` | the last `n` commits: hash, date, subject, and the writer and run from the body |
| `trent brain show <path>` | one brain file, refusing any path that leaves the brain |

`trent doctor` carries one Brain line: `ok` when the brain is versioned, `warn` when it exists
without versioning, and `skip` when it is switched off or has not been created yet.

## 7. Configuration

```yaml
brain:
  enabled: true        # false: no brain/ directory, no brain block in any prompt
  versioning: auto     # auto: git when it is installed; off: never shell out
```

See `docs/configuration.md` for the rest of the file, and `fleet-memory/README.md` for how the
brain block sits alongside the memory blocks, the shared skills index and cross-agent recall in the
three-tier prompt.
