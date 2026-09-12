# Skills

A skill is a named block of instructions an agent can load. Skills are files in the profile's skills
directory, and every one is scanned before it is written to disk.

```bash
npm run cli -- skills browse
npm run cli -- skills search audit
npm run cli -- skills install repo-audit
npm run cli -- skills list
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
`~/.trent/profiles/<name>/skills/` otherwise. One file per skill, named for its slug.

Markdown form, `<slug>.md`:

```markdown
# Repository Audit
> Deep codebase mapping and dependency graph.

Analyze package dependencies, circular imports, and API surface.
```

The loader takes the name from the first `# ` heading and the description from the first `> ` line.
Everything else is the instruction body. Version defaults to `1.0.0`, tags to `["general"]`, author
to `community`.

JSON form, `<slug>.json`, when you want the metadata explicit:

```json
{
  "name": "Repository Audit",
  "description": "Deep codebase mapping and dependency graph.",
  "version": "1.2.0",
  "tags": ["audit", "code"],
  "author": "you",
  "instructions": "Analyze package dependencies, circular imports, and API surface."
}
```

`instructions` is read from the JSON, falling back to `content`. `skills install` always writes the
markdown form; the JSON form is for skills you author by hand.

Every skill gets a slash command derived from its slug: `repo-audit` becomes `/repo-audit`.

## Not yet implemented

- A remote skills registry. `skills install` installs from the built-in catalog or from content you
  supply; there is no network fetch and therefore no manifest hash to verify.
- A `<slug>/SKILL.md` directory layout with `scripts/` and `tools/` subdirectories. Earlier
  documentation described this; the loader reads a single file per skill.
- Repository-local `.trent/skills/` discovery. Only the profile directory is read.
- A trust-and-verdict install table where a `dangerous` verdict cannot be forced. Today the scan is
  simply pass or fail.
