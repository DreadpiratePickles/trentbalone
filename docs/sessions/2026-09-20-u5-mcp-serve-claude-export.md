# 2026-09-20 — U5: `trent mcp serve` over toolsets, `fleet export --target claude`

Wave-1 task U5 (design v2 sections 1/G9 and 4; review items 4 and 6.7; research 1a, 1d, 4, 5).
Branch `feature/trent-fleet-v2`. Invariants held: nothing under `apps/web` changes; failing test
first per item; files under 500 lines; no canned strings, emoji or hex in output surfaces;
`TRENT_QUEUE_FALLBACK=disabled` in every shell; no live model (fake adapters only); no
`git add`/commit by this agent; other agents' files (`governance/**`, `connect/**`,
`fleet-memory/**`, `fleet/FleetPacks.ts`, `skills/**` except the frontmatter parser,
`apps/cli/src/runtime/**`, `orchestrator/**`) untouched.

## Specs read
- MCP tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
  (`tools/list` -> `{tools:[{name, description, inputSchema}]}`; `tools/call` -> `{content, isError,
  structuredContent}`; unknown tool is a protocol error, a failed call is `isError: true`).
- MCP transports: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
  (stdio: nothing on stdout but messages, logs on stderr; Streamable HTTP: one endpoint, POST+GET,
  `Mcp-Session-Id`, validate `Origin`, bind loopback, authenticate).
- SDK `@modelcontextprotocol/sdk` 1.30.0 (installed under apps/web, hoisted): low-level `Server`
  with `setRequestHandler(ListToolsRequestSchema | CallToolRequestSchema)`, `StdioServerTransport`,
  `StreamableHTTPServerTransport.handleRequest(req, res)`, `InMemoryTransport.createLinkedPair()`.
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents (`.claude/agents/<name>.md`,
  frontmatter `name` (lowercase-hyphen, required), `description` (required), `tools` (comma list,
  `mcp__<server>__<tool>`), `model` optional; body is the system prompt).
