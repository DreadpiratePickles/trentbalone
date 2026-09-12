# THE TRENT FLEET BUILD PROMPT

> **Copy everything below the line into your AI coding agent (Claude Code, Cursor, Copilot, etc.) to build the Trent Fleet platform.**

---

## SYSTEM CONTEXT

You are building Trent Fleet — a hybrid AI cofounder platform that combines:
1. A Next.js 15 web application (already exists at github.com/DreadpiratePickles/trent, commit bcb8180)
2. A CLI binary (`trent`) with setup wizard, doctor, and REPL
3. A TUI (`trent --tui`) built with Ink (React for CLIs)
4. A Desktop app built with Tauri
5. A messaging gateway (Telegram, Discord, Slack, WhatsApp, Signal, Email, Teams)
6. A pre-configured agent fleet (164 specialists already exist in the codebase)
7. An add-on ecosystem (skills, plugins, MCP servers)

The existing codebase already contains:
- `lib/model-gateway.ts` — Multi-provider gateway (OpenAI, Anthropic, Google, DeepSeek, OpenRouter) with tier-based routing, semantic cache, fallback chains, reversibility checks
- `lib/agent-catalog.ts` — 164 specialist agents across 13 categories
- `lib/agent-marketplace.ts` — Agent marketplace with Stripe billing, pack pricing, entitlements
- `lib/mcp-connector-catalog.ts` — MCP marketplace with trust scores, risk tiers, policy classes
- `lib/skill-foundry.ts` — Skill distillation from traces, quarantine→live→rejected lifecycle
- `lib/heartbeat.ts` — Full heartbeat with self-improvement sweep, autoresearch feature flag
- `lib/trace-store.ts` — Per-step traces with tool calls, costs, critique verdicts
- `lib/eval-harness.ts` — Multiple grader types, fixture scoring, failure clustering
- `lib/gepa.ts` — Evolutionary prompt optimization with frontier tracking
- `lib/orchestrator.ts` — planner → DAG → specialists → critic → consolidator
- `lib/readiness-controls.ts` — Comprehensive readiness framework
- `lib/orchestration-golden-capture.ts` — Golden trace capture from failed runs
- `prisma/schema.prisma` — Extensive data models

You will NOT modify the existing `lib/` modules. You will CREATE a new `packages/trent-core/` package that WRAPS them, plus new `apps/cli/`, `apps/desktop/`, and shared UI components.

## ARCHITECTURE

