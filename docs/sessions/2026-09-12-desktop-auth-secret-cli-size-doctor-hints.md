# 2026-09-12 — desktop AUTH_SECRET, CLI binary size, doctor hints

Branch feature/trent-fleet-v2. Nothing committed.

## Fix 1 — desktop: per-install AUTH_SECRET (done, verified)
- New `apps/desktop/src-tauri/src/auth_secret.rs`: 32 random bytes (getrandom 0.3) hex-encoded, persisted at
  `~/.trent/desktop/auth-secret` (0600, dir 0700, temp-file + rename). Never regenerated, never logged.
- `server.rs` passes it as `AUTH_SECRET`. `Cargo.toml` adds `getrandom = "0.3"`.
- `cargo test`: 14 passed. `npx tauri build --debug`: exit 0. Launched the .app binary twice: `/api/auth/session` 200,
  zero `MissingSecret` lines, secret file hash identical across launches.
- Where the secret lives: `~/.trent/desktop/auth-secret` (value never recorded anywhere).

## Fix 2 — CLI binary size: requested change is a no-op (not applied)
- `@/lib/runtime-eval-overrides` has only `import type` lines; bun bundles it to 8 bytes. Hiding it from the
  bundler produced a byte-identical binary (82,966,002 both ways).
- Real chain: `@/lib/orchestrator -> orchestrator-run-queue -> queue -> workbench-orchestrator -> workbench-providers
  -> workbench-local-provider -> await import("playwright")`; `@/lib/queue` reaches it too. All inside apps/web
  (read-only). `orchestrator/index.ts` left unchanged.

## Fix 3 — doctor hints (done, verified)
- `cron.ts`: three `trent cron …` hints replaced with true statements. `workbench.ts:69` `trent terminal open` also
  bogus (out of listed scope, one line, same defect) — replaced.
- New `packages/trent-core/src/doctor/checks/fix-hints.test.ts` greps CLI top-level command names and asserts every
  `trent <word>` in any fixHint is registered. Doctor suite: 65 passed. tsc clean.
