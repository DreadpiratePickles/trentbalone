# 2026-09-20 — W5: `fleet export --target hermes | codex`, the A2A card retagged by toolset

Wave-3 task W5 (design v2 section 4; research 1b, 1c, 3, 4). Branch `feature/trent-fleet-v2`,
HEAD 7243f91. Invariants held: nothing under `apps/web` changes; failing test first per renderer;
files under 500 lines; no canned strings, emoji or hex in output surfaces;
`TRENT_QUEUE_FALLBACK=disabled` in every shell; no live model; no `git add`/commit by this agent;
other agents' files (`tools/**`, `governance/**`, `improve/**`, `fleet-memory/**`, `mcp-server/**`,
`doctor/**`) untouched. `export-claude.ts` is also left as it is: the pieces the two new renderers
share with it live in a new `fleet/export-host.ts`, so the Claude renderer can adopt them in a
commit of its own.

## Specs read
- Hermes profile distributions: https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions
  (`distribution.yaml` with `name` required, `version description hermes_requires author license`,
  `env_requires[] {name, description, required, default}`; `SOUL.md config.yaml skills/ cron/
  mcp.json README.md .env.EXAMPLE`; `hermes profile install <git-url|dir>`, `hermes profile
  import <tar.gz> [--name]`; hard-excluded `auth.json .env memories/ sessions/ state.db* ...`).
- Hermes import-agent: https://hermes-agent.nousresearch.com/docs/user-guide/import-from-other-agents
  (`hermes import-agent [claude-code|codex] [--dry-run|--source|--overwrite|--yes|--sync]` maps
  instruction files to memory, permission rules, `mcpServers`/`[mcp_servers.*]`, skills; it does
  NOT read `.claude/agents/*.md` or `.codex/agents/*.toml`). So the Hermes target is the profile
  distribution, taken by `hermes profile install <dir>` and `hermes profile import <tar>`.
