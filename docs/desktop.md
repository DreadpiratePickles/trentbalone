# Desktop app

`apps/desktop/` is a Tauri v1 shell with its own React 19 frontend. It is the least finished surface
in the repository. Read this page before relying on any of it.

## What it is today

- **Tauri v1**, not v2. `Cargo.toml` pins `tauri = "1.6"` and `tauri-build = "1.5"`; the npm side
  pins `@tauri-apps/api` and `@tauri-apps/cli` at `^1.6`. The design calls for v2. The migration has
  not happened.
- **A separate React frontend**, built by Vite from `apps/desktop/src/`. It does not load, embed or
  wrap `apps/web/`. There is no bundled Bun runtime and no `.next/standalone/` in
  `tauri.conf.json`'s `resources`, which is empty.
- **A global shortcut** registered as `CommandOrControl+Shift+T`, which shows or hides the main
  window. This part works as described.
- **A system tray** with a menu, built in `src-tauri/src/main.rs`.

## The build does not work

```bash
cd apps/desktop && npx tauri build --debug
```

```
Error `tauri.conf.json` error on `tauri > allowlist`: Additional properties are not allowed
('systemTray' was unexpected)
```

`systemTray` is not a v1 allowlist key. The configuration is rejected before compilation starts, so
`tauri build` and `tauri dev` both fail. There is also no `src-tauri/icons/` directory, though
`tauri.conf.json` lists five icon files, so the build would fail again on icons once the allowlist is
fixed. No 1024x1024 application icon has been authored.

The frontend alone does build:

```bash
cd apps/desktop && npm run build
```

```
✓ 1611 modules transformed.
dist/assets/index-S9D9lcqa.js  310.20 kB │ gzip: 90.30 kB
✓ built in 9.69s
```

## The tray does not change colour

`set_system_tray_state` takes `"active"`, `"idle"` or `"approval"` and calls `tray.set_tooltip`. That
is the whole function. The icon is `icons/32x32.png` for every state, and that file does not exist.
Any description of a green, amber or red tray icon is wrong.

## The embedded terminal is a simulator

`apps/desktop/src/terminal.ts` is a string matcher, not a terminal. It has no child process, no PTY,
no shell. Typing `trent doctor` in it appends fixed lines:

```
Running 12 diagnostics across config, credentials, agents, and systems...
✓ Config: valid configuration loaded
✓ Credentials: key detected and verified
✓ Agents: 3 installed cofounders, 1 active, 164 specialists ready
✓ Doctor: All 12 diagnostics passed! Fleet system operational.
```

None of that is real. The real doctor has 13 checks, fails on this machine, and exits 3. Any other
input falls through to `[PTY] Executed '<command>' successfully. Exit code: 0.`, which is printed
regardless of what you typed. Use the CLI.

## The "single binary" claim is retired for desktop

Next.js cannot be compiled into one binary. A spike measured 20 unresolved specifiers, and building
with `--external` produced a 169 MB binary that 404s its own chunks. The intended packaging is the
Bun runtime plus `.next/standalone/` shipped as Tauri resources, which makes the honest claim **no
external dependencies to install** — true, because the runtime is vendored — and not "a single
binary".

## Not yet implemented

Everything below was previously documented as a feature and is not built:

- The desktop app wrapping the web application. It renders its own React frontend instead.
- Tauri v2.
- A working `tauri dev` or `tauri build`.
- Native OS notifications on task completion, error or approval. `notifications.ts` exists; nothing
  drives it from a real run.
- An embedded terminal that runs anything.
- A tray icon that reflects fleet state.
- An approval queue backed by the durable approval gate.
- A fleet explorer backed by the real catalog.
- Any signed installer: `.dmg`, `.msi`, `.AppImage` or `.deb`.
