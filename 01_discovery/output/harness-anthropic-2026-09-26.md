# Anthropic agent harnesses today: primary-source inventory

Compiled 2026-09-26 for the harness-landscape pass (`docs/sessions/2026-09-26-harness-landscape.md`).
Scope: Claude Code (CLI, desktop, IDE, web and mobile), the Claude Agent SDK, Claude Managed Agents,
Cowork and the Claude Desktop agent features, and the Claude Developer Platform's agent primitives.

**Method.** Primary sources only: code.claude.com/docs (Claude Code and Agent SDK docs, fetched as raw
Markdown from the `llms.txt` index), platform.claude.com/docs (API and Managed Agents), support.claude.com
(Cowork help center), claude.com/docs (Claude Desktop on third-party), anthropic.com/engineering,
claude.com/blog, and the `anthropics/claude-code` GitHub repository (issues, read through the GitHub REST
API). Each row has one URL. Every page was fetched in one pass dated 2026-09-26, the session date; the
machine clock read 2026-09-25 21:00 local. The newest changelog entry seen is v2.1.283, dated
2026-09-25. Where a page didn't load, or something wasn't found, this document says so. Nothing is
inferred from memory.

**Surface codes.** `CC` Claude Code · `SDK` Claude Agent SDK · `MA` Claude Managed Agents ·
`CW` Cowork and Claude Desktop agent features · `API` Claude Developer Platform primitives.
The status (GA, beta, research preview, experimental) is given where the source states one.

---

## 1. Features table

### 1.1 Execution model

