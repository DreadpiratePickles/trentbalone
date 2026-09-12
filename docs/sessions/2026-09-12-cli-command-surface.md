# 2026-09-12 — CLI command surface (Milestone 2, task 2.7)

Branch `feature/trent-fleet-v2`. Scope owned: `apps/cli/src/commands/**` and `apps/cli/src/index.ts`.
No git run, nothing committed.

## RED
`npx vitest run apps/cli/src/commands` → **29 failed / 29**, `TypeError: (0, runCli) is not a function`
(`buildProgram`/`runCli` did not exist). Both new test files failed to collect meaningfully.

## What was built
- `registry.ts` — `defineCommand` is the only door into the Commander tree; it attaches the global
  flag set (`--json`, `--profile`, `--no-color`, `-c/--continue`, `--version`, `--dry-run`) before the
  caller sees the command. `assertRegistryInvariants` re-walks the finished tree and throws if any
  command lacks `--json` or a description.
- `context.ts` — every side effect (stdout, stderr, config, doctor checks, setup, REPL) is injected.
- Groups: `diagnostics` (doctor, setup), `configuration` (model, tools, config), `fleet`
  (fleet, skills), `sessions` (sessions, mcp), `servers` (a2a, acp, gateway, egress, web),
  `maintenance` (update, uninstall, serve shim).
- `index.ts` (commands) — `buildProgram` / `runCli(argv) -> {exitCode, stdout, stderr, keepAlive}`.
- `apps/cli/src/index.ts` — the only `process.exit` in the CLI.

## Findings
- Commander 15: an option declared on the **parent** shadows the same option on a subcommand, so
  `cmd.opts()` in a subcommand action never saw `--json`. Fixed by reading `optsWithGlobals()`.
- `@trent/core` does **not** export `errors/` from its root index or its `exports` map. Imported as
  `@trent/core/errors/index.js`, which resolves through the tsconfig/vitest path alias.
- `SetupWizard` now takes `Partial<SetupContext>`, not a `ConfigManager`; the previous call sites in
  `apps/cli` were stale and were replaced.
- `apps/cli/package.json` declares `bin: ./dist/index.js`; nothing builds `dist` (Milestone 5).

## GREEN
`npx vitest run apps/cli/src/commands` → exit 0, **246 passed**, 43 commands discovered dynamically.
`npx tsx apps/cli/src/index.ts doctor --json` → exit **3** (2 real failing checks on this machine).
`npx tsx apps/cli/src/index.ts serve` → exit **2**, points at `trent a2a serve` / `trent web`.
