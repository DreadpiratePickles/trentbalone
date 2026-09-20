# 2026-09-20 — U4: three fleet packs, personas, core skill source

Wave-1 task U4 (design v2 sections 0, 2, 3/B4; review items 6 and 7). Branch `feature/trent-fleet-v2`.
Invariants held: nothing under `apps/web` changes; failing test first per item; files under 500 lines;
no canned strings, emoji or hex in output surfaces; `TRENT_QUEUE_FALLBACK=disabled` in every shell;
no live model; no `git add`/commit by this agent.

## Plan (in order)
1. Core skill source `packages/trent-core/skills/<name>/SKILL.md`, read by `SkillProvisioner` layered
   under the app bundle (app wins on a name collision); both sources listable.
2. Packs `small-business`, `social`, `creator` in `FleetPacks.ts` with an honest `state`; `trent fleet
   packs`; `trent fleet install <pack>` installs members, pack skills and the persona; dry-run.
3. Personas as `brain/system/persona-<pack>.md` through `brain.writeFile` (committed, under the limit).
4. Thirteen skills (five small-business, four social, four creator).
5. `improve/seat-prompt.ts:27` -> V3 catalog lookup.
6. `docs/fleet.md` "Packs".

## Findings while reading
- `skill-store.ts` `readFlat` ignores Agent Skills frontmatter in a flat `.md`, so every skill the
  provisioner installs migrates with a DOUBLE frontmatter and a description taken from a random `> `
  line of the body (probe: `brainstorming` migrated with description "Spec written and committed to
  `<path>`..."). Fixed here with a failing test first, because item 1's "visible to skills_list" is
  only honest when the description is the skill's own.
- `SkillProvisioner.plan` treats only the flat `<slug>.md` as present, so a reinstall after the store
  migrated it rewrites a stray flat file. Fixed alongside (canonical `<slug>/SKILL.md` counts as present).

## Log
- Item 0 (found while reading): `skill-store.test.ts` RED "migrates a flat markdown skill that carries
  Agent Skills frontmatter..." (description came from the body's `> ` line) -> `readFlat` parses the
  frontmatter; RED "reads a quoted frontmatter scalar without its quote marks" -> `unquote` in
  `parseFrontmatter`. `npx vitest run packages/trent-core/src/skills packages/trent-core/src/tools/skills` -> 27 passed.
- Item 1: `fleet/SkillProvisioner.test.ts` (6 tests) RED (no `CORE_SKILLS_DIR`, no `listSourceSkills`,
  no core dir) -> `CORE_SKILLS_DIR`, `DEFAULT_SKILL_SOURCE_DIRS` (app first), `createLayeredSkillSource`,
  `listSourceSkills`, `hasCanonicalSkill` (flat or `[<category>/]<slug>/SKILL.md` counts as present);
  first core skill `packages/trent-core/skills/quote-estimate/SKILL.md`. GREEN 6/6; RED for the
  categorised case re-proven by disabling the deeper check (1 failed) then restoring (6 passed).
- Items 2 and 3: `FleetPacks.test.ts` (+5 tests) RED -> `FleetPack.state` (required; grouping packs
  derive a truthful line from membership), `FleetPack.skills`, the three market packs, `PERSONA_LIMIT_CHARS`
  (1,800), `packPersona`, `personaPathFor`, `isFleetPackId`; personas in `fleet/pack-personas.ts`
  (The Counter Crew 1,655 chars; The Signal Crew 1,668; The Cutting Room 1,489). `FleetManager.test.ts`
  (+5 tests) RED -> `installPack` returns `{ pack, agents, skills, persona }`, provisions pack skills through
  `AgentInstaller.provisionSkills`, writes the persona with `brain.writeFile` (unchanged bytes are left alone,
  so a reinstall neither churns git nor moves the stable tier), `listPacks`, `isPackQuery`, `brain` option.
  `apps/cli` `fleet.test.ts` (+4 tests) RED -> `trent fleet packs`, pack-aware `fleet install` (exact pack id
  wins when no seat or specialist has that exact id; `--pack` still forces), dry-run reports members, skills
  and persona path and writes nothing. Registry invariant 637 passed.
- Item 4: thirteen skills under `packages/trent-core/skills/` plus two references
  (`quote-estimate/references/change-order-language.md`, `crosspost-adapt/references/platform-limits.md`).
  Demo in a scratch TRENT_HOME: `fleet packs`, `fleet install small-business` (persona written, committed),
  `skills list` shows the five with their own descriptions, `brain show system/persona-small-business.md`.
- Item 1 (second half): `SkillsHub.test.ts` (+2) RED -> `SkillsHub.install` falls back to the layered
  bundled sources (frontmatter metadata kept, `official` stays read-only) and `search` appends bundled
  matches after the built-in catalog; `trent skills search hook` and `trent skills install hook-lab` shown.
- Item 5: `improve/seat-prompt.test.ts` (3 tests) RED (`eng-code-reviewer`'s prompt exists only in the V3
  overrides and never reached the provider) -> `getCatalogAgentV3` at `seat-prompt.ts:27`. GREEN 3/3.
- Item 6: `docs/fleet.md` "Packs" rewritten (commands, grouping states, the three market packs table with
  honest states, personas, skill sources); `docs/skills.md` notes the flat-form frontmatter rule and the
  second source.

## Verification (2026-09-20, TRENT_QUEUE_FALLBACK=disabled)
- `npx vitest run packages/trent-core/src/fleet packages/trent-core/src/skills packages/trent-core/src/tools/skills
  packages/trent-core/src/improve packages/trent-core/src/fleet-memory apps/cli/src/commands/__tests__/fleet.test.ts
  apps/cli/src/commands/__tests__/skills.test.ts apps/cli/src/commands/__tests__/registry.test.ts
  packages/trent-core/src/wrapped-modules.test.ts` -> exit 1: 1201 passed, 1 failed:
  `wrapped-modules.test.ts` 500-line ceiling on `packages/trent-core/src/orchestrator/index.ts` (544 lines,
  another agent's in-flight `orchestrator.resume` work; `orchestrator/**` is outside U4).
- My suites alone (`fleet/`, `skills/`, `tools/skills`, `improve/seat-prompt.test.ts`, CLI `fleet.test.ts`,
  `skills.test.ts`) -> exit 0, 15 files, 122 tests.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0 (an earlier run failed on `config/defaults.ts`
  `media`, another agent's file, fixed by them before this run).
- `npm --prefix packages/trent-core run build` -> exit 2: six errors, all in `src/mcp-server/server.test.ts`
  and `src/mcp-server/stdio.test.ts` (U5's in-flight work); none in U4 files.
- `node scripts/ci/repo-scan.mjs` -> exit 0 (0 canned, 0 hex, 0 emoji).
- `git status --short apps/web` -> empty: nothing under apps/web changed.
- Not done: no `evals/evals.json` for the thirteen skills (the improve loop's suite discovery reads only
  `BUNDLED_SKILLS_DIR`, `improve/frozen-surface.ts:98`, which is `improve/**` and not U4's); the CLI bundle
  (`bun build`) resolves `packages/trent-core/skills` relative to the module like the app bundle already
  does, so the binary's resource layout is the same pre-existing question for both sources.
- Coordination note: at 01:34 U5 added `packages/trent-core/src/skills/frontmatter-nested.test.ts`
  (nested `metadata:` parsing in `parseFrontmatter`/`renderFrontmatter`), the same `skill-store.ts` U4
  edited (`unquote`, `readFlat` reading frontmatter). Both edits are on disk now; whoever lands second
  must keep the other's, and U5's quoted-description expectation is consistent with `unquote`.
