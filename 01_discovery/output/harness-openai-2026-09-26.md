# OpenAI agent harnesses as of 2026-09-26

What OpenAI ships for agents today, with primary-source evidence: Codex (CLI, the Codex experience inside the ChatGPT desktop app, IDE extension, cloud, Remote, SDK, app-server), the Agents API (new, public beta), the Agents SDK (Python and TypeScript, including Sandbox Agents), the Responses API built-in tools, and ChatGPT Work / Browser / Computer Use / agent mode. Read-only research for the harness-landscape round (`docs/sessions/2026-09-26-harness-landscape.md`).

## Method and caveats

- **Read date.** Every URL below was read on 2026-09-26 (UTC; the host clock said 2026-09-25 EDT). The "Read" column repeats this for each row.
- **Pinned code.** `openai/codex` main @ `25270df2615eb4da5b9d4a9a392226933fb096c5` (2026-09-26T00:51Z); `openai/openai-agents-python` @ `588826c5be27cad21a3067463e21972ffea38561`; `openai/openai-agents-js` @ `fdaf0a66ca6e9d89498909ad7cf64745630e8afb`; `openai/gpt-oss` @ `7b583341fe16729127f6d5b94a7b09ccae97e1a1`; `ollama/ollama` @ `7af393188defd52d370464de0d2064649cab9b41`.
- **How pages were read.** Pages on `learn.chatgpt.com` and `developers.openai.com` were read through their Markdown twins (same path plus `.md`, which both sites document). GitHub content came through `gh api`. Direct fetches of `openai.com/index/*` and `help.openai.com` return HTTP 403, so two pages were read through the `r.jina.ai` reader of the same URL; those rows say "(reader)". One LM Studio page was read through WebFetch's summarizer; its row says "(summary)".
- **Where the docs live.** `developers.openai.com/codex` now returns a 308 redirect to `learn.chatgpt.com/docs`. The Codex desktop app merged into the ChatGPT desktop app on 2026-07-09. Current model names in the docs are GPT-6 Astra, GPT-6 Sol and Luna, and GPT-5.6 Sol, Terra and Luna. GPT-5.5 retires from ChatGPT and Codex on 2026-10-14.
- **Gaps.** Anything I could not confirm from a primary source is marked **not found** or **unverified**. The "Not found" section at the end lists them all.

## 0. Product map today

| Product | State on 2026-09-26 | Evidence URL | Read |
|---|---|---|---|
| Codex CLI | 0.157.1 on npm (published 2026-09-26). Written in Rust, Apache-2.0 license, 126,487 stars | https://github.com/openai/codex | 2026-09-26 |
| Codex in the ChatGPT desktop app | The Codex app merged into the ChatGPT desktop app (macOS and Windows) on 2026-07-09. The Linux preview has shipped since 2026-08-11 | https://learn.chatgpt.com/docs/whats-new | 2026-09-26 |
| Codex IDE extension | Runs in VS Code, Cursor and Windsurf. JetBrains and Xcode ship their own Codex integrations | https://learn.chatgpt.com/docs/codex/ide | 2026-09-26 |
| Codex cloud | Isolated cloud containers. Tasks can start from web, GitHub, GitLab (beta), Linear or Slack | https://learn.chatgpt.com/docs/cloud | 2026-09-26 |
| Codex Remote | A phone starts, steers and approves tasks that run on a connected Mac or PC | https://learn.chatgpt.com/docs/remote | 2026-09-26 |
| Codex SDK and app-server | TypeScript `@openai/codex-sdk`, Python `openai-codex`, and app-server (JSON-RPC, experimental) | https://learn.chatgpt.com/docs/codex-sdk | 2026-09-26 |
| **Agents API** (new) | Public beta since 2026-09-10: "a managed Codex harness" | https://developers.openai.com/api/docs/changelog | 2026-09-26 |
| Agents SDK | Python v0.22.3, released 2026-09-17 (JS v0.18.0 is in D9) | https://github.com/openai/openai-agents-python/releases/tag/v0.22.3 | 2026-09-26 |
| Agents SDK Sandbox Agents | Changelog: sandboxes and the open-source harness added 2026-04-15; "now available in TypeScript, with support for sandbox agents" 2026-05-06 | https://developers.openai.com/api/docs/changelog | 2026-09-26 |
| Responses API built-in tools | `web_search`, `file_search`, `tool_search`, `function`, `mcp`, `computer`, image generation, `shell`, `skills`, Programmatic Tool Calling | https://developers.openai.com/api/docs/guides/tools | 2026-09-26 |
| ChatGPT Work | Launched in the week of 2026-07-06. It "can break a goal into steps and work for hours" | https://learn.chatgpt.com/docs/whats-new | 2026-09-26 |
| ChatGPT agent mode | The help article (read via reader) still documents agent mode, with monthly limits of 40 (Plus) and 400 (Pro). The current learn.chatgpt.com docs have no agent-mode page and point to Work, Browser and Computer Use instead. **Removal is unverified** | https://help.openai.com/en/articles/11752874-chatgpt-agent | 2026-09-26 |
| Workspace Agents API | Triggers published ChatGPT workspace agents from backend systems | https://developers.openai.com/workspace-agents/trigger-runs | 2026-09-26 |
| Retired or retiring | Agent Builder and the Evals platform shut down 2026-11-30. The Assistants API shut down 2026-08-26 | https://developers.openai.com/api/docs/deprecations | 2026-09-26 |
| Removed from Codex | `codex mcp-server` and the `codex-mcp-server` binary. Integrations must move to app-server | https://learn.chatgpt.com/docs/mcp-server | 2026-09-26 |

## 1. Features table

One URL per row. "Surface" names which product the row describes.

### 1.1 Execution model: sessions, compaction, long tasks, background runs, resumption

