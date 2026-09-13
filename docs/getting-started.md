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

## 9. Verify

Everything in this page is checkable:

```bash
npm run cli -- --version        # 1.0.0
npm run cli -- doctor --json    # machine-readable report, exit 3 on failure
npm run cli -- fleet status     # active, installed, catalog, budget
npm run cli -- sessions list
```

## Not yet implemented

- A published release for `curl … | bash` installation. The installer exists and is tested;
  `agent.let-trent.uk/install.sh` returns 404 and no GitHub release has been cut, so it has nothing
  to download.
- A `trent` binary on your `PATH` without building it yourself (`npm run build:binary`). Use
  `npm run cli --`.
- Windows outside CI. The `windows-x64` binary is built and executed on a Windows runner in
  `.github/workflows/binary.yml`; nothing has been run on a Windows desktop by hand.
