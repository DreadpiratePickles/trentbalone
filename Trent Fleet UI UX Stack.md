# Trent Fleet: UI/UX Stack & Design System

**Goal:** Define the complete UI/UX technology stack and design language for Trent's four surfaces — CLI, TUI, Desktop, and Web — ensuring a cohesive experience across all of them.

---

## 1. Design Philosophy

Trent is an **AI cofounder fleet**, not a chatbot. The UX must communicate:

1. **Agency** — Agents are active workers, not passive responders. Show what they're doing, not just what they said.
2. **Fleet** — Multiple agents work simultaneously. The UI must handle multi-agent visibility.
3. **Trust** — Users delegate real work to agents. Approval gates, audit trails, and budget visibility must be first-class.
4. **Hermes-like simplicity** — One-line install, setup wizard, doctor command. Power when you need it, simplicity when you don't.

### Design Principles

- **Progressive disclosure:** Start with one agent and a chat. Reveal fleet, tools, skills, and MCP as the user grows.
- **Terminal-native aesthetic:** The CLI and TUI are the primary surfaces. The web and desktop apps are the control center, not the only interface.
- **Dark-first:** All surfaces default to dark mode. Terminal aesthetics carry through.
- **Monospace accents:** Use monospace for code, tool calls, agent IDs, and technical details. Sans-serif for conversation and UI.
- **Color-coded agents:** Each agent role has a consistent accent color across all surfaces.

---

## 2. Four Surfaces

### Surface 1: CLI (Classic REPL)

