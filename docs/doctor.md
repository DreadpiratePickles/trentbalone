# Doctor

`trent doctor` runs 18 checks. Each one inspects something real: a file, a daemon, a socket, an
authenticated request. None of them return a hard-coded green.

```bash
npm run cli -- doctor
npm run cli -- doctor --json
npm run cli -- doctor --fix
npm run cli -- doctor --dry-run
```

Options: `--fix`, `--mode <standalone|connected>`, `--health-url <url>`, `--timeout <ms>`, plus the
global `--json`, `--profile`, `--no-color`, `--dry-run`.

## Real output

```
TRENT DOCTOR

  ✓ Config Validity           Valid configuration (2 profiles loaded)
  ✗ API Credentials           ANTHROPIC_API_KEY is not a usable Anthropic key: key is 16
                              characters; an Anthropic key is at least 40. This looks like a
                              placeholder.
      fix: Replace it with a real key: `trent config set ANTHROPIC_API_KEY <your-api-key>`.
  ✗ Standalone Environment Contract
                              The standalone environment contract is violated
                              (TRENT_QUEUE_FALLBACK must be "disabled"; otherwise the inline
                              fallback races the drain loop and every job executes twice).
                              Consequence: every job runs twice, silently, roughly quadrupling
                              the model bill while the run still reports success.
      fix: Export TRENT_QUEUE_FALLBACK=disabled and unset TRENT_EVAL_SYNC_QUEUE, REDIS_URL,
           UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN before running Trent.
  ✓ Fleet Agents              5 installed agent(s) loaded, 4 active.
  ✓ Skills Hub                1 skill(s) synced and healthy.
  · MCP Connectors            No MCP servers are declared, so none were contacted.
  ✓ Network & Cloud Connectivity  Network connectivity verified; API endpoints reachable.
  ◆ Database & State Store    No database file at /Users/you/.trent/trent.db; nothing has been
                              persisted yet.
  ◆ Autonomous Scheduler      No scheduled jobs: /Users/you/.trent/cron/jobs.json does not exist,
                              so nothing is scheduled on this machine.
  ✓ Disk & Logs               Log storage healthy (0.0 MB across 0 files).
  ✓ System Binaries           All core binaries present (git, node, npm). Docker sandbox: available.
  ◆ Sandbox & Workbench       Docker daemon is running (server 29.5.3) but the sandbox image
                              trent-sandbox:latest is not present locally.
  ✓ Self-Improvement Loop     Trace store at /Users/you/.trent/traces is writable.

  · OTel Trace Export         Tracing is not configured (telemetry.otlp_endpoint is unset); nothing
                              was probed and nothing is exported.

  total 14  passed 7  warnings 3  failed 2  skipped 2  in 880ms
  2 check(s) failed — exit 3
```

Glyphs carry the status when colour is off: `✓` ok, `◆` warn, `✗` fail, `·` skip.

That capture, and the JSON one further down, are verbatim from a run that predates the egress root,
brain and app-memory checks, so both report `total 14`. They are transcripts, not specifications;
the table below is the current list, and a run of `trent doctor` here today reports `total 18`.

## The 18 checks

