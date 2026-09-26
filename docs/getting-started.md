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
| bun | For the durable SQLite store (`npm run cli:bun`) and `npm run build:binary` | Not yet checked by doctor |

Docker is optional. Without it, set the terminal backend to `local` and everything else works. bun is
optional too: without it everything runs, but approvals, budget and the audit chain live in process
memory and do not survive a restart, and `trent service install` refuses (exit 3) unless you pass
`--allow-ephemeral` (see "Durable state needs Bun" below).

## 2. Clone and install

```bash
git clone <your remote> trent && cd trent
npm install
```

`npm install` sets up the workspaces in `packages/*` and `apps/*`. It does not install anything into
`~/.trent`. It also generates the Prisma client for the CLI's SQLite store: the root `postinstall`
runs `prisma generate --schema packages/trent-core/prisma/schema.sqlite.prisma`, the same command CI
runs. It writes only `packages/trent-core/src/store/generated/`, which is gitignored, and it is safe
to re-run with `npm run postinstall` after a schema change or a `git clean`.

### Durable state needs Bun

The store's SQLite driver is `bun:sqlite`, so the store is durable only when the CLI runs under Bun:

```bash
npm run cli:bun --                          # the REPL, persisted in trent.db in the profile directory
npm run cli:bun -- improve status --json    # "store": {"durable": true}
```

Under Node (`npm run cli --`) everything works, but the store is in process memory: the REPL prints
`This session is not durable`, `trent service install` exits 3 unless you pass `--allow-ephemeral`, a
daemon started anyway logs `service.ephemeral_store` at start, and approvals, budget and the audit
chain do not survive a restart.
`npm run cli:bun` runs `bun --no-env-file apps/cli/src/index.ts`, so a `.env` file in the directory
you launch from is never read.

## 3. Check what is missing

```bash
npm run cli -- doctor
```

On a fresh machine this reports failures, and that is the point. Real output from this repository:

```
TRENT DOCTOR

  ◆ Config Validity            Config file not found at /Users/you/.trent/config.yaml; running
                               with defaults.
      fix: Run `trent setup` to generate an initial configuration.
  ✗ API Credentials            Active provider "google" needs GEMINI_API_KEY; the secrets file
                               does not exist yet.
      fix: Run `trent config set GEMINI_API_KEY <your-api-key>`.
  ✓ Standalone Environment Contract Standalone environment contract holds: the queue fallback is
                               disabled and no Redis variable is set.
  ✓ Fleet Agents               3 installed agent(s) loaded, 1 active.
  ...
  · Brain Repository           The brain has not been created yet: it is written on the first run
                               that assembles a prompt.
  ◆ App Memory Tiers           The app's company memory is not used: DATABASE_URL is unset, so
                               the app's store is in-process and a tier row would not outlive
                               this process; ...

  total 20  passed 9  warnings 4  failed 1  skipped 4  in 7097ms
  1 check(s) failed — exit 3
```

That is an elided capture of `TRENT_HOME=$(mktemp -d) npm run cli -- doctor`, taken on 2026-09-18
with `TRENT_QUEUE_FALLBACK=disabled` exported by hand, which the CLI now does for you (section 4).
Your own counts will differ; the exit code is the part to read. Exit code 3 means configuration. See
[doctor.md](doctor.md).

## 4. The environment contract

There is nothing to export. The CLI sets `TRENT_QUEUE_FALLBACK=disabled` itself, before anything
else loads, whenever the variable is unset or empty (`apps/cli/src/env-defaults.ts`). Two things are
still yours:

```bash
unset TRENT_EVAL_SYNC_QUEUE REDIS_URL UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
```

and never set `TRENT_QUEUE_FALLBACK` to anything but `disabled`. An explicit value is left alone, and
the doctor's Standalone Environment Contract check fails on it.

This is not optional and it is not a performance tweak. Without `disabled` the application's inline
queue fallback races the CLI's own drain loop and every job executes twice. Measured on a three-step
run: 31 worker invocations, 13 step executions, `run_done` emitted ten times, nothing on stderr, final
status `completed`. You would only find out from the bill.

If a shell profile or a `.envrc` sets any of those variables for another project, remove them there
rather than in one terminal, so a second terminal does not behave differently from the first.

## 5. Run setup

```bash
npm run cli -- setup --mode quick
```

Three modes exist:

- `--mode quick` detects a key already in your shell or in `~/.trent/.env`, then writes that
  provider, its default model, the starter seats and every toolset whose backend is present (`media`,
  `social` and `business` stay off until ffmpeg or a `trent connect` provider exists, and `a2a`
  until `a2a.peers` names a peer). It asks one
  confirmation before writing. With no key present it names the environment variables and the
  `.env` path, writes nothing, prints `Setup did not complete: No provider key found. ...` and exits
  3. It does not fake an OAuth flow. With `--provider ollama` or `--provider lmstudio` it looks for
  no key at all: it checks the runtime and the model instead (section 11).
  When there is no key but a model on this machine could run Trent now (Ollama or LM Studio at its
  usual loopback address, listing a chat model that can call tools: the one `trent setup --mode local`
  would choose), setup leads with it instead: `Ollama at http://127.0.0.1:11434 has qwen3.5:9b. To use
  it, run: trent setup --mode local`. It still writes nothing and exits 3 with `"reason": "no-key"`, and
  `--json` adds `"suggested": "local"`.
- `--mode full` walks every provider, messaging platform and toolset interactively, and offers to
  store a key through a masked prompt.
- `--mode blank-slate` keeps `file_ops` and `terminal` and writes every other toolset name into
  `disabled_toolsets`, `agent.disabled_toolsets` and `platform_toolsets.cli`, so a later update
  reading any of the three cannot re-enable something you never asked for.

The `toolsets` list in `config.yaml` is what the seats get, and it accepts seventeen names:
`file_ops`, `terminal`, `web`, `browser`, `code`, `vision`, `memory`, `delegation`, `cron`,
`skills`, `plugins`, `mcp`, `human`, `media`, `social`, `business` and `a2a`. A `config.yaml` with no
`toolsets` key gets nine of them — everything except `browser`, `vision`, `memory`, `mcp`, `media`,
`social`, `business` and `a2a`. `web` needs the egress proxy, and when it
is off the banner says `skipped web (...)` instead of dropping it silently. `memory` rides in
through the fleet-memory hook whether or not the list names it, and the run's `todo`, `clarify` and
`session_search` tools are registered on every build rather than enabled here. Above
`tools.disclosure_threshold` registered tools (24 by default) everything outside the core toolsets
is reached through `tool_search`, `tool_describe` and `tool_call` instead of being advertised
directly; MCP, plugin and app-catalog tools are behind those bridges at any count. See
[tools.md](tools.md).

Setup writes `~/.trent/config.yaml`. Bare `npm run cli --` with no config on disk runs quick setup
automatically. When that finds no key it prints `Setup did not complete: ...`, writes no config and
opens the REPL anyway, in degraded mode (section 7), so the next launch runs setup again and picks
up a key once there is one. `doctor`, `setup`, `config` and `uninstall` never run setup, because
those are what you run when the config is the broken thing.

Setup exits 0 when it wrote a configuration and 3 when it did not. `--json` prints exactly one JSON
document on stdout in every outcome, with `"reason": "no-key"` (plus `"suggested": "local"` when a local model is ready) or `"cancelled"` when it did not
complete (`"runtime-unreachable"` or `"model-not-pulled"` on a local provider, section 11), and sends the wizard's own lines and prompts to stderr. The prompts need a terminal: with
stdin redirected, `full` and `blank-slate` refuse before touching the profile, and `quick` refuses at
its confirmation, each with one line and exit 2:

```
$ npm run cli -- setup --mode blank-slate </dev/null
error: setup.blank-slate: stdin is not a terminal, so nothing here can answer the blank-slate setup questions; run trent setup --mode blank-slate in a terminal
  exit code: 2
```

## 6. Add a model key

The live model path is proven against Google Gemini. Get a key from Google AI Studio, then:

```bash
npm run cli -- config set GEMINI_API_KEY <your-key>
npm run cli -- config set provider google
```

`config set` routes any key the secrets schema recognises to `~/.trent/.env` rather than
`config.yaml`, and `config get` on a secret reports `[set]`, never the value. That file and the
process environment are the only places a key is read from: the compiled binary is built with
Bun's `.env` autoload off, so a `.env.local` in the project you launch it from is never consulted.

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