| # | Area | Capability (surface) | Evidence URL | Read |
|---|---|---|---|---|
| E1 | Execution | Codex CLI: `codex resume` reopens a chat by ID or the most recent one. `--last` is scoped to the cwd unless `--all` is passed. `codex fork` copies an earlier session into a new chat | https://learn.chatgpt.com/docs/developer-commands | 2026-09-26 |
| E2 | Execution | `codex exec`: `resume --last` or `resume <SESSION_ID>`. `--ephemeral` stops session files from persisting. `--json` emits a JSONL event stream | https://learn.chatgpt.com/docs/non-interactive-mode | 2026-09-26 |
| E3 | Execution | Codex compaction: `/compact`, plus `model_auto_compact_token_limit` (unset means the model default) and `model_auto_compact_token_limit_scope` (`total` or `body_after_prefix`) | https://learn.chatgpt.com/docs/config-file/config-reference | 2026-09-26 |
| E4 | Execution | Codex Goal mode: `/goal <objective>`, with `edit`, `pause`, `resume` and `clear`. Works in the desktop app, CLI and IDE. A goal keeps the same sandbox and approvals | https://learn.chatgpt.com/docs/long-running-work | 2026-09-26 |
| E5 | Execution | `features.goals` means "persisted goals and automatic continuation" (stable, on by default). `features.prevent_idle_sleep` keeps the machine awake during turns (experimental) | https://learn.chatgpt.com/docs/config-file/config-reference | 2026-09-26 |
| E6 | Execution | Codex 0.157.0 "Enabled automatic background-server startup for eligible interactive sessions" and added "an `f` shortcut to fork conversations open in another app" | https://github.com/openai/codex/releases/tag/rust-v0.157.0 | 2026-09-26 |
| E7 | Execution | Codex state lives in SQLite (`CODEX_SQLITE_HOME`, which defaults to `CODEX_HOME`) | https://learn.chatgpt.com/docs/config-file/environment-variables | 2026-09-26 |
| E8 | Execution | Codex transcripts go to `~/.codex/history.jsonl`. `[history] persistence = "none"` turns this off and `max_bytes` caps the file | https://learn.chatgpt.com/docs/config-file/config-advanced | 2026-09-26 |
| E9 | Execution | Codex cloud: one container per task running the setup script. Container state is cached "for up to 12 hours" | https://learn.chatgpt.com/docs/environments/cloud-environment | 2026-09-26 |
| E10 | Execution | Scheduled tasks (desktop app) run in the project or in an isolated worktree, and need the computer on and the app running. The CLI has no scheduler UI | https://learn.chatgpt.com/docs/automations | 2026-09-26 |
| E11 | Execution | Agents API: a session is "a durable instance of an agent". Turns run asynchronously. Input sent during an active turn steers it; input sent to an idle session starts a new turn. Streams do not replay missed events, so recovery goes through saved items | https://developers.openai.com/api/docs/guides/agents-api/sessions | 2026-09-26 |
| E12 | Execution | Agents API hosted sandbox: deleted after an hour with no activity or keep-alive, and "This timeout isn't configurable". Files under `/workspace/outputs` are published as immutable artifacts | https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted | 2026-09-26 |
| E13 | Execution | Agents API self-hosted environments: the API "waits up to five minutes" for the executor to connect, and "does not guarantee recovery of pending input after a process crash" | https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle | 2026-09-26 |
| E14 | Execution | Agents API data residency is US only and ZDR is **not** supported, even with a self-hosted sandbox | https://developers.openai.com/api/docs/guides/agents-api/overview | 2026-09-26 |
| E15 | Execution | The Agents API launch post says the infrastructure "keeps them running reliably for days" and that the API "automatically compacts earlier context" (reader) | https://openai.com/index/introducing-the-agents-api/ | 2026-09-26 |
| E16 | Execution | Responses API compaction: set `context_management.compact_threshold` for server-side compaction, which returns an encrypted, opaque compaction item. Standalone `/responses/compact` is stateless and ZDR-friendly | https://developers.openai.com/api/docs/guides/compaction | 2026-09-26 |
| E17 | Execution | Responses background mode: send `background=true`, then poll, cancel, or resume a stream from `sequence_number`. For ZDR projects the data is kept for roughly 10 minutes | https://developers.openai.com/api/docs/guides/background | 2026-09-26 |
| E18 | Execution | Responses state: `previous_response_id` chaining or the Conversations API. Responses are kept 30 days; Conversation items have no 30-day TTL | https://developers.openai.com/api/docs/guides/conversation-state | 2026-09-26 |
| E19 | Execution | Agents SDK Sessions: SQLite, async SQLite, Redis, SQLAlchemy, Dapr, MongoDB, encrypted, OpenAI Conversations, and `OpenAIResponsesCompactionSession` (auto-compaction after each turn) | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/sessions/index.md | 2026-09-26 |
| E20 | Execution | Agents SDK `RunState`: serialize a paused run with `to_json()` and resume it later. The docs say to deserialize only trusted snapshots | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/human_in_the_loop.md | 2026-09-26 |
| E21 | Execution | Agents SDK durable execution via Temporal, Restate and DBOS integrations | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/running_agents.md | 2026-09-26 |
| E22 | Execution | Agents SDK Sandbox Agents: a `Manifest` describes the workspace. Runs can reconnect through `session`, `session_state` or `snapshot`, and the default capabilities include `Compaction()` | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/sandbox_agents.md | 2026-09-26 |

### 1.2 Tools: built-ins, MCP, tool search, computer use

| # | Area | Capability (surface) | Evidence URL | Read |
|---|---|---|---|---|
| T1 | Tools | Codex feature flags: `shell_tool` and `unified_exec` (PTY-backed exec) are stable and on. `code_mode` is under development and off. `network_proxy` is experimental and off | https://learn.chatgpt.com/docs/config-file/config-reference | 2026-09-26 |
| T2 | Tools | Codex web search defaults to "cached" results from an OpenAI-maintained index. Live mode raises "exposure to prompt injection" | https://learn.chatgpt.com/docs/agent-approvals-security | 2026-09-26 |
| T3 | Tools | Codex as an MCP **client**: STDIO and Streamable HTTP servers; bearer auth; OAuth including CIMD and DCR; reads the server's `instructions` field (the first 512 characters should stand alone). The desktop app, CLI and IDE share one config | https://learn.chatgpt.com/docs/extend/mcp | 2026-09-26 |
| T4 | Tools | Per-server MCP settings: `enabled_tools` and `disabled_tools`; startup timeout 10 s and tool timeout 60 s by default; `required`; `bearer_token_env_var`; `oauth.callback_port` | https://learn.chatgpt.com/docs/config-file/config-reference | 2026-09-26 |
| T5 | Tools | Codex as an MCP **server** has been removed. The replacement, app-server, is "isn't an MCP server" and is experimental | https://learn.chatgpt.com/docs/mcp-server | 2026-09-26 |
| T6 | Tools | Codex `tool_search` "Searches over apps/connectors tool metadata with BM25" and loads the matching deferred tools | https://github.com/openai/codex/blob/25270df2615eb4da5b9d4a9a392226933fb096c5/codex-rs/core/templates/search_tool/tool_description.md | 2026-09-26 |
| T7 | Tools | Computer Use (desktop app plugin, macOS and Windows): operates GUI apps. macOS needs the Screen Recording and Accessibility permissions | https://learn.chatgpt.com/docs/computer-use | 2026-09-26 |
| T8 | Tools | Built-in Browser: desktop app and web only, "isn't available in Codex CLI or the Codex IDE extension". It uses a browser profile separate from the user's own | https://learn.chatgpt.com/docs/browser | 2026-09-26 |
| T9 | Tools | Site tools, ChatGPT's implementation of the proposed WebMCP standard. Websites expose actions to the agent inside the user's signed-in session | https://learn.chatgpt.com/docs/webmcp | 2026-09-26 |
| T10 | Tools | Responses `tool_search`: tools marked `defer_loading` stay out of context until needed; namespaces should hold fewer than 10 functions each; hosted and client modes; "only gpt-5.4 and later" | https://developers.openai.com/api/docs/guides/tools-tool-search | 2026-09-26 |
| T11 | Tools | Responses remote MCP: `server_url` or `tunnel_id`; `allowed_tools`; `require_approval` produces an `mcp_approval_request`. Works over Streamable HTTP or HTTP/SSE. Legacy built-in connectors are being phased out | https://developers.openai.com/api/docs/guides/tools-connectors-mcp | 2026-09-26 |
| T12 | Tools | Secure MCP Tunnel: an outbound-only `tunnel-client` makes private MCP servers reachable without opening inbound ports | https://developers.openai.com/api/docs/guides/secure-mcp-tunnels | 2026-09-26 |
| T13 | Tools | Responses `computer` tool with actions click, drag, type, scroll, screenshot and similar. The alternative is a code-execution harness (Playwright or PyAutoGUI). Guidance: run in an isolated browser or VM with an allow-list | https://developers.openai.com/api/docs/guides/tools-computer-use | 2026-09-26 |
| T14 | Tools | Hosted `shell`: `container_auto` or `container_reference`; "Hosted containers don't have outbound network access" by default; domain allowlists; skills mount into the container; containers expire when idle | https://developers.openai.com/api/docs/guides/tools-shell | 2026-09-26 |
| T15 | Tools | Code Interpreter: container memory of 1g, 4g, 16g or 64g; the container expires after 20 minutes unused | https://developers.openai.com/api/docs/guides/tools-code-interpreter | 2026-09-26 |
| T16 | Tools | Web search: up to 100 allowed or blocked domains. `external_web_access: false` gives cache-only mode; live access is the default | https://developers.openai.com/api/docs/guides/tools-web-search | 2026-09-26 |
| T17 | Tools | File search over vector stores (semantic plus keyword) | https://developers.openai.com/api/docs/guides/tools-file-search | 2026-09-26 |
| T18 | Tools | Programmatic Tool Calling: the model writes JavaScript that runs in "a fresh, isolated V8 runtime" with no network or filesystem. `allowed_callers` sets which tools a program may call. Supports ZDR | https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling | 2026-09-26 |
| T19 | Tools | Agents API without an environment has no built-in Bash, apply-patch or workspace files; remote MCP and function tools still work | https://developers.openai.com/api/docs/guides/agents-api/architecture | 2026-09-26 |
| T20 | Tools | Agents SDK tools: function tools, hosted tools, `ToolSearchTool`, `ComputerTool`, `ShellTool`, `ApplyPatchTool`, and an experimental `codex_tool` that wraps the Codex CLI | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/tools.md | 2026-09-26 |
| T21 | Tools | Agents SDK MCP: `HostedMCPTool`, Streamable HTTP, SSE and stdio servers | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/mcp.md | 2026-09-26 |
| T22 | Tools | ChatGPT developer mode: "full Model Context Protocol (MCP) client support for all tools, both read and write" on the web (Plus and above); flagged as elevated risk | https://developers.openai.com/api/docs/guides/developer-mode | 2026-09-26 |