```
trent/
├── apps/
│   ├── web/                    # Existing Next.js app (minimal changes)
│   ├── cli/                    # NEW: CLI binary
│   │   ├── src/
│   │   │   ├── commands/       # setup.ts, doctor.ts, model.ts, fleet.ts, skills.ts, tools.ts, gateway.ts, egress.ts, acp.ts, sessions.ts, config.ts
│   │   │   ├── repl/           # Classic REPL (prompt_toolkit equivalent)
│   │   │   │   ├── index.ts    # REPL entry point
│   │   │   │   ├── input.ts    # Input handler (multi-line, slash commands)
│   │   │   │   ├── output.ts   # Output formatter (agent messages, status, panels)
│   │   │   │   └── session.ts  # Session management (save, resume, list)
│   │   │   ├── tui/            # Ink-based TUI
│   │   │   │   ├── App.tsx     # Main TUI app (3-pane layout)
│   │   │   │   ├── Sidebar.tsx # Fleet status, budget, tools, skills
│   │   │   │   ├── Chat.tsx    # Chat panel with messages + input
│   │   │   │   ├── Activity.tsx # Agent activity, approvals, budget
│   │   │   │   ├── modals/     # Model switch, fleet, tools, skills, doctor
│   │   │   │   └── hooks/      # useSession, useFleet, useApprovals, useBudget
│   │   │   ├── slash/          # Slash command handlers
│   │   │   │   ├── help.ts, fleet.ts, tools.ts, model.ts, skills.ts
│   │   │   │   ├── approvals.ts, budget.ts, personality.ts, voice.ts
│   │   │   │   ├── save.ts, sessions.ts, doctor.ts, config.ts
│   │   │   │   └── index.ts    # Command registry
│   │   │   ├── voice/          # Voice mode (faster-whisper sidecar)
│   │   │   └── index.ts        # CLI entry point (commander)
│   │   └── package.json
│   └── desktop/                # NEW: Tauri desktop app
│       ├── src/
│       │   ├── main.tsx        # React entry (wraps Next.js web view)
│       │   ├── tray.ts         # System tray
│       │   ├── notifications.ts # Native notifications
│       │   ├── updater.ts      # Auto-update
│       │   └── terminal.ts     # Embedded xterm.js terminal
│       ├── src-tauri/
│       │   ├── main.rs         # Tauri entry
│       │   ├── commands.rs     # Rust commands
│       │   └── tauri.conf.json
│       └── package.json
├── packages/
│   └── trent-core/             # NEW: Shared core library
│       ├── src/
│       │   ├── index.ts        # Public API
│       │   ├── config/         # Config management
│       │   │   ├── ConfigManager.ts  # ~/.trent/config.yaml + ~/.trent/.env
│       │   │   ├── schema.ts   # Config schema (providers, models, toolsets, agents)
│       │   │   └── defaults.ts # Default config
│       │   ├── setup/          # Setup wizard
│       │   │   ├── SetupWizard.ts  # 3 modes: Quick, Full, Blank Slate
│       │   │   ├── QuickSetup.ts   # OAuth + auto-config
│       │   │   ├── FullSetup.ts    # Walk through everything
│       │   │   └── BlankSlate.ts   # Minimal agent, opt-in later
│       │   ├── doctor/         # Health diagnostics
│       │   │   ├── DoctorRunner.ts # Runs all checks
│       │   │   ├── checks/        # config, credentials, agents, skills, mcp, connectivity, database, cron, disk, dependencies, workbench, self-improvement
│       │   │   └── FixRunner.ts   # Auto-remediation (--fix)
│       │   ├── model-gateway/  # Wraps lib/model-gateway.ts
│       │   ├── agents/         # Wraps lib/agent-catalog.ts
│       │   ├── marketplace/    # Wraps lib/agent-marketplace.ts
│       │   ├── mcp/            # Wraps lib/mcp-connector-catalog.ts
│       │   ├── skills/         # Wraps lib/skill-foundry.ts + skills hub
│       │   │   ├── SkillsHub.ts    # browse/search/install
│       │   │   ├── SkillLoader.ts  # on-demand loading
│       │   │   └── SecurityScan.ts # pre-install security scan
│       │   ├── orchestrator/   # Wraps lib/orchestrator.ts
│       │   ├── heartbeat/      # Wraps lib/heartbeat.ts
│       │   ├── traces/         # Wraps lib/trace-store.ts
│       │   ├── evals/          # Wraps lib/eval-harness.ts
│       │   ├── readiness/      # Wraps lib/readiness-controls.ts
│       │   ├── sessions/       # Session management
│       │   │   ├── SessionManager.ts  # save, resume, list
│       │   │   └── SessionStore.ts    # SQLite (local) or API (cloud)
│       │   ├── gateway/        # Messaging gateway
│       │   │   ├── GatewayManager.ts   # Platform routing
│       │   │   ├── platforms/
│       │   │   │   ├── telegram.ts
│       │   │   │   ├── discord.ts
│       │   │   │   ├── slack.ts
│       │   │   │   ├── whatsapp.ts
│       │   │   │   ├── signal.ts
│       │   │   │   ├── email.ts
│       │   │   │   ├── teams.ts
│       │   │   │   └── homeassistant.ts
│       │   │   └── ApprovalBridge.ts  # Approval gates → inline buttons
│       │   ├── egress/         # Egress credential proxy
│       │   │   ├── EgressProxy.ts     # TLS-intercepting daemon
│       │   │   └── TokenManager.ts   # Opaque proxy tokens
│       │   ├── terminal/       # Terminal backends
│       │   │   ├── DockerBackend.ts  # Docker sandbox
│       │   │   ├── SSHBackend.ts     # Remote SSH execution
│       │   │   ├── E2BBackend.ts     # Cloud sandbox (existing)
│       │   │   └── LocalBackend.ts   # Direct (dev only)
│       │   ├── voice/          # Voice mode
│       │   │   ├── VoiceManager.ts   # faster-whisper sidecar
│       │   │   └── WhisperProcess.ts # STT process management
│       │   ├── acp/            # ACP editor integration
│       │   │   └── ACPServer.ts      # ACP protocol server
│       │   ├── fleet/          # Fleet management
│       │   │   ├── FleetManager.ts   # Install, deploy, status
│       │   │   ├── FleetPacks.ts     # Pre-configured packs
│       │   │   └── AgentInstaller.ts # Agent installation + config
│       │   ├── personalities/  # Personality system
│       │   │   ├── PersonalityManager.ts
│       │   │   └── built-in/        # default, professional, casual, pirate, robot, coach
│       │   └── updater/        # Auto-update
│       │       └── UpdateChecker.ts
│       └── package.json
├── scripts/
│   ├── install.sh              # curl | bash installer
│   ├── install.ps1             # PowerShell installer
│   └── build-cli.sh            # CLI binary builder (Bun --compile)
└── package.json                # Workspace root (npm workspaces or turborepo)
```

