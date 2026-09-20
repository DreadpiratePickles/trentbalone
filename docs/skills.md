# Skills

A skill is a named block of instructions an agent can load. Skills live in the profile's skills
directory, and every one is scanned before it is written to disk.

There is **one store**. `trent skills` and the seat's `skills` toolset read and write the same
directory in the same format, so a skill you install is one the agent can view and edit, and a skill
the agent writes is one `trent skills list` and `trent skills view` show you.

```bash
npm run cli -- skills browse
npm run cli -- skills search audit
npm run cli -- skills install repo-audit
npm run cli -- skills list
npm run cli -- skills view repo-audit
npm run cli -- skills remove repo-audit
```

## The catalog

`skills browse` lists the built-in catalog. Six entries today:

```
SKILLS (6)
  repo-audit                 Deep codebase mapping, architectural dependency graph, and security hotspots check.
  competitive-teardown       Evaluates competitor positioning, feature sets, pricing models, and defensive moats.
  pr-reviewer                Reviews code changes against correctness, performance, test coverage, and security criteria.
  landing-page-copy          Generates benefit-driven landing page headlines, feature grids, and founder notes.
  financial-runway-forecast  Calculates burn rate, runway months, cash break-even scenarios, and budget caps.
  customer-escalation-triage Classifies ticket urgency, synthesizes repro steps, and drafts polite empathetic replies.
```

`skills search <term>` matches against name, description and tags. `skills list` shows what is
installed in the active profile, which is a different list.

Seats reach the same store through the `skills` toolset (`skills_list`, `skill_view`,
`skill_manage`) once `skills` is in `toolsets`; the REPL's `/tools` lists it when registered. It is
the same directory, the same format and the same writer the CLI uses: `skill_manage {"action":
"patch"}` edits the skill `skills install` wrote, and `skills view` prints the edit.

## The pre-install scan

`SkillsHub.install` scans the content before it writes anything. A skill that fails the scan is not
written; installation throws and names every finding. There is no flag that overrides a failing scan.

Patterns matched, from `packages/trent-core/src/skills/SecurityScan.ts`:

| Pattern | Reason given |
|---|---|
| `rm -rf /` or `rm -rf ~` | Dangerous recursive root/home deletion |
| `curl … \| bash` or `… \| sh` | Arbitrary remote code execution via pipe to shell |
| `wget … \| bash` or `… \| sh` | Arbitrary remote code execution via pipe to shell |
| `eval(… process.env …)` | Dynamic evaluation of environment secrets |
| `cat ~/.ssh/…` or `cat ~/.trent/.env` | Unauthorized attempt to read secret files |
| `ignore all previous instructions` | Prompt injection / jailbreak attempt |
| `system override mode` | Prompt injection attempt |
| `webhook: https://…` to a non-Trent host | Untrusted external exfiltration webhook |

The scan returns `{ safe, score, findings }`. The score starts at 1.0 and drops 0.35 per finding.
Eight rules is a small ruleset — Hermes runs roughly 110 regexes across 12 categories — so treat this
as a floor, not a guarantee, and read a skill before installing it from anywhere untrusted.

## Where skills live and what they look like

Skills live in the profile's skills directory: `~/.trent/skills/` for the default profile,
`~/.trent/profiles/<name>/skills/` otherwise. One directory per skill, named for its slug, holding
a `SKILL.md`:

```
~/.trent/skills/
  repo-audit/SKILL.md                  uncategorised, or category "general"
  engineering/release-notes/SKILL.md   category "engineering"
    references/  scripts/  assets/     the skill's bundle, read a file at a time
```

`SKILL.md` carries its metadata in frontmatter and its instructions in the body:

```markdown
---
name: Repository Audit
description: Deep codebase mapping and dependency graph.
category: engineering
trust: trusted
version: 1.2.0
author: you
tags: audit, code
---
Analyze package dependencies, circular imports, and API surface.
```

Missing fields fall back: the name to the first `# ` heading, the description to the first `> ` line,
the category to the parent directory (else `general`), the version to `1.0.0`, the author to
`community`, the trust tier to `community`. `trust` is what decides whether the agent may edit a
skill: `trusted` and `community` are editable, `builtin` and `official` are read-only and no flag
overrides that. `trent skills install` writes `trusted`, so an installed skill is one the agent can
improve; `skill_manage` writes `community`.