### 1.3 Safety and permissions

| # | Area | Capability (surface) | Evidence URL | Read |
|---|---|---|---|---|
| S1 | Safety | Codex sandbox by OS: macOS Seatbelt; Linux and WSL2 bubblewrap (a bundled helper is the fallback); native Windows sandbox under PowerShell | https://learn.chatgpt.com/docs/sandboxing | 2026-09-26 |
| S2 | Safety | Linux details: bubblewrap is the default, with `--ro-bind / /` and writable roots bound read-write. `.git` and `.codex` are re-applied read-only, plus a seccomp network filter and `PR_SET_NO_NEW_PRIVS`. The legacy Landlock path is rejected for filesystem-restricted policies | https://github.com/openai/codex/blob/25270df2615eb4da5b9d4a9a392226933fb096c5/codex-rs/linux-sandbox/README.md | 2026-09-26 |
| S3 | Safety | Sandbox modes are `read-only`, `workspace-write` and `danger-full-access`. Approval policy is `on-request` (default), `never`, or `granular` per category. "`untrusted` is unsupported, and `on-failure` is deprecated" | https://learn.chatgpt.com/docs/config-file/config-reference | 2026-09-26 |
| S4 | Safety | Network is off by default and turned on with `[sandbox_workspace_write] network_access = true`. `--full-auto` is deprecated. `--yolo` means no sandbox and no approvals ("not recommended") | https://learn.chatgpt.com/docs/agent-approvals-security | 2026-09-26 |
| S5 | Safety | `codex exec` runs read-only by default. `--sandbox workspace-write` replaces `--full-auto`. `--ignore-rules` and `--ignore-user-config` exist | https://learn.chatgpt.com/docs/non-interactive-mode | 2026-09-26 |
| S6 | Safety | Desktop permission modes: "Ask for approval" (default), "Approve for me" (auto-review) and "Full access" | https://learn.chatgpt.com/docs/permission-modes | 2026-09-26 |
| S7 | Safety | Auto-review: a separate reviewer agent decides requests at the sandbox boundary. It "is a reviewer swap, not a permission grant" | https://learn.chatgpt.com/docs/sandboxing/auto-review | 2026-09-26 |
| S8 | Safety | Permission profiles (beta) set filesystem and network rules. Domain rules are enforced only when the network proxy is running | https://learn.chatgpt.com/docs/permissions | 2026-09-26 |
| S9 | Safety | Rules (experimental): `prefix_rule` in `rules/*.rules` controls which commands may run outside the sandbox. Smart approvals suggest rules | https://learn.chatgpt.com/docs/agent-configuration/rules | 2026-09-26 |
| S10 | Safety | Environment handling: `ignore_default_excludes` **defaults to `true`**, so Codex does **not** strip variables named `*KEY*`, `*SECRET*` or `*TOKEN*` from spawned commands unless configured to | https://learn.chatgpt.com/docs/config-file/config-advanced | 2026-09-26 |
| S11 | Safety | Where the CLI stores credentials: `file`, `keyring`, `auto` or `ephemeral` | https://learn.chatgpt.com/docs/auth | 2026-09-26 |
| S12 | Safety | Best-effort regex redaction of `sk-…`, `AKIA…`, bearer tokens and `api_key=`-style assignments | https://github.com/openai/codex/blob/25270df2615eb4da5b9d4a9a392226933fb096c5/codex-rs/secrets/src/sanitizer.rs | 2026-09-26 |
| S13 | Safety | Enterprise `requirements.toml` (`/etc/codex/requirements.toml`, `%ProgramData%`, macOS MDM) can forbid `never` or `danger-full-access` | https://learn.chatgpt.com/docs/enterprise/managed-configuration | 2026-09-26 |
| S14 | Safety | Codex cloud: agent internet is off by default while setup scripts keep internet access. Allowlists can be set per environment by domain and HTTP method | https://learn.chatgpt.com/docs/cloud/internet-access | 2026-09-26 |
| S15 | Safety | Codex cloud secrets are "only available to setup scripts" and are "removed before the agent phase starts" | https://learn.chatgpt.com/docs/environments/cloud-environment | 2026-09-26 |
| S16 | Safety | Agents API: the executor's environment key "only permits connecting environments". Vault secrets reach the sandbox as a placeholder, and a proxy swaps in the real value for approved hosts | https://developers.openai.com/api/docs/guides/agents-api/environments/security | 2026-09-26 |
| S17 | Safety | Agents API hosted network: `enabled` (default), `disabled`, or `restricted` to 1–100 exact hosts. Hosted stdio MCP servers need `enabled` | https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted | 2026-09-26 |
| S18 | Safety | Vaults hold `static_bearer`, `mcp_oauth` or `environment_variable` credentials. "Retrieving a vault or credential does not return its secret values" | https://developers.openai.com/api/docs/guides/agents-api/tools/vaults | 2026-09-26 |
| S19 | Safety | Hosted shell domain secrets: "The model and runtime see placeholder names", and the real values are applied "only for approved destinations" | https://developers.openai.com/api/docs/guides/tools-shell | 2026-09-26 |
| S20 | Safety | Agents SDK `UnixLocalSandboxClient` "adds no OS-level confinement" on Linux; on macOS it restricts the filesystem through `sandbox-exec` but not the network. For Docker, `network_mode="none"` disables networking | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/sandbox/clients.md | 2026-09-26 |
| S21 | Safety | Agents SDK human in the loop: tools declare `needs_approval`, pending calls surface as interruptions, and `always_approve`/`always_reject` decisions stick | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/human_in_the_loop.md | 2026-09-26 |
| S22 | Safety | ChatGPT agent safeguards: confirmations for high-impact actions, "watch mode" on some sites, takeover mode for sensitive input, prompt-injection monitoring (reader) | https://help.openai.com/en/articles/11752874-chatgpt-agent | 2026-09-26 |

### 1.4 Multi-agent