- The installed Hermes (v0.21.2, `~/.hermes/hermes-agent`, git) confirms the format from source:
  `hermes_cli/profile_distribution.py` (manifest fields above plus `distribution_owned[]`, a
  path allowlist; a local-directory source needs `distribution.yaml` at its root; symlinks are
  refused), `hermes_cli/profiles.py` (`import_profile`: the archive must hold exactly ONE
  top-level directory, which names the profile; names match `[a-z0-9][a-z0-9_-]{0,63}` and are
  never `hermes default test tmp root sudo`), `hermes_cli/archive_safe.py` (directories and
  regular files only), `hermes_cli/tools_config.py` (`platform_toolsets.cli` is the enabled
  list; a configured `mcp_servers.<name>` is enabled by default and its bare name passes through
  as an explicit toolset; `agent.disabled_toolsets` prunes last), `toolsets.py` (built-in ids:
  `file terminal web browser vision memory skills delegation cronjob code_execution clarify
  todo session_search ...`), `hermes_cli/agent_plugins.py` (`mcp.json` in the Agent Plugins
  shape: `$schema` https://agent-plugins.org/schemas/1.0.0/mcp.schema.json, `mcpServers.<name>
  {type: stdio, command, args, env, cwd}`).
- Codex custom agents: https://learn.chatgpt.com/docs/agent-configuration/subagents.md
  (`~/.codex/agents/*.toml` or `.codex/agents/*.toml`; required `name description
  developer_instructions`; optional `model model_reasoning_effort sandbox_mode approval_policy
  mcp_servers skills.config`; "Codex loads these files as configuration layers for spawned
  sessions"; caveat: "That can feel heavier than a dedicated agent manifest, and the format may
  evolve as authoring and sharing mature.").
- Codex config reference: https://learn.chatgpt.com/docs/config-file/config-reference
  (`[mcp_servers.<id>]` stdio: `command args env cwd enabled startup_timeout_sec
  tool_timeout_sec`; http: `url bearer_token_env_var`).
- AGENTS.md convention: https://agents.md/ (free-form Markdown, nearest file wins).

## Decisions
- Toolsets in `config.yaml`: the names Hermes shares with Trent pass through unchanged
  (`terminal web browser vision memory delegation skills`); the four Hermes spells differently
  are translated by a table that is data (`file_ops -> file`, `code -> code_execution`,
  `cron -> cronjob`, `human -> clarify`); the ones Hermes has no toolset for (`plugins mcp
  media`, and `business` / `social` as they land) ride on the `trent` MCP server only. `agent.disabled_toolsets` carries `denied`. The
  bare server name `trent` is listed explicitly so the seat's Trent tools are on even when the
  user narrows the list later.
- `env_requires` names the `trent connect` field env names of the providers a seat's toolsets
  execute against (`business`: Stripe, Google, Square, Twilio; `social`: Buffer, Meta, Bluesky),
  all `required: false`, with the description saying they live in the Trent profile's secrets
  (written by `trent connect <provider>`), never in this profile's `.env`. Trent does not read
  the Hermes profile's `.env` (`connect/store.ts` reads `loadSecrets()` only), so marking them
  required would be a lie. `TRENT_HOME` is the one optional variable the profile itself honours.
- Profile name `trent-<id>` (sanitised to Hermes's pattern): never a reserved name, never
  colliding with a user's own `engineer`.
- The tarball is written by a small ustar writer over `node:zlib` (no `tar` binary, byte-stable).
- Codex: `.codex/agents/<id>.toml` is a minimal emitter (basic strings, string arrays, a
  multi-line basic string for the instructions); `AGENTS.md` carries the approval rules and skills
  index; `[mcp_servers.trent]` is appended to the same TOML file since an agent file is a
  config layer. `@iarna/toml` (already in the lock as a `@daytona/sdk` dependency) parses the
  output in the test only.
- A2A card: `tags` = the seat's toolsets from `seatCapability`, so `a2a_orchestrate(capability)`
  can fan out by toolset name.

## RED, then GREEN
RED (02:06, `npx vitest run packages/trent-core/src/fleet/export-hermes.test.ts
packages/trent-core/src/fleet/export-codex.test.ts packages/trent-core/src/a2a/card.test.ts
apps/cli/src/commands/__tests__/fleet-export-hermes-codex.test.ts`): 4 files failed, 9 tests
failed, each for the right reason: `Cannot find module './export-hermes.js'`, `Cannot find
module './export-codex.js'`, the card's tags were `['executive', 'best-reasoning']` where the
seat's toolsets were expected, and the CLI answered `unknown --target "hermes"; one of trent,
claude` (exit 2).
GREEN: the four suites pass (9 + 7 + 3 + 6 tests); `fleet-export-claude.test.ts` now refuses
`--target grok` instead of `codex`, since codex is rendered.

## Files
New: `packages/trent-core/src/fleet/export-host.ts` (shared: members, persona, description,
approval rules split into preamble / seat gates / enforcement note, skills index, skill writer),
`export-hermes.ts` (+ `.test.ts`, `.live.test.ts`), `export-codex.ts` (+ `.test.ts`),
`targz.ts` (ustar over `node:zlib`), `a2a/card.test.ts`,
`apps/cli/src/commands/__tests__/fleet-export-hermes-codex.test.ts`.
Changed: `fleet/index.ts` (re-exports), `a2a/card.ts` (tags), `apps/cli/src/commands/groups/
fleet-versions.ts` (`--target hermes|codex`, the `profiles` field and render line),
`apps/cli/src/commands/__tests__/fleet-export-claude.test.ts` (the refused target),
`docs/fleet.md` ("Exporting to Hermes and Codex"), `docs/a2a.md` ("Tags are toolsets"),
`packages/trent-core/package.json` and `apps/cli/package.json` (`@iarna/toml` as a
devDependency, test-only; already in the lock through `@daytona/sdk`; `npm install
--package-lock-only` added the two workspace lines and nothing else).

## Live proof (Hermes v0.21.2 at ~/.local/bin/hermes; nothing installed)
`TRENT_TEST_LIVE=1 npx vitest run packages/trent-core/src/fleet/export-hermes.live.test.ts`
-> 1 passed (2.0 s): `hermes profile import <archive> --name trent-live-import-<stamp>` and
`hermes profile install <dir> --name trent-live-install-<stamp> --yes` both succeed, `hermes
profile list` shows both, `hermes profile info` reads back version `1.0.0` and `TRENT_HOME`,
the installed profile holds `SOUL.md`, `config.yaml`, `skills/repo-audit/SKILL.md` and no
`agent.json` (the `distribution_owned` allowlist held), both deleted in `afterAll`. A manual
`hermes profile install` of a CLI export plus `hermes -p <name> doctor` reported "No suspicious
MCP stdio commands" and no toolset warning; `hermes -p <name> config get mcp_servers` shows the
`trent` entry. Codex CLI 0.139.0 is installed too but has no offline agent-file check; the
TOML is proven by `@iarna/toml` parsing it in the tests.

## Verification
Working tree (other agents' uncommitted W2/W3/B1 files present):
- `npx vitest run packages/trent-core/src/fleet packages/trent-core/src/a2a apps/cli/src/commands/__tests__/fleet* apps/cli/src/commands/__tests__/registry.test.ts apps/cli/src/commands/__tests__/docs-truth.test.ts packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 1: 1086 passed, 4 failed, all in files this task does not touch (`improve/sweep.ts`
  and `tools/index.ts` over 500 lines; `seat-capabilities.test.ts` on the B1 `crm:read` mapping;
  docs-truth on the new `retrieval` config key and the doctor check count).
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 2: 5 errors, all in `improve/golden-store.ts`,
  `mcp-server/toolset-tools.ts`, `tools/index.ts` (the concurrent `social`/`business` enum work); 0 in this task's files.
- `npm --prefix packages/trent-core run build` -> exit 2: 9 errors, same origin; 0 in this task's files.
- `node scripts/ci/repo-scan.mjs` -> exit 0.
Isolated on a clean HEAD worktree with only this task's files (`TRENT_DEV_SCRATCH=/tmp/trent-dev-w5
zsh scripts/dev/isolate.sh <the same suites> -- <the files above>`): tsc exit 0, core build exit 0,
repo-scan exit 0, vitest 51 files / 1080 tests passed, ISOLATED rc=0.

## Not done
- `export-claude.ts` still carries its own copies of what `export-host.ts` now shares; pointing
  it at the shared module is a pure refactor for its own commit.
- No Codex live proof: `codex` exposes no offline validation of `.codex/agents/*.toml`.
- Trent-only toolsets (`plugins`, `mcp`, `media`, `business`, `social`) have no Hermes toolset and
  ride on the `trent` server only; the table says so rather than inventing a name.
