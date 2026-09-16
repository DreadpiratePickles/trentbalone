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
  double_text_policy: enqueue # enqueue | interrupt | reject: a second message on a busy chat

repl:
  double_text_policy: enqueue # the same three modes for input typed during a REPL turn

runtime:
  max_concurrent_runs: 2      # runs driven at once per profile; the next one waits FIFO (docs/jobs.md)

heartbeat:
  enabled: false              # trent heartbeat start, and gateway start, run the loop only when true
  interval_minutes: 60        # one model turn over <profile>/HEARTBEAT.md per interval
  # active_hours:             # unset means never quiet
  #   start: "08:00"          # HH:MM on the wall clock of tz; the end is exclusive
  #   end: "20:00"            # a window that crosses midnight (22:00-06:00) wraps
  #   tz: Europe/Berlin       # IANA zone, default UTC
  consolidate_memory: true    # once a day, inside quiet hours, draft a rewrite of the memory and user blocks

fleet:
  installed_agents: [ceo, eng-ai-engineer, support-responder]
  active_agents: [ceo]
  default_agent: ceo

memory:
  blocks:                     # named memory blocks; every seat reads all of them in its prelude
    - label: memory           # ^[a-z][a-z0-9_-]{1,30}$; the memory tool's default block
      file: MEMORY.md         # under <profile>/memories/
      description: durable facts about the company and how it works
      limit: 2200             # hard character cap, checked on the final state of a batch
    - label: user
      file: USER.md
      description: who the founder is and how they want to be worked with
      limit: 1375
    - label: company
      file: COMPANY.md
      description: shared facts every seat reads; edited by the founder or the heartbeat
      limit: 1500
      read_only: true         # a seat write is refused naming the label; edit the file yourself

telemetry:
  # otlp_endpoint: http://127.0.0.1:4318/v1/traces   # unset means tracing off
  service_name: trent

privacy:
  redact_prompts: false       # true: mask secrets and PII in every prompt before the provider call
  patterns: []                # extra regular expressions (JavaScript syntax) to mask as well

policy:
  rules: []                   # appended to the shipped rules; a rule with a shipped id replaces it
```

### Memory blocks

`memory.blocks` lists the files under `<profile>/memories/` that make up the company memory
(`packages/trent-core/src/tools/memory/`, [fleet-memory README](../packages/trent-core/src/fleet-memory/README.md)).
Every seat's prelude renders every block with its label, description, limit and the characters in
use; the `memory` tool writes one block per call (`block`, alias `target`, default `memory`) and
refuses a `read_only` block or a write that would leave the block over its limit. Add a block
(`product`, `PRODUCT.md`, 800) and it appears in the prelude and accepts writes up to 800
characters. Labels and files must be distinct. The heartbeat's consolidation pass works on the two
default blocks `memory` and `user`.

### Runtime

`runtime.max_concurrent_runs` (integer, at least 1, default 2) is the per-profile cap on runs the
orchestrator drives at once: every surface on the headless runtime (REPL, TUI, gateway, cron,
heartbeat, `trent jobs retry`) shares it. A run past the cap is not launched: it waits in FIFO
order for a slot, has no row in the store yet, and its event stream starts with one `heartbeat`
frame whose `detail` reads `queued: N ahead; max_concurrent_runs is <cap>`. A run parked on an
approval keeps its slot. See [jobs.md](jobs.md).

### Heartbeat

`heartbeat` drives the loop in `packages/trent-core/src/heartbeat/` (see [heartbeat.md](heartbeat.md)).
The reply goes to `gateway.owner`, so set that block too; without it every reply stays in
`<profile>/heartbeat/runs.jsonl` with a `deliveryError` naming the missing key.

### Privacy

`privacy.redact_prompts` turns on prompt-side redaction in the model gateway
(`packages/trent-core/src/model-gateway/redact.ts`). With it on, every message content that is about
to leave for a provider, the system prompt and tool results included, is run through the shared
secret detectors of `telemetry/redact.ts` (API keys, bearer tokens, private keys, connection strings,
named credentials) and the built-in PII detectors (email addresses, E.164 phone numbers, IPv4
addresses). `privacy.patterns` adds your own expressions; each is compiled with the `g` flag at
startup, and an expression that does not compile fails the start with exit code 3 and the index of
the offending pattern. The masked value becomes a numbered token per kind, `[REDACTED:email#1]`,
and the same value maps to the same token within one request, so the model can still say "reply to
the first email" without seeing it. Off by default; see docs/security.md, "Prompt redaction".

The block reaches the gateway through two environment variables the runtime writes from config
(`TRENT_PRIVACY_REDACT_PROMPTS=1`, `TRENT_PRIVACY_PATTERNS='["..."]'`); an explicit value in the
process environment wins over the file, the same precedence as the model block.

### Telemetry

`telemetry.otlp_endpoint` is optional and must be an `http(s)` URL. When it is unset nothing is
built: no exporter, no buffered spans, and `/traces` in the REPL says `tracing off`. When it is
set, every run's event stream is exported as OTLP/HTTP JSON to that URL
(`packages/trent-core/src/traces/bus-hook.ts`) as one tree per run:

| Span | Opens on | Closes on | Parent |
|---|---|---|---|
| `trent.run` | `run_start` | `run_done`, `run_failed`, `run_cancelled` | none |
| `gen_ai.agent.turn` | `step_start` | `step_end`, `step_blocked` | the run span |
| `execute_tool <adapter>` | each tool call record on `step_output` | the same frame | the step span |

The batch is posted when the run ends and again on flush, so a cancelled process still ships what it
closed. Prompt-shaped strings (step output, the objective, tool summaries) go through the shared
redactor in `telemetry/redact.ts` before they are attached. `service_name` becomes the
`service.name` resource attribute. `trent doctor` probes the endpoint with an empty batch and reports
it reachable or unreachable; with no endpoint it reports `not configured` as a skip, never as a pass.

### Policy rules

`policy.rules` is a list of trace-level rules evaluated at every tool call against the run's
recent calls (`packages/trent-core/src/governance/policy-rules.ts`). Each rule is
`{ id, effect, when, also, after, within, reason }`: `effect` is `deny` or `require_approval`,
`when` (and the optional `also`) are classes the current call must carry, `after` is a class that
must appear within the last `within` calls (default 20), and `reason` is what the seat reads in the
blocked or needs_approval result. Classes are `read_only`, `write`, `execute`, `external_send`,
`network`, `secret_access`, `destructive`, `money_moving`, `deploy` and `customer_facing`; any other
value fails validation. Six rules ship by default (listed in docs/security.md, "Policy rules"); a
config rule with the same `id` replaces the shipped one in place, any other id appends.

```yaml
policy:
  rules:
    - id: send-after-secret          # soften the shipped deny to an approval
      effect: require_approval
      when: external_send
      after: secret_access
      within: 10
      reason: a secret was read in this run; confirm the send
    - id: no-deploy-from-seats       # a new rule
      effect: deny
      when: deploy
      reason: deploys are run by hand
```

### Double texting

`gateway.double_text_policy` and `repl.double_text_policy` each take `enqueue` (hold the message
and run it as the next turn, the default), `interrupt` (abort the running turn and run the new
message once it has settled) or `reject` (refuse it with one status line; the model never sees
it). `/stop` interrupts the running turn under every policy. See [gateway.md](gateway.md).

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