| Area | Capability | Evidence URL | Date read |
|---|---|---|---|
| Execution | CC: agentic loop of three blended phases (gather context, take action, verify results), interruptible at any point | https://code.claude.com/docs/en/how-claude-code-works | 2026-09-26 |
| Execution | CC: sessions saved continuously to local `.jsonl` transcripts; `--continue`, `--resume <name/id/path>`, `--from-pr`, `/resume`; since v2.1.223 resume-by-ID searches every project on the machine | https://code.claude.com/docs/en/sessions | 2026-09-26 |
| Execution | CC: `/branch` copies the conversation into a new branch and leaves the original intact | https://code.claude.com/docs/en/sessions | 2026-09-26 |
| Execution | CC: auto-compaction at the model limit (about 967K tokens for native-1M models on the Anthropic API); window settable from 100K to 1M through `/autocompact`, `--autocompact` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | https://code.claude.com/docs/en/model-config | 2026-09-26 |
| Execution | CC: compaction re-injects the project-root CLAUDE.md, auto memory, the plan-mode plan and invoked skills (capped at 5K tokens per skill and 25K in total), re-reads up to 5 recent files, keeps background tasks running, and re-runs `SessionStart` hooks that match `compact` | https://code.claude.com/docs/en/context-window | 2026-09-26 |
| Execution | CC: checkpoints are captured before each prompt; `/rewind` (or Esc Esc) restores code and/or conversation; checkpoints survive resume | https://code.claude.com/docs/en/checkpointing | 2026-09-26 |
| Execution | CC: plan mode (Shift+Tab, `/plan`, `--permission-mode plan`) researches and plans without editing source; where auto mode is available, a classifier reviews shell commands during planning | https://code.claude.com/docs/en/permission-modes | 2026-09-26 |
| Execution | CC: agent view (`claude agents`) dispatches and monitors background sessions that run without an attached terminal | https://code.claude.com/docs/en/agent-view | 2026-09-26 |
| Execution | CC: `claude --worktree <name>` isolates a parallel session in its own git worktree; subagents can use `isolation: worktree`; `EnterWorktree`/`ExitWorktree` tools | https://code.claude.com/docs/en/worktrees | 2026-09-26 |
| Execution | CC: `/goal` sets a completion condition; Claude keeps working until a model judges it met or impossible | https://code.claude.com/docs/en/goal | 2026-09-26 |
| Execution | CC: cloud sessions on Anthropic infrastructure (or an org's self-hosted environment); `claude --cloud` creates one, and `--teleport` pulls a cloud session to the terminal, one way only | https://code.claude.com/docs/en/claude-code-on-the-web | 2026-09-26 |
| Execution | CC: self-hosted environments run cloud sessions and routines inside the org's network (public beta, Team/Enterprise) | https://code.claude.com/docs/en/self-hosted-environments | 2026-09-26 |
| Execution | CC: Remote Control drives a local session from claude.ai/code or the mobile app; execution stays on the local machine | https://code.claude.com/docs/en/remote-control | 2026-09-26 |
| Execution | CC: three scheduling tiers: `/loop` (in session, minimum 1 minute), Desktop scheduled tasks (local, machine on) and Routines (cloud, minimum 1 hour, machine off) | https://code.claude.com/docs/en/scheduled-tasks | 2026-09-26 |
| Execution | CC: Routines bundle a prompt, repositories and connectors, with Scheduled, API (HTTP POST plus bearer token) and GitHub-event triggers (research preview) | https://code.claude.com/docs/en/routines | 2026-09-26 |
| Execution | CC: channels are MCP servers that push events into a running session, optionally two-way (research preview; not available on Bedrock, Vertex or Foundry) | https://code.claude.com/docs/en/channels | 2026-09-26 |
| Execution | CC: Projects (public beta, Pro/Max) are one conversation coordinating a stream of tasks as parallel threads, mostly cloud sessions | https://code.claude.com/docs/en/claude-projects | 2026-09-26 |
| Execution | SDK: sessions support continue, resume and fork (`forkSession` / `fork_session`) | https://code.claude.com/docs/en/agent-sdk/sessions | 2026-09-26 |
| Execution | SDK: a `SessionStore` adapter mirrors transcripts to an object store, KV store or database so another host can resume them | https://code.claude.com/docs/en/agent-sdk/session-storage | 2026-09-26 |
| Execution | SDK: each `query()` spawns a `claude` CLI subprocess over stdio; one session is one long-lived subprocess with local state | https://code.claude.com/docs/en/agent-sdk/hosting | 2026-09-26 |
| Execution | MA: Agent (versioned config), Environment (Anthropic cloud sandbox or self-hosted), Session, and Events over SSE; history is persisted server-side; steer or interrupt mid-run (beta header `managed-agents-2026-04-01`) | https://platform.claude.com/docs/en/managed-agents/overview | 2026-09-26 |
| Execution | MA: stateful by design, so not eligible for ZDR or HIPAA BAA | https://platform.claude.com/docs/en/managed-agents/overview | 2026-09-26 |
| Execution | MA: scheduled deployments take a cron expression and timezone at minute granularity, with a per-run budget and run history (beta) | https://platform.claude.com/docs/en/managed-agents/scheduled-deployments | 2026-09-26 |
| Execution | MA: session budgets are a hard dollar cap enforced at public list rates | https://platform.claude.com/docs/en/managed-agents/budgets | 2026-09-26 |
| Execution | MA: webhooks fire on major session events, so no polling is needed | https://platform.claude.com/docs/en/managed-agents/webhooks | 2026-09-26 |
| Execution | CW: Cowork sessions run in the cloud (beta) in a per-session isolated environment and continue with the laptop closed; local files and the browser are reached through the Desktop app | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | 2026-09-26 |
| Execution | CW: Cowork scheduled tasks run in the cloud with no device online; projects hold their own files, instructions and memory | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | 2026-09-26 |
| Execution | CW: "Claude Cowork is now just Claude": chat and Cowork are merging, rolling out to Pro/Max | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | 2026-09-26 |
| Execution | API: server-side compaction on demand (`compact-2026-09-04`), at a token threshold, and in the background (async); beta | https://platform.claude.com/docs/en/build-with-claude/compaction | 2026-09-26 |
| Execution | API: context editing with the server-side strategies `clear_tool_uses_20250919` and `clear_thinking_20251015` | https://platform.claude.com/docs/en/build-with-claude/context-editing | 2026-09-26 |
| Execution | API: prompt caching, automatic or by explicit breakpoints; 5-minute default TTL, optional 1-hour; reads at 0.1x, writes at 1.25x (5m) or 2x (1h) | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | 2026-09-26 |
| Execution | CC: requests the 1-hour cache TTL by default only on a subscription within included usage; API-key users set `promptCacheTtl: 1h` | https://code.claude.com/docs/en/prompt-caching | 2026-09-26 |
| Execution | API: Message Batches at 50% price; up to 100,000 requests or 256 MB; most finish within 1 hour; expire at 24 hours | https://platform.claude.com/docs/en/build-with-claude/batch-processing | 2026-09-26 |

### 1.2 Tools

| Area | Capability | Evidence URL | Date read |
|---|---|---|---|
| Tools | CC: 46 built-in tools listed, including Bash, PowerShell, Read/Write/Edit, Glob/Grep (absent by default on macOS/Linux/WSL), LSP, Monitor (commands or WebSocket as event streams), WebFetch, WebSearch, Agent, Workflow, Skill, the Task* and Cron* tools, SendMessage/ListAgents, PushNotification, SendUserFile, Artifact and RemoteTrigger | https://code.claude.com/docs/en/tools-reference | 2026-09-26 |
| Tools | CC: MCP client over stdio, HTTP, SSE and WebSocket; local/project/user scopes; OAuth; elicitation; resources; auto-reconnect; long tool calls backgrounded automatically | https://code.claude.com/docs/en/mcp | 2026-09-26 |
| Tools | CC: MCP server mode, where `claude mcp serve` exposes Claude Code as a stdio MCP server | https://code.claude.com/docs/en/mcp | 2026-09-26 |
| Tools | CC: tool search defers MCP tool definitions (only names and server instructions load); no fixed per-server cap | https://code.claude.com/docs/en/mcp | 2026-09-26 |
| Tools | CC: tool search is off by default when `ANTHROPIC_BASE_URL` points at a non-first-party host (`ENABLE_TOOL_SEARCH=true` turns it back on) | https://code.claude.com/docs/en/env-vars | 2026-09-26 |
| Tools | CC: computer use from the CLI (macOS research preview; Pro/Max only; interactive sessions only) | https://code.claude.com/docs/en/computer-use | 2026-09-26 |
| Tools | CC Desktop: computer use can run in the background on macOS (beta, Pro/Max) | https://code.claude.com/docs/en/whats-new/2026-w36 | 2026-09-26 |
| Tools | CC: Chrome integration through the Claude in Chrome extension; shares browser login state; pauses for login or CAPTCHA | https://code.claude.com/docs/en/chrome | 2026-09-26 |
| Tools | SDK: custom tools as an in-process MCP server (`createSdkMcpServer` / `create_sdk_mcp_server`) | https://code.claude.com/docs/en/agent-sdk/custom-tools | 2026-09-26 |
| Tools | SDK: tool search scales to thousands of tools | https://code.claude.com/docs/en/agent-sdk/tool-search | 2026-09-26 |
| Tools | MA: agent toolset of bash, read, write, edit, glob, grep, web_fetch and web_search; outputs over 100,000 characters spill to a sandbox file | https://platform.claude.com/docs/en/managed-agents/tools | 2026-09-26 |
| Tools | MA: MCP servers attached per agent; MCP toolsets default to `always_ask` | https://platform.claude.com/docs/en/managed-agents/mcp-connector | 2026-09-26 |
| Tools | API/MA: MCP tunnels reach private-network MCP servers over an outbound-only link (research preview; Cloudflare transport) | https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview | 2026-09-26 |
| Tools | CW: browser actions through a browser built into Claude Desktop or through Claude in Chrome; the Chrome side panel runs Cowork sessions | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | 2026-09-26 |
| Tools | API: the tool runner (beta) handles the loop in the Python, TypeScript, C#, Go, Java, PHP and Ruby SDKs | https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner | 2026-09-26 |
| Tools | API: computer use toolset `computer_toolset_20260801`, 17 member tools, client-executed, GA; not available in Managed Agents | https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool | 2026-09-26 |
| Tools | API: browser use toolset `browser_toolset_20260801`, 27 member tools plus 4 optional, client-run, GA | https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool | 2026-09-26 |
| Tools | API: tool search tool (regex and BM25); about 55K tokens of definitions cut by more than 85% | https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool | 2026-09-26 |
| Tools | API: programmatic tool calling, where Claude writes code in the code-execution container that calls your tools (GA; needs `code_execution_20260120`) | https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling | 2026-09-26 |
| Tools | API: MCP connector calls remote MCP servers directly from the Messages API (`mcp-client-2025-11-20`, beta) | https://platform.claude.com/docs/en/agents-and-tools/mcp-connector | 2026-09-26 |
| Tools | API: advisor tool, where a cheaper executor consults a stronger advisor model mid-generation, server-side | https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool | 2026-09-26 |
| Tools | CC: advisor is experimental and Anthropic API only (not Bedrock, Vertex, Foundry or AWS) | https://code.claude.com/docs/en/advisor | 2026-09-26 |

### 1.3 Safety and permissions

| Area | Capability | Evidence URL | Date read |
|---|---|---|---|
| Safety | CC: six permission modes: `default` (Manual), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`; deny rules block in every mode, bypass included | https://code.claude.com/docs/en/permission-modes | 2026-09-26 |
| Safety | CC: auto mode, in which a separate classifier model blocks actions that escalate beyond the request, touch unrecognized infrastructure, or appear driven by hostile content; it is the starting mode on Pro/Max/Team; requires Opus/Sonnet 4.6+ or Fable on the Anthropic API | https://code.claude.com/docs/en/permission-modes | 2026-09-26 |
| Safety | CC: server-side classifier review inside model requests; an action with no verdict is denied rather than run unreviewed | https://code.claude.com/docs/en/permission-modes | 2026-09-26 |
| Safety | CC: never auto-approved in any mode: explicit ask rules, AskUserQuestion, `requiresUserInteraction` MCP tools, critical-path `rm`/`rmdir` | https://code.claude.com/docs/en/permission-modes | 2026-09-26 |
| Safety | CC: OS-enforced Bash sandbox (Seatbelt on macOS, bubblewrap on Linux/WSL2) covering filesystem and network for Bash, PowerShell, Monitor and their child processes; native Windows unsupported | https://code.claude.com/docs/en/sandboxing | 2026-09-26 |
| Safety | CC: network isolation through a proxy outside the sandbox; no domains pre-allowed; `strictAllowlist`; managed `allowManagedDomainsOnly` | https://code.claude.com/docs/en/sandboxing | 2026-09-26 |
| Safety | CC: credential masking, where sandboxed commands see a per-session sentinel and the proxy swaps in the real secret only on requests to `injectHosts` (v2.1.199+, needs TLS termination) | https://code.claude.com/docs/en/sandboxing | 2026-09-26 |
| Safety | CC: sandboxing cut permission prompts by 84% (Anthropic's own measurement); runtime open-sourced as `anthropic-experimental/sandbox-runtime` | https://www.anthropic.com/engineering/claude-code-sandboxing | 2026-09-26 |
| Safety | CC: isolation options compared: per-command sandbox, dev containers, custom containers, VMs | https://code.claude.com/docs/en/sandbox-environments | 2026-09-26 |
| Safety | CC: hooks as guards: `PreToolUse` can block; `PermissionRequest`; `PermissionDenied` for auto-mode denials | https://code.claude.com/docs/en/hooks | 2026-09-26 |
| Safety | CC: restricted mode (`--restricted`) removes the command- and code-running tools and WebFetch and confines the file tools (v2.1.248) | https://code.claude.com/docs/en/whats-new/2026-w35 | 2026-09-26 |
| Safety | CC: model lockdown via managed settings: `deniedModels` blocks specific models, and `availableModelsMatch: "exact"` keeps new model releases blocked until they're listed (v2.1.283) | https://code.claude.com/docs/en/changelog | 2026-09-26 |
| Safety | CC cloud: per-environment network access levels (for example Trusted); an agent proxy attaches credentials only to listed hosts | https://code.claude.com/docs/en/cloud-environments | 2026-09-26 |
| Safety | SDK: `canUseTool` callback for runtime approvals; ask rules route to it even in `bypassPermissions` | https://code.claude.com/docs/en/agent-sdk/permissions | 2026-09-26 |
| Safety | SDK: secure deployment pattern with an egress proxy for domain allowlists and credential injection outside the container | https://code.claude.com/docs/en/agent-sdk/secure-deployment | 2026-09-26 |
| Safety | MA: permission policies `always_allow`, `always_ask` and `auto` (the server runs, denies or pauses each call); the agent toolset defaults to allow, MCP defaults to ask | https://platform.claude.com/docs/en/managed-agents/permission-policies | 2026-09-26 |
| Safety | MA: vaults register per-user credentials once and reference them by ID per session; OAuth refresh (beta) | https://platform.claude.com/docs/en/managed-agents/vaults | 2026-09-26 |
| Safety | MA: self-hosted sandboxes keep tool execution, files and network egress on your own infrastructure | https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes | 2026-09-26 |
| Safety | CW: Manual, Auto and Skip modes; Auto reviews each action for exfiltration and prompt injection and falls back to asking after repeated blocks; per-connector Always allow / Needs approval / Blocked; explicit prompt before permanent deletion | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | 2026-09-26 |
| Safety | CW: the cloud environment is created per session, can't reach home or company networks, and is removed afterwards | https://support.claude.com/en/articles/13364135-use-claude-cowork-safely | 2026-09-26 |

### 1.4 Multi-agent

| Area | Capability | Evidence URL | Date read |
|---|---|---|---|
| Multi-agent | CC: subagents get their own context, system prompt, tools and permissions; defined as Markdown with frontmatter in user, project or plugin scope; built-ins Explore and Plan skip CLAUDE.md | https://code.claude.com/docs/en/sub-agents | 2026-09-26 |
| Multi-agent | CC: nested subagents up to 3 layers (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`); 20 running at once (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) | https://code.claude.com/docs/en/sub-agents | 2026-09-26 |
| Multi-agent | CC: fork (`/subtask`) is a subagent that inherits the full conversation and runs in the background; fork mode is on by default in interactive sessions | https://code.claude.com/docs/en/sub-agents | 2026-09-26 |
| Multi-agent | CC: dynamic workflows, where Claude writes a JS orchestration script and the runtime executes it; 16 concurrent agents by default (configurable 1 to 256), 1,000 agents per run, 4,096 items per `parallel()`; resumable; shippable in plugins | https://code.claude.com/docs/en/workflows | 2026-09-26 |
| Multi-agent | CC: agent teams, a lead plus teammates with a shared task list and direct messaging; experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | https://code.claude.com/docs/en/agent-teams | 2026-09-26 |
| Multi-agent | CC: cross-session messaging (`ListAgents` plus `SendMessage`) across your sessions, locally, on other machines or in the cloud (v2.1.224+) | https://code.claude.com/docs/en/cross-session-messaging | 2026-09-26 |
| Multi-agent | CC: the auto-mode classifier also reviews each `SendMessage` to another agent before delivery (v2.1.222+) | https://code.claude.com/docs/en/permission-modes | 2026-09-26 |
| Multi-agent | CC: ultrareview runs a fleet of reviewer agents in a cloud sandbox (`/code-review ultra`, research preview) | https://code.claude.com/docs/en/ultrareview | 2026-09-26 |
| Multi-agent | SDK: subagents defined programmatically to isolate context and run in parallel | https://code.claude.com/docs/en/agent-sdk/subagents | 2026-09-26 |
| Multi-agent | MA: a coordinator plus agents in context-isolated session threads that share the sandbox, filesystem and vaults; threads persist, so follow-ups keep their history | https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration | 2026-09-26 |
| Multi-agent | MA: outcomes, where a rubric plus an automatically provisioned grader in a separate context window drives iteration until the outcome is met | https://platform.claude.com/docs/en/managed-agents/define-outcomes | 2026-09-26 |
| Multi-agent | CW: Cowork splits work into subtasks and coordinates parallel sub-agents | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | 2026-09-26 |

