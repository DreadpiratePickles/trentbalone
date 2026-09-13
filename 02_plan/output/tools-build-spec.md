# Tools build spec — every Hermes tool for Trent's seats

Full research report is the agent output; this is the decision record and the dependency order.

## The fork, decided
Trent's `ToolAdapter` registry is a module constant built at import with no `register()` and no
env-driven loader. The only injection path in production is the MCP bridge, which has five defects for
this purpose: it returns nothing without DATABASE_URL, the router computes tool guidance BEFORE the
merge so injected names reach the seat only when the router ranks nothing, every result is cut at
800 characters, it reconnects per call with a 30s timeout, and the API validator blocks loopback.
`read_file` cannot be built on an 800-character cap. Hermes returns 100K.

**Decision: add a ~15-line additive seam in `apps/web/lib/tools.ts` + `semantic-router.ts`** —
`registerExternalAdapters(list)` that appends to the adapters array and resets the router catalog,
plus an env loader `TRENT_TOOL_ADAPTERS_MODULE` consulted by `buildAdapterRegistry`. Own commit, own
test, nothing else in apps/web touched. The read-only rule guards against rewriting the app; a tested
registration hook that makes agents able to read files is the exception it allows.

## Hermes's twelve toolsets, and the Trent verdict
| toolset | Trent today | verdict |
|---|---|---|
| file | none for seats | build new over TerminalBackend |
| terminal | 8-command allowlist in a temp dir | build new over DockerBackend / LocalBackend |
| web | Tavily + Jina, direct fetch | adapt: route through the egress proxy |
| browser | Camofox / Steel adapters | adapt: alias Hermes names; needs a service |
| vision / image / tts | Fal mocked; voice module | build; needs a service |
| memory | memory:read internal action | adapt: add write with 2200/1375 caps |
| delegation | workRequests -> delegated steps | exists; alias delegate_task |
| cron | autonomy-scheduler | adapt: cronjob_manage over profile jobs.json |
| skills | SkillLoader/Hub/SecurityScan | adapt: skills_list / skill_view / skill_manage |
| plugins | none | build, phase 3, same seam |
| mcp | exists per company | exists; allow loopback under a flag |
| code execution | none | phase 2, terminal + RPC |

## Build order
0. `tools/approval-floors.ts` — Hermes's hardline and dangerous patterns, matched over DEOBFUSCATED
   variants (NFKC, quote/escape strip, $IFS, env unwrap, basename). Floors are checked inside
   `execute`, not only `requiresApproval`, because approvalGranted is loop-wide once granted.
1. `tools/file_ops/` — read_file, write_file, patch, search_files with Hermes's schemas. Every op runs
   through the seat's TerminalBackend. Path confinement by realpath after symlink resolution. Deny
   globs for .env*, .git/config, ~/.ssh, ~/.aws, docker.sock. Protected instruction files are
   always-approve. 2000 lines / 100K chars with next_offset.
2. `tools/terminal/` — terminal + process_manage over DockerBackend (cap-drop ALL, no-new-privileges,
   network none; bridge + egress proxy only when a command needs egress). LocalBackend MUST be
   wrapped to scrub process.env — it currently forwards everything. 50K output, 40/60 head/tail,
   spill to a file. Approval order exactly Hermes: floors -> dangerous findings merged into ONE prompt
   -> sudo / rm -r / git push / curl|sh always.
3. `tools/web/` — web_search, web_extract through the egress proxy, SSRF floors, 15K default, spill.
4. `tools/memory/`, 5. `tools/skills/`, 6. `tools/cron/`, 7. `tools/delegation/`,
8. `tools/vision/` + `tools/browser/`, 9. `tools/code_execution/`.

## Seat wiring
`config.toolsets` is read by nothing at runtime today; file_ops and terminal are labels. The wrapper
builds adapters for `toolsets - disabled_toolsets`, registers them through the seam, resets the
router catalog, and upserts each active seat's environment with the enabled scopes and the approval
floors. Each toolset registers as ONE adapter so a single catalog entry covers the family and the
top-3 router still finds it.

## Output limits
summary <= 24,000 chars (the seat prompt re-injects every prior summary). Overflow to
<profile>/cache/spillover/<id>.txt with a 1.5K preview and the path.

## The test that closes the requirement
With `toolsets: [file_ops, terminal]`, a run whose objective is "print the name field of package.json"
ends completed with a toolCalls entry from file_ops whose summary contains the real name, and one from
terminal whose stdout came from a container whose inspect shows NetworkMode=none. Today that run
records `Tool "read_file" is not allowed for this seat.`