| # | Area | Capability (surface) | Evidence URL | Read |
|---|---|---|---|---|
| M1 | Multi-agent | Codex subagents: built-in `default`, `worker` and `explorer`. Custom TOML agents live in `~/.codex/agents/` or `.codex/agents/` with `name`, `description` and `developer_instructions`, plus optional model, sandbox and MCP settings. "Subagents inherit your current sandbox policy" | https://learn.chatgpt.com/docs/agent-configuration/subagents | 2026-09-26 |
| M2 | Multi-agent | Subagent settings: `agents.max_concurrent_threads_per_session` (unset means "Codex chooses the default"), `default_subagent_model` and effort, and `agents.<name>.config_file` | https://learn.chatgpt.com/docs/config-file/config-reference | 2026-09-26 |
| M3 | Multi-agent | "Ultra" mode in Codex and Work uses subagents for large tasks | https://learn.chatgpt.com/docs/models | 2026-09-26 |
| M4 | Multi-agent | Git worktrees let parallel chats in one project avoid interfering; scheduled tasks can run on background worktrees | https://learn.chatgpt.com/docs/environments/git-worktrees | 2026-09-26 |
| M5 | Multi-agent | Agents API `multi_agent`: the harness supplies create, message, wait and interrupt tools. `max_concurrent_subagents` defaults to 6. Subagents share the filesystem and inherit MCP and web search, but get **no** function tools | https://developers.openai.com/api/docs/guides/agents-api/multi-agent | 2026-09-26 |
| M6 | Multi-agent | Responses API Multi-agent (beta, GPT-5.6 models): the root model spawns a tree of subagents on the server. Enabled with the header `OpenAI-Beta: responses_multi_agent=v1` | https://developers.openai.com/api/docs/guides/responses-multi-agent | 2026-09-26 |
| M7 | Multi-agent | Agents SDK: handoffs, agents-as-tools, and orchestration in code (structured outputs, chaining, evaluator loops, `asyncio.gather`) | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/multi_agent.md | 2026-09-26 |
| M8 | Multi-agent | Agents SDK `OpenAIHostedMultiAgentModel` (experimental): hosted subagents over a Responses WebSocket. Tools with `needs_approval` are rejected | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/models/index.md | 2026-09-26 |

### 1.5 Memory and instructions

| # | Area | Capability (surface) | Evidence URL | Read |
|---|---|---|---|---|
| I1 | Memory | AGENTS.md chain: global `~/.codex/AGENTS.override.md` or `AGENTS.md`, then each directory from the project root down to the cwd, concatenated. Capped at 32 KiB by `project_doc_max_bytes` | https://learn.chatgpt.com/docs/agent-configuration/agents-md | 2026-09-26 |
| I2 | Memory | Skills follow the open agent-skills standard with progressive disclosure. The initial skill list is limited to 2% of the context window, or 8,000 characters when the window is unknown | https://learn.chatgpt.com/docs/build-skills | 2026-09-26 |
| I3 | Memory | Codex Memories: off by default, stored in `~/.codex/memories/`, "redacts secrets", updated in the background. The docs describe it as "a helpful recall layer, not as the only source for rules" | https://learn.chatgpt.com/docs/customization/memories | 2026-09-26 |
| I4 | Memory | Keeping chats that used MCP, web search or tool search out of memory generation is **opt-in**: `memories.disable_on_external_context` defaults to `false` | https://learn.chatgpt.com/docs/config-file/config-reference | 2026-09-26 |
| I5 | Memory | Computer History (macOS, off by default, Pro/Business/Enterprise) turns activity across apps and sites into memories and a timeline. Not available with an API key or Bedrock | https://learn.chatgpt.com/docs/customization/computer-history | 2026-09-26 |
| I6 | Memory | Record & Replay (macOS): demonstrate a workflow once and it is packaged as a reusable skill | https://learn.chatgpt.com/docs/extend/record-and-replay | 2026-09-26 |
| I7 | Memory | Agents SDK sandbox `Memory()`: two phases (extraction, then consolidation) into `MEMORY.md` and `memory_summary.md`; progressive disclosure; keeps the 256 most recent raw memories by default | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/sandbox/memory.md | 2026-09-26 |
| I8 | Memory | Import from Claude Code or Cursor (CLI `/import`) and from Claude Cowork (desktop). Covers instructions, settings, skills, plugins, projects and recent chats, with automatic sync available | https://learn.chatgpt.com/docs/import | 2026-09-26 |

### 1.6 Extensibility: hooks, plugins, custom tools, config layering

| # | Area | Capability (surface) | Evidence URL | Read |
|---|---|---|---|---|
| X1 | Extensibility | Hooks: SessionStart, SessionEnd, SubagentStart, SubagentStop, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, Stop and Interrupt. They run as command or MCP-tool hooks and can run in the background. Non-managed hooks "must be reviewed and trusted" | https://learn.chatgpt.com/docs/hooks | 2026-09-26 |
| X2 | Extensibility | Plugins bundle skills and MCP servers into "one universal plugin directory" shared by ChatGPT and Codex, with marketplaces. "The IDE extension doesn't support plugins" | https://learn.chatgpt.com/docs/plugins | 2026-09-26 |
| X3 | Extensibility | Config precedence: CLI flags, then project `.codex/config.toml` (trusted projects only), profile file, user file, cloud-managed defaults, `/etc/codex`, built-ins. Untrusted projects skip project hooks and rules | https://learn.chatgpt.com/docs/config-file/config-basic | 2026-09-26 |
| X4 | Extensibility | Profiles are now separate files (`~/.codex/<name>.config.toml`). Since 0.134.0 the CLI no longer reads `[profiles.x]` sections. There is also a `notify` command hook | https://learn.chatgpt.com/docs/config-file/config-advanced | 2026-09-26 |
| X5 | Extensibility | app-server: JSON-RPC over stdio, WebSocket or Unix socket; powers the VS Code extension; `codex --remote ws://…` attaches a TUI; experimental | https://learn.chatgpt.com/docs/app-server | 2026-09-26 |
| X6 | Extensibility | GitHub Action `openai/codex-action@v1` | https://learn.chatgpt.com/docs/github-action | 2026-09-26 |
| X7 | Extensibility | Agents API plugins (`.codex-plugin/plugin.json`, `.mcp.json`, `skills/`), ZIP upload to hosted sandboxes, environment templates | https://developers.openai.com/api/docs/guides/agents-api/tools/plugins | 2026-09-26 |
| X8 | Extensibility | Agents API session webhooks for lifecycle changes, including `agent.session.action_required` | https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks | 2026-09-26 |
| X9 | Extensibility | Agents SDK primitives: agents, agents-as-tools and handoffs, guardrails, function tools with Pydantic validation, MCP, sessions, human in the loop, tracing | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/index.md | 2026-09-26 |

### 1.7 Local models (summary rows; details in section 3)

