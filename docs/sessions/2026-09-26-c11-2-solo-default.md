# 2026-09-26 — C11.2: new profiles default to solo; the fleet stays as `--team`

The council's decision rule is met (02_plan/output/hermes-council-verdict-2026-09-26.md §7 item 4: "Flip new
profiles to solo when the 9B solo-format smoke scores 4/5 or better ... The fleet stays available as `--team`"):
C11 measured the 9B solo-format smoke at 4/5 (docs/local-models.md, "Solo on this machine"). §4 item 3: no
"164 specialists" in help or pitch. No commit, stash, checkout, reset or push. Parallel waves in the tree:
C13 (solo/turn.ts, repl/render.ts, tui/, gateway/agent-handler.ts; also edited docs/solo.md) and C16 (bench/**,
a `bench` group in commands/registry.ts and index.ts). My hunks in registry.ts and index.ts are kept to the
option beside `--solo` and the few lines the mode needs, each `// [C11.2]`.

## Read first
AGENTS.md; the rulebook's Universal Coding Rules and Phase 4; the council verdict §3 C11, §4, §7; docs/solo.md;
docs/sessions/2026-09-26-s2-solo-surfaces.md; commands/{registry,index,context}.ts, groups/diagnostics.ts
(setupSpec, runSetup), runtime/{runner-for-mode,child-run}.ts, groups/{run,cron}.ts (modeOverride callers);
setup/{SetupWizard,SetupRun,QuickSetup,FullSetup,BlankSlate,LocalModeSetup,steps,types}.ts;
config/{defaults,sections/agent,ConfigManager}.ts; README.md; docs-truth-pages.test.ts, docs-truth.test.ts;
docs/local-models.md "Solo on this machine"; the Hermes inventory rows 296-298 (local models).

## Decisions (before code)
- The default for a profile WITHOUT `agent.mode` stays `fleet` (`DEFAULT_AGENT_MODE`, `agentMode`); DEFAULT_CONFIG
  is untouched. What changes is what setup WRITES: a new profile (no `config.yaml` on disk when setup starts) gets
  `agent.mode: solo` explicitly, from one constant beside the old one, `NEW_PROFILE_AGENT_MODE`.
- An existing profile keeps its mode. Quick and blank-slate leave the key as it is (absent stays absent, so a
  pre-C11.2 profile stays on the fleet). Full asks (`agent_mode`, pre-filled with the profile's current runner, or
  solo on a new profile), so pressing enter through it on an existing profile lands where it was. Local mode is
  unchanged (L2: it writes solo on any profile unless the fleet is chosen), because one prompt prefix is its point.
- Choosing at setup: the launch flags. `trent setup --team` (or `--fleet`, which local mode already had) writes
  `fleet`; `trent setup --solo` writes `solo`. On every other command the same flags are the one-launch override.
- `--team` and `--fleet` are two global options, not one dual-long option: Commander's `--team, --fleet` form puts
  `--team` in `.short`, which `GLOBAL_LONG_FLAGS` and docs-truth-pages' bare-`trent` check read as `.long`, and it
  would rename setup's existing `opts.fleet` (setup-local.test.ts asserts it). Two options keep both working.
- `--solo` with `--team`/`--fleet` is a usage error (exit 2) in `defineCommand`'s action (every command) and on the
  bare-`trent` path; `modeOverride` refuses it too.
- A bare `trent --dry-run` opens nothing and writes nothing (today it opened the REPL, or ran first-run setup): it
  reports `{ dryRun, command: "trent", launch, mode, firstRun }`, the mode by the precedence (override, else the
  profile's `agent.mode`, else fleet; a first run reports what setup would write, solo).
- A pinned cron child under `--team` gets `--team` (it got `--solo` for solo; a fleet override was lost on a solo
  profile).

## Log
### Red 1: setup writes solo into a new profile (`packages/trent-core/src/setup/solo-default.test.ts`, new)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/setup/solo-default.test.ts` (load ~450) -> exit 1,
`Tests 8 failed | 4 passed (12)`. Each failure is the behaviour: `NEW_PROFILE_AGENT_MODE` `expected undefined to be 'solo'`;
quick, full (answered fleet, and `fleet: true`) and blank slate `expected undefined to be 'solo'|'fleet'` (no `agent.mode`
written); the first-run screen `expected [] to have a length of 1` (no mode lines); full `expected [...] to include
'agent_mode'` (no question). The four passes are guards that already hold and must keep holding: a config without
`agent.mode` resolves to the fleet; quick and full leave an existing profile on the fleet (nothing writes the key today);
local mode already writes solo, and fleet when chosen (L2).

### Red 2: `--team` / `--fleet`, the conflict, the bare dry run, help (`apps/cli/src/commands/__tests__/team-mode.test.ts`, new)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/commands/__tests__/team-mode.test.ts` -> exit 1, `Tests 12 failed (12)`:
`trent --team --json --dry-run` opened the REPL (`expected [ { profile: 'default', ... } ] to deeply equal []`: a bare
`--dry-run` opened the REPL today) and printed nothing (`Unexpected end of JSON input`); `trent --team` opened it with no
mode (`...(1)` vs `...(2)`), `result.mode` undefined; `trent run ... --team` exit 2 (unknown option); `--team` missing on
all 156 commands; `--solo --team` exit 0 (not 2); a first-run `trent --json --dry-run` exit 3 (it RAN quick setup,
which found no key); the help has no `--team` entry; `trent setup --team` exit 2.
### Red 3: a pinned cron child under `--team` (`apps/cli/src/runtime/child-run.test.ts`, one test added)
Same runner -> exit 1, `Tests 1 failed | 14 passed (15)`: the argv ended at `--no-color`, no `--team` (`...(6)` vs `...(7)`).

### Baseline (before any source edit; tests only, one file at a time)
Each file alone with `TRENT_QUEUE_FALLBACK=disabled npx vitest run <file>`, load 60-450: every one exit 0 (25 files):
`setup/{SetupWizard,business-quick-setup,local-mode,local-setup}.test.ts` (23, 2, 13, 18), `commands/__tests__/`
`registry` (777), `solo-mode` (6), `setup-keyless` (4), `setup-local` (5), `docs-truth` (11), `docs-truth-pages` (11),
`behaviour` (38), and the 14 files of `apps/cli/src/runtime` other than `child-run.test.ts` (all green, e.g.
`runner-for-mode` 14, `headless` 22, `runner-for-mode.constrained` 5).

### Green 1: setup (core)
`config/sections/agent.ts` `NEW_PROFILE_AGENT_MODE = "solo"` beside `DEFAULT_AGENT_MODE` (unchanged, `fleet`);
`ConfigManager.hasConfigFile()` (config.yaml on disk; `exists()` is also true for a `.env` alone, and quick setup can
write the key before its config); `setup/steps.ts` `chosenAgentMode`, `setupAgentMode`, `withAgentMode`,
`AGENT_MODE_LINES`, `AGENT_MODE_CHOICES`; `QuickSetup` (the mode read once, written with the config, the two lines
printed with the summary: this is the first-run screen), `FullSetup` (the `agent_mode` question after the model, skipped
when a flag chose), `BlankSlate`; `types.ts` (`fleet` for every mode, `solo`). `LocalModeSetup` is unchanged.
`solo-default.test.ts` -> exit 0, `Tests 12 passed (12)`. Then each alone, exit 0: `SetupWizard` 23, `business-quick-setup`
2, `local-mode` 13, `local-setup` 18, `config/agent-solo-schema` 4, `config/agent-schema` 3, `config/ConfigManager` 25.

### Green 2 and 3: the CLI
New `apps/cli/src/runtime/launch-mode.ts` (`launchModeOf`: the override, both named is `TrentError` USAGE; `bareLaunchPlan`;
the two help strings), read by `commands/registry.ts` (`--team` and `--fleet` in the global set beside `--solo`; one line in
`defineCommand`'s action refuses both before the command runs), `commands/index.ts` (the root options; `Globals.team`; the
bare path takes its mode from `launchModeOf`; a bare `--dry-run` prints the plan and returns), `runtime/runner-for-mode.ts`
(`modeOverride` delegates: one import, one body line; the [CF] wave's hunks in that file are theirs), `runtime/child-run.ts`
(`fleet` -> `--team`), `groups/diagnostics.ts` (setup's own `--fleet` removed: Commander refuses a command option whose flag
the global set also declares; `--team`/`--fleet` -> `fleet`, `--solo` -> `solo`, for every mode).
One test corrected before its green, recorded: the help assertion was `not.toMatch(/164|specialists/)`, which C6's truthful
`fleet` description ("the catalog specialists whose profiles and skills they read") fails; the brief and the council
(§4 item 3) strike the count, so it is now `not.toMatch(/\b164\b|\b173\b/)`. Its red had failed earlier, on the missing
`--team` entry. `team-mode.test.ts` -> exit 0, `Tests 12 passed (12)`; `child-run.test.ts` -> exit 0, `Tests 15 passed (15)`.

### Docs
README: the lead (a profile setup creates runs solo; the fleet is the optional team), "The first minute" (`trent run --team`:
the transcript's run was the fleet, so the command names it; a proof comment says the capture predates `--team`), the
"First run" intro (captured when a fresh profile ran the fleet), the "Agent shape" row without the 164 count, two new rows
("Solo mode", "Local model") each with its tests in the list under the table, "Where Trent is ahead" item 1 (the seats as
the optional team), `trent --team` in the command list. docs/solo.md "Turning it on" (what setup writes into a new and an
existing profile, `--team`/`--fleet`, the conflict, the bare dry run); docs/configuration.md "Agent mode";
docs/getting-started.md section 5. C13 edited docs/solo.md in parallel (its "Streaming" section); my edits there are the
"Turning it on" section only. Markers: every hunk of mine in an existing file carries `[C11.2]` (checked with
`git diff -U0` per file) except two README lines inside code fences, where no comment fits: the `trent run --team` line
of "The first minute" and the `trent --team` line of "Commands"; the proof comments beside both name `[C11.2]`.
The Hermes cells are from the inventory: lines 308 and 334-337 (one agent, subagents), 296 and 298 (local models).

### Verification (the brief's list; each file alone, `TRENT_QUEUE_FALLBACK=disabled npx vitest run <file>`)
- `packages/trent-core/src/setup`: all 5 files exit 0 (`solo-default` 12, `SetupWizard` 23, `business-quick-setup` 2,
  `local-mode` 13, `local-setup` 18); `config/{agent-solo-schema,agent-schema,ConfigManager}` exit 0 (4, 3, 25).
- `apps/cli/src/commands/__tests__`: `registry` 777, `solo-mode` 6, `team-mode` 12, `setup-keyless` 4, `setup-local` 5,
  `docs-truth` 11, `docs-truth-pages` 11 (re-run after the last README edit: exit 0), `behaviour` 38, `run-solo` 5,
  `cron-solo` 2, `protocol-solo` 2: every one exit 0.
- `apps/cli/src/runtime`: all 16 files exit 0 (`child-run` 15, `runner-for-mode` 14, the rest as in the baseline).
- Also exit 0: `repl/__tests__/degraded.test.ts` 21, `repl/__tests__/solo.repl.test.ts` 3.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0. `cd packages/trent-core && npm run build` -> exit 2 at first, 2
  errors, both in C16's untracked `src/bench/{hermes-runner,tools}.ts`; re-run after C16's fix -> exit 0.
  `node scripts/ci/repo-scan.mjs` -> exit 0. Anchored TODO/FIXME grep over the three new files -> exit 1 (0 matches).
  Every file touched is under 500 lines (largest: `runner-for-mode.ts` 408, `index.ts` 390, `ConfigManager.ts` 383).
- The real binary on a throwaway `TRENT_HOME`: `npx tsx apps/cli/src/index.ts --team --json --dry-run` -> exit 0,
  `{"dryRun": true, "command": "trent", "profile": "default", "launch": "repl", "mode": "fleet", "firstRun": true}`, and
  nothing written to the profile; `... --solo --team --no-color` -> exit 2, `error: cli.usage: --solo and --team (--fleet)
  name two runners; pick one for this launch`, nothing written. (One false alarm on the way, mine: a zsh loop over
  `$args` passed `"--solo --team"` as ONE argument, which is a bare first run, so setup wrote the profile; zsh does not
  split an unquoted variable. Run directly, neither command writes anything.)

## Not done here
- `apps/cli/src/ui/banner.ts:235`: the `fleet` banner variant's subtitle still reads "164 specialists, one conversation".
  No caller renders that variant today (only `installer` is rendered by name), so it is not on any screen; it is the
  last "164" string in `apps/cli/src` outside comments. Left for its owner: one line, with `ui/__tests__/banner.test.ts`.
- The TUI (`trent --tui`) still runs the fleet only; `--tui --solo` reports `mode: fleet` in the bare dry run.
- `runner-for-mode.ts`'s header still lists only `--solo` as the override; its `modeOverride` doc names `--team`. The
  file is under concurrent edit by the [CF] wave, so my hunk there is the two lines it needs.
- A profile whose `config.yaml` was written by something other than setup (`trent fleet install`, `trent config set
  model ...`, `trent doctor --fix`) before its first setup counts as existing: quick setup leaves it on the fleet.