## IMPLEMENTATION ORDER

Build in this exact order. Each phase must be complete and tested before the next.

### Phase 1: Core Package + Config (Week 1-2)

1. Create `packages/trent-core/` with package.json (TypeScript, ESM, exports map)
2. Implement `config/ConfigManager.ts`:
   - Read/write `~/.trent/config.yaml` (non-secret settings)
   - Read/write `~/.trent/.env` (secrets)
   - Config schema with validation (zod)
   - Default config
   - `get(key)`, `set(key, value)`, `delete(key)` methods
   - Profile support (multiple configs)
3. Implement `config/defaults.ts`:
   - Default provider: OpenAI
   - Default model: gpt-5.6-terra
   - Default toolsets: file_ops, terminal
   - Default budget: $10.00/day
   - Default terminal backend: docker
4. Implement `sessions/SessionManager.ts`:
   - Save session to `~/.trent/sessions/` (SQLite or JSON files)
   - Resume last session (`--continue` / `-c`)
   - List sessions
5. Write unit tests for config and sessions

### Phase 2: Doctor Command (Week 2-3)

6. Implement `doctor/DoctorRunner.ts`:
   - Runs all checks sequentially
   - Returns structured results (category, status, message, fix_hint)
   - Pretty-prints to terminal with colors (chalk)
7. Implement all doctor checks:
   - `checks/config.ts` — YAML valid, required fields, profile paths
   - `checks/credentials.ts` — API keys non-empty, provider ping
   - `checks/agents.ts` — All installed agents load, no missing deps
   - `checks/skills.ts` — sync dry-run, conflicts, orphan symlinks
   - `checks/mcp.ts` — MCP servers reachable, trust scores valid
   - `checks/connectivity.ts` — Trent Cloud API reachable, health endpoint
   - `checks/database.ts` — SQLite/Postgres integrity, session count, size
   - `checks/cron.ts` — Scheduler running, jobs not stuck
   - `checks/disk.ts` — Log dir size, temp files, old session cleanup
   - `checks/dependencies.ts` — Required binaries in PATH (git, docker, etc.)
   - `checks/workbench.ts` — Sandbox provider healthy
   - `checks/self-improvement.ts` — Trace store writable, eval gate functional
8. Implement `doctor/FixRunner.ts`:
   - Auto-remediate where safe (clear temp files, fix config, restart cron)
   - Never auto-fix credentials or delete data
9. Write integration tests for doctor

### Phase 3: Setup Wizard (Week 3-4)

10. Implement `setup/SetupWizard.ts`:
    - Interactive prompts (using @inquirer/prompts)
    - Three modes: Quick, Full, Blank Slate
11. Implement `setup/QuickSetup.ts`:
    - OAuth login (opens browser)
    - Auto-configures provider + model + toolsets + 3 starter agents
    - Enables Tool Gateway
12. Implement `setup/FullSetup.ts`:
    - Walks through every provider, tool, agent, and option
    - API key entry for each provider
    - Toolset selection
    - Agent selection from catalog
    - Budget configuration
13. Implement `setup/BlankSlate.ts`:
    - Minimal agent only (provider + model + file_ops + terminal)
    - Writes explicit `platform_toolsets.cli` and `agent.disabled_toolsets`
    - Offers opt-in walk-through after baseline
14. Write tests for setup wizard

### Phase 4: CLI Binary + REPL (Week 4-6)

15. Implement `apps/cli/src/index.ts`:
    - Commander.js command registration
    - All subcommands: setup, doctor, model, fleet, skills, tools, gateway, egress, acp, sessions, config, update