## code_execution — Hermes `execute_code` (built 2026-09-13)
`tools/code_execution/{index,schemas}.ts`, test `code-execution.test.ts`. Config toolset name is
`code` (the `ToolsetSchema` enum); adapter name `code_execution`, scope `execute_code`.
Schema from Hermes `tools/code_execution_tool.py:861-876`: `code` (string, required), `reset`
(boolean; accepted, nothing to discard — every call is a fresh interpreter, no persistent kernel).
Trent extensions: `language` (`python` | `javascript`, default python; Hermes is Python-only) and
`timeout` (1-600 s, default 300 = Hermes's five minutes). Runs `exec python3 -c '<code>'` /
`exec node -e '<code>'` through the same `Sandbox` as `terminal`: Docker isolated container
(NetworkMode=none, cap-drop ALL) or the scrubbed-env `LocalBackend`. `exec` replaces the shell so
a timeout kill reaches the interpreter itself; Docker wraps in `withGroupTimeout` (exported from
`terminal/adapter.ts`, with `ALWAYS_APPROVE`). Timeout -> `failed` with `[timed_out: ...]`.
Interpreter absent (exit 127) -> `failed` with `[interpreter X is not available in this sandbox]`.
Output: stdout, then `[stderr]`, `fitSummary` at 24K with spill to `<profile>/cache/spillover/`.
Approval floor identical to `terminal`: `floorBlock(code)` inside `execute` (`blocked`), then
`dangerous(code)` + always-approve merged into one `needs_approval`. Hermes's `from hermes_tools
import ...` RPC bridge is NOT built: no tool calls from inside the snippet.

## delegation — Hermes `delegate_task` (built 2026-09-13)
`tools/delegate/{index,types}.ts`, test `delegate.test.ts`. Config toolset `delegation`; adapter
name `delegation`, scope `delegate_task`. NOT an agent loop: an alias over the orchestrator's
existing `[delegated]` child steps. `DelegatePort { delegate({task, agent?, context?}) ->
{status, output, agent?, runId?, toolCalls?} }` is injected through `ToolBuildDeps.delegate`; the
orchestrator side binds it. Without a port: `availability: "unavailable"`, health
`needs_credentials`, every call `failed` with `delegate_task not_available: ...`.
Schema from Hermes `tools/delegate_tool.py:598-660`: `tasks[{goal (required), context}]`, at most
6 per call (the orchestrator's delegated-step cap); the legacy top-level `goal`/`context` shape is
accepted as Hermes does. `agent` on a task is a Trent extension (a fleet specialist id). Not
advertised: Hermes's `output_schema`, `group`, and the `action=list|steer|stop` control plane —
the port has none. The child's `toolCalls` are rendered with their statuses verbatim, so a
delegated child's `blocked` memory write surfaces as `memory blocked: ...` for the parent to act on.

## plugins (built 2026-09-13)
`tools/plugins/{index,manifest}.ts`, `tools/tool-names.ts`, test `plugins.test.ts`. Config
toolset `plugins`; adapter name `plugins`, scopes `plugins_list` + every accepted plugin tool.
Manifest: `<profile>/plugins/<name>/plugin.json` (`~/.trent/plugins` for the default profile;
override with `ToolBuildDeps.pluginsDir`) = `{name, version, tools:[{name, description,
parameters, command}]}`. Hermes's general plugins are Python `register(ctx)` modules and its
portable `plugin.json` is the agent-plugins.org skills+MCP package; Trent ships only this
command form so NO plugin code is ever imported into the process. A call runs
`printf '%s' '<json args>' | <command>` through the sandbox (local: cwd = plugin dir; Docker:
cwd = /workspace, command must resolve inside the image), 120 s timeout, stdout + `[stderr]`,
fitSummary. Refused with the reason (visible via `plugins_list` and `loadPluginManifests().refused`):
manifest not a regular file / symlink / mode looser than 0600 / over 256 KB / invalid JSON; plugin
or tool name outside `^[a-z][a-z0-9_]{1,40}$`; plugin name != directory; tool name equal to a
built-in in `tool-names.ts` (`BUILTIN_TOOL_NAMES`) or already claimed by an earlier plugin;
`parameters` not a `type:"object"` schema with `properties`; empty `command`; command tripping the
hardline floor. Approval: every plugin tool call `requiresApproval` (stricter than terminal's
findings-only floor), and `floorBlock(command)` is re-checked inside `execute`.

Registered in `buildTrentToolAdapters` for `code`, `delegation`, `plugins` behind
`enabledToolsets(config)` (`tools-index.test.ts`).
