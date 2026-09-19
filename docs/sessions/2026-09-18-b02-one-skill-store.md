# 2026-09-18 — B0.2: one skill store

Wave 1, task B0.2. Branch `feature/trent-fleet-v2`. `TRENT_QUEUE_FALLBACK=disabled` exported in
every shell. No model was called; no commit and no `git add` from this session.

## The defect

`packages/trent-core/src/tools/skills/store.ts:1-9` documented two stores in one directory:
`SkillsHub.install` / `SkillLoader` wrote and read flat `<slug>.md|.json`, while the `skills`
toolset read and wrote Hermes's `<category>/<name>/SKILL.md` and exposed the flat files read-only
as `builtin`. So a skill the user installed could not be edited by the agent, and a skill the agent
authored did not appear in `trent skills list`.

## The decision

The canonical form is the **directory form**, because it is the richer of the two: explicit
frontmatter (name, description, category, trust, version, author, tags), a bundle
(`references/ scripts/ assets/`), a trust tier that decides editability, and in-place patching. The
flat form can express none of that, so dir -> flat would lose information and flat -> dir loses
nothing. `trust` of anything a person installed or the migration converted is `trusted`, which is
mutable — that is what makes a CLI-installed skill editable by the agent.

`packages/trent-core/src/skills/skill-store.ts` is the one store. `SkillLoader` (the read API
`fleet/agent-definition.ts` and `SkillsHub` call) keeps its exact shape and now reads through it, so
nothing outside the skills surfaces changed. `improve/**` and `fleet-memory/**` never read this
directory at all — they read `SkillDraft` rows — and were not touched.

## Migration

On read, by either surface: each flat file is rendered into canonical form (atomic write-then-rename,
0600 in a 0700 directory), the flat file is unlinked after the new one lands, and one line naming the
skill goes to stderr. A second read finds nothing. A flat file whose canonical skill already exists is
never overwritten; a name a directory cannot carry is left flat and still listed.

## Evidence

| Command | Exit |
|---|---|
| `npx vitest run packages/trent-core/src/tools/skills packages/trent-core/src/skills packages/trent-core/src/improve packages/trent-core/src/fleet-memory apps/cli/src/commands/__tests__/skills*` | 0 (26 files, 154 tests) |
| `node scripts/ci/repo-scan.mjs` | 0 |
| `npx tsc --noEmit -p apps/cli/tsconfig.json` | 2 |
| `npm --prefix packages/trent-core run build` | 2 |

Both typechecks fail on one error in a file this task did not touch:
`packages/trent-core/src/fleet/AgentInstaller.ts(60,18) TS2339: Property 'INTERNAL' does not exist`.
`EXIT.INTERNAL` exists nowhere in `packages/trent-core/src/errors/`, and `git show HEAD` of that file
contains no reference to it, so it comes from another wave-1 agent's uncommitted edit (B1 owns that
file). No error was reported in any file changed here.

## Known interaction, reported not absorbed

`fleet/SkillProvisioner.ts` still writes and deletes the flat form for agent installs, and it was
left alone because `fleet/**` belongs to task B1 in this wave. Consequences, both lossless: a skill
provisioned by `fleet install` migrates on the next read, so a later `fleet uninstall` no longer
deletes it; and a re-provision rewrites the flat file, which the canonical skill then shadows (the
migration refuses to overwrite it), so nothing is duplicated. Recorded in `docs/skills.md` under
"Not yet implemented".
