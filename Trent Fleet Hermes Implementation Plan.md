# Trent Fleet: Hermes-Style Implementation Plan

**Goal:** Transform Trent from a Next.js web app into a hybrid platform — CLI + TUI + Desktop + Web — with pre-customized agent roles, add-on system, setup wizard, doctor diagnostics, and terminal-based installation, modeled on the Hermes Agent UX.

---

## 1. What Hermes Has That Trent Needs

Based on [Hermes Agent docs](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart) and the [doctor feature spec](https://github.com/NousResearch/hermes-agent/issues/28223):

| Hermes Feature | What It Does | Trent Equivalent | Gap |
|---|---|---|---|
| `curl install.sh \| bash` | One-line CLI install | None — Trent is web-only | **Must build** |
| Desktop installer | macOS/Windows installer | None | **Must build** |
| `hermes setup` (3 modes) | Quick / Full / Blank Slate setup wizard | None | **Must build** |
| `hermes model` | Interactive provider/model selection | Model gateway exists, no CLI | **Must expose** |
| `hermes doctor` | Health diagnostics (config, creds, plugins, skills, logging, connectivity, DB, cron, disk, deps) | Readiness controls exist, no CLI doctor | **Must build** |
| `hermes doctor --fix` | Auto-remediation | None | **Must build** |
| `hermes` (classic CLI) | prompt_toolkit-based REPL | None | **Must build** |
| `hermes --tui` | Modern TUI with modal overlays, mouse, non-blocking input | None | **Must build** |
| `hermes --continue` / `-c` | Resume last session | Orchestrator runs exist, no session resume | **Must expose** |
| `hermes sessions list` | List sessions | None | **Must build** |
| Skills system | browse/search/install SKILL.md, slash commands, on-demand loading | Skill Foundry exists, no CLI hub | **Must expose** |
| Tool Gateway | Web search, image gen, TTS, cloud browser | Generation stack exists, no gateway CLI | **Must expose** |
| Messaging gateway | Telegram, Discord, Slack, WhatsApp, Signal, Email, Teams, Home Assistant | Social accounts exist, no gateway | **Must extend** |
| Terminal backend | Docker (egress proxy), SSH, local | Workbench (E2B/Daytona/mock_local) | **Must add Docker/SSH** |
| Voice mode | faster-whisper, `/voice on`, Ctrl+B | None | **Must build** |
| ACP editor integration | `hermes acp` | None | **Must build** |
| Egress credential proxy | Credentials never enter sandbox | None | **Must build** |
| Slash commands | `/help`, `/tools`, `/model`, `/personality`, `/save` | None | **Must build** |
| Personality system | `/personality pirate` | None | **Must build** |
| Config separation | `~/.trent/.env` (secrets) + `~/.trent/config.yaml` (settings) | `.env.local` only | **Must restructure** |
| MCP server config | YAML in config | MCP marketplace exists | **Must expose** |
| Pre-configured agents | Hermes doesn't have these | **Trent has 164 agents** | **Trent's advantage** |
| Toolsets | File Ops, Terminal, Web, Browser, Code, Vision, Memory, Delegation, Cron, Skills, Plugins, MCP | Most exist internally | **Must expose as toolsets** |

**Key insight:** Trent already has what Hermes doesn't — 164 pre-customized specialist agents, a self-improvement loop, a marketplace with billing, and a model gateway. The gap is the **delivery surface**: Trent is web-only. Hermes is CLI-first with desktop. Trent needs to become a hybrid.

---

## 2. Architecture: The Hybrid Model

```
┌─────────────────────────────────────────────────────────┐
│  Trent Platform                                         │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │  CLI     │  │  TUI     │  │ Desktop  │  │  Web    │ │
│  │ (trent)  │  │ (trent   │  │ (Tauri)  │  │ (Next.js│ │
│  │          │  │  --tui)  │  │          │  │  exist.)│ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │              │             │              │      │
│       └──────────────┴─────────────┴──────────────┘      │
│                          │                              │
│                   ┌──────▼──────┐                       │
│                   │  Trent Core │                       │
│                   │  (shared TS │                       │
│                   │  library)   │                       │
│                   └──────┬──────┘                       │
│                          │                              │
│  ┌───────────┬───────────┼───────────┬──────────┐      │
│  │           │           │           │          │      │
│  ▼           ▼           ▼           ▼          ▼      │
│ Agent      Model      Skill      MCP       Messaging   │
│ Catalog    Gateway    Foundry    Market    Gateway     │
│ (164)      (5 prov.)  (GEPA)     (connectors)          │
│                                                          │
│  ┌──────────────────────────────────────────────┐      │
│  │  Backend Services                            │      │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │      │
│  │  │ Postgres│ │ Redis  │ │ Worker │ │ Egress │ │      │
│  │  │ +Prisma │ │ +BullMQ│ │Container│ │ Proxy  │ │      │
│  │  └────────┘ └────────┘ └────────┘ └────────┘ │      │
│  └──────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

### Design Principle

The CLI, TUI, Desktop, and Web are all **thin clients** over a shared TypeScript core library (`@trent/core`). The core library wraps Trent's existing `lib/` modules into a consumable API. This avoids duplicating logic across surfaces.

---

## 3. Implementation Phases

### Phase 1: Core Library Extraction (Weeks 1-3)

**Goal:** Extract Trent's existing `lib/` modules into a shareable core package.

**Actions:**
1. Create `packages/trent-core/` — a standalone TypeScript package that wraps:
   - `lib/model-gateway.ts` → `trent-core/model-gateway`
   - `lib/agent-catalog.ts` → `trent-core/agents`
   - `lib/agent-marketplace.ts` → `trent-core/marketplace`
   - `lib/mcp-connector-catalog.ts` → `trent-core/mcp`
   - `lib/skill-foundry.ts` → `trent-core/skills`
   - `lib/heartbeat.ts` → `trent-core/heartbeat`
   - `lib/orchestrator.ts` → `trent-core/orchestrator`
   - `lib/trace-store.ts` → `trent-core/traces`
   - `lib/eval-harness.ts` → `trent-core/evals`
   - `lib/readiness-controls.ts` → `trent-core/readiness`
2. The core library can run in two modes:
   - **Connected:** Connects to a Trent server (API mode — for cloud-hosted Trent)
   - **Standalone:** Runs locally with SQLite + local Redis fallback (for CLI-only installs)
3. Config separation:
   - `~/.trent/.env` — secrets (API keys, tokens)
   - `~/.trent/config.yaml` — non-secret settings (provider, model, toolsets, agent preferences)
   - `~/.trent/skills/` — installed SKILL.md files
   - `~/.trent/sessions/` — session state

### Phase 2: CLI Binary (Weeks 4-7)

**Goal:** Build the `trent` CLI binary with setup wizard, doctor, and basic chat.

**Commands to implement:**

```
trent install              # One-line install (curl | bash)
trent setup                # Setup wizard (Quick / Full / Blank Slate)
trent setup --portal       # Quick setup with Trent cloud auth
trent model                # Interactive provider/model selection
trent doctor               # Health diagnostics
trent doctor --fix         # Auto-remediation
trent                       # Classic CLI REPL
trent --tui                 # Modern TUI
trent --continue / -c      # Resume last session
trent sessions list         # List sessions
trent tools                 # Configure toolsets
trent skills browse         # Browse skills hub
trent skills search <term>  # Search skills
trent skills install <slug> # Install a skill
trent skills opt-in --sync  # Sync skill preferences
trent config set <key> <val># Set configuration
trent config get <key>     # Get configuration
trent gateway setup         # Configure messaging platforms
trent gateway status        # Check gateway status
trent gateway               # Start messaging gateway
trent egress setup          # Set up egress credential proxy
trent egress start          # Start egress proxy
trent acp                   # Start ACP editor integration
trent update                # Update Trent
trent fleet list            # List available pre-configured agents
trent fleet install <agent> # Install a pre-configured agent
trent fleet create          # Create a custom agent
trent fleet deploy <agent>  # Deploy an agent to the fleet
```

**Setup wizard modes (mirroring Hermes):**

1. **Quick Setup (Trent Cloud):** OAuth login, auto-configures provider + model + toolsets + 3 starter agents. Recommended fast path.
2. **Full Setup:** Walks through every provider, tool, agent, and option. For users bringing their own keys.
3. **Blank Slate:** Minimal agent only (provider + model + file ops + terminal). Everything else disabled. User opts in incrementally.

**Doctor checks (mirroring Hermes doctor):**

| Category | What It Checks |
|---|---|
| Config | YAML valid, required fields present, profile paths exist |
| Credentials | API keys non-empty, providers reachable (lightweight ping) |
| Agents | All installed agents load, no missing dependencies |
| Skills | sync_skills dry-run, external_dirs conflicts, orphan symlinks |
| MCP | All configured MCP servers reachable, trust scores valid |
| Connectivity | Gateway connected, API server health endpoint |
| Database | state.db integrity check, session count, size |
| Cron | Scheduler running, jobs not stuck, last run within window |
| Disk | Log directory size, temp files, old session cleanup |
| Dependencies | Required binaries in PATH (git, docker, etc.) |
| Workbench | Sandbox provider healthy, E2B/Daytona reachable |
| Self-improvement | Trace store writable, eval gate functional, GEPA frontier exists |

### Phase 3: TUI (Weeks 8-10)

**Goal:** Build the modern TUI with modal overlays, mouse selection, and non-blocking input.

**Technology:** [Ink](https://github.com/vadimdemedes/ink) (React for CLIs) — same React knowledge from Next.js transfers.

**TUI features:**
- Modal overlays for agent selection, model switching, tool configuration
- Mouse-selectable menus
- Non-blocking input (type while agent works)
- Split panes: chat + agent activity + tool calls
- Slash command autocomplete dropdown
- Agent fleet status sidebar (shows which agents are active, idle, or need approval)
- Real-time SSE timeline (like Trent's web orchestration stream)
- `/voice on` — voice mode toggle
- `/personality <name>` — personality switching

### Phase 4: Desktop App (Weeks 11-14)

**Goal:** Build the Trent Desktop app for macOS, Windows, and Linux.

**Technology:** [Tauri](https://tauri.app/) (Rust + web frontend) — lighter than Electron, better security, smaller bundle.

**Desktop features:**
- Wraps the Next.js web app as the main view
- System tray icon with quick actions (start agent, check status, open TUI)
- Native notifications for approval gates and CEO autopilot updates
- Built-in terminal emulator (embedded TUI)
- File drag-and-drop for wiki uploads
- Auto-update mechanism
- Menu bar app (macOS) / taskbar app (Windows/Linux)

### Phase 5: Messaging Gateway + Add-ons (Weeks 15-18)

**Goal:** Connect Trent's agents to messaging platforms and build the add-on ecosystem.

**Messaging gateway:**
- Telegram, Discord, Slack, WhatsApp, Signal, Email, Microsoft Teams, Home Assistant
- Each platform gets per-agent routing (e.g., Support agent on Telegram, CEO on Slack)
- Approval gates surface as inline buttons on messaging platforms

**Add-on system (three layers, mirroring Hermes):**

1. **Skills** (SKILL.md files):
   - `trent skills browse` — browse the skill hub
   - `trent skills install <org>/<name>` — install with security scan
   - Skills become slash commands automatically
   - On-demand loading (agent reads description, loads full skill only when needed)
   - Trent's Skill Foundry already generates SKILL.md — expose it as a hub

2. **Plugins** (code packages):
   - npm packages that extend Trent with new tools, integrations, or agent behaviors
   - `trent plugins install <package>`
   - Sandboxed execution with trust scores

3. **MCP Servers** (tool connectors):
   - Trent already has the MCP marketplace
   - `trent mcp add <server>` — add from the marketplace
   - `trent mcp list` — list configured servers
   - `trent mcp remove <server>` — remove

### Phase 6: Terminal Backend + Egress Proxy (Weeks 19-20)

**Goal:** Sandboxed terminal execution with credential isolation.

**Terminal backends:**
- **Docker:** Default for local installs. Isolated containers with egress proxy.
- **SSH:** Remote server execution. `trent config set terminal.backend ssh`
- **E2B/Daytona:** Cloud sandboxes (Trent already supports these).
- **Local:** Direct execution (development only, with warnings).

**Egress credential proxy:**
- API keys never enter the sandbox
- Opaque proxy tokens work only from behind a local TLS-intercepting daemon
- `trent egress setup && trent egress start`

### Phase 7: Voice + ACP + Polish (Weeks 21-24)

**Goal:** Voice mode, editor integration, and final polish.

**Voice mode:**
- `faster-whisper` for local speech-to-text (free, offline)
- `/voice on` in CLI/TUI
- Ctrl+B to record
- Optional TTS for agent responses (via Tool Gateway)

**ACP editor integration:**
- `trent acp` — start ACP server
- Integrates with VS Code, Cursor, and other ACP-compatible editors
- Agents can read/write files in the editor context

**Pre-customized agent fleet (Trent's differentiator):**

This is where Trent exceeds Hermes. Hermes has no pre-configured agents. Trent has 164.

- `trent fleet list` — list all 164 pre-configured specialists
- `trent fleet install eng-ai-engineer` — install the AI Engineer agent
- `trent fleet install --pack engineering` — install all engineering agents as a pack
- `trent fleet create` — create a custom agent with the setup wizard
- `trent fleet deploy ceo` — deploy the CEO agent to active duty
- `trent fleet status` — show fleet status (active, idle, needs approval)
- Pre-configured agents come with:
  - System prompt (versioned)
  - Tool access list
  - Model policy (provider, tier, quality)
  - Budget caps
  - Memory scope
  - Approval policy
  - Eval suite
  - Skills pre-loaded
  - Personality

**Fleet packs (add-on bundles):**
- **Engineering Pack:** Frontend, Backend, AI Engineer, DevOps, QA
- **Marketing Pack:** Growth Hacker, Content Creator, SEO Specialist, Social Media Manager
- **Finance Pack:** Bookkeeper, Tax Analyst, FP&A, Treasury
- **Support Pack:** Support Responder, Escalation, Customer Success
- **Executive Pack:** CEO, CFO, CMO, CTO (strategic agents)
- **Custom Pack:** User selects agents à la carte

---

## 4. Installation Flow (End User Experience)

### One-Line Install

```bash
# Linux / macOS / WSL2
curl -fsSL https://trent.app/install.sh | bash

# Windows (PowerShell)
iex (irm https://trent.app/install.ps1)

# Or: Desktop installer (macOS/Windows)
# Download from trent.app
```

### First Run Setup

```bash
$ trent
╔══════════════════════════════════════════════════════════╗
║  Trent — Your AI Cofounder Fleet                         ║
║  164 specialist agents ready to deploy                   ║
╚══════════════════════════════════════════════════════════╝

Welcome! Let's get you set up.

  ❯ Quick Setup (Trent Cloud) — OAuth, zero config
    Full Setup — Bring your own keys, configure everything
    Blank Slate — Minimal agent, add features later

> Quick Setup selected

🔐 Opening browser for Trent Cloud login...
✅ Logged in as user@example.com
✅ Provider: OpenAI (GPT-5.6-terra)
✅ Model configured
✅ Tool Gateway enabled (web, images, TTS, browser)
✅ 3 starter agents installed: CEO, Engineer, Support

Your fleet is ready. Type a message or press / for commands.

$ trent>
```

### Doctor Command

```bash
$ trent doctor
✓ Config — valid, 2 profiles loaded
✓ Credentials — 3/3 providers reachable (openai, anthropic, google)
✓ Agents — 12/12 installed agents loaded
⚠ Skills — 2 name conflicts in external_dirs
✗ MCP — github MCP server unreachable
✓ Connectivity — Trent Cloud connected, API server reachable
✓ Database — state.db healthy (47 sessions, 2.1 MB)
✓ Cron — 4/4 jobs healthy, last run 12 min ago
✓ Disk — logs/ 340 MB (within limit)
✓ Workbench — E2B sandbox healthy
✓ Self-improvement — trace store writable, GEPA frontier active

1 warning, 1 issue found.
Run `trent doctor --fix` for auto-remediation.
```

---

## 5. Technology Stack Summary

| Component | Technology | Why |
|---|---|---|
| Core library | TypeScript package (`@trent/core`) | Shares existing Trent lib/ code |
| CLI framework | [Commander.js](https://github.com/tj/commander.js) | Mature, TypeScript-native |
| TUI framework | [Ink](https://github.com/vadimdemedes/ink) | React for CLIs, same knowledge as Next.js |
| Desktop app | [Tauri](https://tauri.app/) | Rust + web, lighter than Electron, better security |
| Web app | Next.js 15 (existing) | Already built |
| Local DB (standalone) | SQLite (via Prisma) | Zero-config local storage |
| Cloud DB (connected) | PostgreSQL (existing) | Production-grade |
| Queue (standalone) | In-process (BullMQ fallback) | No Redis needed for CLI-only |
| Queue (cloud) | Redis + BullMQ (existing) | Production-grade |
| Terminal backend | Docker (default), SSH, E2B/Daytona | Sandboxed execution |
| Egress proxy | Local TLS-intercepting daemon | Credential isolation |
| Voice | faster-whisper | Free, local, offline STT |
| Packaging | [pkg](https://github.com/vercel/pkg) or [Bun](https://bun.sh/) | Single-binary distribution |
| Auto-update | [update-notifier](https://github.com/yeoman/update-notifier) | Check for updates on startup |
| Config | YAML (`~/.trent/config.yaml`) + `.env` | Separation of secrets from settings |
| Installer | Shell script (curl \| bash) + NSIS/DMG | Cross-platform install |

---

## 6. File Structure

```
trent/
├── apps/
│   ├── web/                    # Existing Next.js app
│   ├── cli/                    # CLI binary
│   │   ├── src/
│   │   │   ├── commands/       # trent setup, doctor, model, etc.
│   │   │   ├── repl/           # Classic CLI REPL
│   │   │   ├── tui/            # Ink-based TUI
│   │   │   └── index.ts        # Entry point
│   │   └── package.json
│   └── desktop/                # Tauri desktop app
│       ├── src/
│       └── tauri.conf.json
├── packages/
│   └── trent-core/             # Shared core library
│       ├── src/
│       │   ├── model-gateway/  # Wraps lib/model-gateway.ts
│       │   ├── agents/         # Wraps lib/agent-catalog.ts
│       │   ├── marketplace/    # Wraps lib/agent-marketplace.ts
│       │   ├── mcp/            # Wraps lib/mcp-*.ts
│       │   ├── skills/         # Wraps lib/skill-foundry.ts
│       │   ├── orchestrator/   # Wraps lib/orchestrator.ts
│       │   ├── heartbeat/      # Wraps lib/heartbeat.ts
│       │   ├── traces/         # Wraps lib/trace-store.ts
│       │   ├── evals/          # Wraps lib/eval-harness.ts
│       │   ├── readiness/      # Wraps lib/readiness-controls.ts
│       │   ├── config/         # Config management (~/.trent/)
│       │   ├── doctor/         # Health diagnostics
│       │   ├── setup/          # Setup wizard
│       │   ├── gateway/         # Messaging gateway
│       │   ├── egress/         # Egress credential proxy
│       │   └── sessions/       # Session management
│       └── package.json
├── lib/                        # Existing Trent lib/ (unchanged)
├── scripts/
│   ├── install.sh              # curl | bash installer
│   ├── install.ps1             # PowerShell installer
│   └── build-cli.sh            # CLI binary builder
└── package.json                # Workspace root
```

---

## 7. What Trent Already Has (No Need to Rebuild)

- 164 pre-configured specialist agents (Hermes has zero)
- Agent marketplace with Stripe billing
- Multi-provider model gateway (5 providers)
- MCP marketplace with trust scores
- Skill Foundry (distills SKILL.md from traces)
- Self-improvement loop (trace → eval → foundry → GEPA)
- Readiness controls framework
- Golden trace capture
- Agent traces
- Skill health monitoring
- SHA-256 audit log
- Approval gates + kill switch
- Workbench (E2B/Daytona/mock_local)
- Orchestrator (planner → DAG → specialists → critic → consolidator)
- Heartbeat autonomy system
- CEO autopilot updates
- Social accounts (partial — extend to gateway)

**Trent's competitive advantage over Hermes:** Pre-configured agents, self-improvement, marketplace with billing, and multi-agent orchestration. Hermes is a single-agent system. Trent is a fleet.
