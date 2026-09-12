# Desktop launch evidence — 2026-09-12

Built bundle: `apps/desktop/src-tauri/target/debug/bundle/macos/Trent Fleet.app` (224 MB) plus a DMG.
`npx tauri build --debug` -> exit 0.

## Launch log (the binary's own stdout, run directly)
```
[trent-desktop] sidecar pid 45962 bound to 127.0.0.1:56435
[server]    Next.js 15.5.25
[trent-desktop] http://127.0.0.1:56435 accepting after 575 ms
[server]  Ready in 247ms
```
A random free port. The window stays hidden until the port accepts.

## What it serves — verified by loading the sidecar's URL in a browser
1. Boot screen: the `trent.` wordmark in bone with the mint dot, the atmosphere grid, mono tracked
   labels `BOOT SEQUENCE 01 / 05  EDITION 01  OPERATING`, and `SKIP INTRO`.
2. Agent boot: `BOOTING 9 AGENTS` — Atlas, Forge, Vector, Quill, Echo, Prism, Vault, Guard, Pipeline,
   each `READY` in mint.
3. Landing: `TRENT - THE ONE HIRE`, the mint cube, nav, and the `HIRE TRENT` call to action.

This is the real `apps/web` application, not a rebuilt copy. Constraint 19 satisfied.

## Defect observed in the served app (pre-existing, not the wrapper)
```
[auth][error] MissingSecret: Please define a `secret`. https://errors.authjs.dev#missingsecret
```
The web app's auth layer requires `AUTH_SECRET`. The desktop must generate one per install and persist
it in `~/.trent`, otherwise sign-in paths fail. Queued as a fix.

## Shutdown
`pkill` on the parent -> sidecar terminated, no orphan on the port.

## Screen recording note
`screencapture` from this session is attributed to the CLI process, not the app granted the
permission, and macOS reports "could not create image from display" until that process restarts.
The browser capture of the same server is the evidence recorded here.