| # | Area | Capability (surface) | Evidence URL | Read |
|---|---|---|---|---|
| L1 | Local | `--oss` runs against Ollama or LM Studio. The provider comes from `--local-provider` or `oss_provider`; if neither is set, the TUI prompts and `codex exec` exits with an error | https://learn.chatgpt.com/docs/config-file/config-advanced | 2026-09-26 |
| L2 | Local | The default OSS model is `gpt-oss:20b` (Ollama), which Codex pulls if it is missing. Ollama must be at least 0.13.4 for Responses support | https://github.com/openai/codex/blob/25270df2615eb4da5b9d4a9a392226933fb096c5/codex-rs/ollama/src/lib.rs#L16 | 2026-09-26 |
| L3 | Local | LM Studio's default is `openai/gpt-oss-20b`, which Codex downloads if missing and loads in the background | https://github.com/openai/codex/blob/25270df2615eb4da5b9d4a9a392226933fb096c5/codex-rs/lmstudio/src/lib.rs#L7 | 2026-09-26 |
| L4 | Local | `wire_api = "chat"` "is no longer supported" and `ollama-chat` has been removed, so every provider must speak the Responses API | https://github.com/openai/codex/blob/25270df2615eb4da5b9d4a9a392226933fb096c5/codex-rs/model-provider-info/src/lib.rs#L96-L98 | 2026-09-26 |
| L5 | Local | Chat Completions deprecation discussion (2025-12-09), with hard errors from February 2026: 94 thumbs-down reactions out of 108 | https://github.com/openai/codex/discussions/7782 | 2026-09-26 |
| L6 | Local | Custom providers without `env_key` or `requires_openai_auth` need no authentication, which the docs call "useful for local models" | https://learn.chatgpt.com/docs/auth | 2026-09-26 |
| L7 | Local | Agents SDK: `set_default_openai_client`, `ModelProvider` or `Agent.model`. Chat Completions for providers that lack Responses. LiteLLM and Any-LLM adapters are "best-effort, beta" | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/models/index.md | 2026-09-26 |
| L8 | Local | Agents SDK JS: the Vercel AI SDK adapter (`@openai/agents-extensions`) connects "any model" | https://github.com/openai/openai-agents-js/blob/fdaf0a66ca6e9d89498909ad7cf64745630e8afb/docs/src/content/docs/extensions/ai-sdk.mdx | 2026-09-26 |
| L9 | Local | Agents API: model usage is billed at OpenAI API rates. Third-party or local model support is **not found** | https://developers.openai.com/api/docs/guides/agents-api/overview | 2026-09-26 |

### 1.8 Observability: tracing, cost, evals

| # | Area | Capability (surface) | Evidence URL | Read |
|---|---|---|---|---|
| O1 | Observability | Codex OpenTelemetry: `otel.exporter` is `none`, `otlp-http` or `otlp-grpc`; `otel.trace_exporter`; raw prompts exported only with `log_user_prompt` opt-in; `[analytics] enabled=false` turns metrics off | https://learn.chatgpt.com/docs/config-file/config-reference | 2026-09-26 |
| O2 | Observability | In `codex exec --json`, `turn.completed` carries `input_tokens`, `cached_input_tokens` and `output_tokens` | https://learn.chatgpt.com/docs/non-interactive-mode | 2026-09-26 |
| O3 | Observability | `/status` shows the chat ID, context usage and rate limits | https://learn.chatgpt.com/docs/reference/slash-commands | 2026-09-26 |
| O4 | Observability | `codex debug prompt-input` renders the exact prompt the model sees; `codex debug models` prints the model catalog | https://learn.chatgpt.com/docs/developer-commands | 2026-09-26 |
| O5 | Observability | Agents API tracing is on by default. The dashboard (Logs → Agents) shows agent, generation and tool spans, and sessions can be exported as OTLP JSON | https://developers.openai.com/api/docs/guides/agents-api/tracing | 2026-09-26 |
| O6 | Observability | Agents API usage per turn is best-effort, can be `null`, and has no separate cache-write count, so exact cost cannot always be computed | https://developers.openai.com/api/docs/guides/agents-api/observability | 2026-09-26 |
| O7 | Observability | Agents SDK traces go to OpenAI by default. `trace_include_sensitive_data` **defaults to True**. More than 30 third-party processors are listed (Langfuse, MLflow, Braintrust, Datadog and others) | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/tracing.md | 2026-09-26 |
| O8 | Observability | Agents SDK usage: requests, input, output, cached, cache-write and reasoning tokens, per request | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/usage.md | 2026-09-26 |
| O9 | Observability | Trace grading: build graders over traces (tool choice, handoffs, policy) | https://developers.openai.com/api/docs/guides/agent-evals | 2026-09-26 |
| O10 | Observability | **Evals platform deprecated**: existing evals turn read-only on 2026-10-31 and the platform shuts down 2026-11-30. The documented migration path is Promptfoo | https://developers.openai.com/api/docs/deprecations | 2026-09-26 |

### 1.9 Distribution

| # | Area | Capability (surface) | Evidence URL | Read |
|---|---|---|---|---|
| D1 | Distribution | Install with `npm i -g @openai/codex`, `brew install --cask codex`, `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`, the PowerShell `install.ps1`, or GitHub release binaries. Runs on macOS arm64 and x86_64, Linux x86_64 and arm64, and Windows | https://github.com/openai/codex | 2026-09-26 |
| D2 | Distribution | The standalone installer also updates Codex: "Run the same installation command" | https://learn.chatgpt.com/docs/codex/cli | 2026-09-26 |
| D3 | Distribution | Release cadence: 17 stable npm releases between 2026-08-26 and 2026-09-26 (35 since 2026-06-26), and 134 GitHub releases including alphas in the same 30 days (counted with `npm view` and `gh api`) | https://www.npmjs.com/package/@openai/codex | 2026-09-26 |
| D4 | Distribution | 0.157.0 (2026-09-25): GPT-6 Sol and Luna, Amazon Bedrock, network restrictions "enforced across redirects and ongoing HTTP and WebSocket traffic" | https://github.com/openai/codex/releases/tag/rust-v0.157.0 | 2026-09-26 |
| D5 | Distribution | Open source: CLI, SDK, app-server, skills, plugins, `codex-universal`. Closed: IDE extension and Codex cloud | https://learn.chatgpt.com/docs/open-source | 2026-09-26 |
| D6 | Distribution | Pricing: Codex and Work share usage and are included on Free, Go, Plus, Pro, Business, Edu and Enterprise. Extra local chats can be billed to an API key | https://learn.chatgpt.com/docs/pricing | 2026-09-26 |
| D7 | Distribution | Amazon Bedrock is a built-in Codex provider (OpenAI models on AWS) | https://learn.chatgpt.com/docs/amazon-bedrock | 2026-09-26 |
| D8 | Distribution | Agents API: "no additional fees"; public beta "to all developers" (reader) | https://openai.com/index/introducing-the-agents-api/ | 2026-09-26 |
| D9 | Distribution | Agents SDK JS v0.18.0 (2026-09-10) | https://github.com/openai/openai-agents-js/releases/tag/v0.18.0 | 2026-09-26 |
| D10 | Distribution | Agent Builder shuts down 2026-11-30; migrate to the Agents SDK or ChatGPT Workspace Agents | https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder | 2026-09-26 |

### 1.10 What users complain about (GitHub, reactions counted on 2026-09-26)

