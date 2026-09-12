# Trent Desktop Application

The Trent Desktop App provides a companion workstation built with Tauri, React, and Tailwind CSS.

---

## Key Features

1. **System Tray Integration**:
   - Dynamic tray icon reflects fleet activity:
     - 🟢 **Active**: Agents are running subtasks.
     - 🟡 **Idle**: Monitoring workspace and ready for input.
     - 🔴 **Approval Required**: An agent has paused for human sign-off.
   - Quick menu: Open chat, view pending approvals, run doctor diagnostics, quit.

2. **Global Hotkey Overlay**:
   - Press `Cmd+Shift+T` (macOS) or `Ctrl+Shift+T` (Linux/Windows) anywhere on your computer to toggle the Trent window.

3. **Native Desktop Notifications**:
   - Instant OS alerts when cofounders complete long-running tasks, encounter errors, or request action approvals.

4. **Embedded Terminal**:
   - Live interactive terminal running Trent's PTY engine. Execute `trent doctor`, `trent fleet`, or bash commands without switching apps.

5. **Approval Bridge & Action Queue**:
   - Visual inspection of proposed shell commands and file changes with one-click **Approve** or **Deny**.

6. **164-Specialist Fleet Explorer**:
   - Filter and deploy domain cofounders with instant category sorting and pack deployment.

---

## Running in Development

```bash
# In the repository root:
npm run --prefix apps/desktop tauri dev
```

## Building Native Installers

```bash
# Produces .dmg (macOS), .msi/.exe (Windows), or .AppImage/.deb (Linux):
npm run --prefix apps/desktop tauri build
```
The compiled binaries will be output to `apps/desktop/src-tauri/target/release/bundle/`.
