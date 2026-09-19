# Getting started

From a clone to a first real conversation. The one-line installer (`scripts/install.sh`) is written
and tested but no release has been published for it to download yet, so every command below runs
through the workspace.

## 1. Requirements

| Tool | Why | Checked by |
|---|---|---|
| Node 22 or newer | Runs the CLI and the test suite | `trent doctor`, Dependencies check |
| npm | Workspace installs | `trent doctor`, Dependencies check |
| git | Required by the dependencies check | `trent doctor`, Dependencies check |
| Docker | Only for the `docker` sandbox backend | `trent doctor`, Workbench check |
| bun | Only for the SQLite store and `npm run build:binary` | Not yet checked by doctor |

Docker is optional. Without it, set the terminal backend to `local` and everything else works. bun is
optional unless you want to compile the single-file binary yourself.

## 2. Clone and install

```bash
git clone <your remote> trent && cd trent
npm install
```

`npm install` sets up the workspaces in `packages/*` and `apps/*`. It does not install anything into
`~/.trent`.

## 3. Check what is missing

```bash
npm run cli -- doctor
```

On a fresh machine this reports failures, and that is the point. Real output from this repository:

```
TRENT DOCTOR

  ✓ Config Validity           Valid configuration (2 profiles loaded)
  ✗ API Credentials           ANTHROPIC_API_KEY is not a usable Anthropic key: key is 16
                              characters; an Anthropic key is at least 40. This looks like a
                              placeholder.
      fix: Replace it with a real key: `trent config set ANTHROPIC_API_KEY <your-api-key>`.
  ✗ Standalone Environment Contract
                              The standalone environment contract is violated
                              (TRENT_QUEUE_FALLBACK must be "disabled"; ...).
  ✓ Fleet Agents              5 installed agent(s) loaded, 4 active.
  ...
  total 13  passed 7  warnings 3  failed 2  skipped 1  in 880ms
  2 check(s) failed — exit 3
```

Exit code 3 means configuration. See [doctor.md](doctor.md).

## 4. Set the environment contract

```bash
export TRENT_QUEUE_FALLBACK=disabled
unset TRENT_EVAL_SYNC_QUEUE REDIS_URL UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
```

This is not optional and it is not a performance tweak. Without it the application's inline queue
fallback races the CLI's own drain loop and every job executes twice. Measured on a three-step run:
31 worker invocations, 13 step executions, `run_done` emitted ten times, nothing on stderr, final
status `completed`. You would only find out from the bill.

Put those lines in your shell profile, or in a `.envrc`, so a second terminal does not silently lose
them.

## 5. Run setup

```bash
npm run cli -- setup --mode quick
```

Three modes exist:

- `--mode quick` writes a default provider and model and the core seats. With no keys present it
  names the environment variables and the `.env` path and writes no credentials. It does not fake an
  OAuth flow.
- `--mode full` walks every provider, messaging platform and toolset interactively.
- `--mode blank-slate` writes explicit disable lists for toolsets, skills and background work.

The `toolsets` list in `config.yaml` is what the seats get. `file_ops`, `terminal`, `code`,
`delegation`, `plugins`, `skills`, `cron` and `web` are registered by the REPL; `web` needs the
egress proxy, and when it is off the banner says `skipped web (...)` instead of dropping it
silently. `memory` rides in through the fleet-memory hook, not the toolsets list. The default is
still `file_ops, terminal`; add the others explicitly.

Setup writes `~/.trent/config.yaml`. Bare `npm run cli --` with no config on disk runs quick setup
automatically. `doctor`, `setup`, `config` and `uninstall` never do, because those are what you run
when the config is the broken thing.

## 6. Add a model key

The live model path is proven against Google Gemini. Get a key from Google AI Studio, then:

```bash
npm run cli -- config set GEMINI_API_KEY <your-key>
npm run cli -- config set provider google
```

`config set` routes any key the secrets schema recognises to `~/.trent/.env` rather than
`config.yaml`, and `config get` on a secret reports `[set]`, never the value:

```
$ npm run cli -- config get ANTHROPIC_API_KEY
  ANTHROPIC_API_KEY [set]
```

Then confirm the key actually authenticates:

```bash
npm run cli -- doctor
```

The credentials check does not test for presence. It checks the key's shape against the provider's
real format, then makes one cheap authenticated call: a one-token completion for Anthropic, a models
listing for OpenAI and Google. A placeholder that looks plausible fails here.

### Pick a model that still exists

Set `GOOGLE_MODEL_DEFAULT` explicitly. The hard-coded Google default in the wrapped application,
`apps/web/lib/ai-client.ts:73`, is `gemini-2.0-flash`, which is retired and returns 404, and
`gemini-2.5-flash` is refused for keys created recently. The live gateway test uses
`gemini-3.6-flash`.

```bash
export GOOGLE_MODEL_DEFAULT=gemini-3.6-flash
```

Google streams do not carry usage numbers, because the wrapped client requests usage reporting for
OpenAI only. The gateway estimates the cost and marks the record `estimated: true` rather than
reporting a guess as measured.

## 7. What happens with no key

Trent still starts, and it tells you loudly what you are looking at. With no provider key present in
any of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY` or
`OPENROUTER_API_KEY`, the planner falls back to deterministic plans and the critic auto-passes. Both
are silent upstream, so the REPL prints a banner before the first turn and marks every agent line
`DEGRADED` for the rest of the session:

```
◆ DEGRADED MODE — no provider key is configured.
  Plans are deterministic fallbacks and the critic auto-passes.
  Nothing below is real model output. Run `trent doctor` to fix it.