| Issue | State, opened | Reactions | Complaint | Evidence URL | Read |
|---|---|---|---|---|---|
| Codex desktop app for Linux | closed, 2026-02-07 | 1,463 | Linux users locked out; a preview shipped in August 2026 | https://github.com/openai/codex/issues/11023 | 2026-09-26 |
| Remote development in the desktop app | closed, 2026-02-03 | 876 | Wanted SSH and remote hosts; Remote connections have since shipped | https://github.com/openai/codex/issues/10450 | 2026-09-26 |
| Event hooks | closed, 2025-08-09 | 689 | Wanted lifecycle hooks; they have shipped (X1) | https://github.com/openai/codex/issues/2109 | 2026-09-26 |
| SQLite feedback logs ~640 TB/year | closed, 2026-06-14 | 615 | Log writes wearing out SSDs; fixed in 0.142 and 0.143 | https://github.com/openai/codex/issues/28224 | 2026-09-26 |
| LSP integration | **open**, 2026-01-05 | 604 | No language-server awareness | https://github.com/openai/codex/issues/8745 | 2026-09-26 |
| Rate-limit cost per token jumped 10–20x | closed, 2026-06-18 | 560 | The 5-hour budget drained in 2–3 prompts | https://github.com/openai/codex/issues/28879 | 2026-09-26 |
| Bring back `/undo` | **open**, 2026-01-14 | 513 | Undo was removed | https://github.com/openai/codex/issues/9203 | 2026-09-26 |
| macOS `syspolicyd`/`trustd` CPU runaway | **open**, 2026-06-01 | 454 | Desktop app degrades the whole machine | https://github.com/openai/codex/issues/25719 | 2026-09-26 |
| "Burning tokens very fast" | closed, 2026-03-13 | 308 (630 comments) | Usage drained after an extension update | https://github.com/openai/codex/issues/14593 | 2026-09-26 |
| Make the removal of the 5-hour limit permanent | **open**, 2026-07-18 | 265 | Unpredictable usage limits | https://github.com/openai/codex/issues/34035 | 2026-09-26 |
| `/rewind` checkpoint restore | **open**, 2026-02-12 | 225 | No combined rollback of chat and code | https://github.com/openai/codex/issues/11626 | 2026-09-26 |
| GPT-5.6 Sol cannot set subagent models | closed, 2026-07-09 | 206 | Model metadata forced every subagent onto Sol | https://github.com/openai/codex/issues/31814 | 2026-09-26 |
| Encrypted MultiAgentV2 messages | **open**, 2026-06-13 | 143 | Subagent messages became unreadable, which removed the audit trail | https://github.com/openai/codex/issues/28058 | 2026-09-26 |
| Control over auto-compaction | **open**, 2025-09-23 | 125 | Compaction at about 220k tokens degrades long sessions | https://github.com/openai/codex/issues/4106 | 2026-09-26 |
| Custom providers in the desktop app | **open**, 2026-02-06 | 61 | No model switcher for custom providers | https://github.com/openai/codex/issues/10867 | 2026-09-26 |
| Flatten MCP namespace tools for non-OpenAI providers | **open**, 2026-06-03 | 54 | MCP tools never reach Ollama, LM Studio or OpenRouter models | https://github.com/openai/codex/issues/26234 | 2026-09-26 |
| Agents SDK (for contrast) | — | ≤65 | No issue above 65 reactions. The top ones (MCP support, human in the loop) are closed; current open bugs are about replaying sessions and compaction | https://github.com/openai/openai-agents-python/issues/5162 | 2026-09-26 |

## 2. What is distinctive (ten items)

1. **One open-source harness, deployed three ways.** It runs locally (CLI and desktop app), as OpenAI's managed Agents API, and against your own compute, where the Agents API drives `codex exec-server` inside your sandbox over an outbound WebSocket: https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted
2. **A sandbox by default on all three desktop OSes.** Seatbelt on macOS, bubblewrap plus seccomp on Linux, a native Windows sandbox. The default is workspace-write with network off, and `.git` and `.codex` stay read-only: https://github.com/openai/codex/blob/25270df2615eb4da5b9d4a9a392226933fb096c5/codex-rs/linux-sandbox/README.md
3. **An agent reviews approvals instead of the user.** Auto-review sends escalation requests to a separate reviewer agent. It changes who reviews but never widens access: https://learn.chatgpt.com/docs/sandboxing/auto-review
4. **The model never sees the secret.** Vault and domain secrets appear in the sandbox as placeholders, and a proxy substitutes the real value only for approved hosts: https://developers.openai.com/api/docs/guides/agents-api/tools/vaults
5. **Compaction is opaque and runs on the server.** The encrypted compaction item carries state and reasoning forward, is not human-readable, and also has a stateless ZDR endpoint: https://developers.openai.com/api/docs/guides/compaction
6. **Tools load only when needed.** `defer_loading` and namespaces keep large tool surfaces out of context. Codex runs its own BM25 `tool_search` over connectors: https://developers.openai.com/api/docs/guides/tools-tool-search
7. **Programmatic Tool Calling.** The model writes JavaScript that calls tools in parallel and filters results inside an isolated V8, returning only the small result: https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling
8. **Multi-agent is built into the API.** In the Agents API the harness supplies create, message, wait and interrupt tools and reports delegation as typed items (`create_subagent_call` and similar); the Responses API has the same capability in beta (M6): https://developers.openai.com/api/docs/guides/agents-api/multi-agent
9. **Skills from demonstration and from activity.** Record & Replay turns one demonstrated Mac workflow into a skill, and Computer History turns app activity into memories: https://learn.chatgpt.com/docs/extend/record-and-replay
10. **Importing from competitors.** One flow imports instructions, skills, plugins, projects and recent chats from Claude Code, Claude Cowork and Cursor, and can keep syncing: https://learn.chatgpt.com/docs/import

## 3. Local models

### 3.1 Codex: exact commands

```bash
# Ollama (default local provider port 11434; Codex pulls gpt-oss:20b if missing)
codex --oss                                  # uses oss_provider, else prompts (TUI)
codex --oss -m gpt-oss:120b                  # pick a model
codex --oss --local-provider lmstudio        # LM Studio on port 1234
codex exec --oss --local-provider ollama "…" # exec errors out if no provider is set

# Ollama's own launcher (writes a Codex profile file plus a model catalog)
ollama launch codex
ollama launch codex --config                 # configure without launching
ollama launch codex --restore                # remove profile and generated catalog

# LM Studio
lms server start --port 1234
codex --oss -m ibm/granite-4-micro           # example model from LM Studio's page
```

Sources:
- `--oss`, `--local-provider` and `oss_provider`: https://learn.chatgpt.com/docs/config-file/config-advanced
- Ollama launcher: https://github.com/ollama/ollama/blob/7af393188defd52d370464de0d2064649cab9b41/docs/integrations/codex.mdx
- LM Studio (summary): https://lmstudio.ai/docs/integrations/codex

### 3.2 Codex: config

```toml
# ~/.codex/config.toml
oss_provider = "ollama"          # or "lmstudio"
```

Profiles are separate files from 0.134.0 on:

```toml
# ~/.codex/ollama-launch.config.toml   (shape published by Ollama)
model = "gpt-oss:120b"
model_provider = "ollama-launch"
model_catalog_json = "/Users/you/.codex/model.json"

[model_providers.ollama-launch]
name = "Ollama"
base_url = "http://localhost:11434/v1/"
wire_api = "responses"
```

Run it with `codex --profile ollama-launch`. To stop web search from going through Ollama, add `-c 'web_search="disabled"'`. Source: https://github.com/ollama/ollama/blob/7af393188defd52d370464de0d2064649cab9b41/docs/integrations/codex.mdx

Any other OpenAI-compatible server (vLLM, llama.cpp, a remote box) needs a custom provider:
- Set `base_url`. Leave out `env_key` for no authentication.
- `wire_api` must be `"responses"`.
- Set `model_context_window` and, if needed, `model_catalog_json`.
- The IDs `openai`, `ollama` and `lmstudio` are reserved.

Sources: https://learn.chatgpt.com/docs/config-file/config-advanced and https://learn.chatgpt.com/docs/config-file/config-reference

Experimental environment overrides for the built-in providers are `CODEX_OSS_BASE_URL` and `CODEX_OSS_PORT`: https://github.com/openai/codex/blob/25270df2615eb4da5b9d4a9a392226933fb096c5/codex-rs/model-provider-info/src/lib.rs#L719-L735