### 1.5 Memory and instructions

| Area | Capability | Evidence URL | Date read |
|---|---|---|---|
| Memory | CC: CLAUDE.md in four scopes (managed policy, user, project, local); ancestor files load at launch and subdirectory files on demand; `@` imports | https://code.claude.com/docs/en/memory | 2026-09-26 |
| Memory | CC: `.claude/rules/` topic files, scoped to paths through `paths:` frontmatter | https://code.claude.com/docs/en/memory | 2026-09-26 |
| Memory | CC: AGENTS.md read directly when no CLAUDE.md exists (v2.1.277+) | https://code.claude.com/docs/en/memory | 2026-09-26 |
| Memory | CC: auto memory, on by default; types user, feedback, project and reference; `MEMORY.md` index plus topic files under `~/.claude/projects/<project>/memory/`, shared across worktrees | https://code.claude.com/docs/en/memory | 2026-09-26 |
| Memory | CC: skills are `SKILL.md` files on the Agent Skills open standard (agentskills.io); the body loads only on use; custom commands merged into skills; skills can run in a subagent; dynamic context injection | https://code.claude.com/docs/en/skills | 2026-09-26 |
| Memory | SDK: `settingSources` controls whether CLAUDE.md, settings, skills and agents load; by default the SDK loads the same sources as the CLI | https://code.claude.com/docs/en/agent-sdk/claude-code-features | 2026-09-26 |
| Memory | MA: memory stores mounted at `/mnt/memory/<slug>`, read_only or read_write; every write creates an immutable version, and versions can be redacted | https://platform.claude.com/docs/en/managed-agents/memory | 2026-09-26 |
| Memory | MA: dreams consolidate a memory store plus 1 to 100 past sessions into a new, deduplicated store; the input is never modified (research preview) | https://platform.claude.com/docs/en/managed-agents/dreams | 2026-09-26 |
| Memory | MA: skills attached to agents, including skills loaded from a GitHub repository | https://platform.claude.com/docs/en/managed-agents/skills | 2026-09-26 |
| Memory | CW: in cloud sessions Cowork shares memory with chat; projects carry their own memory | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | 2026-09-26 |
| Memory | API: memory tool `memory_20250818`, client-side file operations on storage you control | https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool | 2026-09-26 |
| Memory | API: Skills API for uploading and versioning skills | https://platform.claude.com/docs/en/build-with-claude/skills-guide | 2026-09-26 |

