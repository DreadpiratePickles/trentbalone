# Portable agents: how each target harness defines an agent, and what a Trent Agent Package could be

Date: 2026-09-19. Primary sources only; every row carries a URL or a `file:line` in this repo.
Effort figures in section 5 are estimates in engineer-days for one adapter or one unit of work,
not measurements.

## 0. Summary of what the harnesses agree on

- Every target reads the **Agent Skills** format (`<skill>/SKILL.md` with `name` + `description`
  frontmatter, optional `scripts/ references/ assets/`): Claude Code, Codex, Hermes and Grok Build are
  all listed as clients on https://agentskills.io (home page client list; spec at
  https://agentskills.io/specification).
- Every target is an **MCP client** with a config table of stdio/HTTP servers. Only Hermes and Trent
  are **A2A servers**; only Hermes is an A2A client; Codex removed its MCP-server mode
  (https://learn.chatgpt.com/docs/mcp-server.md).
- Three targets have a **file-based agent definition** (Claude Code `.claude/agents/*.md`, Codex
  `.codex/agents/*.toml`, Grok Build `.grok/agents/` + native reading of `.claude/agents/`). Hermes
  has no per-agent file: an agent is a **profile directory** (SOUL.md + config.yaml + skills), and a
  **Profile Distribution** is its package format. Grok Bot (the consumer product) has **no public
  file format** at all: bots are created in the app and shared as template links.
- A new vendor-neutral package standard, **Agent Plugins 1.0.0** (`plugin.json` + `skills/` +
  `mcp.json`; TSC from Amazon, Cursor, Microsoft, OpenAI, Vercel), is what Codex's `plugin.json`
  points at (https://agent-plugins.org/, schema
  https://agent-plugins.org/schemas/1.0.0/plugin.schema.json). It packages skills and MCP servers,
  **not** agent prompts, models, budgets or memory.

## 1. Per-target agent-definition surface

### 1a. Claude Code and the Claude Agent SDK

Source: https://code.claude.com/docs/en/sub-agents (file format, fields, limits),
https://code.claude.com/docs/en/agent-sdk/subagents (SDK `AgentDefinition`),
https://code.claude.com/docs/en/skills, https://code.claude.com/docs/en/plugins.

| Concern | Where it lives | Notes |
|---|---|---|
| Definition file | `.claude/agents/<name>.md` (project), `~/.claude/agents/` (user), plugin `agents/`, managed settings, `--agents` JSON flag; precedence managed > CLI > project > user > plugin | Markdown, YAML frontmatter; body is the system prompt |
| Required fields | `name` (lowercase-hyphen), `description` | |
| Prompt | Markdown body; SDK `prompt` string | |
| Tools | `tools` (allowlist), `disallowedTools`; MCP tools inherited from the main session; `mcp__server` / `mcp__*` patterns to deny; `mcpServers` list by name or inline config | Built-in tool names (`Read`, `Bash`, ...) are Claude Code's, not portable |
| Skills | `skills: [names]` preloads; unlisted skills stay invocable via the Skill tool | Skill = `SKILL.md`; spec fields `name description license compatibility metadata allowed-tools`; Claude adds `disable-model-invocation user-invocable when_to_use argument-hint arguments disallowed-tools model effort context agent background hooks paths shell` |
| Memory | `memory: user|project|local` gives the subagent a persistent directory; auto memory of the main session is NOT loaded | Free-form files, not typed blocks |
| Model | `model: sonnet|opus|haiku|fable|<id>|inherit`; `effort: low..max` | |
| Guardrails | `permissionMode`, `maxTurns`, `hooks`, `omitClaudeMd`, `isolation: worktree` | No per-agent spend cap in the file; SDK has `maxBudgetUsd` per query and env caps `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (3), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (20) |
| Packaging | Plugin: `.claude-plugin/plugin.json` + `agents/ skills/ hooks/hooks.json .mcp.json settings.json`; marketplaces (`claude plugin marketplace add owner/repo`); `--plugin-dir`, `--plugin-url <zip>` | Plugin `settings.json` `agent` key makes one agent the main thread |
| Remote agent instead? | No A2A client. A remote agent is reachable only as an MCP tool (`.mcp.json` / `mcpServers`), or the SDK wraps it | |
| Import command | None inbound. `claude plugin init`, `claude plugin validate` | |
| Limits | Combined descriptions >15k tokens warn; nesting 3; concurrency 20 | |

SDK `AgentDefinition` fields: `description prompt tools disallowedTools model skills memory
mcpServers initialPrompt maxTurns background omitClaudeMd effort permissionMode`; programmatic agents
override same-named filesystem agents.

### 1b. OpenAI Codex CLI and the ChatGPT desktop app

Source: https://learn.chatgpt.com/docs/agent-configuration/subagents.md (custom agents),
https://learn.chatgpt.com/docs/config-file/config-reference (config keys),
https://learn.chatgpt.com/docs/build-skills (skills), https://learn.chatgpt.com/docs/build-plugins.md,
https://learn.chatgpt.com/docs/import.md, https://learn.chatgpt.com/docs/mcp-server.md,
https://agents.md/ (AGENTS.md convention).

| Concern | Where it lives | Notes |
|---|---|---|
| Definition file | `~/.codex/agents/<x>.toml` (personal) or `.codex/agents/<x>.toml` (project); one agent per file; the file is a **config layer** for the spawned session | Docs: "That can feel heavier than a dedicated agent manifest, and the format may evolve" |
| Required fields | `name`, `description`, `developer_instructions` | `name` is the identity, not the filename |
| Prompt | `developer_instructions` | Project guidance is `AGENTS.md` (free-form Markdown, nested, closest wins) |
| Tools | No allowlist field; inherits parent sandbox/approvals; may set `sandbox_mode`, `mcp_servers`, `skills.config` in the file | Tool surface = sandbox + MCP servers |
| Skills | `.agents/skills/` (repo, walked to root), `~/.agents/skills/`, `/etc/codex/skills`; `SKILL.md` with `name` + `description`; optional `agents/openai.yaml` for display and `allow_implicit_invocation` | Invoked with `$skill` (CLI) or `@skill` (ChatGPT) |
| Memory | `memories/*.md` (Codex memories feature); no per-agent memory field | |
| Model | `model`, `model_reasoning_effort` in the file; `[agents].default_subagent_model`, `default_subagent_reasoning_effort` | |
| Guardrails | `approval_policy`, `sandbox_mode`, `[hooks]`, `agents.max_concurrent_threads_per_session` | No per-agent budget |
| Packaging | Agent Plugins package: `plugin.json` (`$schema` agent-plugins.org 1.0.0) + `skills/`; Codex adds `.codex-plugin/plugin.json`; plugins may bundle an MCP server; local marketplaces; universal directory shared with ChatGPT | Plugins carry skills + MCP, not custom-agent TOML |
| Remote agent instead? | MCP client only (`[mcp_servers.<id>]`, stdio or HTTP with `bearer_token_env_var`). `codex mcp-server` was **removed**; the replacement "app server" uses its own JSON-RPC, "isn't an MCP server", and is experimental | No A2A |
| Import command | `/import` in the CLI (from Claude Code or Cursor) and Settings > Import in the app (also Claude Cowork). Maps instruction files to `AGENTS.md`, `settings.json` to `config.toml`, skills, plugins, MCP config, hooks, slash commands to skills, **subagents to Codex subagents**, Claude project memories to Codex memories; up to 50 chats/30 days | Trent is not a source it recognises |
| Limits | Custom-agent format explicitly unstable; subagents inherit the parent's live runtime overrides even when the file sets different defaults | |

### 1c. Nous Hermes Agent

Source: https://hermes-agent.nousresearch.com/docs/user-guide/profiles,
https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions,
https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode,
https://hermes-agent.nousresearch.com/docs/user-guide/import-from-other-agents,
https://hermes-agent.nousresearch.com/docs/user-guide/features/skills,
https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins,
https://hermes-agent.nousresearch.com/docs/user-guide/messaging/a2a; repo inventory
`01_discovery/output/hermes-feature-inventory-2026-09.md:45,143,263,360,374`.

| Concern | Where it lives | Notes |
|---|---|---|
| Definition | A **profile**: `~/.hermes/profiles/<name>/` holding `config.yaml` (model, provider, toolsets, all settings), `SOUL.md` (personality / system prompt), `.env`, `memories/MEMORY.md`, `memories/USER.md`, `skills/`, cron, `state.db` | "a Bot **is** a Hermes profile" (bot-mode) |
| Package format | **Profile Distribution**: `distribution.yaml` (`name` required; `version description hermes_requires author license env_requires[]`), `SOUL.md`, `config.yaml`, `skills/`, `cron/`, `mcp.json`, `README.md`; `hermes profile install github.com/you/x`, `hermes profile update`, `/export`, `/import x.tar.gz`; `hermes profile export/import` strips API keys | Hard-excluded: `auth.json .env memories/ sessions/ state.db* logs/ workspace/ ...` (memory never ships) |
| Prompt | `SOUL.md`; project context from `.hermes.md`, `AGENTS.md`, `CLAUDE.md` | |
| Tools | `config.yaml` toolsets; tool names `mcp__<server>__<tool>`; plugins register tools via `ctx.register_tool(name, toolset, schema, handler)` in Python | Hermes toolset names are the ones Trent mirrors (`packages/trent-core/src/tools/tool-names.ts:8-33`) |
| Skills | `~/.hermes/skills/<category>/<name>/SKILL.md`, project `.hermes/skills/` or `.agents/skills/`; spec fields plus `version`, `platforms`, `metadata.hermes.{tags,category,fallback_for_toolsets,requires_toolsets,config[]}`; hub sources `official skills-sh well-known github clawhub lobehub browse-sh url`; taps `hermes skills tap add owner/repo` (repo layout `skills/<name>/SKILL.md`); security scanner on install | `skill_manage` tool, `skills.write_approval` |
| Memory | `memories/MEMORY.md`, `USER.md`; external memory-provider plugins | Not exported by distributions |
| Model | `config.yaml` `model.default`; per-subagent/cron pins via `delegation.{provider,model}` (inventory:294) | |
| Guardrails | approval allowlist/denylist, `tool_loop_guardrails` caps (inventory:185); no per-profile spend cap documented | |
| Bot Mode | Profiles become bots with avatar/roster; `agent.bot_mode_protocol: true` injects bot-to-bot protocol; `message_agent(target, message)` | UI layer over profiles, no extra file |
| Plugin packs | `hermes-pack.yaml`, every entry `ref` an exact 40-char SHA; `hermes plugins pack install ./hermes-pack.yaml` | Pins plugins, not agents |
| Trajectories | ShareGPT JSONL via `run_agent.py --save_trajectories`; no `hermes` CLI flag (inventory:263,485) | Training data, not a definition |
| Remote agent instead? | **Yes, both directions**: A2A server at `/.well-known/agent-card.json` (skills derived from enabled toolsets) and A2A client tools `a2a_discover(url)`, `a2a_call(agent, message, context_id?)`, `a2a_orchestrate(capability, message, mode?)`, peers in `config.yaml` `a2a_agents`; also ACP server (`hermes acp`) and MCP client | |
| Import command | `hermes import-agent [claude-code|codex] [--dry-run|--source|--overwrite|--yes|--sync]`: `CLAUDE.md`/`AGENTS.md` to memory entries, `permissions.allow/deny` to allow/deny lists, `mcpServers`/`[mcp_servers.*]` to config, skills to `skills/claude-code-imports/` or `codex-imports/`, Codex `memories/*.md` merged; credentials never read, secret-looking env stripped; slash commands skipped; `--sync` skips unchanged sources by digest | **Does not import `.claude/agents/*.md` subagent files or Codex agent TOML** (not in the mapped list) |

### 1d. xAI Grok: Grok Build (CLI), Grok Bot (app), and the API

Source: https://docs.x.ai/build/overview.md, https://docs.x.ai/build/features/subagents.md,
https://docs.x.ai/build/features/skills-plugins-marketplaces.md, https://docs.x.ai/build/settings/reference.md,
https://docs.x.ai/build/cli/reference.md, https://docs.x.ai/build/cli/headless-scripting.md,
https://docs.x.ai/grok-bot/bots.md, https://docs.x.ai/grok-bot/skills-routines-and-automations.md,
https://docs.x.ai/developers/tools/remote-mcp.md, https://docs.x.ai/developers/model-capabilities/text/multi-agent.md.

**Grok Build** (terminal coding agent, `~/.grok/config.toml`):

| Concern | Where it lives | Notes |
|---|---|---|
| Definition file | "Add or override types under `.grok/agents/` or `~/.grok/agents/`"; `/config-agents` (alias `/agents`); env `GROK_AGENT` = "Built-in agent name, profile, or absolute path to an agent definition" | The docs do not publish the `.grok/agents/` schema; the subagents page is 15 lines |
| Claude compatibility | "Grok automatically reads Claude Code marketplaces, plugins, skills, MCPs, agents, hooks, and instruction files (`CLAUDE.md` ... `.claude/rules/`)"; `[compat.claude]` `skills rules agents mcps hooks` toggles; also Cursor agents; `/import-claude` modal | So `.claude/agents/*.md` IS the de facto Grok Build agent format |
| Personas | `[subagents.personas]` or `.grok/personas/*.toml`; "behavioral overlays only (tone, focus, contracts)" | |
| Built-in types | `general-purpose`, `explore`, `plan`; `[subagents.toggle]`, `[subagents.models]` per-type model routing; `GROK_SUBAGENTS` default `0` | |
| Skills | `./.grok/skills/`, `~/.grok/skills/`, plugin `skills/`, `[skills] paths`; reads `~/.agents/skills/`; fields `name description when-to-use paths allowed-tools argument-hint user-invocable disable-model-invocation metadata`; "`allowed-tools` does not grant or restrict tools"; accepts `model effort license compatibility` "and does not apply them" | |
| Plugins | `./.grok/plugins/`, `~/.grok/plugins/`, `[[marketplace.sources]]`, `--plugin-dir`; "additional skills, agents, hooks, MCP servers, and LSP servers" | Claude plugin layout is read as-is |
| MCP | `[mcp_servers.<name>]` with `command args env url headers bearer_token_env_var`; project config may only contribute `[mcp_servers] [plugins] [permission]` | |
| Memory | `[memory].enabled` (default off), `/remember` | No per-agent memory |
| Remote agent instead? | ACP server: `grok agent stdio`. MCP client. No A2A | |

**Grok Bot** (consumer/enterprise app): a Bot is "a durable AI teammate with a name, a job, its own
conversation, and working context"; created in the UI (**New > Create new Bot**, then name, label,
description, avatar); duplicated with "profile, settings, enabled skills, routines, and avatar" but not
memory; shared as a **template link** (public or team-only) that a recipient adds via **Add to Grok
Bot**. Skills are saved by asking the bot, invoked with `/`, installed from **Marketplace**; routines
are schedules or event triggers. **There is no public file-based agent-definition or export format
documented for Grok Bot** (https://docs.x.ai/grok-bot/bots.md, .../skills-routines-and-automations.md).
Note: those two pages reference "Cursor terms" and "Cursor account integrations" verbatim; treat the
Grok Bot docs as in flux.

**xAI API**: OpenAI-compatible `https://api.x.ai/v1`; server-side tools (`web_search`, `x_search`,
code execution, collections search); **Remote MCP tools** (`server_url`, `server_label`,
`allowed_tools`, `authorization`, `headers`; Streamable HTTP/SSE only; `require_approval` not
supported); a beta `grok-4.20-multi-agent` model that orchestrates internal research agents. No
persisted agent object, no agent-definition endpoint.

### 1e. Cross-harness formats

| Format | What it carries | Who reads it |
|---|---|---|
| Agent Skills (https://agentskills.io/specification) | `SKILL.md`: `name` (1-64, lowercase/digits/hyphen, must equal dir name), `description` (1-1024), optional `license`, `compatibility` (<=500), `metadata` (string map), `allowed-tools` (experimental); `scripts/ references/ assets/`; SKILL.md <500 lines recommended; validator `skills-ref validate` | All four targets and Trent |
| Agent Plugins 1.0.0 (https://agent-plugins.org/) | `plugin.json` (`$schema`, `name` required; `version description author homepage repository license keywords extensions{reverse-domain}`), `skills/`, `mcp.json` (stdio, Streamable HTTP, legacy SSE), client namespaces `com.example.client/hooks/` | Codex/ChatGPT natively; Claude's `.claude-plugin/plugin.json` and Grok's plugin loader are the same shape but not declared conformant |
| AGENTS.md (https://agents.md/) | Free-form Markdown, no schema, nested closest-wins | Codex, Grok Build, Hermes (context file), Cursor, Copilot, others |
| MCP server config | Claude `.mcp.json`/`mcpServers`; Codex `[mcp_servers.*]`; Hermes `mcp.json` / `mcp_servers`; Grok `[mcp_servers.*]`; Trent `mcp_servers` (`docs/mcp.md:7-16`) | All; key spellings differ (Codex ignores `mcpServers` silently) |
| A2A Agent Card (https://a2a-protocol.org/latest/specification/) | `/.well-known/agent-card.json`: name, url, skills, capabilities, securitySchemes | Served by Trent (`packages/trent-core/src/a2a/card.ts:55-85`) and Hermes; consumed by Hermes only |
| ACP (https://agentclientprotocol.com/) | stdio JSON-RPC for editors | Served by Trent (`docs/a2a.md:100-130`), Hermes, Grok Build |

## 2. How Trent defines an agent today

| Concept | Where | Shape |
|---|---|---|
| Seat roster | `packages/trent-core/src/fleet/AgentInstaller.ts:79-165` | `CORE_ROLES`: `name emoji category color modelPolicy description budgetCapCents? skills?`; nine seats read from `apps/web/lib/agents.ts` |
| Installed record | `AgentInstaller.ts:15-33`, written to `<agentsDir>/<id>.json` (`:301-313`) | `id name emoji category color modelPolicy installed_at active tools[] skills[] installed_skills[] budget_cap_per_run_cents` |
| Capabilities (the things that make a seat a seat) | `packages/trent-core/src/fleet/seat-capabilities.ts:83-104` | `toolsets denied unavailable approvalGates budgetCents modelTier evalSuiteId`, derived from `SLOT_ENVIRONMENTS` (`apps/web/lib/agent-catalog.ts:1980-1997`) and `SEAT_MANIFESTS` (`apps/web/lib/seat-manifest.ts:39`) |
| Prompt | injected provider: app seat prompt + specialist prompt + promoted GEPA proposal (`packages/trent-core/src/fleet/agent-definition.ts:4-7,68`) | Not a file in the profile |
| Definition snapshot | `AgentDefinition` = `prompt model{provider,model} toolsets[] skills[{slug,content}]` (`agent-definition.ts:67-72`) | Hashed per `AgentVersions.ts:58-61` |
| Versions | `AgentVersions.ts:46-55`: `createCandidate promote rollback liveVersion list`; only `"human"` promotes (`:80-82`); runs pin the live version (`docs/fleet.md:251-256`) | |
| Export/import | `packages/trent-core/src/fleet/export.ts:1-14,25-43`: `agent.json` schema `trent.agent/1` (`agentId version promptHash skillsHash model toolsets prompt skills[]`) + `skills/<slug>/SKILL.md`; import runs `SecurityScan` on prompt and every skill, files a NEW candidate, never live (`:146-160`) | CLI `fleet export|import` (`docs/fleet.md:260-278`); drops `scripts/` and `tools/` (`01_discovery/output/harness-parity-audit-2026-09-18.md:297`, `docs/skills.md:228-233`) |
| Skill store | `packages/trent-core/src/skills/skill-store.ts:4-8,44-49,53-82` | `<skills>/[<category>/]<name>/SKILL.md`, frontmatter `name description category trust version author tags status created_by promoted_at quarantine_reason`; `references/ scripts/ assets/`; frontmatter parser is flat `key: value` only (`:125-135`), so nested `metadata:` maps are not parsed |
| Tool names | `packages/trent-core/src/tools/tool-names.ts:9-33` | Hermes toolset names (`file_ops terminal web memory skills cron code_execution delegation plugins browser vision mcp human tools todo clarify session_search`) |
| Approval floors | `packages/trent-core/src/tools/approval-floors.ts:1-18`; seat gates in `seat-capabilities.ts:93` | Absolute floors never relaxed per seat (`docs/fleet.md:109-114`) |
| Budget | integer cents per seat per run, enforced by the seat-guard purse (`docs/fleet.md:116-129`) | |
| Model tier | `haiku|sonnet|opus` per seat mapped through config (`docs/fleet.md:132-149`) | |
| Memory / brain | `memory.blocks[]` migrated into `brain/system/*.md`, git-versioned (`docs/brain.md:113-127`) | Per-profile, not per-seat |
| Verifier / evals | `evalSuiteId` = seat id, goldens only (`docs/fleet.md:156-161`) | |
| A2A card | `packages/trent-core/src/a2a/card.ts:43-52`: one A2A skill per seat, tags `[category, modelPolicy]`, text only | Served by `trent a2a serve` (`apps/cli/src/commands/groups/protocol-commands.ts:20-35`) |
| MCP server mode | **Does not exist.** `trent serve` is a retired shim (`apps/cli/src/commands/groups/maintenance.ts:73-89`); Trent is an MCP client only (`packages/trent-core/src/tools/mcp/index.ts:2`) | |
| Packs | `packages/trent-core/src/fleet/FleetPacks.ts:15-80`: named lists of agent ids | Not a package format |

## 3. Matrix: Trent concept versus what each harness carries

Legend: **N** native field; **D** degrades (carried as prose, or approximated); **X** not carried.

| Trent concept | Claude Code / SDK | Codex CLI/app | Hermes | Grok Build | Grok Bot |
|---|---|---|---|---|---|
| Seat prompt | N: agent `.md` body / `prompt` | N: `developer_instructions` | N: profile `SOUL.md` | N: via `.claude/agents` compat or `.grok/agents/` | D: bot description typed in UI |
| Toolsets (Hermes names) | D: map to `tools:` allowlist of Claude tool names (`Read Bash WebFetch...`); `browser`, `human`, `delegation` have no 1:1 | D: no allowlist; `sandbox_mode` read-only vs write only | N: `config.yaml` toolsets use the same names | D: `[permission]` allow/deny rules; no per-agent tools field documented | X |
| Denied toolsets | N: `disallowedTools` | D: `sandbox_mode = "read-only"` | N: toolset disable | D: deny rules (global) | X |
| Skills | N: `skills: [..]` + `SKILL.md` dirs | N: `.agents/skills/` | N: `skills/` in distribution | N: `.grok/skills/` or `.claude/skills/` | D: saved by prompt / marketplace plugin |
| Skill trust/status/provenance frontmatter | D: extra keys pass through `metadata` only if nested; Claude rejects unknown top-level keys when packaging for claude.ai | D: unknown keys ignored | D: `metadata.hermes` namespace exists; Trent's flat keys are not Hermes's | D: "Extra keys are ignored" | X |
| Memory blocks / brain | D: `memory: project` dir, free-form; brain files copied as plain files | D: `memories/*.md` | X: distributions hard-exclude `memories/` | D: `[memory]` global, off by default | X (bot memory is learned in-app, not importable) |
| Approval floors + seat gates | D: `permissionMode` + hooks + `settings.json` `permissions.deny`; floors are Trent semantics | D: `approval_policy`, `[hooks]`, rules | D: approval allow/deny lists (import-agent maps these) | D: `[permission]` rules | D: "requires approval" written into description |
| Budget (cents per run) | D: SDK `maxBudgetUsd` per query, not per agent; CLI none | X | X (loop caps, not spend) | X | X |
| Model tier | N: `model: haiku|sonnet|opus` aliases | N: `model` + `model_reasoning_effort` (OpenAI ids) | N: `model.default`, per-delegation pins | N: `[subagents.models]`, `[models]` | D: model picker per bot in UI |
| Verifier suite / goldens | X (plugin evals exist as `claude plugin eval` but are prompt sets, not Trent goldens) | X | X | X | X |
| Version pin / promote / rollback | X (plugin `version` only) | X | D: distribution `version` | X | X |
| Delegation between seats | D: `Agent(worker, researcher)` restricts spawnable subagents | D: spawn by name | N: `message_agent`, `delegate_task`, A2A | D: task tool | N: `@` mentions between bots |
| Call Trent remotely instead of copying | via MCP only (Trent has no MCP server) | via MCP only | **A2A client can call `trent a2a serve` today** | via MCP only | via Remote MCP tools (API) or connectors |

Three biggest gaps: (1) **budget** is native nowhere; (2) **memory/brain** never travels (Hermes
hard-excludes it, Claude/Codex accept only free-form files); (3) **verifier suite, versions and
promotion** exist only in Trent.

## 4. Three candidate designs for a Trent Agent Package

### (i) Export to each harness's native format

Emit, per seat: `SKILL.md` dirs (already produced by `fleet export`), plus a per-harness agent file
and config snippet: `.claude/agents/<seat>.md` (+ `.mcp.json`), `.codex/agents/<seat>.toml` (+
`AGENTS.md`, `[mcp_servers]`), a Hermes Profile Distribution (`distribution.yaml SOUL.md config.yaml
skills/ mcp.json`), and for Grok Build the Claude layout (read natively). Grok Bot: no target.

- Per unit cost: one adapter each. Claude ~2 days (prompt + tools map + skills list + model alias +
  `.mcp.json`); Codex ~2 days (TOML layer, `developer_instructions`, model id map, `AGENTS.md` from
  the seat's gates); Hermes ~3 days (distribution manifest, `config.yaml` toolsets 1:1, SOUL.md,
  env_requires, tar); Grok Build 0 extra (Claude output); plus ~1 day for a toolset-to-tool-name
  table and ~1 day for `metadata`-nested skill frontmatter so Trent's `trust/status/created_by` survive
  as `metadata.trent.*` (requires changing `skill-store.ts:125-135` to parse nested maps).
- Lost: budget (all), approval floors (become prose or host permission rules), brain/memory (Hermes),
  eval suite, version pins; the prompt is frozen at export and the GEPA-promoted prompt drifts
  (`agent-definition.ts:4-7`). Four formats to keep in step as they change (Codex says its format
  "may evolve").

### (ii) Trent as a remote agent: MCP server and/or A2A server that the host harness calls

Agents stay in Trent with their budget, floors, brain, versions and evals. The host harness gets one
entry: an MCP server (`trent mcp serve`, to be built) exposing one tool per seat, or the existing A2A
card (`trent a2a serve`). Claude Code: `.mcp.json` entry; Codex: `[mcp_servers.trent]`; Grok Build:
`[mcp_servers.trent]` or xAI Remote MCP tools with `server_url`; Hermes: `a2a_agents` peer today, no
new code.

- Per unit cost: MCP server mode ~4 days (stdio + Streamable HTTP, one `run_seat` tool per seat
  reusing the A2A runner in `protocol-commands.ts:32-35`, `input-required` mapped to a tool result
  the host relays, redaction as in `docs/mcp.md:80-88`); per host ~0.5 day (a config snippet and a
  doc page); Hermes 0.
- Lost: the host's own tools are not available inside the Trent run (the seat uses Trent's sandbox,
  as ACP already does, `docs/a2a.md:120-128`); the agent is not "in" the host's roster (no
  `@seat` mention in Claude, no `spawn` by name in Codex); requires a running Trent process; offline
  use impossible; latency of a second agent loop.

### (iii) Common package: Agent Skills + one manifest, per-harness adapters

Define `trent-agent/2` as an Agent Plugins 1.0.0 directory (`plugin.json` with
`extensions["ai.trent.agent"]` carrying `prompt model.tier toolsets denied approvalGates budgetCents
evalSuiteId version hashes brainFiles[]`), `skills/` per the spec, `mcp.json` for the seat's MCP
servers, and `brain/` as plain files. Adapters render that one directory into (i)'s outputs on
`trent fleet export --target claude|codex|hermes|grok`, and `fleet import` reads either the package
or a foreign agent file (Claude `.md`, Codex `.toml`, Hermes distribution).

- Per unit cost: manifest + validator ~2 days (extend `export.ts:33-43`); the same four render
  adapters as (i) (~7 days total) but each is a pure function over one struct; inbound importers
  ~1 day each for Claude and Codex, ~2 for Hermes; nested-frontmatter parser ~1 day.
- Lost: at the host, exactly what (i) loses (the host still cannot enforce budget or evals); but
  the package itself carries everything, so a round trip through a host returns to Trent lossless
  and a Grok Bot user at least has a description and skills to paste. The `extensions` block is
  opaque to other clients by design (schema: "Agent Plugins assigns no semantics").

## 5. What the repo already has, and what is missing

Have:
- A versioned, hashed, human-promoted definition (`AgentVersions.ts`), an export/import bundle with
  a security scan (`export.ts`), and a CLI (`docs/fleet.md:232-278`).
- Skills already in Agent Skills layout with `references/ scripts/ assets/` (`skill-store.ts:4-5,43`).
- An A2A server with one skill per seat and a truthful card (`card.ts`, `docs/a2a.md:16-52`), ACP
  stdio (`docs/a2a.md:100-118`), and an MCP client with redaction and scanning (`docs/mcp.md`).
- The seat capability record that a manifest would serialise (`seat-capabilities.ts:83-104`).
- Hermes-compatible toolset names (`tool-names.ts:9-33`), so the Hermes adapter is near 1:1.

Missing:
- No MCP **server** mode (`maintenance.ts:73-89` retires `trent serve`; nothing replaces it for MCP).
- `agent.json` carries neither approval gates, budget, model tier, eval suite id, nor brain files
  (`export.ts:33-43` versus `seat-capabilities.ts:83-104`).
- Export drops skill `scripts/` (`harness-parity-audit-2026-09-18.md:297`) and `tools/`
  (`docs/skills.md:232-233`); the frontmatter parser cannot read nested `metadata:`
  (`skill-store.ts:125-135`), which both the spec and Hermes use.
- No importer for `.claude/agents/*.md`, Codex agent TOML, or a Hermes distribution
  (`harness-parity-audit-2026-09-18.md:297`: zero hits for "claude.code" under `skills/`).
- No `AGENTS.md` / `CLAUDE.md` emitter for a seat's gates and floors.
- The A2A card's `tags` are `[category, modelPolicy]` (`card.ts:48`); Hermes's `a2a_orchestrate`
  fans out by advertised capability, so tagging seats by toolset would make Trent seats
  discoverable by capability there.

## 6. Recommendation

Do (ii) first, then (iii); treat (i) as (iii)'s render step, never as its own format.

Reasons:
1. The concepts that make a seat a seat (budget purse, absolute floors, evals, pinned versions,
   brain) are enforceable **only where Trent runs** (`docs/fleet.md:62-161`). Any copy-out design
   silently drops them; a remote-call design keeps them. Hermes can call Trent over A2A today with
   zero new code, and every other target is an MCP client, so one `trent mcp serve` (~4 days)
   reaches Claude Code, Codex, Grok Build and the xAI API at once.
2. Skills are already portable and already exported; the only package-level work that adds
   durable value is the manifest (iii), and Agent Plugins 1.0.0 is the emerging neutral container
   with OpenAI on its TSC and Codex already emitting its `plugin.json`. Putting Trent's fields in
   an `extensions` namespace keeps the package valid for every client that ignores them.
3. Native adapters (i) are cheap once (iii) exists (pure renderers) and expensive alone (four
   formats, one of which OpenAI says may change). Ship Claude first because Grok Build reads it
   natively (two hosts for one adapter), then Hermes (toolset names match), then Codex.
4. Grok Bot has no file surface; the only paths in are a Remote MCP tool pointing at Trent (ii)
   or a human pasting the description and skills, so (ii) is the sole design that reaches it.

Order of work: `trent mcp serve` (reuse the A2A runner) -> extend `agent.json` to the full seat
record and nested-metadata skills -> `fleet export --target claude|hermes|codex` renderers ->
inbound importers -> retag the A2A card by toolset.

## 7. Sources not reached

- https://learn.chatgpt.com/docs/config (404) and `/docs/config-reference` (404); the
  `config-file/config-reference` page was reachable and is cited instead.
- https://docs.x.ai/build/skills-plugins (404); the `features/skills-plugins-marketplaces.md` page
  is the live one.
- https://hermes-agent.nousresearch.com/docs/user-guide/features/agents (404; no such page).
  The `.md` suffix form of Hermes pages 404s; HTML pages were read.
- The schema of Grok Build's `.grok/agents/` files is not published on any page indexed in
  https://docs.x.ai/llms.txt; only the directory and the Claude-compat statement are documented.
- https://github.com/openai/codex/blob/main/docs/config.md now only links to the hosted docs.