Files are written with an atomic write-then-rename, `0600` inside a `0700` directory.

`fleet install` materialises a bundled skill as a flat `<slug>.md` first; the store converts it to
the directory form on the next read. A flat file that carries Agent Skills frontmatter keeps its
own metadata through that conversion (name, description, category, trust, version, author, tags)
and its body becomes the instructions; a flat file without frontmatter is read from its heading
and first `> ` line, as before. The bundled sources are the app's `apps/web/.agents/skills/` and
the core `packages/trent-core/skills/`, in that order (see [fleet.md](fleet.md), "Skill sources").

Every skill gets a slash command derived from its slug: `repo-audit` becomes `/repo-audit`.

## Curator

Skills decay. One a seat wrote for a problem it had once is still in the store a year later, still
advertised, still costing context on every list. The curator is the part that notices, and the
ledger is the part that makes everything it does reversible.

```bash
npm run cli -- curator status
npm run cli -- curator age
npm run cli -- curator adopt repo-audit
npm run cli -- curator release deploy-runbook
npm run cli -- curator log repo-audit
npm run cli -- curator undo mut_9f3c1ab27d40e651
```

### Lifecycle

Every skill carries four more frontmatter fields, and two counters that live beside it:

| Field | Where | Meaning |
|---|---|---|
| `status` | `SKILL.md` | `active`, `stale`, `archived` or `quarantined` |
| `created_by` | `SKILL.md` | `human`, `agent` or `import` — declared, never inferred |
| `promoted_at` | `SKILL.md` | when the skill entered the store: the aging baseline |
| `quarantine_reason` | `SKILL.md` | why the scan gate held it; absent otherwise |
| `use_count` | `.usage.json` | loads by a seat's run |
| `last_used_at` | `.usage.json` | the last of those loads |

The counters are a sidecar (`<profile>/skills/.usage.json`, `0600`) and not frontmatter for one
reason: the ledger content-addresses the skill's bytes, so a counter bumped on every load would
change those bytes on every load and every blob would be unique. `SkillLoader.loadFull` is where a
load is counted — the one path that puts a skill's instructions in front of a model. Installing a
skill is not using it, so `trent skills install` leaves the counters at zero and `promoted_at` is
what the clock runs from until something loads it.

`trent curator age` applies the transitions. A skill unused for `curator.stale_after_days` (60)
becomes `stale`; unused for `curator.archive_after_days` (180) it becomes `archived`; a `stale`
skill that gets loaded again goes back to `active`, because a fresh load is the answer to
staleness. An `archived` skill is **not advertised** to seats — `skills_list` does not show it and
the seat cannot use it — but it is still on disk, still readable with `trent skills view`, and
`trent curator release` puts it back. Nothing is ever deleted by aging.

Nothing wires this to the heartbeat yet. `ageSkills` takes its clock and both thresholds as
arguments and reads no configuration, so a heartbeat tick can call exactly the function the CLI
calls when that is switched on.

### Declared provenance is the autonomy policy

Only `created_by: agent` skills are aged, archived or quarantined by the curator.
A skill you installed or imported is **reported** by `curator status` and `curator age` with its
idle days, and left exactly where it is however old it gets. Provenance changes in one place and
one way — `trent curator adopt <skill>` — and never from telemetry: how often a skill is used says
nothing about whose it is. `trent skills install` writes `created_by: human`, `skill_manage`
writes `agent`, and a legacy flat file migrates as `import`.

### The scan gate on agent-authored skills

`skill_manage` already refuses dangerous text operation by operation, and that write gate is
unchanged. The curator adds a second one, after the write: the **composed** skill — its `SKILL.md`
and every file in its `references/`, `scripts/` and `assets/` bundle, scanned together — goes past
the same pre-install scanner. No single operation ever sees that much, which is the point: a
poisoned bundle file that arrived by another path is caught the next time an agent touches the
skill. A flagged skill is not rolled back and not deleted. It sits `quarantined` with the reason
in its frontmatter, is not advertised to any seat, and waits for `trent curator release <skill>`,
which is a human command.

The gate is on for every agent write today. `curator.scan_agent_skills` is the setting meant to
switch it off, and `createSkillsAdapter({ scanAgentSkills: false })` is the seam it feeds, but the
toolset builder (`packages/trent-core/src/tools/index.ts`) does not pass the setting through yet,
so the key is read by nothing.