**Technology:** [Commander.js](https://github.com/tj/commander.js) for command parsing + [prompt_toolkit-equivalent] for REPL

**Equivalent to:** `hermes` (classic CLI)

**UX pattern:**
```
$ trent
╔══════════════════════════════════════════════════════════╗
║  Trent — AI Cofounder Fleet          12 agents active    ║
║  Model: GPT-5.6-terra · Provider: OpenAI                 ║
╚══════════════════════════════════════════════════════════╝

trent> Summarize this repo and tell me the main entrypoint
[CEO] Planning approach...
[Engineer] Reading package.json, lib/orchestrator.ts...
[Engineer] Found: Next.js 15 app, entry at app/page.tsx
[CEO] Synthesizing summary...

Trent is an AI cofounder OS with a multi-agent orchestrator...

trent> /fleet
┌──────────────────────────────────────────────────────┐
│  Fleet Status                                         │
│                                                       │
│  ● CEO          active   GPT-5.6-terra    $0.12/run  │
│  ● Engineer     active   Claude Sonnet 5  $0.08/run  │
│  ● Support      idle     Claude Haiku 4.5 $0.01/run  │
│  ○ Analyst      offline  Claude Sonnet 5  —          │
│  ○ Finance      offline  Claude Opus 5    —          │
│                                                       │
│  2/12 agents active · Budget: $4.50/$10.00 today     │
└──────────────────────────────────────────────────────┘

trent> /doctor
✓ Config     valid, 2 profiles loaded
✓ Credentials 3/3 providers reachable
⚠ Skills     2 name conflicts
✗ MCP        github server unreachable
✓ Cron       4/4 jobs healthy
✓ Workbench  E2B sandbox healthy

1 warning, 1 issue. Run `trent doctor --fix`
```

**Key UX elements:**
- `[AgentName]` prefix for each agent's messages (color-coded)
- `/` triggers slash command autocomplete
- `Ctrl+C` interrupts the current agent
- `Alt+Enter` / `Ctrl+J` / `Shift+Enter` for multi-line input
- Agent activity shown inline (planning, reading, writing, executing)
- Budget ticker in header

### Surface 2: TUI (Modern Terminal UI)

**Technology:** [Ink](https://github.com/vadimdemedes/ink) (React for CLIs)

**Equivalent to:** `hermes --tui`

**UX pattern — Three-pane layout:**
```
┌─────────────────┬──────────────────────┬─────────────────┐
│ Fleet Sidebar   │  Chat                │ Activity Panel  │
│                 │                      │                 │
│ ● CEO           │  trent> Summarize    │ [Engineer]      │
│   active        │  this repo           │ Reading files...│
│   $0.12/run     │                      │                 │
│                 │  [CEO] Planning...   │ [CEO]           │
│ ● Engineer      │  [Engineer] Reading  │ Planning        │
│   active        │  package.json...     │ approach...    │
│   $0.08/run     │                      │                 │
│                 │  Trent is an AI      │ [Engineer]      │
│ ○ Analyst       │  cofounder OS with   │ lib/orchestrator│
│   offline       │  a multi-agent...    │ 142 lines       │
│                 │                      │                 │
│ ○ Finance       │                      │ [Approvals]     │
│   offline       │                      │ 0 pending       │
│                 │                      │                 │
│ ──────────────  │                      │ [Budget]        │
│ Budget          │                      │ $4.50 / $10.00  │
│ $4.50/$10.00    │                      │ today           │
│                 │                      │                 │
│ ──────────────  │                      │ [Tools]         │
│ Tools: 8 active │                      │ 8 active        │
│ Skills: 12      │                      │ Skills: 12      │
│ MCP: 3 servers  │                      │ MCP: 3          │
│                 │                      │                 │
│ ──────────────  │                      │ [Self-Improvement│
│ Last sweep:     │                      │ 2 skills distilled│
│ 2 skills distilled                      │ GEPA: +0.03    │
│ 3h ago          │                      │                 │
└─────────────────┴──────────────────────┴─────────────────┘
```

**Key TUI features:**
- Modal overlays (press `?` for help, `m` for model switch, `f` for fleet, `t` for tools)
- Mouse-selectable menus and sidebar items
- Non-blocking input (type while agents work)
- Split panes with resizable dividers
- Real-time SSE timeline in the activity panel
- Approval gates appear as modal dialogs with `y/n` prompts
- `/voice on` enables voice mode (Ctrl+B to record)
- `/personality <name>` switches personality

**TUI components (Ink/React):**
```
<App>
  <Sidebar>
    <FleetStatus agents={agents} />
    <BudgetDisplay spent={spent} cap={cap} />
    <ToolsList tools={tools} />
    <SkillsList skills={skills} />
    <SelfImprovementStatus lastSweep={sweep} />
  </Sidebar>
  <Chat>
    <MessageList messages={messages} />
    <InputBox onSubmit={sendMessage} onSlash={handleSlash} />
  </Chat>
  <ActivityPanel>
    <AgentActivity agents={activeAgents} />
    <ApprovalQueue approvals={pendingApprovals} />
    <BudgetBreakdown agents={agents} />
  </ActivityPanel>
</App>
```

### Surface 3: Desktop App

**Technology:** [Tauri](https://tauri.app/) (Rust + React frontend)

**Equivalent to:** Hermes Desktop

**Desktop-specific UX:**
- System tray icon with context menu:
  - Quick chat (opens mini-window)
  - Fleet status
  - Approve pending (if any)
  - Open full dashboard
  - Settings
  - Quit
- Native OS notifications for:
  - Approval gate triggered
  - CEO autopilot update ready
  - Agent completed a mission
  - Budget threshold reached (50%, 80%, 100%)
  - Self-improvement sweep results
- Built-in terminal panel (embedded TUI via xterm.js)
- File drag-and-drop for wiki uploads
- Auto-update on launch (checks for new versions)
- Global hotkey to summon Trent (e.g., Cmd+Shift+T on macOS)

**Desktop window layout:**
```
┌─────────────────────────────────────────────────────────┐
│  [≡] Trent Dashboard          [Fleet: 2 active]  [⚙]   │
├──────────┬──────────────────────────────────────────────┤
│          │                                              │
│ Sidebar  │  Main Content Area                           │
│          │                                              │
│ Dashboard│  ┌────────────────────────────────────────┐  │
│ Fleet    │  │  Agent Activity Feed                   │  │
│ Missions │  │  [CEO] Planning approach... 2s ago      │  │
│ Workbench│  │  [Engineer] Reading files... 1s ago     │  │
│ Wiki     │  │  [CEO] Summary ready 0s ago             │  │
│ Settings │  └────────────────────────────────────────┘  │
│          │                                              │
│ ──────── │  ┌────────────────────────────────────────┐  │
│ Approvals│  │  Approval Queue                        │  │
│ (1)      │  │  ⚠ Engineer wants to create GitHub PR  │  │
│ Budget   │  │  [Approve] [Deny] [Review Changes]     │  │
│ $4.50    │  └────────────────────────────────────────┘  │
│          │                                              │
│ ──────── │  ┌────────────────────────────────────────┐  │
│ Terminal │  │  Embedded Terminal (xterm.js)          │  │
│          │  │  trent> _                              │  │
│          │  └────────────────────────────────────────┘  │
└──────────┴──────────────────────────────────────────────┘
```

### Surface 4: Web App (Existing Next.js)

**Technology:** Next.js 15 (already built)

**Web-specific UX:**
- The web app becomes the "command center" — full dashboard with all features
- Real-time SSE timeline for orchestration runs
- Wiki/memory with graph view
- Workbench IDE (Devin-style three-pane)
- Agent marketplace with browsing and purchase
- Company transparency pages
- Multi-company management
- Settings and configuration

---

## 3. Cross-Surface Design System

### Color System

```css
/* Agent role colors (consistent across all surfaces) */
--agent-ceo:          #8B5CF6;  /* Purple — leadership */
--agent-engineer:     #06B6D4;  /* Cyan — engineering */
--agent-growth:       #10B981;  /* Green — growth */
--agent-content:      #F59E0B;  /* Amber — content */
--agent-support:      #3B82F6;  /* Blue — support */
--agent-analyst:      #EC4899;  /* Pink — analysis */
--agent-finance:      #EF4444;  /* Red — finance */
--agent-browser:      #6366F1;  /* Indigo — browser */
--agent-escalation:   #F97316;  /* Orange — escalation */

/* Status colors */
--status-active:      #10B981;  /* Green dot */
--status-idle:        #F59E0B;  /* Amber dot */
--status-offline:     #6B7280;  /* Gray dot */
--status-approval:    #EF4444;  /* Red dot */
--status-error:       #DC2626;  /* Red */

/* Surface colors (dark-first) */
--bg-primary:         #0F1117;  /* Near-black */
--bg-secondary:       #1A1D27;  /* Dark gray */
--bg-tertiary:        #252937;  /* Medium gray */
--text-primary:       #E4E6EB;  /* Off-white */
--text-secondary:     #9CA3AF;  /* Medium gray */
--text-muted:         #6B7280;  /* Gray */
--accent:             #8B5CF6;  /* Trent purple */
--border:             #2D3139;  /* Subtle border */
```

### Typography

```css
/* Primary font (UI, conversation) */
--font-sans: 'Inter', system-ui, sans-serif;

/* Monospace (code, tool calls, agent IDs, terminal) */
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;

/* Display (headers, banners) */
--font-display: 'Inter', system-ui, sans-serif;

/* Sizes */
--text-xs:    0.75rem;   /* 12px — labels, captions */
--text-sm:    0.875rem;  /* 14px — secondary text */
--text-base:  1rem;      /* 16px — body text */
--text-lg:    1.125rem;  /* 18px — section headers */
--text-xl:    1.5rem;    /* 24px — page titles */
--text-2xl:   2rem;      /* 32px — banners */
```

### Spacing & Layout

```css
/* Spacing scale (4px base) */
--space-1:  4px;
--space-2:  8px;
--space-3:  12px;
--space-4:  16px;
--space-6:  24px;
--space-8:  32px;
--space-12: 48px;

/* Border radius */
--radius-sm: 4px;
--radius-md: 8px;
--radius-lg: 12px;
--radius-xl: 16px;

/* Shadows (desktop/web only) */
--shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
--shadow-md: 0 4px 6px rgba(0,0,0,0.4);
--shadow-lg: 0 10px 15px rgba(0,0,0,0.5);
```

### Component Patterns

**Agent message bubble (all surfaces):**
```
┌─ [CEO] ───────────────────────────────────────┐
│ Trent is an AI cofounder OS with a multi-     │
│ agent orchestrator that...                    │
│                                               │
│ 📎 lib/orchestrator.ts · 142 lines            │
│ ⏱ 2.3s · 💰 $0.12 · 🤖 GPT-5.6-terra         │
└───────────────────────────────────────────────┘
```

**Approval gate card (all surfaces):**
```
┌─ ⚠ APPROVAL REQUIRED ─────────────────────────┐
│                                               │
│  Engineer wants to: Create GitHub PR          │
│                                               │
│  Repository: acme-inc/web-app                 │
│  Branch: feature/auth-fix                     │
│  Files changed: 3                             │
│                                               │
│  [Review Changes]  [Approve]  [Deny]          │
│                                               │
│  Budget impact: $0.08 · Time: ~30s            │
└───────────────────────────────────────────────┘
```

**Fleet status card (all surfaces):**
```
┌─ FLEET STATUS ────────────────────────────────┐
│                                               │
│  ● CEO          active   GPT-5.6-terra        │
│  ● Engineer     active   Claude Sonnet 5      │
│  ● Support      idle     Claude Haiku 4.5     │
│  ○ Analyst      offline                      │
│  ○ Finance      offline                      │
│                                               │
│  Budget: $4.50 / $10.00 today (45%)           │
│  Last sweep: 2 skills distilled, 3h ago       │
│  Pending approvals: 1                         │
└───────────────────────────────────────────────┘
```

---

## 4. Terminal Backend UX

### Docker Terminal Backend

```
$ trent config set terminal.backend docker
✅ Terminal backend set to Docker
✅ Egress proxy configured — credentials will not enter the sandbox
✅ Egress proxy token issued: trnt_egress_****

$ trent
trent> Run the test suite
[Engineer] Spawning Docker sandbox...
[Engineer] Sandbox ready (container: trent-sandbox-a1b2c3)
[Engineer] Running: npm test
[Engineer] Tests: 1,731 passed, 122 skipped ✓
[Engineer] Cleaning up sandbox...
[Engineer] Done. Cost: $0.03
```

### SSH Terminal Backend

```
$ trent config set terminal.backend ssh
$ trent config set terminal.ssh.host user@server.example.com
✅ Terminal backend set to SSH
✅ SSH connection verified

$ trent
trent> Deploy to staging
[Engineer] Connecting to staging server...
[Engineer] Running: npm run build && npm run deploy:staging
```

---

## 5. Setup Wizard UX

### Quick Setup Flow

```
$ trent setup --portal

╔══════════════════════════════════════════════════════════╗
║  Trent Quick Setup                                        ║
╚══════════════════════════════════════════════════════════╝

Step 1/4: Authentication
  🔐 Opening browser for Trent Cloud login...
  ✅ Logged in as crodie@example.com

Step 2/4: Model Selection
  Available providers (3 keys detected):
    ❯ OpenAI — GPT-5.6-terra (recommended)
      Anthropic — Claude Sonnet 5
      Google — Gemini 2.5 Pro
      OpenRouter — Multi-provider routing

  ✅ Provider: OpenAI
  ✅ Model: GPT-5.6-terra

Step 3/4: Starter Agents
  Select your starter fleet:
    [x] CEO — Strategic decisions, planning
    [x] Engineer — Code, builds, debugging
    [x] Support — Customer responses

  Additional agents available (install later with `trent fleet install`):
    Analyst, Growth, Content, Finance, Browser, Escalation
    + 155 more specialists in the marketplace

  ✅ 3 starter agents installed

Step 4/4: Tool Configuration
  ✅ Tool Gateway enabled (web search, images, TTS, browser)
  ✅ File Operations enabled
  ✅ Terminal enabled (Docker backend)
  ⚪ Voice mode — install with: trent extras install voice
  ⚪ Messaging gateway — configure with: trent gateway setup

╔══════════════════════════════════════════════════════════╗
║  ✅ Setup Complete!                                        ║
║                                                          ║
║  Your fleet is ready. 3 agents active.                   ║
║  Budget: $10.00/day (adjust with `trent config set`)    ║
║                                                          ║
║  Next steps:                                             ║
║    trent              — Start chatting                   ║
║    trent --tui        — Modern TUI                       ║
║    trent fleet list   — Browse 164 agents                ║
║    trent skills browse — Browse skills                   ║
║    trent doctor       — Health check                     ║
╚══════════════════════════════════════════════════════════╝
```

### Blank Slate Flow

```
$ trent setup
  ❯ Quick Setup (Trent Cloud)
    Full Setup
    Blank Slate

> Blank Slate selected

╔══════════════════════════════════════════════════════════╗
║  Blank Slate — Minimal Agent                              ║
╚══════════════════════════════════════════════════════════╝

The following are enabled:
  ✓ Provider and model
  ✓ File Operations toolset
  ✓ Terminal toolset

The following are disabled:
  ✗ Web
  ✗ Browser
  ✗ Code execution
  ✗ Vision
  ✗ Memory
  ✗ Delegation
  ✗ Cron
  ✗ Skills
  ✗ Plugins
  ✗ MCP servers
  ✗ Compression
  ✗ Checkpoints
  ✗ Smart routing
  ✗ Memory capture
  ✗ Self-improvement

Would you like to:
  ❯ Start with the minimal agent (finish setup)
    Walk through all configurations and opt in

> Start with the minimal agent

✅ Blank Slate configured.
✅ Writes explicit platform_toolsets.cli and agent.disabled_toolsets
✅ Disabled tools will not load, even after `trent update`

To enable features later:
  trent tools          — Enable toolsets
  trent skills opt-in --sync  — Seed skills
  trent setup agent    — Adjust agent settings
```

---

## 6. Slash Commands (All Surfaces)

| Command | Function | Available In |
|---|---|---|
| `/help` | Show all available commands | CLI, TUI, Desktop, Web |
| `/fleet` | Show fleet status | CLI, TUI, Desktop, Web |
| `/tools` | List and configure tools | CLI, TUI, Desktop, Web |
| `/model` | Switch models interactively | CLI, TUI, Desktop, Web |
| `/skills` | Browse and manage skills | CLI, TUI, Desktop, Web |
| `/mcp` | List MCP servers | CLI, TUI, Desktop, Web |
| `/approvals` | Show pending approvals | CLI, TUI, Desktop, Web |
| `/budget` | Show budget status | CLI, TUI, Desktop, Web |
| `/personality <name>` | Switch personality | CLI, TUI |
| `/voice on/off` | Toggle voice mode | CLI, TUI |
| `/save` | Save conversation | CLI, TUI |
| `/sessions` | List sessions | CLI, TUI |
| `/doctor` | Run health check | CLI, TUI |
| `/fleet install <agent>` | Install an agent | CLI, TUI, Desktop, Web |
| `/fleet deploy <agent>` | Deploy agent to active duty | CLI, TUI, Desktop, Web |
| `/config` | View/edit configuration | CLI, TUI, Desktop, Web |
| `/wiki` | Access wiki/memory | CLI, TUI, Desktop, Web |
| `/workbench` | Open workbench IDE | TUI, Desktop, Web |
| `/marketplace` | Browse agent marketplace | TUI, Desktop, Web |
| `/traces` | View recent agent traces | TUI, Desktop, Web |

---

## 7. Personality System

Personalities modify the agent's tone and style without changing its capabilities:

```
trent> /personality pirate
✅ Personality set to: Pirate
[CEO] Arrr, let me be plottin' our course for the quarter...

trent> /personality professional
✅ Personality set to: Professional
[CEO] Let's review our quarterly objectives...

trent> /personality default
✅ Personality set to: Default
[CEO] Let me plan our approach for the quarter...
```

**Built-in personalities:**
- `default` — Trent's standard tone
- `professional` — Formal, concise
- `casual` — Friendly, conversational
- `pirate` — Fun, pirate-themed
- `robot` — Mechanical, precise
- `coach` — Encouraging, motivational
- `custom` — User-defined (via config)

Personalities are stored as prompt suffixes in `~/.trent/personalities/`.

---

## 8. Technology Stack Summary

| Surface | Technology | Key Libraries |
|---|---|---|
| CLI | Node.js binary | commander, chalk, ora, inquirer |
| TUI | Ink (React for CLIs) | ink, ink-text-input, ink-select-input, ink-spinner, ink-table |
| Desktop | Tauri (Rust + React) | @tauri-apps/api, tauri-plugin-notification, tauri-plugin-shell |
| Web | Next.js 15 (existing) | SSE, React Server Components, Tailwind |
| Terminal backend | Docker / SSH / E2B / Daytona | dockerode, ssh2, @e2b/code-interpreter |
| Egress proxy | Node.js TLS daemon | node-forge, node-tls |
| Voice | faster-whisper (Python sidecar) | faster-whisper, sounddevice |
| Config | YAML + dotenv | js-yaml, dotenv |
| Sessions | SQLite (local) / PostgreSQL (cloud) | prisma, better-sqlite3 |
| Packaging | Bun (single binary) or pkg | bun build --compile |
| Installer | Shell + PowerShell + NSIS/DMG | — |
| Notifications | tauri-plugin-notification (desktop), node-notifier (CLI) | — |
| Auto-update | update-notifier + tauri-plugin-updater | — |