### 1.6 Extensibility

| Area | Capability | Evidence URL | Date read |
|---|---|---|---|
| Extensibility | CC: 33 hook events (SessionStart, Setup, InstructionsLoaded, UserPromptSubmit, UserPromptExpansion, MessageDisplay, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, PostToolBatch, PermissionDenied, Notification, SubagentStart/Stop, TaskCreated/Completed, Stop, StopFailure, TeammateIdle, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate/Remove, PreCompact, PostCompact, Pre/PostModelSwitch, SessionEnd, Elicitation, ElicitationResult) | https://code.claude.com/docs/en/hooks | 2026-09-26 |
| Extensibility | CC: five hook handler types: `command`, `http`, `mcp_tool`, `prompt` (single-turn model judgment) and `agent` (a tool-using verifier, experimental); async hooks | https://code.claude.com/docs/en/hooks | 2026-09-26 |
| Extensibility | CC: plugins bundle skills, agents, hooks and MCP servers as one unit; installed from marketplaces through `/plugin` | https://code.claude.com/docs/en/plugins/overview | 2026-09-26 |
| Extensibility | CC: three Anthropic marketplaces (official, community, demo), each a GitHub repository | https://code.claude.com/docs/en/plugins/anthropic-marketplaces | 2026-09-26 |
| Extensibility | CC: settings precedence is managed > CLI flags > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`; list values merge | https://code.claude.com/docs/en/settings | 2026-09-26 |
| Extensibility | CC: output styles, four built in (Proactive, Concise, Explanatory, Learning) plus custom ones | https://code.claude.com/docs/en/output-styles | 2026-09-26 |
| Extensibility | CC: the claude.ai and Cowork plugin surface is separate from Claude Code's and documented on claude.com | https://code.claude.com/docs/en/plugins/overview | 2026-09-26 |
| Extensibility | SDK: hooks as in-process callbacks | https://code.claude.com/docs/en/agent-sdk/hooks | 2026-09-26 |
| Extensibility | SDK: plugins load in the SDK | https://code.claude.com/docs/en/agent-sdk/plugins | 2026-09-26 |
| Extensibility | SDK: branding rule: products must not appear to be Claude Code | https://code.claude.com/docs/en/agent-sdk/overview | 2026-09-26 |
| Extensibility | SDK: no claude.ai login or plan rate limits in third-party products unless pre-approved | https://code.claude.com/docs/en/agent-sdk/quickstart | 2026-09-26 |
| Extensibility | CC: artifacts publish a live HTML page from a session to a private claude.ai URL (paid plans) | https://code.claude.com/docs/en/artifacts | 2026-09-26 |

### 1.7 Model providers and local models (details in section 3)

| Area | Capability | Evidence URL | Date read |
|---|---|---|---|
| Models | CC: model can be an alias or a name: an Anthropic API model name, a Bedrock inference-profile ARN, a Foundry deployment name or a Vertex version name | https://code.claude.com/docs/en/model-config | 2026-09-26 |
| Models | CC: `ANTHROPIC_BASE_URL` "changes where requests are sent, not which model answers them" | https://code.claude.com/docs/en/model-config | 2026-09-26 |
| Models | CC: Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" | https://code.claude.com/docs/en/llm-gateway | 2026-09-26 |
| Models | CC: gateway API formats: Anthropic Messages (`ANTHROPIC_BASE_URL`), Bedrock InvokeModel and Vertex rawPredict; for Anthropic Messages, Claude Code "can't tell which upstream you forward to" | https://code.claude.com/docs/en/llm-gateway-protocol | 2026-09-26 |
| Models | SDK: third-party authentication is documented only for Bedrock, Claude Platform on AWS, Google Cloud Agent Platform and Microsoft Foundry | https://code.claude.com/docs/en/agent-sdk/quickstart | 2026-09-26 |
| Models | MA: "Claude 4.5 and later models are supported" | https://platform.claude.com/docs/en/managed-agents/agent-setup | 2026-09-26 |
| Models | CW/Desktop on 3P: routes inference to Vertex, Bedrock, Foundry, the Anthropic API, or a self-hosted gateway that implements the Anthropic Messages API "to use Claude models" | https://claude.com/docs/third-party/claude-desktop/gateway | 2026-09-26 |

### 1.8 Observability, cost and evals

| Area | Capability | Evidence URL | Date read |
|---|---|---|---|
| Observability | CC: OpenTelemetry metrics (`claude_code.session.count`, `lines_of_code.count`, `pull_request.count`, `commit.count`, `cost.usage`, `token.usage`, `code_edit_tool.decision`, `active_time.total`), events over logs, traces (beta), mTLS; managed settings can lock the OTLP destination | https://code.claude.com/docs/en/monitoring-usage | 2026-09-26 |
| Observability | CC: `/usage` shows a session cost estimated locally at list price (or at the org's `modelPricing`), plan usage bars and usage credits | https://code.claude.com/docs/en/costs | 2026-09-26 |
| Observability | CC: analytics dashboards for org adoption and contribution metrics | https://code.claude.com/docs/en/analytics | 2026-09-26 |
| Observability | CC: every enabled plugin's skill, agent and command descriptions cost tokens each session; a guide measures and reduces this | https://code.claude.com/docs/en/plugins/measure | 2026-09-26 |
| Observability | CC: `claude plugin eval` scores cases with graders (regex, tool-called, model rubric), compares against a no-plugin baseline and gates CI; `init` drafts the suite (v2.1.269) | https://code.claude.com/docs/en/plugin-evals | 2026-09-26 |
| Observability | CC: skill-creator evals for single skills; `/skill-doctor` finds unused skills | https://code.claude.com/docs/en/skills | 2026-09-26 |
| Observability | SDK: OpenTelemetry export of traces, metrics and events | https://code.claude.com/docs/en/agent-sdk/observability | 2026-09-26 |
| Observability | SDK: `total_cost_usd` is a client-side estimate from a bundled price table, not billing data | https://code.claude.com/docs/en/agent-sdk/cost-tracking | 2026-09-26 |
| Observability | MA: Console session viewer shows status, token usage, cost and a per-thread timeline | https://platform.claude.com/docs/en/managed-agents/events-and-streaming | 2026-09-26 |
| Observability | MA: `ant beta:sessions connect` attaches a terminal to a live session to watch, message, or allow/deny tools | https://platform.claude.com/docs/en/cli-sdks-libraries/cli/sessions-connect | 2026-09-26 |
| Observability | CW: a Cowork-specific telemetry or eval surface was not found | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | 2026-09-26 |

### 1.9 Distribution

| Area | Capability | Evidence URL | Date read |
|---|---|---|---|
| Distribution | CC: native installer (`curl -fsSL https://claude.ai/install.sh \| bash`; PowerShell on Windows); native installs auto-update in the background | https://code.claude.com/docs/en/setup | 2026-09-26 |
| Distribution | CC: Homebrew casks `claude-code` (stable) and `claude-code@latest`, WinGet, apt/dnf/apk; none of these auto-update by default | https://code.claude.com/docs/en/setup | 2026-09-26 |
| Distribution | CC: the npm package installs the same native binary through per-platform optional dependencies (8 platforms; Node 22+) | https://code.claude.com/docs/en/setup | 2026-09-26 |
| Distribution | CC: release channels `latest` and `stable` (about one week behind, skipping major regressions); `minimumVersion`; `DISABLE_AUTOUPDATER` | https://code.claude.com/docs/en/setup | 2026-09-26 |
| Distribution | CC: a GPG-signed `manifest.json` lists SHA256 checksums for every binary | https://code.claude.com/docs/en/setup | 2026-09-26 |
| Distribution | CC cadence: 405 changelog entries; 20 to 28 releases per month in 2026; 24 releases from Sep 1 to Sep 25 (v2.1.257 to v2.1.283) | https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md | 2026-09-26 |
| Distribution | CC: weekly "What's new" digests | https://code.claude.com/docs/en/whats-new/2026-w37 | 2026-09-26 |
| Distribution | CC Desktop app for macOS and Windows; Linux in beta (Ubuntu/Debian) | https://code.claude.com/docs/en/desktop-linux | 2026-09-26 |
| Distribution | CC IDE: VS Code extension | https://code.claude.com/docs/en/vs-code | 2026-09-26 |
| Distribution | CC IDE: JetBrains plugin | https://code.claude.com/docs/en/jetbrains | 2026-09-26 |
| Distribution | CC mobile: the iOS/Android app is a client for cloud sessions and Remote Control, and no code runs on the phone | https://code.claude.com/docs/en/mobile | 2026-09-26 |
| Distribution | CC Slack: the earlier Claude Code in Slack is being retired for Team/Enterprise in favour of Claude Tag (the Claude Tag page itself returned 403 and wasn't read) | https://code.claude.com/docs/en/slack | 2026-09-26 |
| Distribution | SDK: bundles the native Claude Code binary as an optional dependency, with the SDK version tracking the CLI (v0.3.191 bundles v2.1.191) | https://code.claude.com/docs/en/agent-sdk/typescript | 2026-09-26 |
| Distribution | SDK: semver; take patch releases continuously and read the changelog before a minor | https://code.claude.com/docs/en/agent-sdk/hosting | 2026-09-26 |
| Distribution | CW: Cowork on Desktop (macOS/Windows, all paid plans), web and mobile (Pro/Max/Team), and the Chrome side panel (Max/Team) | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | 2026-09-26 |

---

## 2. Ten distinctive capabilities

1. **A classifier model replaces most approval prompts, and fails closed.** Auto mode sends actions
   to a second model that blocks scope escalation, unknown infrastructure and injection-driven actions.
   It is the default start mode on Pro, Max and Team. Server-side review returns a verdict per action,
   and an action without a verdict is denied rather than run. The same classifier reviews messages
   between agents. https://code.claude.com/docs/en/permission-modes
2. **An OS-enforced sandbox that masks credentials.** Seatbelt or bubblewrap confine Bash and its
   children, and a proxy enforces domain allowlists. Sandboxed commands see only a sentinel, and the
   proxy substitutes the real secret on allowed hosts. Anthropic measured 84% fewer prompts and
   open-sourced the runtime. https://code.claude.com/docs/en/sandboxing ·
   https://www.anthropic.com/engineering/claude-code-sandboxing
3. **Orchestration as a rerunnable script.** In dynamic workflows the plan moves out of the context
   window into JS that the runtime executes: 16 to 256 concurrent agents, up to 1,000 agents per run,
   resumable, and distributable in plugins. https://code.claude.com/docs/en/workflows
4. **Four distinct multi-agent shapes in one product.** Subagents (nesting to 3 layers, 20 at once),
   forks that inherit the whole conversation, experimental agent teams with a shared task list, and
   cross-session messaging between independent sessions. https://code.claude.com/docs/en/agents ·
   https://code.claude.com/docs/en/sub-agents
5. **Hooks cover the whole lifecycle, and some handlers are models.** There are 33 events. Handlers
   can be a shell command, an HTTP endpoint, an MCP tool, a single-turn prompt judgment, or a
   tool-using verifier agent, and all matching handlers run in parallel.
   https://code.claude.com/docs/en/hooks
6. **Compaction that restores what matters.** After a summary, Claude Code re-injects the project
   CLAUDE.md, auto memory, the approved plan and invoked skills within fixed budgets, and re-reads the
   five most recent files. The API exposes on-demand, threshold and background compaction for custom
   loops. https://code.claude.com/docs/en/context-window ·
   https://platform.claude.com/docs/en/build-with-claude/compaction
7. **A session isn't tied to a device.** Work moves between the terminal and the cloud
   (`--cloud`/`--teleport`), a phone drives a local session through Remote Control, Desktop resumes CLI
   sessions, and cloud sessions continue with the laptop shut. Cowork uses the same cloud-first model
   for non-coders. https://code.claude.com/docs/en/claude-code-on-the-web ·
   https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
8. **Scheduling at four levels.** In-session `/loop` (1 minute), Desktop tasks (local), cloud Routines
   with schedule, API and GitHub triggers, and Managed Agents scheduled deployments with per-run dollar
   budgets. https://code.claude.com/docs/en/scheduled-tasks ·
   https://platform.claude.com/docs/en/managed-agents/scheduled-deployments
9. **A hosted harness with a grader and auditable memory.** In Managed Agents, an outcome
   automatically provisions a grader in a separate context window. Memory stores are mounted
   directories with immutable, redactable versions, and dreams consolidate memory from past sessions.
   https://platform.claude.com/docs/en/managed-agents/define-outcomes ·
   https://platform.claude.com/docs/en/managed-agents/memory
10. **Extensions are measured, not just installed.** `claude plugin eval` scores a plugin against a
    no-plugin baseline and gates CI. Plugin token overhead is documented and measurable, and skills
    follow the cross-vendor Agent Skills standard. https://code.claude.com/docs/en/plugin-evals ·
    https://code.claude.com/docs/en/plugins/measure

---

## 3. Local models

**Short answer: there is no first-party path to local or non-Claude models in any Anthropic harness.
There is one wire-level seam, the Anthropic Messages format behind `ANTHROPIC_BASE_URL`. Anthropic
documents that seam and explicitly doesn't support using it for non-Claude models.**

### 3.1 Claude Code (CLI, IDE, Desktop Code tab)

| Finding | Evidence URL | Date read |
|---|---|---|
| Supported providers: Anthropic API, Amazon Bedrock, Claude Platform on AWS, Google Cloud Agent Platform (formerly Vertex AI) and Microsoft Foundry, plus the Claude apps gateway, which adds IdP sign-in in front of those providers or the Anthropic API | https://code.claude.com/docs/en/third-party-integrations | 2026-09-26 |
| A gateway must expose one of three formats: Anthropic Messages (`/v1/messages`, set with `ANTHROPIC_BASE_URL`), Bedrock InvokeModel, or Vertex rawPredict. Streaming is required; buffering stalls Claude Code | https://code.claude.com/docs/en/llm-gateway-protocol | 2026-09-26 |
| On the Anthropic Messages format, Claude Code "treats the gateway as the Claude API and can't tell which upstream you forward to" | https://code.claude.com/docs/en/llm-gateway-protocol | 2026-09-26 |
| Policy: Anthropic "doesn't endorse, maintain, or audit third-party gateway products, and doesn't support routing Claude Code to non-Claude models through any gateway" | https://code.claude.com/docs/en/llm-gateway | 2026-09-26 |
| "`ANTHROPIC_BASE_URL` changes where requests are sent, not which model answers them" | https://code.claude.com/docs/en/model-config | 2026-09-26 |
| Behind a custom `ANTHROPIC_BASE_URL`, Claude Code passes any model string through without checking it; `ANTHROPIC_CUSTOM_MODEL_OPTION` accepts "any string your API endpoint accepts" | https://code.claude.com/docs/en/model-config | 2026-09-26 |
| Unknown model IDs are assumed to have a 200K window (1M with `[1m]`); fix this with `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, or set `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` to compact only after a too-long error | https://code.claude.com/docs/en/model-config | 2026-09-26 |
| Capability shim for unknown IDs: `behavesAs` on a `modelPicker` option applies a known Claude model's capabilities and effort defaults to that entry (v2.1.257+); `modelOverrides` maps model IDs to a provider's own IDs | https://code.claude.com/docs/en/settings-reference | 2026-09-26 |
| Gateway model discovery (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, `GET /v1/models`) keeps only IDs containing `claude` or `anthropic` | https://code.claude.com/docs/en/llm-gateway-protocol | 2026-09-26 |
| What a non-first-party base URL loses: Remote Control and server-managed settings are off whatever the gateway forwards; Advisor works only if the gateway forwards requests intact to the Anthropic API | https://code.claude.com/docs/en/feature-availability | 2026-09-26 |
| MCP tool search is off by default when `ANTHROPIC_BASE_URL` is non-first-party | https://code.claude.com/docs/en/env-vars | 2026-09-26 |
| The fast-mode availability check and the WebFetch domain-safety check call `api.anthropic.com` directly, not through `ANTHROPIC_BASE_URL` | https://code.claude.com/docs/en/llm-gateway-protocol | 2026-09-26 |
| Auto mode needs specific Claude models (Opus/Sonnet 4.6+ or Fable on the Anthropic API) | https://code.claude.com/docs/en/permission-modes | 2026-09-26 |
| Subscription-only surfaces (cloud sessions, Desktop, Routines, Remote Control, Chrome, computer use, artifacts) aren't reachable from a third-party provider | https://code.claude.com/docs/en/feature-availability | 2026-09-26 |
| Anthropic's self-hosted "Claude apps gateway" ships inside the `claude` binary (`claude gateway --config gateway.yaml`) and fronts Claude upstreams (Bedrock, Claude Platform on AWS, Google Cloud, Foundry) | https://code.claude.com/docs/en/claude-apps-gateway | 2026-09-26 |
| Community demand exists but is unmet: per-agent provider routing so subagents can use local Ollama (open, 48 reactions) | https://github.com/anthropics/claude-code/issues/38698 | 2026-09-26 |
| Community reports of local-model breakage: #92449 (unrecognized Ollama models misread capabilities without `behavesAs`), #51239 (hangs with local Ollama), #85499 (auto-compaction ends sessions on third-party models) | https://github.com/anthropics/claude-code/issues/92449 | 2026-09-26 |

### 3.2 Claude Agent SDK

| Finding | Evidence URL | Date read |
|---|---|---|
| The SDK isn't a model-agnostic library: `query()` spawns the bundled `claude` binary as a subprocess, so it inherits Claude Code's provider logic exactly | https://code.claude.com/docs/en/agent-sdk/hosting | 2026-09-26 |
| The provider can't be plugged in through code. No provider or model-client interface appears in the options table; `model` is documented as a "Claude model alias or full model name" | https://code.claude.com/docs/en/agent-sdk/typescript | 2026-09-26 |
| Provider selection is by environment variable only: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_VERTEX` or `CLAUDE_CODE_USE_FOUNDRY` | https://code.claude.com/docs/en/agent-sdk/quickstart | 2026-09-26 |
| `ANTHROPIC_BASE_URL` in `env` is documented for gateways and for credential-injecting proxies, not for other models | https://code.claude.com/docs/en/agent-sdk/configuration | 2026-09-26 |
| `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` lets an embedding host own provider routing, still over the same providers | https://code.claude.com/docs/en/env-vars | 2026-09-26 |
| Usage entries name the serving provider as one of `firstParty`, `bedrock`, `vertex`, `foundry`, `anthropicAws`, `mantle` or `gateway`; there is no local value | https://code.claude.com/docs/en/agent-sdk/typescript | 2026-09-26 |

### 3.3 Managed Agents, Cowork and Desktop, and the platform

| Finding | Evidence URL | Date read |
|---|---|---|
| Managed Agents supports Claude 4.5 and later models only. Self-hosted sandboxes move tool execution to your infrastructure, but inference stays with Anthropic | https://platform.claude.com/docs/en/managed-agents/agent-setup | 2026-09-26 |
| Claude Desktop on 3P can use a self-hosted gateway (for example LiteLLM or Portkey) that implements the Anthropic Messages API, documented as "to use Claude models" | https://claude.com/docs/third-party/claude-desktop/gateway | 2026-09-26 |
| Cowork: no local or third-party model path was found in the Cowork help articles. Cowork on 3P exists only through Claude Desktop on 3P, which is Claude-only | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | 2026-09-26 |
| Client SDK tool runner and the API primitives: the docs describe them only against the Claude API and cloud providers. A documented non-Claude backend was not found | https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner | 2026-09-26 |

**What this means for Trent.** A harness whose users bring their own local model can't be built on
the Agent SDK or Managed Agents with Anthropic's support. The only mechanical option is an
Anthropic-Messages-compatible shim behind `ANTHROPIC_BASE_URL`. That option is unsupported, loses
auto mode, tool search defaults, Remote Control and the subscription surfaces, and has open community
bugs around capability detection and compaction. A local-model feature in Trent should therefore sit
behind Trent's own model gateway contract rather than inherit Anthropic's harness.

---

## 4. Known complaints: most-reacted issues in anthropics/claude-code

Reaction totals come from the GitHub REST API (`sort=reactions`) on 2026-09-26.

| Issue | Reactions | State | Complaint | Evidence URL | Date read |
|---|---:|---|---|---|---|
| #6235 | 6,680 | closed | Support AGENTS.md (now read directly from v2.1.277) | https://github.com/anthropics/claude-code/issues/6235 | 2026-09-26 |
| #42796 | 3,287 | closed | "Unusable for complex engineering tasks with the Feb updates": ignores instructions, false completion claims | https://github.com/anthropics/claude-code/issues/42796 | 2026-09-26 |
| #45596 | 2,095 | open | "Bring Back Buddy", a community plea for a removed feature | https://github.com/anthropics/claude-code/issues/45596 | 2026-09-26 |
| #17118 | 1,416 | closed | Max plan blocked for third-party harness OpenCode | https://github.com/anthropics/claude-code/issues/17118 | 2026-09-26 |
| #3382 | 1,371 | closed | Sycophancy ("You're absolutely right!") | https://github.com/anthropics/claude-code/issues/3382 | 2026-09-26 |
| #36151 / #18435 | 1,023 / 991 | open | Multi-account switching on mobile and in Desktop | https://github.com/anthropics/claude-code/issues/18435 | 2026-09-26 |
| #3648 / #826 / #1913 / #769 | 836 / 822 / 321 / 335 | mixed | Terminal scrolling and flicker during output | https://github.com/anthropics/claude-code/issues/826 | 2026-09-26 |
| #16157 | 726 | open | Instantly hitting usage limits on Max | https://github.com/anthropics/claude-code/issues/16157 | 2026-09-26 |
| #38335 | 545 | open | Max session limits exhausted abnormally fast since 2026-03-23 | https://github.com/anthropics/claude-code/issues/38335 | 2026-09-26 |
| #53262 | 533 | closed | `HERMES.md` in commit messages routed requests to extra-usage billing | https://github.com/anthropics/claude-code/issues/53262 | 2026-09-26 |
| #46829 | 341 | closed | Cache TTL silently regressed from 1h to 5m, inflating quota and cost | https://github.com/anthropics/claude-code/issues/46829 | 2026-09-26 |
| #77136 | 575 | open | Newer models default to repetitive rhetorical tics | https://github.com/anthropics/claude-code/issues/77136 | 2026-09-26 |
| #1455 | 451 | open | Doesn't respect the XDG Base Directory spec | https://github.com/anthropics/claude-code/issues/1455 | 2026-09-26 |
| #22543 | 264 | open | Cowork creates a 10 GB VM bundle that degrades performance | https://github.com/anthropics/claude-code/issues/22543 | 2026-09-26 |
| #6686 | 552 | closed | Add Agent Client Protocol (ACP) support | https://github.com/anthropics/claude-code/issues/6686 | 2026-09-26 |

The recurring themes are model-quality regressions, opaque usage limits and billing, terminal rendering,
account switching, and lock-in (AGENTS.md, OpenCode, ACP, local models).

---

## 5. For Trent: who would notice each capability

`Creator` means a small-business, social or creator user. `Dev` means a developer.

| Capability | Who notices | One line | Evidence URL |
|---|---|---|---|
| Cloud sessions that continue with the laptop closed | Creator + Dev | Creators feel it directly as "hand it off and walk away" | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork |
| Scheduled tasks and routines | Creator | Daily posts, reports and inbox sweeps are the headline creator use | https://code.claude.com/docs/en/scheduled-tasks |
| Auto mode classifier | Creator + Dev | Creators notice fewer "Allow?" prompts; devs notice the fail-closed denials | https://code.claude.com/docs/en/permission-modes |
| Manual / Auto / Skip modes and deletion protection | Creator | Plain-language trust controls a non-coder can choose | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork |
| OS sandbox and credential masking | Dev | Invisible to creators unless it's missing and a secret leaks | https://code.claude.com/docs/en/sandboxing |
| Compaction with re-injection | Neither, directly | Noticed only when it fails and the agent "forgets" the brand brief | https://code.claude.com/docs/en/context-window |
| Checkpoints and `/rewind` | Creator + Dev | "Undo what the agent just did" is universally legible | https://code.claude.com/docs/en/checkpointing |
| Plan mode | Dev (Creator via "show me first") | Creators notice it only as a preview-before-acting step | https://code.claude.com/docs/en/permission-modes |
| Worktrees | Dev | No creator meaning | https://code.claude.com/docs/en/worktrees |
| Subagents, forks and workflows | Dev | Creators see only speed on big batch jobs | https://code.claude.com/docs/en/workflows |
| Agent teams and cross-session messaging | Dev | Power-user orchestration; experimental | https://code.claude.com/docs/en/agent-teams |
| Hooks | Dev | Creators never author them, but benefit from the guards | https://code.claude.com/docs/en/hooks |
| Plugins and marketplace | Creator + Dev | Creators notice an app-store-style catalog; devs build for it | https://code.claude.com/docs/en/plugins/overview |
| Plugin evals and cost measurement | Dev | Quality and token discipline behind the scenes | https://code.claude.com/docs/en/plugin-evals |
| Skills | Creator + Dev | Creators notice them as saved "recipes"; devs as `SKILL.md` | https://code.claude.com/docs/en/skills |
| CLAUDE.md and auto memory | Creator | "It remembers my voice and my accounts" is a visible creator win | https://code.claude.com/docs/en/memory |
| Output styles | Creator | Tone and format control without prompting each time | https://code.claude.com/docs/en/output-styles |
| MCP connectors | Creator + Dev | Creators notice "connect Gmail / Drive / socials"; devs notice MCP | https://code.claude.com/docs/en/mcp |
| Tool search / deferred tools | Neither, directly | Shows up only as cost and context headroom | https://code.claude.com/docs/en/mcp |
| Browser and computer use | Creator | Posting to sites without APIs, using logged-in social accounts | https://code.claude.com/docs/en/chrome |
| Remote Control, mobile and push notifications | Creator | Approve or steer from the phone | https://code.claude.com/docs/en/remote-control |
| OpenTelemetry | Dev | Operator-only | https://code.claude.com/docs/en/monitoring-usage |
| `/usage` and spend visibility | Creator + Dev | Creators care about "how much did this cost me" (see complaints #16157, #38335) | https://code.claude.com/docs/en/costs |
| Hard dollar budgets per session or run | Creator | A cap a small business can trust | https://platform.claude.com/docs/en/managed-agents/budgets |
| Vaults / masked credentials | Dev (Creator sees "connect once") | Creators notice only "log in once and it works" | https://platform.claude.com/docs/en/managed-agents/vaults |
| Memory stores and dreams | Creator | Gets better at the job over weeks, and the memory is inspectable | https://platform.claude.com/docs/en/managed-agents/dreams |
| Outcomes with a separate grader | Creator | "Done means done" quality on deliverables | https://platform.claude.com/docs/en/managed-agents/define-outcomes |
| Artifacts (shareable live pages) | Creator | Shareable client-facing output | https://code.claude.com/docs/en/artifacts |
| Prompt caching and batch | Neither, directly | Pure cost levers | https://platform.claude.com/docs/en/build-with-claude/batch-processing |
| Native installer and auto-update | Creator + Dev | Creators notice install friction; devs notice churn | https://code.claude.com/docs/en/setup |
| Release cadence (about 1 release per day) | Dev | Constant change; the stable channel exists for this reason | https://code.claude.com/docs/en/changelog |
| Local models | Creator + Dev | Creators want privacy and cost savings; devs hit an unsupported seam (section 3) | https://code.claude.com/docs/en/llm-gateway |

---

## 6. Not found or not fetched

| Item | Result | URL tried | Date |
|---|---|---|---|
| Claude Tag (Claude in Slack) page | Returned 403 (Cloudflare challenge); not read, and nothing is asserted from it | https://code.claude.com/docs/en/claude-tag | 2026-09-26 |
| First-party support for local or open-weights models in any Anthropic harness | Not found; explicitly unsupported for Claude Code gateways | https://code.claude.com/docs/en/llm-gateway | 2026-09-26 |
| Pluggable model-provider interface in the Agent SDK | Not found | https://code.claude.com/docs/en/agent-sdk/typescript | 2026-09-26 |
| Cowork telemetry or eval hooks | Not found in the Cowork help articles read | https://support.claude.com/en/articles/13364135-use-claude-cowork-safely | 2026-09-26 |
| Agent SDK release cadence | Not measured; only the semver policy was read | https://code.claude.com/docs/en/agent-sdk/hosting | 2026-09-26 |