- Claude Code `.mcp.json`: https://code.claude.com/docs/en/mcp (`{"mcpServers": {"<name>":
  {"command","args","env"}}}`, tools named `mcp__<server>__<tool>`).
- Codex: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (`[mcp_servers.<name>]` `command`,
  `args`, `env`; http `url`, `bearer_token_env_var`). Grok Build (research 1d): reads the Claude
  layout; `[mcp_servers.<name>]` with `command args env url headers bearer_token_env_var`.

## Findings while reading
- The seat path never returns `needs_approval` from `execute`: the autonomy wrapper decides
  `requiresApproval`, the seat loop parks the step, the founder decides through `gateway.json`
  (`ApprovalBridge` over `FileGatewayStore`, `trent approvals`). The MCP server therefore has to
  own that half itself: ask the wrapped adapter, park a row bound to the call key, answer
  `needs_approval` with the id, execute on the replay once the row is approved.
- `buildTrentTools` returns the DISCLOSED adapter list: past `tools.disclosure_threshold` (24) the
  non-core toolsets' names are masked out of `scopes` and their blocks out of `instructions`;
  only the `tools` bridge can reach them. The server needs the deferred list, which nothing
  exported; the bridge grows a `deferred()` accessor.
- `file_ops` and `terminal` carry prose instructions, not `renderToolInstructions` blocks, so
  their schemas cannot be read back from the adapter text; every other toolset's can.
- Concurrency: U4 is editing `skills/skill-store.ts` (uncommitted `unquote`, `readFlat`); my
  parser change is confined to `parseFrontmatter`/`renderFrontmatter` and lands last, re-read first.
  U4 is also adding `packPersona`/`personaPathFor` to `FleetPacks.ts`; the Claude renderer reads
  `<profile>/brain/system/persona-<pack>.md` from disk and does not depend on that API.

## Log
- Item 1a `tools/tool_search/deferred.test.ts` RED (`bridge.deferred is not a function`) -> `ToolBridgeAdapter.deferred()`
  returns `disclosure.deferred()`. `npx vitest run packages/trent-core/src/tools/tool_search` -> 11 passed.
- Item 1b `mcp-server/schemas.test.ts` RED (module absent) -> `schemas.ts`: `parseInstructionBlock` (inverse of
  `renderToolInstructions`, round-trips web/skills/cron/browser schemas), `PROSE_TOOL_SCHEMAS` for
  `file_ops`/`terminal` held to `BUILTIN_TOOLS_BY_TOOLSET`, `toolInputSchema`. 5 passed.
- Item 1c `mcp-server/catalog.test.ts` RED (module absent) -> `catalog.ts`: one MCP tool per callable Trent
  tool, advertised from scopes+instructions, deferred through the bridge (`via: "bridge"`), the bridge's
  own three tools and `human`/`clarify` excluded by name (`EXCLUDED_ADAPTERS`). 2 passed.
- Item 1d `mcp-server/approvals.test.ts` RED (module absent) -> `approvals.ts`: `approvalKey(run, tool, args)`
  (sorted-key sha256), `createMcpApprovalGate` over `ApprovalBridge` + `FileGatewayStore(<profile>/gateway.json)`
  (the file `trent approvals` decides), rows `agentId: mcp:<client>`, `details.surface: "mcp"`, a yes spent
  by one execution, a no kept. 4 passed.
- Item 1e `mcp-server/server.test.ts` RED (module absent) -> `server.ts`: SDK low-level `Server`,
  `tools/list` from the catalog, `tools/call` -> `requiresApproval` on the wrapped adapter -> park/replay ->
  `runWithToolCallContext({runId: mcp_<hex>, stepId})` -> `execute`; `needs_approval` structured result
  with `approval_id`, `preview`, `settle`; `blocked`/`failed` -> `isError`; `scrubMcpResult` on every
  summary; unknown tool -> `McpError(InvalidParams)`. First run: 2 failed because the test used
  `autonomy: never` (which auto-approves) for the gated case; test corrected to the default level, 7 passed.
- Item 1f `mcp-server/transport.test.ts` RED (module absent) -> `transport.ts`: `serveStdio`,
  `createMcpHttpServer` (one endpoint `/mcp`, sessions by `Mcp-Session-Id`, one Trent server per session,
  bearer compared with `timingSafeEqual`, `Origin` must be loopback, non-loopback bind without a token
  refused with `TrentError(CONFIG)` before `listen`). 4 passed (assertions on the refusal body, since the
  SDK client reports the body not the status).
- Item 1g `mcp-server/stdio.test.ts` over real pipes (`__fixtures__/serve-fake.ts`, spawned with
  `node --import tsx`, SDK `StdioClientTransport`): list, call, hardline refusal, park + approve + run.
  RED re-proven by replacing `serveStdio` with `process.exit(0)` (Connection closed), restored, 1 passed.
- Item 1h CLI `apps/cli/src/commands/__tests__/mcp-serve.test.ts` RED (exit 2, no `serve`) ->
  `groups/mcp-serve.ts` (`mcpServeSpec`, wired into `groups/mcp.ts`): runtime via
  `overrides.gatewayRuntime ?? createHeadlessRuntime` with `surface: "mcp"`, adapters =
  `runtime.tools.adapters` + `runtime.fleetMemory.adapters`, one run scope per connection
  (`openRunScope`/`closeRunScope`, surface `mcp`), `--token-env` (default `TRENT_MCP_TOKEN`, value never
  printed), `--dry-run` JSON. `parsePort` refuses 0, so the tests use fixed ports 7931-7934. 5 passed.
  `packages/trent-core/package.json` gains the `./mcp-server` export.
- Environment: at 01:24 another agent's install (pdfjs-dist) left `node_modules` without `@types/node`,
  `agentkeepalive`, `abort-controller`, `accepts` (present in `package-lock.json`, absent on disk), so
  `tsc` failed on every file. `npm install --no-audit --no-fund` run twice from the root reconciled the
  tree with the lockfile; `git diff --stat package-lock.json` unchanged before and after (278 insertions,
  not mine). `tsc -p apps/cli` now has one error, another agent's in-progress `config/defaults.ts`
  (`media` missing).
- Item 2a `skills/frontmatter-nested.test.ts` RED (nested `trust` overwrote the flat one; `hermes` keys
  flattened to bogus scalars) -> parser moved to `skills/frontmatter.ts` (skill-store.ts would have
  passed 500 lines; it re-exports `parseFrontmatter`/`renderFrontmatter` so every reader is unchanged):
  nested maps read as dotted keys, block lists as comma-joined strings, `metadata.trent.<f>` hoisted onto
  the flat `<f>` when absent, `renderFrontmatter` re-nests dotted keys. `npx vitest run
  packages/trent-core/src/skills packages/trent-core/src/tools/skills packages/trent-core/src/curator` -> 54 passed.
- Item 2b `fleet/export-record.test.ts` RED (no `seat` block, `scripts/` dropped, cap not restored) ->
  `export.ts`: `seat` block (name, toolsets, denied, approvalGates, budgetCents, modelTier, evalSuiteId;
  from `SEAT_CAPABILITIES` for a seat, from the record for a custom agent, never invented), optional in
  the zod schema so old bundles import; `skillsDir` copies `references/ scripts/ assets/ tools/`;
  import restores `seat` and the cap in integer cents. 4 passed; `export.test.ts` byte-identity kept (3 passed).
- Item 2c `mcp-server/toolset-tools.test.ts` RED (module absent) -> `toolset-tools.ts`:
  `MCP_TOOLS_BY_TOOLSET` from the schema constants, held to a live `buildToolCatalog` over a full local
  build, `mcpToolNamesFor(toolsets)`. 2 passed.
- Item 2d `fleet/export-claude.test.ts` RED (module absent) -> `export-claude.ts`: `.claude/agents/<id>.md`
  (name, quoted description from CORE_ROLES/catalog, `tools:` = `mcp__trent__<tool>` for the seat's
  toolsets, no model; body = pack persona from `<profile>/brain/system/persona-<pack>.md`, seat prompt,
  approval rules read from `HARDLINE_RULES`/`ALWAYS_APPROVE`/the seat block, skills index), `.mcp.json`
  (`trent mcp serve --stdio --profile <p>`, `TRENT_QUEUE_FALLBACK=disabled`), skills in Agent Skills
  shape with Trent fields under `metadata.trent`, bundle dirs copied; a pack exports every seat member
  (members that are neither seats nor installed are named as skipped). 5 passed.
- Item 2e CLI `apps/cli/src/commands/__tests__/fleet-export-claude.test.ts` RED (exit 2, no `--target`)
  -> `fleet-versions.ts`: `export <agentId> [dir] --target trent|claude --out <dir>`; round trip
  `fleet import` restores the record's seat block and cap. 5 passed.
- Verification set so far: `npx vitest run packages/trent-core/src/mcp-server packages/trent-core/src/tools/mcp
  packages/trent-core/src/fleet packages/trent-core/src/skills apps/cli/src/commands/__tests__/mcp*
  apps/cli/src/commands/__tests__/fleet* apps/cli/src/commands/__tests__/registry.test.ts
  packages/trent-core/src/wrapped-modules.test.ts` -> 58 files, 1098 tests passed.
- Item 3 docs: `docs/mcp.md` "Trent as an MCP server" (what is exposed, the chain, the `needs_approval`
  result, transports and the bearer rule, Claude Code `.mcp.json`, Codex and Grok Build `config.toml`
  snippets); `docs/fleet.md` "Exporting to Claude Code and Grok Build" and the seat record in "Export
  and import"; `docs/skills.md` bundle-carriage note corrected (export now carries `scripts/`, `tools/`).
  `README.md` command count set to the registry's current 135 (another agent's in-flight edit had it at
  130; `docs-truth` "states the command counts" passes; its two remaining failures, the undocumented
  `media` config key and the doctor check count, are the media and doctor agents' in-flight work).
- Media toolset (another agent, uncommitted) added `media` to `Toolset`; `MCP_TOOLS_BY_TOOLSET` lists
  its tools from `tools/media/schemas.ts` and a test holds the table to `IMPLEMENTED_TOOLSETS`.

## Verification (exit codes)
- `npx vitest run packages/trent-core/src/mcp-server packages/trent-core/src/tools/mcp
  packages/trent-core/src/fleet packages/trent-core/src/skills apps/cli/src/commands/__tests__/mcp*
  apps/cli/src/commands/__tests__/fleet* apps/cli/src/commands/__tests__/registry.test.ts
  packages/trent-core/src/wrapped-modules.test.ts` -> exit 0, 58 files, 1099 tests.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
- `npm --prefix packages/trent-core run build` -> exit 0.
- `node scripts/ci/repo-scan.mjs` -> exit 0 (0 canned, 0 hex, 0 emoji).
- `grep -rnE '(//|/\*|\*)[[:space:]]*(TODO|FIXME)\b' packages/trent-core/src apps/cli/src` -> 0.

## Not done
- Codex and Hermes renderers and inbound importers (design v2 waves 2 and 3): `--target` refuses them by name.
- Seats as MCP tools: no seat-targeted runner exists (decision C); the server exposes toolsets only.
- Model spend inside a tool call is charged to the connection's run only when a usage event names
  that run (delegation's child run is opened on the `mcp` surface by the runtime; a `vision_analyze`
  call has no run-scoped meter today, as it has none on the seat path either).
