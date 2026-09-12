# Milestone 2 — Doctor and Setup (task-level)

Ordered BEFORE the REPL on the reviewer's insistence: the live model test is `skipIf(!KEY)`, so without
a doctor that proves a key with a real authenticated call, a skipped test reads as green. That is exactly
the trap already found on this machine — a 16-character placeholder key with a green credentials check.

Prerequisites: Task 1.2 (`TrentError`, exit codes) and Task 1.3 (ConfigManager) complete.

---

## 2.1 — Credentials check that cannot be fooled
**Existing defect:** the check tests only that a string is non-empty. A `sk-ant-` placeholder of 16
characters passed as `ok`.

- **RED tests** (`doctor/checks/credentials.test.ts`):
  1. a 16-char `sk-ant-` value produces status `fail`, not `ok`, with a message naming the key length
  2. a well-formed but rejected key produces `fail` after a real authenticated call (inject a fetch that returns 401)
  3. a working key produces `ok` (inject a fetch that returns 200)
  4. an unreachable provider produces `warn`, not `fail` — offline is not the same as misconfigured
  5. the check completes within its timeout when the injected fetch never resolves
  6. no key value ever appears in the result, even in `details`
- **Shape rules:** every provider has a `validateShape(key): boolean` (prefix + plausible length) and a
  `probe(key, signal): Promise<"ok"|"unauthorized"|"unreachable">` that issues the cheapest
  authenticated request that provider offers. Gemini: `GET /v1beta/models`. Anthropic: a 1-token
  message. OpenAI: `GET /v1/models`.
- **Every probe carries an AbortSignal with a hard timeout.** Hermes's doctor is documented to hang on
  connectivity checks; ours must not. Default 5s, configurable.

## 2.2 — Replace the three lying checks
`checks/mcp.ts`, `checks/cron.ts` and `checks/workbench.ts` currently return hard-coded green inside a
try block that cannot throw.
- **RED per check:** induce a real failure and assert the check reports it.
  - MCP: point at an unreachable server, assert `fail` and that the server name appears.
  - Cron: assert it reads real scheduler state; with no scheduler, `warn` with a reason.
  - Workbench: with the Docker daemon down (true on this machine), assert `warn`/`fail` naming Docker,
    never `ok`. This is directly testable today — `docker info` exits 1 here.
- Delete the hard-coded `details` literals.

## 2.3 — Database check per mode
- Standalone: open the SQLite file, run `PRAGMA integrity_check` and report `journal_mode`; assert
  `wal`. Test with a deliberately corrupted file and assert `fail`.
- Connected: HTTP GET the health endpoint. The web app already returns
  `{"status":"ok","checks":{"database":"ok"},"readiness":{"db":"memory"}}`, and it degrades cleanly
  with no `DATABASE_URL` — assert the check distinguishes `db: memory` from a real database and says so.

## 2.4 — Environment-contract check (new; guards the 2x bug)
Not in the original spec. `trent doctor` must verify `TRENT_QUEUE_FALLBACK=disabled` and that Redis
vars are unset, and explain the consequence in the failure message: every job runs twice, silently.
Reuse `assertStandaloneEnv` from Task 1.1 so there is one definition.

## 2.5 — `--fix` with copy-pasteable remediation
- Safe automatic fixes: create missing directories, write a default config, unlink orphan symlinks,
  quarantine a corrupt session file, set `.env` to 0600, enable WAL.
- **Never** touch credentials, never delete user data.
- **RED test:** every check that can fail must return a `fixHint` string, and every automatic fix must
  be idempotent — running `--fix` twice changes nothing the second time. Assert by hashing the config
  directory before and after the second run.
- The current code advertises a log-prune fix that does not exist. Either implement pruning or remove
  the claim; a hint that does nothing is a lie.

## 2.6 — Setup wizard with real prompts
Three modes. The existing implementation has no prompts and no OAuth at all.
- Quick: detect keys already present in the environment, confirm, write config, install three starter
  agents. No browser OAuth until a portal exists — do not pretend.
- Full: walk provider, model, toolsets, agents, budget. Every prompt pre-fills the current value.
- Blank Slate: provider + model + file_ops + terminal only, and it must WRITE explicit
  `platform_toolsets.cli` and `agent.disabled_toolsets` so a later update cannot silently re-enable them.
- **RED test:** drive the wizard with a scripted input stream and assert the resulting config file,
  including that Blank Slate wrote both explicit disable lists.
- After setup, run the doctor automatically and show the result. Hermes runs its wizard inside the
  installer; we match that.

## 2.7 — `--json` on every command
- **RED test:** enumerate every registered command and assert each accepts `--json` and emits parseable
  JSON, and that a forced failure emits the `TrentError` envelope from Task 1.2. The test must discover
  commands dynamically from the Commander instance, not from a hard-coded list, so a new command
  cannot forget the flag.

## Done when
`trent doctor` runs every check against something real, no check can return green without inspecting,
`--fix` is idempotent, the wizard writes a config a fresh `trent` can use, and `--json` is universal.