### The mutation ledger

Every change to a skill — create, edit, delete, age, archive, restore, quarantine, promote, adopt,
undo — appends one line to `<profile>/skills/.ledger.ndjson` (`0600`, append-only):

```json
{"id":"mut_9f3c1ab27d40e651","skill":"repo-audit","kind":"age","actor":"curator",
 "before":"<sha256>","after":"<sha256>","detail":"active to stale after 74 idle days",
 "undoes":null,"createdAt":"2026-09-18T00:00:00.000Z","prevHash":"<sha256>","hash":"<sha256>"}
```

`actor` is a seat id, `human`, or `curator`. `before` and `after` name content-addressed blobs
under `<profile>/skills/.blobs/<sha256>` (`0600` inside `0700`), so a row is small, identical
content is stored once, and a rollback restores the exact document rather than a reconstruction.
Each row's `hash` covers its `prevHash` and all of its own fields, the same construction the audit
export uses: edit a row in place and every hash after it stops matching. `trent curator status`
and `trent curator log` both report whether the chain is intact, and `log` names the line where a
break starts.

`trent curator undo <mutation_id>` reverses **exactly one** mutation: it writes the `before` blob
back (or removes the skill, when the mutation created it) and appends its own `undo` row naming
what it reversed. Undoing anything but the newest mutation of that skill is refused, naming the
newer mutation, because reversing a change with later changes stacked on it would discard them
silently. Undo the newer one first.

### What the curator does not do

- **No LLM consolidation into umbrella skills.** Hermes' curator can run a model pass that folds
  several skills into one. SkillAxe measured raw LLM-authored skills at zero gain, so the loop
  that would write them is not here and is not planned.
- **No automatic runs.** `curator age` is a command. The heartbeat does not call it yet.
- **Bundle files are not blobbed.** A row records the bundle path it touched in `detail`, but the
  ledger content-addresses `SKILL.md` alone, so `undo` restores the document and not a bundled
  file.
- **No backup, pause, resume, pin, prune or purge.** Hermes has all six; this is the first cut.

## Migration from the older flat form

Older releases wrote one flat file per skill — `<slug>.md`, or `<slug>.json` with the metadata
explicit — and that store was separate from the one the `skills` toolset used, so an installed skill
could not be edited by the agent and an authored skill did not appear in `trent skills list`. There
is now one store, and the flat form is converted into it **on the first read** by either surface:

- the flat file's metadata is carried over exactly as the loader used to report it (a `.json` file
  keeps its name, description, version, tags and author; its first tag becomes the category), the
  body becomes the `SKILL.md` body, and the tier becomes `trusted`;
- the write is atomic and the flat file is unlinked only after it lands; one line naming the skill
  goes to stderr;
- a second read finds nothing to migrate and does nothing;
- a flat file whose canonical skill already exists is never overwritten — the canonical one wins and
  the flat file is left where it is;
- a name that cannot be a skill directory name (anything outside lowercase letters, digits, `-` and
  `_`) is left flat, still listed and still readable, so no skill is ever lost. Such a skill cannot
  be patched by `skill_manage`; rename it to migrate it.

## Not yet implemented

- A remote skills registry. `skills install` installs from the built-in catalog or from content you
  supply; there is no network fetch and therefore no manifest hash to verify.
- A `tools/` subdirectory beside a skill. The store reads `references/`, `scripts/` and `assets/`;
  `tools/` is not read and not carried.
- Bundle carriage through import. `fleet export <id> <dir>` writes `<dir>/skills/<slug>/SKILL.md`
  and, since U5, copies the skill's `references/ scripts/ assets/ tools/` beside it (see
  [fleet.md](fleet.md), "Export and import"); `fleet import <dir>` reads only the SKILL.md back,
  scanning every file first, so the bundle directories arrive with the export and stop there. An
  import still writes the flat form, which the next read of the store migrates.
- Removing an agent no longer removes a skill of its own that has been migrated: `fleet uninstall`
  deletes flat skill files, and a migrated skill is a directory. Re-provisioning is unaffected — a
  reinstall rewrites the flat file, and the canonical skill continues to shadow it, so nothing is
  duplicated and nothing is lost.
- Repository-local `.trent/skills/` discovery. Only the profile directory is read.
- A trust-and-verdict install table where a `dangerous` verdict cannot be forced. Today the scan is
  simply pass or fail.
