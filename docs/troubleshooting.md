# Troubleshooting

Failure modes that have actually happened here, with the command that identifies each one.

## A placeholder key passes as configured

Symptom: the doctor is green, live tests are skipped rather than failed, and every model response is
a deterministic plan.

Cause: a 16-character placeholder sat in `~/.trent/.env` under `ANTHROPIC_API_KEY`. The old
credentials check tested for presence, so it reported green. A `skipIf(!KEY)` live test also reads as
green when it is skipped, so nothing anywhere disagreed.

Identify:

```bash
npm run cli -- doctor --json | grep -A4 '"category": "Credentials"'
```

```
"status": "fail",
"message": "ANTHROPIC_API_KEY is not a usable Anthropic key: key is 16 characters; an Anthropic key
            is at least 40. This looks like a placeholder.",
```

Fix: `npm run cli -- config set ANTHROPIC_API_KEY <real key>`, then run the doctor again. It
validates the shape and then makes one cheap authenticated call, so a plausible-looking string still
fails.

Related: if the REPL prints `DEGRADED MODE` or marks agent lines `DEGRADED`, no provider key was
found at all and nothing on screen is model output.

## Every job runs twice and the bill quadruples

Symptom: no error, no warning, a run status of `completed`, and roughly four times the expected
spend. `run_done` fires more than once.

Cause: `TRENT_QUEUE_FALLBACK` is not `disabled`. The wrapped application's inline queue fallback at
`apps/web/lib/queue.ts:189` fires each job through `setTimeout` while the CLI is also draining the
queue explicitly. Both run. Under vitest, `NODE_ENV=test` suppresses the fallback, which is why this
never shows up in a test run and always shows up in a real one.

Measured on a three-step run: 31 worker invocations, 13 step executions, `run_done` emitted ten
times, zero bytes on stderr.

Identify:

```bash
npm run cli -- doctor --json | grep -A4 '"category": "Environment"'
```

Fix:

```bash
export TRENT_QUEUE_FALLBACK=disabled
unset TRENT_EVAL_SYNC_QUEUE REDIS_URL UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
```

Put these in your shell profile. A second terminal without them behaves differently from the first,
which is the worst version of this bug.

## The retired Google default model 404s

Symptom: a valid Gemini key, a passing credentials check, and a 404 from the provider on the first
real call.

Cause: `apps/web/lib/ai-client.ts:73` hard-codes `gemini-2.0-flash` as the Google default. That model
is retired. `gemini-2.5-flash` is refused for recently created keys. Every new Google key on the
platform hits a dead model unless the default is overridden.

Fix:

```bash
export GOOGLE_MODEL_DEFAULT=gemini-3.6-flash
```

The live gateway test reads the same variable and defaults to the same model. `apps/web/` is
read-only in this repository, so this is reported rather than patched.

Related: Google streams carry no usage numbers, because the wrapped client requests usage reporting
for OpenAI only. The gateway estimates and marks the record `estimated: true`. A cost that says
estimated is an estimate.

## A 429 from the provider fails the live tests

Symptom: `npm run test:live` fails with `429 status code (no body)` from `openai/src/core.ts`.

Cause: rate limiting on a free-tier key, not a code defect. The live suite makes three real streaming
calls back to back.

Fix: wait, or use a key with a higher quota. The non-live suite is unaffected:

```bash
npx vitest run --exclude "**/*.live.test.ts"
```

## Docker is not running, or the sandbox image is missing

Symptom: the Workbench check fails or warns, and the docker terminal backend does nothing useful.

Identify:

```bash
docker info >/dev/null 2>&1 && echo "docker ok" || echo "docker down"
npm run cli -- doctor | grep -A2 Workbench
```

Two distinct states, and the doctor distinguishes them:

- Daemon down: `docker info` exits 1. Start Docker Desktop.
- Daemon up, image absent: `Docker daemon is running (server 29.5.3) but the sandbox image
  trent-sandbox:latest is not present locally.` The image is not published anywhere, so it cannot be
  pulled. Either build one locally or point `terminal.docker.image` at an image you already have.

To work without Docker entirely, set `terminal.backend` to `local` — and read the warning in
[terminal.md](terminal.md) about what that gives up.

## bun is not on PATH in a non-login shell

Symptom: a bun-dependent step works in your terminal and fails in a script, a CI job, an editor task
or a `sh -c` invocation.

Cause: the bun installer appends its PATH lines to `~/.zshrc`. A non-login, non-interactive shell
does not read `~/.zshrc`, so `bun` is simply absent. `which bun` in that context returns nothing.

Identify:

```bash
which bun || echo "bun not found"
sh -c 'command -v bun || echo "bun not on PATH in this shell"'
```

Fix: use the absolute path, `~/.bun/bin/bun`, in any script or CI step, or export the PATH inside the
script rather than relying on the profile.

Nothing in the default developer loop needs bun today. It is the SQLite runtime and the binary
compiler, so you hit this when running the store tests or a build, not when running the CLI.

## Two tests time out under load

Symptom: `wrapped-modules.test.ts` and `derive-sqlite-schema.test.ts` fail with
`Test timed out in 5000ms` during a full parallel run.

Cause: contention. Run alone they pass in 7.2 seconds total:

```bash
npx vitest run packages/trent-core/src/wrapped-modules.test.ts \
               packages/trent-core/src/store/derive-sqlite-schema.test.ts
```

```
Test Files  2 passed (2)
     Tests  12 passed (12)
```

If they fail alone, that is a real regression.

## The compiled binary prints `PrismaClientInitializationError` and `trent run` dies on Linux

The wrapped app's Postgres client (`apps/web/lib/db.ts`) was being constructed in a process with no Postgres, and its engine — not shipped in the binary — failed to load as an unhandled rejection; since W1.1 the runtime never hands its SQLite URL to the app and guards the app's client seam when `DATABASE_URL` is not a postgres URL, so if you still see it, `DATABASE_URL` in your shell is a postgres URL the binary cannot reach the engine for, or a wrapper module imports an `apps/web` store module at the top level (`apps/cli/src/runtime/headless.app-store.test.ts` names it).

## `trent: command not found`

No release has been published yet, so nothing has installed a binary on your PATH. Use
`npm run cli -- <args>` from the repository root, or `npm run tui`. `scripts/install.sh` is the
real installer, but it downloads from GitHub Releases and there is no release to download; it will
stop at `resolve-version`.

## `trent web --start` refuses to start

`trent web --start` serves the real UI: it runs the same `apps/web/.next/standalone` tree the
desktop sidecar runs, on loopback, and polls `/` before it reports the port
(`apps/cli/src/commands/web-server.ts`, test `apps/cli/src/commands/__tests__/web.test.ts`).

It refuses in exactly one case — the standalone tree has not been built — and it says which:

```
web.start: the standalone web build is missing; run `cd apps/web && npm run build` or pass --build to build it now
```

Build it once, or let the command do it: `trent web --start --build`. A different message,
`no web application found`, means the command is not running from a clone and no desktop bundle is
installed; run it from the repository root, or `trent desktop install`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | `trent run`: the run itself failed (the objective did not complete) |
| 2 | Usage error |
| 3 | Configuration problem, including a failing doctor check |
| 4 | Authentication failure |
| 5 | Provider failure |
| 6 | Budget exceeded, including `trent run --max-cost-cents` |
| 7 | `trent run`: the run is parked on an approval a human has to decide |
| 130 | Interrupted |

Add `--json` to any command for a machine-readable error envelope. Secrets are redacted from it by
key name and by value shape, recursively.