### 3.3 Codex: which models

- **Defaults.** In code, the defaults are `gpt-oss:20b` for Ollama and `openai/gpt-oss-20b` for LM Studio (links L2 and L3).
- **Hardware.** gpt-oss-20b runs "within 16GB of memory". gpt-oss-120b fits "a single 80GB GPU". Both "should only be used with" the harmony format: https://github.com/openai/gpt-oss/blob/7b583341fe16729127f6d5b94a7b09ccae97e1a1/README.md
- **Context.** Ollama says to "Use a context window of at least 64k tokens for Codex" (Ollama doc above). LM Studio says more than about 25k (LM Studio page above).
- **Official list.** OpenAI's Codex docs publish **no recommended local-model list** beyond these defaults (not found).
- **Ollama-hosted models.** Ollama's page also offers `gpt-oss:120b-cloud`, a model hosted by Ollama rather than a local one.

### 3.4 Codex: how tool calling works with local models

- **What Codex sends.** Codex sends a Responses API request to `/v1/responses`. Its `tools[]` holds function tools (for example `exec_command`), a `web_search` entry, and each MCP server as a proprietary `{"type":"namespace", …}` wrapper. The local server has to translate that into its own tool-call format: https://github.com/openai/codex/issues/23186
- **Built-in providers.** Only OpenAI, Bedrock, Ollama and LM Studio are built in. The source says "We do not want to be in the business of adjucating which third-party providers are bundled": https://github.com/openai/codex/blob/25270df2615eb4da5b9d4a9a392226933fb096c5/codex-rs/model-provider-info/src/lib.rs#L652-L675

### 3.5 Codex: known limitations with local models (all cited)

- **Responses API only.** Chat Completions has been removed (L4 and L5). Ollama must be at least 0.13.4: https://github.com/openai/codex/blob/25270df2615eb4da5b9d4a9a392226933fb096c5/codex-rs/ollama/src/lib.rs#L46-L48
- **MCP tools never reach non-OpenAI Responses backends**, because of the namespace wrapper: https://github.com/openai/codex/issues/26234
- **MCP tool invocation regressed** for custom and local providers from 0.117.0 on; the reporter pinned 0.116.0: https://github.com/openai/codex/issues/19871
- **No first-class edit tool.** `apply_patch` is often absent or unusable for third-party models: https://github.com/openai/codex/issues/33405
- **Context window and startup.** A 272K context is assumed when metadata is missing, a 12GB default model is auto-downloaded, and the model choice is not remembered: https://github.com/openai/codex/issues/17261
- **Ollama's generated catalog** falls back to 128,000 tokens instead of the loaded runner's context: https://github.com/ollama/ollama/issues/18257
- **No model switcher** for custom providers in the desktop app: https://github.com/openai/codex/issues/10867
- **Subagents ignore `model_provider`**, so a mixed local and cloud fleet cannot be configured: https://github.com/openai/codex/issues/40858
- **Raw reasoning.** "Some models/providers (like `gpt-oss`) don't emit raw reasoning": https://learn.chatgpt.com/docs/config-file/config-advanced
- **OpenAI's own gpt-oss README is stale.** Its Codex snippet uses `[profiles.oss]` and "any chat completions-API compatible server". Codex no longer honours either (see X4 and L4): https://github.com/openai/gpt-oss/blob/7b583341fe16729127f6d5b94a7b09ccae97e1a1/README.md
- **Desktop features.** Computer History is "not available with an API key or Amazon Bedrock": https://learn.chatgpt.com/docs/customization/computer-history. Whether Browser, Computer Use or hosted tool search work with local providers is **not documented**.

### 3.6 Agents SDK (Python) with local models

The documented pattern points an `AsyncOpenAI` client at the provider's base URL and wraps it in `OpenAIChatCompletionsModel`, with tracing disabled. Other routes are:
- `set_default_openai_api("chat_completions")` together with `OPENAI_BASE_URL`
- `ModelProvider` per run
- `MultiProvider` with prefix routing
- `pip install "openai-agents[litellm]"` (model names `litellm/...`)
- `openai-agents[any-llm]`

Source: https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/models/index.md. That file has no Ollama-specific example; the example folder holds generic `custom_example_*.py`, `litellm_*.py` and `any_llm_*.py`.

```python
# Pattern from the SDK docs; base_url/model values are placeholders to fill with e.g. an Ollama endpoint.
from agents import Agent, AsyncOpenAI, OpenAIChatCompletionsModel, set_tracing_disabled
set_tracing_disabled(disabled=True)
client = AsyncOpenAI(api_key="Api_Key", base_url="Base URL of Provider")
agent = Agent(name="Helping Agent", instructions="…",
              model=OpenAIChatCompletionsModel(model="Model_Name", openai_client=client))
```

Limitations, all from the same models page:
- The Responses-only features `ToolSearchTool`, `tool_namespace`, `defer_loading` and Programmatic Tool Calling are "rejected on Chat Completions models and on non-Responses backends".
- Hosted web search and file search are OpenAI-only.
- Some providers do not support `json_schema` structured output.
- Use `buffer_streamed_tool_calls=True` when a provider's tool-call stream is unreliable.
- Tracing returns 401 without an OpenAI key.
- LiteLLM usage needs `ModelSettings(include_usage=True)`.
- Chat Completions silently drops Responses-only fields unless `strict_feature_validation=True` is set.
- Whether Sandbox Agents work over Chat Completions models is **not documented**.

### 3.7 Agents SDK (TypeScript) with local models

Use `npm install @openai/agents-extensions` plus an AI SDK provider package, wrapped with the adapter. Alternatively, pass `setDefaultOpenAIClient(client)` or `OpenAIProvider({ baseURL })`.
- Adapter: https://github.com/openai/openai-agents-js/blob/fdaf0a66ca6e9d89498909ad7cf64745630e8afb/docs/src/content/docs/extensions/ai-sdk.mdx
- `baseURL`: https://github.com/openai/openai-agents-js/blob/fdaf0a66ca6e9d89498909ad7cf64745630e8afb/docs/src/content/docs/guides/models.mdx

### 3.8 Agents API, Responses built-ins, ChatGPT Work

No local or third-party model path is documented for any of these (**not found**). The Agents API bills "at the selected model's API rates": https://developers.openai.com/api/docs/guides/agents-api/overview

## 4. For Trent: who would notice each capability

"User" means a small-business, social or creator user. "Dev" means a developer or operator.