| # | Name | What it actually inspects | Auto-fixable |
|---|---|---|:---:|
| 1 | Config Validity | Reads `config.yaml`, parses the YAML, validates it against the zod schema, counts profiles | yes |
| 2 | API Credentials | Reads the key from the profile `.env`, then the process environment. Validates its shape against the provider's real format, then makes one cheap authenticated call | no |
| 3 | Standalone Environment Contract | Calls the same `assertStandaloneEnv()` the runtime calls. Reports variable names, never values | no |
| 4 | Fleet Agents | Reads `fleet.installed_agents` and `fleet.active_agents` and resolves each id against the catalog | no |
| 5 | Skills Hub | Walks the profile's skills directory and validates each installed skill | yes |
| 6 | MCP Connectors | Reads the declared servers and contacts each one. Skips when none are declared | no |
| 7 | Network & Cloud Connectivity | DNS lookup of the provider API hosts, with a 3-second race | no |
| 8 | Database & State Store | Standalone: opens the SQLite file and queries SQLite itself. Connected: asks the health endpoint, and distinguishes a real database from the in-memory fallback that answers "ok" while storing nothing | yes |
| 9 | Autonomous Scheduler | Reads `<profile>/cron/jobs.json` (the file the `cronjob_manage` tool and `trent cron` share) and `<profile>/cron/runner.lock`. Warns when no job is scheduled, when an enabled job's `next_run_at` is more than 6 hours in the past, and when jobs are enabled but no live process holds the runner lock (a lock left by a dead pid counts as none); passes only with on-time jobs and a live runner | no |
| 10 | Egress Interception Root | Parses `<profile>/egress/ca.crt` with `node:crypto`. A root minted before 8b369d6 can carry a non-minimal DER serial that OpenSSL refuses with `illegal padding`, which surfaces as an unexplained TLS failure on every interception and never names the file. No root at all passes: the proxy mints one on first use | yes |
| 11 | Disk & Logs | Sums the byte size and file count of the logs directory | no |
| 12 | System Binaries | Resolves `git`, `node`, `npm` as required and `docker` as optional, recording the version of each | no |
| 13 | Sandbox & Workbench | Runs `docker info` and checks the sandbox image is present locally. A backend named in YAML is a claim; `docker info` exiting 0 is evidence | no |
| 14 | Self-Improvement Loop | Creates the trace directory if absent, then writes and deletes a probe file to prove it is writable | yes |
| 15 | OTel Trace Export | Posts an empty OTLP batch to `telemetry.otlp_endpoint` under the probe deadline and reports reachable or unreachable. With no endpoint it reports `not configured` as a skip: a skipped check is not a pass, and the line says so | no |
| 16 | Recall Embedder | Resolves `memory.embedder` against the profile's keys, then embeds one character on the chosen endpoint with the cache off and a single attempt. `ok` names the provider, the model and the MEASURED dimension count; 401/403 fails; unreachable warns. With no key, or `provider: none`, it reports lexical TF-IDF ranking as a skip | no |
| 17 | Brain Repository | Stats `<profile>/brain/` and counts the system files, notes, decisions and seat directories actually on disk, and reports whether git versioning resolved. A brain that has not been written yet is a skip, not a failure: it is created by the first run that assembles a prompt | no |
| 18 | App Memory Tiers | Resolves the wrapped application's store from `DATABASE_URL` and reports which of the three cases this profile is in — unset (reachable but in-process, so tier rows die with the process), a postgres URL (reachable and durable), or a `file:` SQLite path (unreachable, recall falls back to run-derived candidates). See [configuration.md](configuration.md), "Company memory in the app" | no |

Checks 6, 9 and 13 used to return hard-coded green from inside a try block that could not throw.
Each now has a test that induces a real failure and asserts it is reported
(`packages/trent-core/src/doctor/checks/inspection.test.ts`).

### The credentials check

This is the one that matters most, because a skipped live test reads as green. Shape validation is
per-provider and specific:

- Anthropic: prefix `sk-ant-`, at least 40 characters.
- OpenAI: prefix `sk-`.
- Google: either the legacy 39-character `AIza` key, or the newer AI Studio key with an `AQ.`
  prefix.

Then it authenticates. Anthropic gets a one-token `/v1/messages` completion, the cheapest
authenticated call the API offers. OpenAI gets `GET /v1/models`. Google gets
`GET /v1beta/models` with the key in the `x-goog-api-key` header, never in the query string, so it
cannot land in a proxy log.

The 16-character placeholder that used to sit in `~/.trent/.env` and pass as green now fails.

## Timeouts

Every probe carries an `AbortSignal` and is also wrapped in a `Promise.race` timer. Two layers,
because a library that ignores its own timeout is exactly the failure mode being defended against.
Defaults are 15 seconds per check and 60 seconds for the run; `--timeout <ms>` overrides the
per-probe deadline. Three deliberately wedged checks still return a full report in under five
seconds.

