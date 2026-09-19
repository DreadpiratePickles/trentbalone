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

Every skill gets a slash command derived from its slug: `repo-audit` becomes `/repo-audit`.

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
- Bundle carriage through export and import. `fleet export <id> <dir>` writes
  `<dir>/skills/<slug>/SKILL.md` and `fleet import <dir>` reads it back, scanning every file first
  (see [fleet.md](fleet.md), "Export and import"), but only that one file: a skill's bundle
  directories do not travel with it. An import still writes the flat form, which the next read of
  the store migrates.
- Removing an agent no longer removes a skill of its own that has been migrated: `fleet uninstall`
  deletes flat skill files, and a migrated skill is a directory. Re-provisioning is unaffected — a
  reinstall rewrites the flat file, and the canonical skill continues to shadow it, so nothing is
  duplicated and nothing is lost.
- Repository-local `.trent/skills/` discovery. Only the profile directory is read.
- A trust-and-verdict install table where a `dangerous` verdict cannot be forced. Today the scan is
  simply pass or fail.