16. Implement `apps/cli/src/repl/`:
    - Classic REPL with prompt_toolkit-equivalent (use ink or readline)
    - Multi-line input (Alt+Enter, Ctrl+J, Shift+Enter)
    - Slash command autocomplete
    - Agent message formatting with color-coded prefixes
    - Budget ticker
    - Ctrl+C to interrupt
17. Implement slash commands in `apps/cli/src/slash/`:
    - All commands from the slash command table
18. Implement `apps/cli/src/voice/`:
    - faster-whisper Python sidecar process management
    - `/voice on/off` toggle
    - Ctrl+B to record
19. Build the CLI binary:
    - Use Bun's `--compile` for single-binary distribution
    - Cross-compile for linux-x64, darwin-x64, darwin-arm64, win-x64
20. Write the install scripts:
    - `scripts/install.sh` — curl | bash for Linux/macOS/WSL2
    - `scripts/install.ps1` — PowerShell for Windows
21. Write integration tests for CLI

### Phase 5: TUI with Ink (Week 6-8)

22. Implement `apps/cli/src/tui/App.tsx`:
    - Three-pane layout (Sidebar | Chat | Activity)
    - Resizable panes
    - Modal overlays
23. Implement `apps/cli/src/tui/Sidebar.tsx`:
    - Fleet status (active/idle/offline agents with colors)
    - Budget display
    - Tools list
    - Skills list
    - Self-improvement status
24. Implement `apps/cli/src/tui/Chat.tsx`:
    - Message list with agent-colored bubbles
    - Input box with slash command autocomplete
    - Non-blocking input (type while agents work)
    - Multi-line support
25. Implement `apps/cli/src/tui/Activity.tsx`:
    - Real-time agent activity feed
    - Approval queue with y/n prompts
    - Budget breakdown per agent
26. Implement TUI modals:
    - Model switch modal
    - Fleet management modal
    - Tools configuration modal
    - Skills browser modal
    - Doctor results modal
27. Implement TUI hooks:
    - `useSession` — session state
    - `useFleet` — fleet status (polls or SSE)
    - `useApprovals` — pending approvals (SSE)
    - `useBudget` — budget tracking
28. Write tests for TUI

### Phase 6: Fleet Management (Week 8-9)

29. Implement `fleet/FleetManager.ts`:
    - `list()` — list all 164 agents from catalog
    - `install(agentId)` — install agent with its config, tools, skills, model policy
    - `deploy(agentId)` — set agent to active duty
    - `status()` — show fleet status
    - `remove(agentId)` — uninstall agent
30. Implement `fleet/FleetPacks.ts`:
    - Pre-configured packs: Engineering, Marketing, Finance, Support, Executive, Custom
    - Pack installation with dependency resolution
31. Implement `fleet/AgentInstaller.ts`:
    - Copies agent config to `~/.trent/agents/`
    - Installs required skills
    - Configures tool access
    - Sets up model policy and budget caps
    - Runs security scan

### Phase 7: Skills Hub (Week 9-10)

32. Implement `skills/SkillsHub.ts`:
    - `browse()` — list all available skills
    - `search(term)` — keyword search
    - `install(slug)` — install with security scan
    - `remove(slug)` — uninstall
    - `list()` — show installed skills
33. Implement `skills/SkillLoader.ts`:
    - On-demand loading (agent reads description, loads full SKILL.md only when needed)
    - Slash command registration (each skill becomes a `/command`)
34. Implement `skills/SecurityScan.ts`:
    - Pre-install security scan
    - Checks for dangerous patterns in SKILL.md
    - Trust score integration with MCP marketplace

### Phase 8: Messaging Gateway (Week 10-12)

35. Implement `gateway/GatewayManager.ts`:
    - Platform routing (which agent handles which platform)
    - Message queue (BullMQ or in-process)
    - Health monitoring
36. Implement platform adapters:
    - `platforms/telegram.ts` — Telegram Bot API
    - `platforms/discord.ts` — Discord.js
    - `platforms/slack.ts` — Slack Bolt SDK
    - `platforms/whatsapp.ts` — WhatsApp Business API
    - `platforms/signal.ts` — signal-cli
    - `platforms/email.ts` — IMAP/SMTP
    - `platforms/teams.ts` — Microsoft Graph
    - `platforms/homeassistant.ts` — Home Assistant webhook
37. Implement `gateway/ApprovalBridge.ts`:
    - Approval gates surface as inline buttons on messaging platforms
    - Telegram: inline keyboard buttons
    - Discord: button components
    - Slack: interactive blocks
    - Email: reply with "APPROVE" or "DENY"

