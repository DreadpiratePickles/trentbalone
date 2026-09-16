# Configuration

Configuration is split in two. Non-secret settings live in `config.yaml` as YAML. Secrets live in
`.env` beside it, mode 0600, and never appear in `config.yaml`, in logs, or in command output.

## Where things live

```
~/.trent/
  config.yaml                    default profile settings
  .env                           default profile secrets, mode 0600
  trent.db                       SQLite store
  sessions/                      transcripts, mode 0600
  skills/                        installed skills
  traces/                        self-improvement trace store
  egress/                        CA certificate, CA key (0600), tokens.json
  profiles/<name>/config.yaml    a named profile's settings
  profiles/<name>/.env           a named profile's secrets
```

The base directory is `$TRENT_HOME` if set, otherwise `~/.trent`.

```bash
npm run cli -- config list
```

```
  base dir /Users/you/.trent
  active   default
    default
    test-slash
```

## The config schema

The schema is a zod object in `packages/trent-core/src/config/schema.ts`. Unknown top-level keys pass
through instead of being stripped, so a config written by a newer release is not destroyed by an
older one.

```yaml
version: 3                    # integer on-disk schema version
profile: default
provider: openai              # openai anthropic google mistral openrouter deepseek groq ollama
model: gpt-5.6-terra
personality: default
theme: dark                   # dark | light

toolsets:                     # file_ops terminal web browser code vision memory
  - file_ops                  # delegation cron skills plugins mcp
  - terminal
disabled_toolsets: []

budget:
  daily_cap: 1000             # INTEGER CENTS. 1000 = USD 10.00
  per_run_cap: 100            # INTEGER CENTS. 100 = USD 1.00
  currency: USD
  alert_thresholds: [50, 80, 100]   # percentages, not money

terminal:
  backend: docker             # docker | local
  docker:
    image: trent-sandbox:latest
    network: bridge

egress:
  enabled: true
  proxy_port: 8089
  auto_token: true
  intercept_domains:
    - api.openai.com
    - api.anthropic.com
    - generativelanguage.googleapis.com

gateway:
  enabled: false
  platforms: []
  routes: {}                  # platform -> agentId

fleet:
  installed_agents: [ceo, eng-ai-engineer, support-responder]
  active_agents: [ceo]
  default_agent: ceo
```

### Money is integer cents

Every monetary field in the schema is `z.number().int()`. `daily_cap: 1000` is ten dollars.
`daily_cap: 10` is ten cents. This matches the rule the rest of the platform already follows and it
is not negotiable: a float dollar value in a cents field is how a ten-dollar cap once became a
ten-cent cap, which the setup wizard rebuild found and fixed.

Percentages are the exception. `alert_thresholds` is a list of percentages of `daily_cap`.

## The yaml and env split

`config set` decides where a value goes by name. Anything in the secrets schema goes to `.env`;
everything else goes to `config.yaml`.

```bash
npm run cli -- config set budget.daily_cap 2500     # -> config.yaml, USD 25.00
npm run cli -- config set provider google           # -> config.yaml
npm run cli -- config set GEMINI_API_KEY <key>      # -> .env, mode 0600
npm run cli -- config get provider                  # prints the value
npm run cli -- config get GEMINI_API_KEY            # prints [set]
npm run cli -- config unset personality
```

Recognised secret names include `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `E2B_API_KEY`,
`DAYTONA_API_KEY`, the messaging tokens (`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`,
`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `WHATSAPP_TOKEN`, `SIGNAL_NUMBER`, the `EMAIL_SMTP_*`
group, the `TEAMS_*` group) and `TRENT_CLOUD_TOKEN`. Any other key found in `.env` is kept rather
than dropped on parse, so a provider key added by a newer release survives a round trip.

Writes are atomic: write to a temporary file, then rename, with the mode re-asserted afterwards.

## Profiles

A profile is a directory. `--profile <name>` selects it for any command.

```bash
npm run cli -- --profile work doctor
npm run cli -- --profile client-acme config get provider
```

`default` uses `~/.trent` directly. Any other name uses `~/.trent/profiles/<name>/`, with its own
`config.yaml` and its own `.env`. Sessions, skills and agents are per-profile too; an earlier version
shared them from the base directory across every profile, which is fixed.

## The standalone environment contract

Four environment variables decide whether a run executes once or twice. This is measured behaviour
of the wrapped application, not a style preference.

| Variable | Required value | What goes wrong otherwise |
|---|---|---|
| `TRENT_QUEUE_FALLBACK` | `disabled` | Every job executes twice, silently |
| `TRENT_EVAL_SYNC_QUEUE` | unset | Synchronous dispatch double-runs against the explicit drain |
| `REDIS_URL` | unset or empty | `getQueue()` returns a queue and a BullMQ connection is attempted |
| `DATABASE_URL` | a SQLite URL, or unset | Unset selects the in-memory store; set selects the Prisma store |

### Why `TRENT_QUEUE_FALLBACK=disabled` is mandatory

A compiled binary does not run under vitest, so it does not inherit the `NODE_ENV=test` escape hatch
that suppresses the queue's inline fallback processor at `apps/web/lib/queue.ts:189`. Left at its
default, that fallback fires each job through `setTimeout` while the CLI is also draining the queue
explicitly. Both run. On a measured three-step run that produced 31 worker invocations, 13 step
executions, `run_done` emitted ten times, zero bytes on stderr, and a final status of `completed`.
Roughly four times the model bill, with no error anywhere to notice.

`applyStandaloneEnv()` in `packages/trent-core/src/runtime/env.ts` sets all four correctly and must
be called before the first import of any `apps/web/lib` module, because `ai-client.ts` freezes its
model registry and token limits at module evaluation time. `assertStandaloneEnv()` throws if
something later mutated the environment, naming only variables, never values.

The doctor checks this with the same function the runtime uses, so there is exactly one definition of
what is safe:

```bash
npm run cli -- doctor --json | grep -A3 '"category": "Environment"'
```

## Migrations

`config.yaml` carries an integer `version`. `CONFIG_SCHEMA_VERSION` is currently 3.

- 1: the pre-versioned layout, with budget in float dollars.
- 2: an explicit integer `version` key, with budget in integer cents.
- 3: `terminal.backend` accepts only `docker` and `local`. A stored `ssh` or `e2b` (both were mocks
  that returned a success string without running anything) is rewritten to `docker`, and the
  migration result carries a note saying so.

Migration steps live in `packages/trent-core/src/config/migrate.ts`. Bump the constant and add a step
whenever the stored shape changes.

## Not yet implemented

- Cloud profiles or a hosted configuration store. `TRENT_CLOUD_TOKEN` is reserved in the secrets
  schema and nothing consumes it.
- A `trent config edit` command. Edit the YAML directly.
- Voice transcription. There is no `voice` section in the schema and no speech engine behind the
  `/voice` command; calling it raises a `TrentError` (`voice.transcribe: voice transcription is not
  available in this release`). A `voice:` block left over in an older `config.yaml` is ignored, not
  migrated: the schema passes unknown top-level keys through untouched.