Trent still starts, and it tells you loudly what you are looking at. With no provider key present
under any name setup detects (the list `trent setup` prints: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_API_KEY` or `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`,
`GROQ_API_KEY`), the planner falls back to a deterministic plan, the critic auto-passes and every
model call is refused, so a run ends `Run failed: every model call failed`. The REPL prints one
paragraph before the first turn and marks every agent line `DEGRADED` for the rest of the session.
A first launch on a clean profile with no key, driven from a pipe (`\r` submits a line; the REPL
ends when stdin does):

```
$ printf '/help\r' | npm run --silent cli --
No provider API key was found.
Trent has no hosted sign-in. A key is read from one of two places:
  1. your shell environment
  2. the profile env file at ~/.trent/.env
Set one of these variables, then run setup again:
  ...
Setup did not complete: No provider key found. Set OPENAI_API_KEY (or another provider variable listed above) in your environment or in ~/.trent/.env, then run setup again.
  (the boot banner)
◆ DEGRADED MODE — no model provider key was found, so nothing typed here reaches
  a model: an objective gets a deterministic fallback plan, the critic
  auto-passes, and the run fails when its model calls are refused. Without a key
  these still work: /help, trent doctor, trent config get|set, trent fleet list
  and trent brain status|log|show. To fix it, put a provider key
  (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY; trent setup lists every
  one) in your shell or in the profile .env file, then run: trent setup
```

When a local runtime already has a usable model, the first-run screen names it first: `Ollama at
http://127.0.0.1:11434 has qwen3.5:9b, which needs no key. To use it, run: trent setup --mode local`,
and the DEGRADED MODE banner and the API Credentials hint in `trent doctor` name the same command
(`apps/cli/src/commands/__tests__/setup-keyless.test.ts`).

If you see `DEGRADED`, nothing on the screen came from a model. A local provider (section 11) needs
no key, so this paragraph never appears for one; its REPL is degraded only when the runtime is down
or lacks the configured model, and then it says so in one line. `trent connect` does not add a model
key: it connects business and social providers (see [connect.md](connect.md)).

## 8. Start a conversation

```bash
npm run cli --          # REPL
npm run cli:bun --      # REPL on the durable store (needs bun; see section 2)
npm run tui             # full-screen Ink TUI
npm run cli -- --continue
```

Both surfaces run on the same session engine and the same model gateway. In the REPL, Ctrl+C aborts
the in-flight stream and leaves the process alive; Ctrl+J inserts a newline; `/exit` or Ctrl+D ends
the session once nothing is running.

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

Two of those commands are about undoing work rather than asking for it. Every file a seat writes is
recorded in a per-turn ledger under `<profile>/checkpoints/<run id>/` together with the bytes that
were there before: `/checkpoints` lists the turn's writes and `/rollback` puts them back, and a
write made while `checkpoints.enabled` was false was never recorded and cannot be undone. See
[checkpoints.md](checkpoints.md). `/goal` and `/goals` open and list standing goals with shell
quality gates ([goals.md](goals.md)); `/stop` interrupts a run that is in flight.

### One shot, for scripts, pipes and CI

```bash
npm run cli -- run "Draft the launch email"            # the REPL transcript, without the prompt
echo "Draft the launch email" | npm run cli -- run -   # objective on stdin
npm run cli -- run "..." --format stream-json          # one JSON object per line
npm run cli -- run "..." --json                        # the final result object only; the app's own stdout lines go to stderr
npm run cli -- run "..." --max-cost-cents 200          # stop the run once it passes $2.00
npm run cli -- run "..." --model gemini-3.6-flash      # the whole run on one model of the profile's provider
```

A run that belongs to a goal ends by running that goal's shell quality gates, and a turn that edited
code cannot give a final answer without fresh test or build evidence — `trent goal create "<objective>"
--gate "typecheck=npx tsc --noEmit"` and `goals.verify_on_stop`, both in [docs/goals.md](goals.md).

`trent run` builds the same headless runtime the REPL, the gateway and `trent cron` build, runs one
objective on it, and exits. It is not interactive: a step that needs an approval cannot be answered
here, so the run parks, the approval is persisted, and the command prints the id and exits 7. Decide
it from the shell with `trent approvals approve <id>` or `trent approvals reject <id>` — or in the
REPL with `/approvals approve <id>` — then run the objective again. `trent approvals list` shows
everything waiting, including a memory write held because the step that produced it read untrusted
context. Ctrl+C aborts the run and releases the runtime before the process goes.

`--format stream-json` emits a `system` line (run id, profile, provider, model), then **every
orchestrator event verbatim**, then one final `result` line. The event lines are the run bus's own
`OrcEvent` objects — `{kind, runId, at, step?, run?, detail?}`, the same objects the gateway handler
folds into a reply and the REPL records in a session — with a `type` field mirroring `kind` so one
field switches every line. Nothing is renamed, dropped or invented here: a tool call is on
`step.toolCalls` of a `step_output` event, a step's cost is `step.costCents`, a run's summary is
`run.summary` on `run_done`. The kinds are listed in `packages/trent-core/src/orchestrator/types.ts`.

The last line is `{"type":"result","status":"completed","cost_cents":0,"duration_ms":0,"run_id":"...","model":"...","models":[...]}`,
whose first keys are the session store's own (`run_id`, `cost_cents`, `duration_ms`). `status` is
`completed`, `failed`, `paused` (an approval, and then `approval_id` names it) or `cancelled` (the
cost cap, or Ctrl+C), and `error` carries the reason when there is one. `model` is the model the run
was asked to run on (the `--model` pin, else the configured model) and `models` the distinct models
its steps reported, which is what actually ran. Costs are integer cents, never dollars.

A run that lost model calls part-way, or whose drain stopped on an error, ends with one `run_failed`
event carrying a `verdict`, and the `result` line repeats it: `error` is a one-line summary naming the
error class and the provider (`1 of 4 steps failed: google HTTP 429 rate_limit (You exceeded your
current quota) on content; consolidation skipped; retry after 3600s`), `reason` is
`model_calls_failed` or `run_error`, `failed_steps` lists `{seat, step, error_class, message,
provider, status, retry_after_seconds}`, and `completed_steps`, `total_steps`, `consolidation`
(`completed`, `failed` or `skipped`) and `retry_after_seconds` (the longest wait a provider asked
for) follow. "the run ended without a verdict" is left only for a stream that closed before any
step reported one.

`--model <id>` runs the whole run on one model of the profile's provider: the planner, the critic,
the consolidator and every seat, whatever tier the profile gives each of them, and over a model
variable set in the shell. `trent run` is the run's only process, so the pin is written into the
environment before the runtime loads, and unless `models.fallback_on_pin` is true no call of the run
may fall back to another provider. The `system` line names the pin, every `step_end` carries it in
`step.model`, and so do the run's rows in the spend ledger (`trent usage --by model`). A pinned cron
job ([jobs.md](jobs.md)) runs through this same flag in a child process.

| Exit | Meaning |
|---|---|
| 0 | The run completed |
| 1 | The run failed; the `result` line carries the reason in `error` |
| 2 | No objective was given |
| 3 | Configuration: an unknown `--format`, a `--max-cost-cents` that is not a positive whole number, a `--model` that is not one model id, an empty stdin |
| 5 | A provider refused the run's model calls part-way (a 429 quota or rate limit, a 5xx, a 401): the `result` line's `reason` is `model_calls_failed` |
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
npm run cli -- sessions search "launch email"       # full text over this profile's transcripts
npm run cli -- sessions export <id>                 # structure and metrics, no message bodies
npm run cli -- sessions export <id> --include-content --out run.json
npm run cli -- brain status                         # identity, decisions, notes, git versioning
npm run cli -- workspace status                     # what this directory would put in the prompt
npm run cli -- security audit                       # read-only; exit 1 on a finding
```

`sessions export` is the boundary a transcript crosses on its way off the machine: bodies are left
out unless `--include-content` says otherwise, and what does leave has been through the redactor, so
a key someone pasted into a prompt does not travel with it. `--out` writes the file mode 0600.

## 11. Local models

Trent can run on a model served from your own machine by Ollama, LM Studio or a llama.cpp server.
None needs a key. [local-models.md](local-models.md) is the full page: the hardware tiers, the
commands from a clean machine to a first solo turn, the numbers measured on the development machine,
the settings and the known limits. `--mode local` sets up the whole local stack in one pass: it lists
what each runtime has with sizes, picks the chat model by this machine's memory and the embedding
model by role, and writes the provider, the model, `memory.embedder`, `agent.mode: solo`, and
`terminal.backend: local` when Docker does not answer. Quick setup on a local provider, below, checks
only the runtime and the chat model.

```bash
npm run cli -- setup --mode local --dry-run                   # the plan for this machine; writes nothing
npm run cli -- setup --mode local                             # the local stack (--pull offers what is missing)
ollama serve                                                  # if Ollama is not already running
npm run cli -- setup --mode quick --provider ollama           # checks Ollama, proposes the model for this machine
npm run cli -- setup --mode quick --provider ollama --pull    # the same, and offers to pull a missing model
npm run cli -- setup --mode quick --provider ollama --model qwen3.5:9b   # any model Ollama has
npm run cli -- setup --mode quick --provider lmstudio         # LM Studio's server
```

Quick setup on a local provider asks for no key and never claims one is set. It checks that the
runtime answers where a run will send its calls (Ollama at `http://127.0.0.1:11434` or
`OLLAMA_BASE_URL`; LM Studio at `http://127.0.0.1:1234` or `LMSTUDIO_BASE_URL`), lists the models it
has, and proposes the one that fits the machine's memory, read from the operating system:

| Memory | Ollama tag | Download |
|---|---|---|
| under 32 GB (a 16 GB or 24 GB Mac) | `qwen3.5:9b` | 6.6 GB |
| 32 GB up to 64 GB | `qwen3.6:27b` | 18 GB |
| 64 GB and up | `qwen3.6:35b-a3b` | 23 GB |

The tags and sizes were read from the Ollama library on 2026-09-26, and the tiers come from
`01_discovery/output/local-models-2026-09-26.md` section 6. The old default, `llama3.2`, is gone:
Berkeley's function-calling leaderboard scores Llama 3.2 3B at 21.95% overall and 4% on multi-turn
tasks. `--model` takes any model the runtime has instead. LM Studio downloads models in its own app,
and setup matches them by name, so `qwen/qwen3.5-9b` counts as the 9B.

When the runtime does not answer, setup names the URL and the start command (`ollama serve`, or
`lms server start`) and exits 3 with `"reason": "runtime-unreachable"`. When the model is not there,
it prints the exact `ollama pull <tag>` line and exits 3 with `"reason": "model-not-pulled"`.
`--pull` offers to pull it instead, after a confirmation, so it needs a terminal. Neither stop asks a
question, so both work from a script. Full setup (`--mode full`) reports the same things and writes
the configuration anyway, because you may start the runtime afterwards.