### Phase 9: Egress Proxy + Terminal Backends (Week 12-14)

38. Implement `egress/EgressProxy.ts`:
    - Local TLS-intercepting daemon
    - Generates opaque proxy tokens
    - Intercepts API calls and injects real credentials
    - Credentials never enter the sandbox
39. Implement `egress/TokenManager.ts`:
    - Issue, rotate, and revoke proxy tokens
    - Token scope (per-agent, per-tool)
40. Implement `terminal/DockerBackend.ts`:
    - Docker container management (dockerode)
    - Container lifecycle (create, start, exec, stop, remove)
    - Volume mounts
    - Network isolation
    - Egress proxy integration
41. Implement `terminal/SSHBackend.ts`:
    - SSH connection management (ssh2)
    - Command execution
    - File transfer (SFTP)

### Phase 10: Desktop App (Week 14-16)

42. Create Tauri project in `apps/desktop/`
43. Implement system tray:
    - Context menu with quick actions
    - Tray icon color based on fleet status (green=active, yellow=approval pending, red=error)
44. Implement native notifications:
    - Approval gate triggered
    - CEO autopilot update
    - Agent mission complete
    - Budget threshold reached
45. Implement embedded terminal (xterm.js):
    - Runs the TUI inside the desktop app
46. Implement auto-update:
    - Check for updates on launch
    - Download and install in background
47. Implement global hotkey:
    - Cmd+Shift+T (macOS) / Ctrl+Shift+T (Windows/Linux) to summon Trent
48. Build desktop installers:
    - DMG for macOS
    - NSIS for Windows
    - AppImage/deb for Linux

### Phase 11: Voice + ACP (Week 16-17)

49. Implement `voice/VoiceManager.ts`:
    - faster-whisper Python sidecar
    - Audio recording (Ctrl+B)
    - Speech-to-text transcription
    - `/voice on/off` toggle
50. Implement `acp/ACPServer.ts`:
    - ACP protocol server
    - Integrates with VS Code, Cursor, and other ACP-compatible editors
    - Agents can read/write files in editor context

### Phase 12: Personality System (Week 17-18)

51. Implement `personalities/PersonalityManager.ts`:
    - Load personalities from `~/.trent/personalities/`
    - `/personality <name>` command
    - Apply personality as prompt suffix
52. Implement built-in personalities:
    - default, professional, casual, pirate, robot, coach
53. Allow custom personalities via config

### Phase 13: Polish + Documentation (Week 18-20)

54. Write `trent --help` output with all commands
55. Write man page
56. Write `docs/getting-started.md` (quickstart guide)
57. Write `docs/configuration.md` (config reference)
58. Write `docs/doctor.md` (doctor command reference)
59. Write `docs/fleet.md` (fleet management guide)
60. Write `docs/skills.md` (skills hub guide)
61. Write `docs/gateway.md` (messaging gateway guide)
62. Write `docs/terminal.md` (terminal backend guide)
63. Write `docs/desktop.md` (desktop app guide)
64. Create a landing page at trent.app with download links
65. Final integration testing across all surfaces

## CONSTRAINTS