```

If you see `DEGRADED`, nothing on the screen came from a model.

## 8. Start a conversation

```bash
npm run cli --          # REPL
npm run tui             # full-screen Ink TUI
npm run cli -- --continue
```

Both surfaces run on the same session engine and the same model gateway. In the REPL, Ctrl+C aborts
the in-flight stream and leaves the process alive; Ctrl+J inserts a newline.

A REPL session is a conversation, not a series of unrelated runs: your line and the run's own
consolidated output are appended to a session under `~/.trent/sessions/`, and the last few turns
travel with the next run, so "now do the second one" has something to refer to. `--continue` resumes
the most recent session — it prints a short recap, re-threads its turns and carries its spend into
the budget ticker. Nothing is written until your first turn, so opening and closing the REPL leaves
no empty session behind. A turn you interrupt is recorded as interrupted and is not offered to the
next run as if it had been an answer.

`/context` reports what the wrapper actually injected into the last seat call: the size of each of
the three tiers (stable, context, volatile), the character total with a token estimate, the
`context.ceiling_chars` it was measured against, the named blocks the ceiling dropped, and how many
times this session's transcript has been compacted. The figures come from the assembly itself, not
from a second count, so they match the prompt the seat was given. The TUI shows the same report in
its context pane, and both surfaces print one pressure notice per run once the injection passes 80
percent of the ceiling. `/help` lists every command the REPL takes.

### One shot, for scripts, pipes and CI

```bash
npm run cli -- run "Draft the launch email"            # the REPL transcript, without the prompt
echo "Draft the launch email" | npm run cli -- run -   # objective on stdin
npm run cli -- run "..." --format stream-json          # one JSON object per line
npm run cli -- run "..." --json                        # the final result object only
npm run cli -- run "..." --max-cost-cents 200          # stop the run once it passes $2.00
```

`trent run` builds the same headless runtime the REPL, the gateway and `trent cron` build, runs one
objective on it, and exits. It is not interactive: a step that needs an approval cannot be answered
here, so the run parks, the approval is persisted, and the command prints the id and exits 7. Decide
it in the REPL with `/approvals approve <id>` or `/approvals reject <id>`, then run the objective
again. Ctrl+C aborts the run and releases the runtime before the process goes.

`--format stream-json` emits a `system` line (run id, profile, provider, model), then **every
orchestrator event verbatim**, then one final `result` line. The event lines are the run bus's own
`OrcEvent` objects — `{kind, runId, at, step?, run?, detail?}`, the same objects the gateway handler
folds into a reply and the REPL records in a session — with a `type` field mirroring `kind` so one
field switches every line. Nothing is renamed, dropped or invented here: a tool call is on
`step.toolCalls` of a `step_output` event, a step's cost is `step.costCents`, a run's summary is
`run.summary` on `run_done`. The kinds are listed in `packages/trent-core/src/orchestrator/types.ts`.

The last line is `{"type":"result","status":"completed","cost_cents":0,"duration_ms":0,"run_id":"..."}`,
whose keys are the session store's own (`run_id`, `cost_cents`, `duration_ms`). `status` is
`completed`, `failed`, `paused` (an approval, and then `approval_id` names it) or `cancelled` (the
cost cap, or Ctrl+C), and `error` carries the reason when there is one. Costs are integer cents,
never dollars.

| Exit | Meaning |
|---|---|
| 0 | The run completed |
| 1 | The run failed; the `result` line carries the reason in `error` |
| 2 | No objective was given |
| 3 | Configuration: an unknown `--format`, a `--max-cost-cents` that is not a positive whole number, an empty stdin |
| 6 | The run passed `--max-cost-cents` and was stopped |
| 7 | The run is parked on an approval; `approval_id` names it |
| 130 | Interrupted (Ctrl+C); the run was aborted and the runtime released |

## 9. Serve the web UI

```bash
cd apps/web && npm run build && cd ../..   # once: produces apps/web/.next/standalone
npm run cli -- web --start                  # http://127.0.0.1:3000, Ctrl+C to stop
npm run cli -- web --start --open --port 0  # free port, opens the browser once ready
npm run cli -- web --start --json           # {port, url, pid, source} once ready, then keeps serving
```

`trent web --start` runs the same `.next/standalone` tree the desktop app ships, on loopback only,
with the standalone environment contract (`TRENT_QUEUE_FALLBACK=disabled`) and an `AUTH_SECRET`
generated once per profile at `~/.trent/auth_secret` (mode 0600, never printed). Without the build
it exits 3 and prints the command above; `--start --build` runs the build for you. From an
installed layout with no clone it serves the resources `trent desktop install` laid down, and exits
3 naming that command when they are absent. `--dry-run` reports the entry and port without
spawning anything.

## 10. Verify

Everything in this page is checkable:

```bash
npm run cli -- --version        # 1.0.0
npm run cli -- doctor --json    # machine-readable report, exit 3 on failure
npm run cli -- fleet status     # active, installed, catalog, budget
npm run cli -- sessions list
npm run cli -- sessions export <id>                 # structure and metrics, no message bodies
npm run cli -- sessions export <id> --include-content --out run.json
```

`sessions export` is the boundary a transcript crosses on its way off the machine: bodies are left
out unless `--include-content` says otherwise, and what does leave has been through the redactor, so
a key someone pasted into a prompt does not travel with it. `--out` writes the file mode 0600.

## Not yet implemented

- A published release for `curl … | bash` installation. The installer exists and is tested, and the
  pipeline that would publish it exists (`.github/workflows/release.yml` on a `v*` tag,
  `.github/workflows/pages.yml` for `agent.let-trent.uk`), but no tag has been pushed, GitHub Pages
  is not enabled, and the repository is private, so `agent.let-trent.uk/install.sh` returns 404 and
  there is nothing to download. Blockers and the release procedure:
  `05_release/output/release-runbook.md`; run `scripts/release/preflight.sh` before tagging.
- A `trent` binary on your `PATH` without building it yourself (`npm run build:binary`). Use
  `npm run cli --`.
- Windows outside CI. The `windows-x64` binary is built and executed on a Windows runner in
  `.github/workflows/binary.yml`; nothing has been run on a Windows desktop by hand.