What to expect, by tier. Setup prints the line for the model it wrote.

- 16 GB, `qwen3.5:9b`: Single tool calls mostly work at 9B. Multi-step plans are unreliable and
  chains of three or more tool calls fail often, so keep each objective short and explicit. Every
  cold prompt pays for prefill first, so expect tens of seconds before the first token on a Mac.
- 32 GB, `qwen3.6:27b`: Tool calls work well on short chains at 27B. Planning is adequate for
  bounded, well-specified tasks but below hosted frontier models. Every cold prompt pays for prefill
  first, and a dense 27B on a Mac can spend a minute or more on one long seat prompt.
- 64 GB, `qwen3.6:35b-a3b`: Tool calls work well on short chains with this 35B mixture-of-experts
  model. Planning is adequate for bounded, well-specified tasks but below hosted frontier models.
  Only 3B parameters are active per token, so prefill is faster than a dense 27B, but a cold long
  prompt still costs seconds to tens of seconds.

The minute on a 27B is measured: a 27B on an M1 Max evaluated prompts at 34.7 tokens per second
(`01_discovery/output/trent-local-path-audit-2026-09-26.md`), and a seat prompt is about 6,200 tokens.

On a local provider the REPL does not print the no-key paragraph of section 7. It is degraded only
when the runtime is down or lacks the configured model, and then it prints one line:

```
◆ DEGRADED — Ollama not answering at http://127.0.0.1:11434. Run: ollama serve
◆ DEGRADED — Ollama at http://127.0.0.1:11434 has no qwen3.6:27b. Run: ollama pull qwen3.6:27b
```

The improvement judge (`improve.judge_model`, [improve.md](improve.md)) never falls back to a hosted
model on a local provider. Set it to a second local model, for example
`npm run cli -- config set improve.judge_model qwen3.6:27b`. Otherwise a live sweep refuses with
`judge needs a second local model: set improve.judge_model`.

## Not yet implemented

- A published release for `curl … | bash` installation. The installer exists and is tested, and the
  pipeline that would publish it exists (`.github/workflows/release.yml` on a `v*` tag,
  `.github/workflows/pages.yml` for `agent.let-trent.uk`), but no tag has been pushed and GitHub
  Pages is not enabled, so `agent.let-trent.uk/install.sh` returns 404 and there is nothing to
  download. Blockers and the release procedure:
  `05_release/output/release-runbook.md`; run `scripts/release/preflight.sh` before tagging.
- A `trent` binary on your `PATH` without building it yourself (`npm run build:binary`). Use
  `npm run cli --`.
- Windows outside CI. The `windows-x64` binary is built and executed on a Windows runner in
  `.github/workflows/binary.yml`; nothing has been run on a Windows desktop by hand.