1. **Do NOT modify existing `lib/` modules.** Wrap them in `packages/trent-core/`.
2. **TypeScript everywhere.** No JavaScript files. Use strict mode.
3. **ESM modules.** Use `"type": "module"` in all package.json files.
4. **Test everything.** Each module must have unit tests. Integration tests for CLI commands.
5. **Dark-first design.** All surfaces default to dark mode.
6. **Progressive disclosure.** Start minimal. Reveal complexity as the user grows.
7. **Config separation.** Secrets in `~/.trent/.env`, settings in `~/.trent/config.yaml`.
8. **Cross-platform.** Must work on Linux, macOS, Windows, and WSL2.
9. **Use the existing Trent design language.** Dark backgrounds (#0F1117), purple accent (#8B5CF6), monospace for technical details.
10. **Every CLI command must have `--help`.**
11. **Every CLI command must have `--json` output option** (for scripting).
12. **The CLI binary must be a single file.** Use Bun's `--compile` for distribution.
13. **The install script must not require root/sudo.** Install to `~/.trent/`.
14. **Doctor must never auto-fix credentials or delete data.**
15. **All messaging platform integrations must support per-agent routing.**
16. **All approval gates must surface on all connected surfaces** (CLI, TUI, Desktop, Messaging).
17. **The egress proxy must be optional but recommended.** Warn if not enabled.
18. **Voice mode must work offline** (faster-whisper is local).
19. **The desktop app must wrap the existing Next.js web app** — do not rebuild the web UI.
20. **Skills must support on-demand loading** — don't bloat every request with all skill content.

## DESIGN SYSTEM

### Colors (use across ALL surfaces)

```
Agent role colors:
  CEO:          #8B5CF6 (purple)
  Engineer:     #06B6D4 (cyan)
  Growth:       #10B981 (green)
  Content:      #F59E0B (amber)
  Support:      #3B82F6 (blue)
  Analyst:      #EC4899 (pink)
  Finance:      #EF4444 (red)
  Browser:      #6366F1 (indigo)
  Escalation:   #F97316 (orange)

Status:
  active:       #10B981 (green dot ●)
  idle:         #F59E0B (amber dot ●)
  offline:      #6B7280 (gray dot ○)
  approval:     #EF4444 (red dot ●)
  error:        #DC2626 (red)

Surface (dark-first):
  bg-primary:   #0F1117
  bg-secondary: #1A1D27
  bg-tertiary:  #252937
  text-primary: #E4E6EB
  text-secondary: #9CA3AF
  accent:       #8B5CF6
  border:       #2D3139
```

### Typography

```
Sans:    Inter, system-ui, sans-serif
Mono:    JetBrains Mono, Fira Code, monospace
Sizes:   xs=12px, sm=14px, base=16px, lg=18px, xl=24px, 2xl=32px
```

### Agent Message Format (all surfaces)

```
[AgentName] message text...
📎 file.ts · 142 lines
⏱ 2.3s · 💰 $0.12 · 🤖 model-name
```

### Approval Gate Format (all surfaces)

```
⚠ APPROVAL REQUIRED
Agent wants to: [action description]
Details: [key=value pairs]
[Review] [Approve] [Deny]
Budget: $cost · Time: ~duration
```

## KEY BEHAVIORS

1. **On first run without config:** Automatically launch the setup wizard.
2. **On `trent` with no args:** Launch the classic REPL.
3. **On `trent --tui`:** Launch the Ink TUI.
4. **On `trent -c` or `--continue`:** Resume the last session.
5. **On `trent doctor`:** Run all health checks and print a report.
6. **On `trent doctor --fix`:** Run health checks and auto-remediate where safe.
7. **On `trent setup`:** Launch the setup wizard with mode selection.
8. **On `trent model`:** Launch interactive model/provider selection.
9. **On `trent fleet list`:** List all 164 agents with status (installed/available).
10. **On `trent fleet install <id>`:** Install an agent with its full config.
11. **On `trent skills browse`:** Browse the skills hub.
12. **On `trent skills install <slug>`:** Install a skill with security scan.
13. **On `trent gateway setup`:** Configure messaging platforms interactively.
14. **On `trent gateway`:** Start the messaging gateway.
15. **On `trent egress setup`:** Set up the egress credential proxy.
16. **On `trent acp`:** Start the ACP editor integration server.
17. **On `/` in REPL or TUI:** Show slash command autocomplete dropdown.
18. **On `Ctrl+C`:** Interrupt the current agent task.
19. **On `Ctrl+B` (voice mode):** Start/stop recording.
20. **On `Alt+Enter` / `Ctrl+J` / `Shift+Enter`:** New line in input.
21. **On agent task completion:** Show completion summary with cost, time, and tools used.
22. **On approval gate triggered:** Show modal/dialog on all connected surfaces simultaneously.
23. **On budget threshold (50%, 80%, 100%):** Show warning/notification on all surfaces.
24. **On `trent update`:** Check for and install updates.
25. **On `trent config set <key> <value>`:** Write to config.yaml or .env as appropriate.

## OUTPUT EXPECTATIONS

For each phase, produce:
1. All source files with complete implementations (no placeholders, no TODOs)
2. Unit tests for each module
3. Integration tests for each CLI command
4. Updated package.json with all dependencies
5. Updated workspace configuration if needed
6. A brief summary of what was built and how to test it

## BEGIN

Start with Phase 1: Core Package + Config. Create the workspace structure, implement ConfigManager and SessionManager, and write tests. Do not proceed to Phase 2 until Phase 1 is complete and tested.