| Capability | Who notices | One line | Evidence URL | Read |
|---|---|---|---|---|
| Goal mode, work that runs for hours with automatic continuation (E4, E5) | User | "Give it the outcome and walk away" is the promise a creator buys. | https://learn.chatgpt.com/docs/long-running-work | 2026-09-26 |
| Scheduled tasks and app-event triggers (E10) | User | Weekly posting and reporting without prompting is a headline feature for a small business. | https://learn.chatgpt.com/docs/automations | 2026-09-26 |
| Remote from phone, approve from phone (Remote row) | User | Approving a post or a spend from the phone fits how creators work. | https://learn.chatgpt.com/docs/remote | 2026-09-26 |
| Session resume and fork (E1, E2) | Dev | Users only notice when it fails, as "it forgot what we were doing". | https://learn.chatgpt.com/docs/developer-commands | 2026-09-26 |
| Auto-compaction (E3, E16) | Both | Users see it as the agent getting worse later in a session (issue #4106); developers tune the threshold. | https://developers.openai.com/api/docs/guides/compaction | 2026-09-26 |
| Durable sessions, webhooks, steering (E11, X8) | Dev | Plumbing for long jobs; users see only "it kept going". | https://developers.openai.com/api/docs/guides/agents-api/sessions | 2026-09-26 |
| Hosted sandbox with a 1-hour idle expiry (E12) | Dev | Affects the cost and design of long jobs; invisible to users unless files vanish. | https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted | 2026-09-26 |
| Built-in Browser and Computer Use (T7, T8) | User | "It can do it in my Canva or Shopify tab" is the most visible capability for non-developers. | https://learn.chatgpt.com/docs/browser | 2026-09-26 |
| WebMCP site tools (T9) | User | Faster, more reliable site actions, felt as fewer botched clicks. | https://learn.chatgpt.com/docs/webmcp | 2026-09-26 |
| MCP client with OAuth (T3, T11) | Dev | Users notice only the connector catalogue ("works with my Google Drive"). | https://learn.chatgpt.com/docs/extend/mcp | 2026-09-26 |
| Tool search and deferred loading (T6, T10) | Dev | A cost and quality lever; users feel it as lower cost and fewer wrong-tool mistakes. | https://developers.openai.com/api/docs/guides/tools-tool-search | 2026-09-26 |
| Programmatic Tool Calling (T18) | Dev | Cuts tokens on bulk work such as 200 product rows; users feel speed and price. | https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling | 2026-09-26 |
| Hosted shell and code interpreter (T14, T15) | Dev | Users see "made me a spreadsheet or chart" results, not the container. | https://developers.openai.com/api/docs/guides/tools-shell | 2026-09-26 |
| OS sandbox by default (S1, S2) | Dev | Users notice only when it blocks something or when a rival lacks one and breaks their machine. | https://learn.chatgpt.com/docs/sandboxing | 2026-09-26 |
| Approval modes and auto-review (S6, S7) | User | Fewer "may I?" prompts is directly felt; the approval UX is the product for non-developers. | https://learn.chatgpt.com/docs/permission-modes | 2026-09-26 |
| Placeholder secrets, vaults (S16, S18, S19) | Dev | Users feel it as trust: "it never saw my Stripe key". | https://developers.openai.com/api/docs/guides/agents-api/tools/vaults | 2026-09-26 |
| Environment variables not stripped by default (S10) | Dev | A footgun to avoid copying; invisible until a key leaks. | https://learn.chatgpt.com/docs/config-file/config-advanced | 2026-09-26 |
| Subagents and Ultra (M1, M3, M5) | Both | Users see faster big jobs and larger bills; developers manage concurrency (default 6) and cost. | https://learn.chatgpt.com/docs/agent-configuration/subagents | 2026-09-26 |
| AGENTS.md and project instructions (I1) | Dev | The user-facing equivalent is "brand voice / business profile" settings. | https://learn.chatgpt.com/docs/agent-configuration/agents-md | 2026-09-26 |
| Skills with progressive disclosure (I2) | Both | Users see installable how-tos ("post like me"); developers see the context budget. | https://learn.chatgpt.com/docs/build-skills | 2026-09-26 |
| Memories, off by default and a recall layer only (I3, I4) | User | "It remembers my brand and customers" is felt directly; the opt-in exclusion of external context is a developer concern. | https://learn.chatgpt.com/docs/customization/memories | 2026-09-26 |
| Record & Replay (I6) | User | "Show it once, it does it forever" is the most creator-legible capability on the list. | https://learn.chatgpt.com/docs/extend/record-and-replay | 2026-09-26 |
| Computer History (I5) | User | Powerful but privacy-heavy; creators will notice both the value and the creepiness. | https://learn.chatgpt.com/docs/customization/computer-history | 2026-09-26 |
| Import from Claude Code, Cowork or Cursor (I8) | Both | Removes switching cost; a Trent equivalent (import from ChatGPT/Claude projects) would matter to users. | https://learn.chatgpt.com/docs/import | 2026-09-26 |
| Hooks (X1) | Dev | Invisible to users; lets operators enforce policy and logging. | https://learn.chatgpt.com/docs/hooks | 2026-09-26 |
| Plugins in a universal directory (X2) | User | A single "store" is how non-developers discover capabilities. | https://learn.chatgpt.com/docs/plugins | 2026-09-26 |
| Config layering, managed requirements (X3, S13) | Dev | Matters for agencies and teams running Trent for clients. | https://learn.chatgpt.com/docs/config-file/config-basic | 2026-09-26 |
| Local models via `--oss` (L1–L4) | Both | Users notice "free and private" and also slowness and worse tool use; developers fight the Responses-only and MCP-namespace gaps. | https://learn.chatgpt.com/docs/config-file/config-advanced | 2026-09-26 |
| Agents SDK non-OpenAI adapters (L7, L8) | Dev | A cheap route to mixed providers, but advanced tools switch off. | https://github.com/openai/openai-agents-python/blob/588826c5be27cad21a3067463e21972ffea38561/docs/models/index.md | 2026-09-26 |
| OTel, tracing, usage fields (O1, O5, O7) | Dev | Users see it only as a cost meter; `/status`-style usage display is user-visible. | https://developers.openai.com/api/docs/guides/agents-api/tracing | 2026-09-26 |
| Usage limits and cost spikes (issues #28879, #34035) | User | The most-reacted complaints after platform support are about budget, so predictable cost is a feature. | https://github.com/openai/codex/issues/28879 | 2026-09-26 |
| Evals platform deprecated (O10) | Dev | Trent cannot depend on OpenAI Evals; it needs its own evaluation harness. | https://developers.openai.com/api/docs/deprecations | 2026-09-26 |
| Cadence of about 17 stable releases a month (D3) | Dev | Fast feature flow, but regressions (for example #19871) land on local-model users first. | https://www.npmjs.com/package/@openai/codex | 2026-09-26 |
| Free-tier availability (D6) | User | Codex and Work on the Free plan set the price expectation Trent competes against. | https://learn.chatgpt.com/docs/pricing | 2026-09-26 |

## 5. Corrections to earlier Trent research

- `01_discovery/output/agent-harness-sota-2026-09.md` (item 15) says Codex "disables memory generation for sessions that used web search or MCP". The current config reference makes this opt-in: `memories.disable_on_external_context` defaults to `false` (row I4).
- Codex's Linux sandbox is bubblewrap plus seccomp, and the legacy Landlock path is rejected for filesystem-restricted policies (S2). Any Trent note that says "Codex uses Landlock" is out of date.

## 6. Not found or unverified

- **Whether ChatGPT agent mode has been removed.** The help article (read via reader) still documents it. The claim that it was "removed in August 2026, use Work" appears only in third-party pages and a search snippet. Unverified.
- **Maximum run time of a Codex cloud task.** Not found. The only related figure is the 12-hour container cache.
- **Codex subagent limits.** Maximum nesting depth and the numeric default of `agents.max_concurrent_threads_per_session` (the docs say "Codex chooses the default") were not found.
- **An OpenAI-published list of recommended local models** for Codex beyond the gpt-oss defaults. Not found.
- **Local providers and newer tools.** Whether Codex's `tool_search`, code mode, Browser or Computer Use work with local providers is not documented.
- **Third-party models in the Agents API**, and Agents SDK Sandbox Agents on Chat Completions models. Not found.
- **The "next evolution of the Agents SDK" post** (https://openai.com/index/the-next-evolution-of-the-agents-sdk/) returned 403 and was not read. Sandbox Agents facts come from the SDK docs and API changelog instead.
- **LM Studio's Codex page** was read only through a summarizer, so its exact wording is not quoted.
