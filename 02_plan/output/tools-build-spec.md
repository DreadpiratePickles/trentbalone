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

## mcp (built 2026-09-13)
`tools/mcp/{index,client,config}.ts`, fixture `tools/mcp/__fixtures__/fake-mcp-server.mjs` (a
stdio JSON-RPC server answering initialize/ping/tools/list/tools/call), test `mcp.test.ts`;
config block in `config/schema.ts` + `defaults.ts` (`mcp-servers-schema.test.ts`); CLI group
`apps/cli/src/commands/groups/mcp.ts` (`__tests__/mcp.test.ts`); user doc `docs/mcp.md`.
Config: `mcp_servers: Record<name, {transport:"stdio", command, args?, env?} |
{transport:"http", url, headers?}>` plus `auto_approve?: string[]`, `enabled?: boolean`; names
`^[a-z][a-z0-9_-]{1,40}$`; `transport` inferred from `command`/`url` when omitted (Hermes's
`~/.hermes/config.yaml` shape); the legacy `[{name,url}]` array from the old CLI is lifted on
read. `env`/`headers` values may hold `${ENV_VAR}`, resolved at connect time from the env handed
to the adapter, never stored resolved; a missing var makes the server unavailable and the reason
names the var only. Adapter name `mcp`, scopes `mcp_status` + `mcp_<server>_<tool>` (Hermes:
`mcp__<server>__<tool>`, `tools/mcp_tool_schema.py:138`), each with the server's JSON input
schema in the instructions. Discovery is a real `tools/list` over the official SDK client at
build time; connections stay open, `cleanup()` closes them. stdio child env =
`scrubChildEnv(env)` + declared vars only, stderr ignored. http = `checkUrlSafety` then the
`tools/web` egress fetch (no egress -> unavailable; no direct mode). Every MCP tool
`requiresApproval` unless in that server's `auto_approve`; `mcp_status` never. Results go
through `fitSummary`. Unavailable servers (connect failure, list failure, disabled, unset var,
name collision) are carried in `createMcpAdapters(...).unavailable`, in `mcp_status` and in the
instructions. `trent mcp list|add|remove|test <name>`: `add` refuses a built-in tool name
(`tool-names.ts`), a duplicate, a bad name, and a literal secret (secret-shaped env name or
credential header without a `${ENV_VAR}` reference); `test` connects and lists tool names.
Not built: SSE, OAuth, resources/prompts, tool-definition drift checks, OSV preflight.
Wiring into `buildTrentTools` (tools/index.ts) is pending: import `createMcpAdapter` from
`./mcp/index.js`, add an `else if (toolset === "mcp")` branch, move `mcp` from
`NOT_YET_IMPLEMENTED` to `IMPLEMENTED_TOOLSETS`, and declare `@modelcontextprotocol/sdk` (hoisted
from apps/web today) in `packages/trent-core/package.json`.

## browser — Hermes `browser_*` on playwright-core (built 2026-09-13)
`tools/browser/{index,schemas,chromium,launch,page-types,session}.ts`, tests `browser.test.ts`
(fake `Browser`) and `browser.chromium.test.ts` (`describe.skipIf(!findChromium())`: a real headless
Chromium through a real `EgressProxy` to a throwaway HTTPS upstream reachable only via
`upstreamOverrides`; asserts the upstream saw `host: browser-test.example` and NO
`x-trent-proxy-token`, i.e. the tunnel was the path and the broker stripped the token). Config
toolset `browser`; adapter name `browser`, scopes = every tool name. Schemas from Hermes
`tools/browser_tool.py:437-577`, names/keys/required verbatim: `browser_navigate{url}`,
`browser_snapshot{full?}`, `browser_click{ref}`, `browser_type{ref,text}`, `browser_scroll{direction:
up|down}`, `browser_back{}`, `browser_press{key}`, `browser_get_images{}`, `browser_vision{question,
annotate?}`, `browser_console{clear?,expression?}`. Two Trent additions: `browser_screenshot{full_page?}`
and `browser_get_text{}`. Hermes has NO `browser_screenshot`/`browser_get_text`; its screenshot path
is `browser_vision`. Refs are `@eN` on `data-trent-ref` attributes set by an in-page script (Hermes
uses the CDP accessibility snapshot; not ported).
Transport: `playwright-core` (no bundled browser, no `.node` addon: `find node_modules/playwright-core
-name '*.node'` = 0) driving a Chromium from `TRENT_BROWSER_PATH`, PATH, or the standard app paths
(`chromium.ts`); none found -> `availability: "unavailable"`, every call `failed` with
`not_available` + the install hint. Launch: headless, `proxy: {server: egress.proxyUrl, bypass:
"<-loopback>"}` so even localhost goes through the proxy, `--ignore-certificate-errors-spki-list=<CA
SPKI>` plus `ignoreHTTPSErrors` on the context (the browser only ever sees the proxy's interception
leaf; the proxy verifies the real upstream), one fresh context per adapter with
`x-trent-proxy-token` as an extra header, closed by `cleanup()`. Floors inside `execute`:
`checkUrlSafety` (web's SSRF port) on every `browser_navigate` before launch -> `blocked`;
`browser_type` into `type=password` -> `blocked` before any text reaches the page. Screenshots:
`<profile>/browser/<runId>/NNN-<ts>.png`, path in the summary, never bytes. Every summary passes
`fitSummary(..., 15_000)` (Hermes's snapshot cap) with spill to `<profile>/cache/spillover/`.
`browser_vision` = screenshot + the `vision` toolset's `askVision` bound by the builder
(`ToolBuildDeps.gateway`); without a gateway it says `not_available`.

## vision — Hermes `vision_analyze` (built 2026-09-13)
`tools/vision/{index,image-source}.ts`, tests `vision.test.ts` (fake gateway asserts the message
shape) and `vision.live.test.ts` (TRENT_TEST_LIVE=1: a generated red PNG to gemini-3.5-flash-lite
through the real gateway; the reply must contain "red"). Schema from Hermes `tools/vision_tools.py:821`:
`vision_analyze{image_url, question}` (required in Hermes: both; here `question` only, because Trent
adds `image_path` as an explicit local alias and accepts either). Hermes's `region` crop is not
built. Image sources: local path realpath'd under workspace or profile (else `blocked`); http(s)
URL through `checkUrlSafety` then `createEgressFetch` (else `blocked`/`failed`); `data:` URI.
Bytes typed by magic number (PNG/JPEG/GIF/WebP), 20 MB cap. Message shape: OpenAI-compatible
`content: [{type:"text",text}, {type:"image_url", image_url:{url:"data:<mime>;base64,..."}}]`
passed through `streamOpenAiCompatibleChat` untouched (verified live on Gemini's
`/v1beta/openai/` path); when the route's first provider is `anthropic`, a Messages `image`
block `{type:"image", source:{type:"base64", media_type, data}}`. `GatewayMessage.content` is
typed `string`; the array is cast at exactly one place (`buildVisionMessages`). Without a gateway:
`availability: "unavailable"`, `not_available` on every call, never a stub.

Builder: `browser` and `vision` moved from `NOT_YET_IMPLEMENTED` to `IMPLEMENTED_TOOLSETS`. `browser`
is skipped (reason) without egress like `web`; `vision` is built `unavailable` without
`ToolBuildDeps.gateway`. `tool-names.ts` lists all twelve browser names. `playwright-core@^1.63.0`
added to `packages/trent-core/package.json` (already hoisted by `apps/web`'s `playwright`).