## Exit codes

The doctor uses the CLI's shared taxonomy.

| Code | Meaning |
|---|---|
| 0 | Every check passed, or only warnings and skips |
| 2 | Usage error, such as an unknown flag |
| 3 | One or more checks failed |
| 4 | Authentication failure |
| 5 | Provider failure |
| 6 | Budget exceeded |
| 130 | Interrupted |

A non-zero exit is what lets the doctor gate CI.

```bash
npm run cli -- doctor --json > report.json; echo $?    # 3 on this machine
```

## JSON output

```json
{
  "timestamp": "2026-09-12T23:20:06.956Z",
  "total": 14,
  "passed": 7,
  "warnings": 3,
  "errors": 2,
  "skipped": 2,
  "durationMs": 1534,
  "results": [
    {
      "category": "Credentials",
      "name": "API Credentials",
      "status": "fail",
      "message": "ANTHROPIC_API_KEY is not a usable Anthropic key: key is 16 characters; an Anthropic key is at least 40. This looks like a placeholder.",
      "fixHint": "Replace it with a real key: `trent config set ANTHROPIC_API_KEY <your-api-key>`.",
      "details": { "provider": "anthropic", "envVar": "ANTHROPIC_API_KEY", "keyLength": 16 }
    }
  ]
}
```

`status` is one of `ok`, `warn`, `fail`, `skip`. `fixHint` is mandatory on anything that is not `ok`.
`details` never contains a credential, an environment value, or a request body — `keyLength` is a
length, not a prefix.

## `--fix`

Seven actions, in order. Every one is idempotent: it reports `changed: false` and writes nothing when
the desired state already holds, because `--fix` has to be safe to run in a loop and a fix that
churns the disk cannot be verified. After the actions run, the full check suite runs again and the
new report is returned alongside them.

| Category | Action | What it does |
|---|---|---|
| Config | `create_directories` | Creates the missing directories under the profile root |
| Config | `write_default_config` | Writes a schema-valid `config.yaml` when there is none |
| Skills | `unlink_orphan_symlinks` | Removes symlinks whose target no longer exists |
| Sessions | `quarantine_corrupt_sessions` | Moves an unparseable session file into `.quarantine/` with a note saying why |
| Credentials | `restrict_secrets_file_mode` | Chmods the secrets file to 0600 |
| Database | `enable_wal` | Turns on SQLite write-ahead logging on the store |
| Egress | `remove_unreadable_egress_root` | Deletes `<profile>/egress/ca.crt` when OpenSSL refuses it, after printing the file, the parse error and the `trent sandbox build` a trusting sandbox now needs |

Two rules bound all of them. A fix never touches a credential's value: `restrict_secrets_file_mode`
changes the mode and never reads or rewrites the file. A fix never deletes user data: a corrupt
session is quarantined, not removed. `remove_unreadable_egress_root` is the one unlink, and it is
not user data — the proxy mints a replacement, and while the refused root is on disk every
interception fails. It still announces the path on stderr before it deletes anything.

```bash
npm run cli -- doctor --fix --json
```

The JSON gains two keys, `actions` and `exitCode`. Each action reports
`{ category, action, changed, success, message }`. On a second run every `changed` is `false`:

```json
{ "category": "Credentials", "action": "restrict_secrets_file_mode",
  "changed": false, "success": true, "message": "Secrets file is already 0600." }
```

## `--dry-run`

Lists the checks that would run and performs no probes, no network calls and no writes.

## Not yet implemented

- `--mode connected` requires a running web server to point `--health-url` at. The server is a later
  milestone, so the connected path is exercised by tests and not by a live deployment.
- `trent cron start` is the only scheduler: nothing ticks `<profile>/cron/jobs.json` while it is
  not running. `trent cron run <id>` executes a job now regardless. See [cron.md](cron.md).
