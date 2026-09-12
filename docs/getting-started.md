# Getting Started with Trent Fleet

Trent Fleet is a hybrid AI cofounder platform combining an autonomous CLI binary, an Ink-based TUI, a high-performance Tauri desktop app, and an extensible multi-agent fleet with 164 pre-configured specialists.

```
  ████████╗██████╗ ███████╗███╗   ██╗████████╗
  ╚══██╔══╝██╔══██╗██╔════╝████╗  ██║╚══██╔══╝
     ██║   ██████╔╝█████╗  ██╔██╗ ██║   ██║   
     ██║   ██╔══██╗██╔══╝  ██║╚██╗██║   ██║   
     ██║   ██║  ██║███████╗██║ ╚████║   ██║   
     ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   
       ⚡ F L E E T · A I   C O F O U N D E R ⚡
```

---

## 1. Quick Installation

### macOS / Linux (One-Line Installer)
Install Trent to `~/.trent` without root/sudo:
```bash
curl -fsSL https://trent.ai/install.sh | bash
```
Or run the local installer:
```bash
./scripts/install.sh
```

### Windows (PowerShell)
```powershell
irm https://trent.ai/install.ps1 | iex
```
Or run locally:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Once installed, ensure `~/.trent/bin` is in your `PATH`.

---

## 2. Running Setup

Trent offers three distinct setup profiles matching your workflow:

### Quick Setup (Fast-Path Bootstrap)
Configures your default model provider and installs the core cofounder trio (CEO, Engineer, Support):
```bash
trent setup --mode quick --provider anthropic --key sk-ant-...
```

### Full Setup (Multi-Model & All Connectors)
Interactive guided configuration for all 6 model providers, 8 messaging adapters, and developer toolsets:
```bash
trent setup --mode full
```

### Blank Slate (Minimal Zero-Extension Baseline)
Sets up a strict minimal agent with no extra toolsets, no external skills, and no autonomous background daemons:
```bash
trent setup --mode blank-slate
```

---

## 3. Starting Trent

### Classic Interactive REPL
Launch the cofounder chat session in your terminal:
```bash
trent
```

### Full-Screen Interactive TUI
Launch the split-screen terminal interface with the live fleet rail, approval prompts, and daily budget ticker:
```bash
trent --tui
```

### Resume Previous Session
Pick up exactly where you left off in your last cofounder discussion:
```bash
trent --continue
# or
trent -c
```

### System Diagnostics
Verify your credentials, sandbox runtime, and agents:
```bash
trent doctor
trent doctor --fix
```

### Desktop Application
Run the native desktop app with system tray, notifications, and embedded terminal:
```bash
npm --prefix apps/desktop run tauri dev
```
Global toggle hotkey: `Cmd+Shift+T` (macOS) or `Ctrl+Shift+T` (Linux/Windows).
