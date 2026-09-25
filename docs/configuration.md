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
  goldens/                       failure fixtures from failed runs, mode 0700
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
provider: openai              # openai anthropic google mistral openrouter
                              # deepseek groq ollama lmstudio  (see "Providers" below)
model: gpt-5.6-terra
personality: default
theme: dark                   # dark | light

toolsets:                     # file_ops terminal web browser code vision memory delegation
  - file_ops                  # cron skills plugins mcp human media social (social.md)
  - terminal
  - human                     # ask_human: the seat asks you and waits (REPL prompt, or a chat reply via the gateway)
disabled_toolsets: []

autonomy: ask_dangerous       # ask_always | ask_dangerous | never  (see "Autonomy and hooks")
approvals:
  deny: []                    # globs refused at every autonomy level
hooks:                        # argv arrays, never shell strings; consented with `trent hooks consent`
  pre_tool_call: []
  post_tool_call: []
  session_start: []
  session_stop: []

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
  email:
    require_authenticated_from: true # inbound mail needs the server's DMARC, or aligned SPF/DKIM, pass
    # authserv_id: mx.example.com    # recommended: read only your server's Authentication-Results

repl:
  double_text_policy: enqueue # the same three modes for input typed during a REPL turn
  history_turns: 8            # turns of this session threaded into the next run (optional)
  history_chars: 6000         # character ceiling for that transcript; oldest turns dropped first

runtime:
  max_concurrent_runs: 2      # runs driven at once per profile; the next one waits FIFO (docs/jobs.md)

heartbeat:
  enabled: false              # trent heartbeat start, and gateway start, run the loop only when true
  interval_minutes: 60        # one model turn over <profile>/HEARTBEAT.md per interval
  # active_hours:             # unset means never quiet
  #   start: "08:00"          # HH:MM on the wall clock of tz; the end is exclusive
  #   end: "20:00"            # a window that crosses midnight (22:00-06:00) wraps
  #   tz: Europe/Berlin       # IANA zone, default UTC
  consolidate_memory: true    # once a day, inside quiet hours, draft itemised edits to every writable memory block
  sweep:
    enabled: false            # opt-in: run the improvement sweep unattended on a tick
  sweep_interval_hours: 24    # at most one unattended sweep per this many hours

fleet:
  installed_agents: [ceo, eng-ai-engineer, support-responder]
  active_agents: [ceo]
  default_agent: ceo

mcp_servers: {}               # Model Context Protocol servers; see docs/mcp.md and `trent mcp add`

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

model_overrides: {}           # per-model price and context window; see "Model pricing" below

privacy:
  redact_prompts: false       # true: mask secrets and PII in every prompt before the provider call
  patterns: []                # extra regular expressions (JavaScript syntax) to mask as well

policy:
  rules: []                   # appended to the shipped rules; a rule with a shipped id replaces it

tools:
  disclosure_threshold: 24    # above this many registered tools, everything outside the core
                              # toolsets is reached through tool_search/tool_describe/tool_call

brain:
  enabled: true               # false: no <profile>/brain/ is created and no brain block is injected
  versioning: auto            # auto | off; auto commits each write with git when git is on PATH

checkpoints:
  enabled: true               # record every agent write with its pre-image, so /rollback can undo it
  max_bytes_per_run: 52428800 # pre-image bytes one run may store; past it a row carries hashes only

curator:
  enabled: true               # false: no ageing pass runs; curator status and log still read
  stale_after_days: 60        # measured from the last LOAD by a seat, not from when it was written
  archive_after_days: 180     # only skills declared created_by: agent are ever aged
  scan_agent_skills: true     # rescan the whole composed skill after every agent write

provenance:
  untrusted_writes: hold      # hold | allow | deny: a memory write from an untrusted step
  untrusted_skills: deny      # deny | allow: skill_manage from an untrusted step

gate:
  ask_classes: []             # classes added to the floor that asks at every level; nothing removes one

retrieval:
  min_recall: 0.9             # recall@8 over the promoted retrieval goldens the ranker must reach

cron:
  failure_alert_after: 3      # consecutive scheduled failures of one job before its one [CRON_FAILURE] alert
  quota_hold_minutes: 30      # how long a provider 429 holds prompt-driven jobs when no Retry-After is given

agent:
  auto_recovery_cycles: 1     # re-runs of a step that failed on a transient provider or tool error; 0 turns it off

connect:
  inherit_default: true       # another profile reads a provider it never connected (trent connect) from default's .env, read-only

goals:
  verify_on_stop: true        # a turn that edited code needs fresh test or build evidence to finish
  verify_commands:            # what counts as that evidence
    - npm test
    - npm run typecheck
    - npx vitest
    - npx tsc
    - pytest
    - go test
    - cargo test
  auto_continue: false        # a red gate never starts another metered run on its own
  max_continuations: 3        # ceiling on attempts at one goal

improve:
  holdout_ratio: 0.3          # share of each suite held back from reflection, used for promotion
  pass_k: 3                   # consecutive trials a fixture must pass to count as passed
  judge_min_tpr: 0.8          # below these the judge's verdicts are advisory and cannot pass a fixture
  judge_min_tnr: 0.8
  sweep_cap_cents: 100        # INTEGER CENTS; defaults to budget.per_run_cap
  frozen_paths: []            # extra paths the loop may never write
  judge_model: ""             # empty means resolve one at run time; never equal to the executor
  min_goldens: 5              # promoted goldens a seat needs before a live sweep reflects for it
```

### Memory blocks

`memory.blocks` lists the files under `<profile>/memories/` that make up the company memory
(`packages/trent-core/src/tools/memory/`, [fleet-memory README](../packages/trent-core/src/fleet-memory/README.md)).
Every seat's prelude renders every block with its label, description, limit and the characters in
use; the `memory` tool writes one block per call (`block`, alias `target`, default `memory`) and
refuses a `read_only` block or a write that would leave the block over its limit. Add a block
(`product`, `PRODUCT.md`, 800) and it appears in the prelude and accepts writes up to 800
characters. Labels and files must be distinct. The heartbeat's consolidation pass covers every
configured block: `memory` and `user` always, each other writable block under its own `limit`, and
a `read_only` block only while `consolidation_may_edit` names it — otherwise it is not even sent to
the model. One draft carries the whole set, so
`trent improve promote` moves every block at once and a rollback puts every block back.

#### Write gates and delta-only consolidation

Two keys sit beside `memory.blocks`, and both are enforced by the writers rather than advertised
by them.

| Key | Default | What it does |
|---|---|---|
| `memory.consolidation_may_edit` | `[]` | `read_only` block labels the SCHEDULED consolidation may propose over. Empty means a read-only block is refused on every write path, seat and consolidation alike. Listing a label lets the nightly draft touch that block; a seat is still refused, and the founder still promotes the draft. |
| `memory.consolidation_max_removal_ratio` | `0.3` | The most of a block's entries one consolidation may remove or merge away, floored at one entry so a three-entry block can still lose its duplicate. A proposal over it is refused whole and written to the ledger as a `reject` row. |

```yaml
memory:
  consolidation_may_edit: []          # e.g. ["company"] to let the nightly pass maintain COMPANY.md
  consolidation_max_removal_ratio: 0.3
```

Who may write what is not configurable. A seat **adds** entries and does nothing else: the `memory`
tool advertises `add` alone, and a `replace` or `remove` from a seat is `blocked` with the reason
naming the consolidation. Rewrites have one owner — the nightly consolidation draft — and that
draft reaches disk only through `trent improve promote`. This is also why a write past a block's
limit answers with the block's current entries and the characters in use: the seat cannot make room
by removing something, so it shortens what it was about to add, and the consolidation path reports
a limit in exactly the same shape.

The consolidation proposes **itemised operations** (`append`, `replace`, `remove`, `merge`) over
entries the prompt addresses by id, never a rewritten block, so a fact the model fails to restate
cannot be lost. See [the fleet-memory README](../packages/trent-core/src/fleet-memory/README.md),
"Memory writes are deltas", and [heartbeat.md](heartbeat.md), "Memory consolidation".

The recall budget stays config-only: `TRENT_FLEET_RECALL_BUDGET_CHARS` was documented for a while,
never did anything, and has been removed rather than wired up.

### Embedder

`memory.embedder` decides what ranks fleet recall. Lexical TF-IDF over the candidate corpus always
runs; when an embedder is configured, the score is a blend of it and the embedding cosine, so a
paraphrase of the objective can outrank a candidate that merely shares four words with it.

```yaml
memory:
  embedder:
    provider: auto            # auto | gemini | openai | none
    # model: gemini-embedding-001   # route default when omitted
    batch_size: 32            # inputs per request, 1-256
```

| Key | Meaning |
|---|---|
| `provider` | `auto` (default) takes the first provider that has a key, preferring the family the top-level `provider` already routes chat through, then Gemini, then OpenAI. `gemini` posts to Google's OpenAI-compatible surface (`https://generativelanguage.googleapis.com/v1beta/openai/embeddings`), `openai` to `https://api.openai.com/v1/embeddings` — or, when `provider` is one of the four OpenAI-dialect aliases, to that alias's own base URL. A named provider with no key falls back to lexical rather than failing a run. `none` is lexical only. |
| `model` | Overrides the route default (`gemini-embedding-001`, `text-embedding-3-small`). |
| `batch_size` | Inputs per request. One recall corpus is split into batches of this size. |

Keys are read from the profile `.env` first, then the process environment: `GEMINI_API_KEY`,
`GOOGLE_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` for Gemini, `OPENAI_API_KEY` for OpenAI.
`GEMINI_BASE_URL` and `OPENAI_BASE_URL` move the endpoint. Vectors are cached on disk under
`<profile>/cache/embeddings/` (mode 0700), content-addressed by sha256 of the endpoint, the model
and the text, so an unchanged run window re-embeds nothing; deleting that directory only costs one
round of re-embedding. Requests are retried under the model gateway's bounded policy and carry a
deadline, and a failed embedder degrades recall to lexical rather than failing the run.

The blend is `0.4 * lexical + 0.6 * credit(cosine)`, where `credit` is zero at or below a per-model
cosine floor (Gemini 0.60, OpenAI 0.30) and rescales the band above it onto 0..1. The floor is
measured, not guessed: `gemini-embedding-001` scores an unrelated sentence 0.529 and a paraphrase
0.754 against the same objective, so without it every candidate would collect vector credit and no
run would ever recall nothing. The recall cut-off itself (`recallMinScore`, 0.12) is unchanged,
which is why the two weights sum to 1: a blended score stays on the scale it was already judged on.

`trent doctor` reports which of the two rankers is live, proven by one cheap embedding call — see
[doctor.md](doctor.md), "Recall Embedder". The weights and the floor are argued in full in
[the fleet-memory README](../packages/trent-core/src/fleet-memory/README.md), "Hybrid recall".

### Company memory in the app

`memory.app_sources` decides how much of the web app's OWN company memory reaches a seat. The CLI
wraps `apps/web`; that app has been writing company memory into `Document` rows since long before
the fleet existed, and until this key a seat recalled only what the orchestrator itself produced —
step outputs, run summaries, skills and the playbook. Six surfaces now join the recall corpus, each
read through the app's own functions and each tagged with where it came from, so a line in the
prelude says `[tiers | semantic | ...]` or `[decisions | ...]` and not just a bare fact.

```yaml
memory:
  app_sources:
    tiers: 4000             # working / episodic / semantic rows (memory-tiers.ts)
    documents: 4000         # the company's other documents, inside their validity window
    capabilities: 1500      # this seat's capability outcomes
    registries: 1500        # this seat's compounding registry
    decisions: 1500         # the CEO decision journal
    wiki: 1500              # the company's wiki notes
```

| Key | What it carries |
|---|---|
| `tiers` | `memoryTier` rows: the episodic narrative written at cycle close and the semantic facts written by consolidation. A fact another row supersedes is never recalled — the validity window AND the supersedes chain are both honoured, because `SemanticMemory.flush` swallows a failed expiry and `validTo` alone is therefore not proof. |
| `documents` | Everything else the company has on file — briefs, roadmaps, research, weekly reports — filtered by `filterActiveDocuments`, so a document that has not started or has already ended is not recalled. |
| `capabilities` | Capability outcome records for THIS seat, summarised by the app's `summarizeCapability`: mean score, success rate, cost in integer cents, latency, sample count. |
| `registries` | The seat's compounding registry, rendered by the app's own `buildSeatRegistryRecall`. Only `growth`, `sales` and `content` own one; every other seat gets nothing here. |
| `decisions` | The CEO decision journal, one entry per run that produced one. |
| `wiki` | The company's wiki notes, summarised through `buildWikiSources` / `buildWikiPageSummary`, which is also what keeps `.env`, keys and `node_modules` paths out of a prompt. |

Every number is characters of candidate text, taken newest-first and clipped at the budget, before
the ranker sees any of it. The sum (14,000) is under a quarter of `context.ceiling_chars`, so this
tier cannot crowd out the memory blocks, the skills index or the transcript. Setting one to `0`
turns that surface off and leaves the others alone.

These candidates are ranked in a corpus of their OWN, never folded into the run-derived one. TF-IDF
weights a term by how rare it is in the corpus it is scored against, and the app writes its own
memory log and decision journal for the same run, so one shared corpus re-scored candidates that
were already reaching the seat and dropped a relevant step output below the cut-off. A new source
of context may add lines to the recall block; it may never take one away.

**Writes, and where they can go.** A seat's `memory` append is mirrored into the app's episodic
tier through the app's `writeEpisodicMemory`, filed under `<run id>:<seat>`; semantic facts are
written only by the consolidation path, from its delta operations, with `supersedesId` set when an
operation replaces an entry. Both go through the app's store singleton, which is chosen once at
process start from `DATABASE_URL` (`apps/web/lib/store.ts`), and whether it is used at all is
decided by one predicate (`packages/trent-core/src/fleet-memory/app-store.ts`) BEFORE any app
module is imported:

| `DATABASE_URL` | App company memory |
|---|---|
| a postgres URL | **Used and durable.** The app's own datasource. |
| unset or empty | **Not used.** The app's store would be in-process, so a tier row would not outlive the process; seats read and write the profile's own memory (blocks, brain, runs, skills, playbook). |
| a `file:` SQLite path | **Not used.** That is the wrapper's own store format; `apps/web/lib/db.ts` builds a client for a postgresql datasource, so the tiers are skipped rather than handed a URL they cannot open. |
| any other scheme | **Not used**, for the same reason. |

The wrapper never exports its own SQLite URL as the app's `DATABASE_URL` (it once did, and the
app's Postgres client then failed every call, or — in the compiled binary — was constructed for
nothing and killed `trent run` on any machine without its engine). In every "not used" state the
readers answer nothing, the writers report nothing to do and no failure, and the app's Postgres
client is never built. `trent doctor` prints the one reason — see the `App Memory Tiers` line.

### Failure goldens

A run that fails, or whose critic escalates or replans, writes one quarantined regression fixture
to `<profile>/goldens/golden-<runId>.json` — the sanitised objective, the reason and the trajectory
failure tags. The directory is created with mode 0700 on the first run of any surface, and every
surface captures: REPL, TUI, gateway, cron, heartbeat and `trent run` all wire the same loop. A
fixture starts `quarantined` and is promoted to blocking only by human review. Nothing in
`config.yaml` turns capture off; delete the directory's contents to discard fixtures.

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

### Autonomy and hooks

`autonomy` sets how often a human is asked, and nothing else:

| Value | Asks for |
|---|---|
| `ask_always` | every tool call that is not a pure read |
| `ask_dangerous` | exactly where the adapters' own floors already ask (**default**) |
| `never` | nothing the floors would have asked about |

The default is `ask_dangerous` because it is the behaviour Trent already had before the key
existed, so setting it explicitly changes nothing. No value lifts the shipped hardline blocklist,
an `approvals.deny` glob, or anything `tools/approval-floors.ts` marks never-auto-approvable — see
docs/security.md, "Autonomy levels" and "The hardline blocklist", which also states plainly that
the blocklist is a guardrail and not a sandbox.

`approvals.deny` is a list of globs matched against the command string a tool would run and the
file paths it would touch. A match is refused at every level, naming the glob. `*` and `**` both
match any run of characters including `/`, `?` matches one character, matching ignores case, and a
leading `~` expands against the home directory.

`hooks` runs a command of yours around tool calls and sessions. Each entry is
`{ command: [...], timeout_ms?, match?: { tool } }` where `command` is an **argv array** — the
executable first, then its arguments — spawned with no shell, so nothing from a tool argument is
ever parsed as shell syntax. `timeout_ms` defaults to 5000. A `pre_tool_call` hook that exits
non-zero blocks the call and its stderr tail becomes the reason; `post_tool_call`, `session_start`
and `session_stop` exit codes are recorded and never block.

```yaml
autonomy: ask_dangerous

approvals:
  deny:
    - "*terraform destroy*"
    - "~/Documents/**"

hooks:
  pre_tool_call:
    - command: ["/usr/local/bin/trent-gate", "--strict"]
      timeout_ms: 3000
      match: { tool: terminal }
  post_tool_call:
    - command: ["/usr/local/bin/trent-audit"]
```

A hook runs only after you have consented to that exact spec:

```
trent hooks list          # every configured hook, its argv, and whether it is consented
trent hooks consent       # record a hash of each hook currently in config.yaml
```

The record is `<profileDir>/hooks-consent.json`, mode 0600, hashes only. Editing a hook's argv,
timeout or match filter loses its consent, and `trent hooks consent` replaces the record rather
than adding to it, so a hook you delete from the config is revoked. An unconsented hook never runs
and the run reports it once. The full contract, including what the hook reads on stdin and how it
is redacted, is in docs/security.md, "User hooks".

### Tool disclosure

`tools.disclosure_threshold` (integer, default 24) is the count of registered tools above which
everything outside the core toolsets is taken out of a seat's advertised list and reached through
`tool_search`, `tool_describe` and `tool_call` instead. MCP, plugin and app-catalog tools are
deferred at **any** count, because their number is not Trent's to bound. Raising the threshold buys
direct schemas at the cost of prompt context on every turn; lowering it buys context at the cost of
one extra round trip the first time a tool is needed. A call made through `tool_call` re-enters the
same wrapper chain a direct call enters, so the approval floors, the policy rules and the hooks all
still apply. See [tools.md](tools.md).

### The brain

`brain.enabled` (default true) creates `<profile>/brain/`, the file tree that holds identity,
standing decisions and episodic notes; the memory blocks migrate into `brain/system/` on first use
and every index over it is disposable. `brain.versioning` is `auto` or `off`: `auto` commits each
write with git when git is on PATH, naming the seat that made it and the run it belonged to, and
falls back to plain files otherwise — which `trent doctor` reports as a line, not a failure.
Versioning is for audit and rollback, never for merging concurrent writers; that is the memory
lock's job. `brain.enabled: false` means no directory is created and no brain block reaches a
prompt, and the memory blocks stay where they are. See [brain.md](brain.md).

### Checkpoints

`checkpoints.enabled` (default true) records every file an agent writes, with the bytes that were
there before, under `<profile>/checkpoints/<run id>/` — 0600 files in a 0700 directory. That ledger
is what `/checkpoints` lists and what `/rollback` restores. `checkpoints.max_bytes_per_run` (default
52428800, that is 50 MiB) caps the pre-image bytes one run may store: past it a row still carries
both hashes and says why it carries no bytes, and that path is refused at rollback rather than
restored from something approximate. A write made while `enabled` was false was never recorded and
can never be undone. See [checkpoints.md](checkpoints.md).

### The skill curator

`curator.enabled` (default true) runs the ageing pass; with it false no skill is ever aged, while
`trent curator status` and `trent curator log` still read, because seeing what the curator would do
is not curation. `stale_after_days` (60) and `archive_after_days` (180) are measured from the last
LOAD of a skill by a seat's run, not from when it was written, and only skills declared
`created_by: agent` are ever aged by them: a skill a person installed is reported and left alone
however old it gets. `scan_agent_skills` (true) is the second scan gate — the composed skill, its
document and its whole bundle put past the pre-install scanner after every agent write, with a
flagged skill held `quarantined` until a human releases it. The toolset builder does not yet pass
this setting into the adapter, so the gate is on regardless of what is written here. See
[skills.md](skills.md).

### Provenance

`provenance` decides what output derived from untrusted context may do. Untrusted means the `web`
and `browser` toolsets, MCP servers, plugin tools, and a delegated child that used any of them.
`untrusted_writes` governs a write into a layer every seat loads next run: `hold` (the default)
turns it into a pending approval row naming the tools it came from, `deny` refuses it outright, and
`allow` writes it tagged — which deliberately reopens the memory-poisoning path, so it is a choice
and not a default. `untrusted_skills` governs `skill_manage` from such a step and ships as `deny`,
because a skill is executable content a later seat runs without reading it. Nothing here inspects
untrusted text for an instruction; the gate is on the combination of untrusted input and a durable
write. See [security.md](security.md), "Provenance and untrusted context".

### The side-effect gate

`gate.ask_classes` adds policy classes to the class floor: the calls a human approves at every
autonomy level, bound to the exact call. The shipped floor is `external_send`, `money_moving` and
`customer_facing` (a post, a send, a booking, an invoice, a charge) and is a constant, not a key;
`never` does not lift it and no setting lowers it. Name `deploy` or `destructive` here to have
those asked about at `never` too. See [security.md](security.md), "Side-effecting tools: the gate".

### Goals

`goals.verify_on_stop` is **on by default**: a turn that edited code cannot give a final answer
without fresh evidence from one of `goals.verify_commands`, which defaults to `npm test`,
`npm run typecheck`, `npx vitest`, `npx tsc`, `pytest`, `go test` and `cargo test`. A goal opened
with `trent goal create "<objective>" --gate "name=<command>"` carries its own shell gates, and
every gate must exit 0 before any judge is consulted; a red gate ends the run and its output starts
the next attempt. `auto_continue` is **off** by default, because a red gate that silently starts
another metered run is a bill nobody authorised — `trent goal continue <id>` is the explicit path,
and `max_continuations` (3) bounds both. See [goals.md](goals.md).

### Improvement gates

`improve` holds the gates the self-improvement loop is held to. `holdout_ratio` (0.3) is the share
of every suite held back from reflection and scoring and used for promotion alone; `pass_k` (3) is
how many consecutive trials a fixture must pass to count as passed; `judge_min_tpr` and
`judge_min_tnr` (0.8) are the calibration floors below which the judge's verdicts are advisory and
cannot make a fixture pass; `sweep_cap_cents` is the sweep's hard spend cap in integer cents and
defaults to `budget.per_run_cap`; `frozen_paths` are extra paths the loop may never write, on top of
the suites, the goldens, the judge prompt and the gate code. `judge_model` empty is not "no judge":
it means resolve one at run time — the configured planner-tier model when it differs from the
executor, else the strongest priced Gemini model that does — and a judge equal to the executor is a
configuration error naming both. `min_goldens` (5) is how many promoted goldens a seat's suite must
hold before `trent improve sweep --live` spends a model call reflecting for it. See
[improve.md](improve.md).

### The retrieval gate

`retrieval.min_recall` (0.9) is the recall@8 the shipped ranker must reach over the profile's
promoted retrieval goldens (`<profile>/goldens/retrieval/`, added with
`trent improve goldens add --retrieval` or captured when a seat reads a ranked chunk). Under it
`trent improve retrieval` exits 1 and no draft promotes; a change to recall, the hybrid blend, the
brain index or the ingest pipeline is a human change measured by that command. See
[improve.md](improve.md), "Retrieval goldens and the recall gate".

### Auto-recovery cycles

`agent.auto_recovery_cycles` (1; a profile written before the key existed has none, and the
orchestrator applies the same 1) is how many times a step that failed on a transient provider or
tool error is run again, with the previous error appended to its prompt as a plain sentence,
before the run reports the failure. It counts re-runs, not attempts, and sits above the gateway's
own per-call retry, which has already been spent by the time a step fails. An approval park, a
budget stop, a refusal, a gated result and any non-transient error are never re-run. 0 turns it
off. See [jobs.md](jobs.md), "Auto-recovery cycles".

### Workspace context files

Trent reads the instruction files of the directory it is run in, the way Claude Code and Codex read
`AGENTS.md` (`packages/trent-core/src/workspace-context/`). The candidates, in the order the prelude
renders them:

1. `AGENTS.md` at the git root (the nearest ancestor holding `.git`; the working directory itself
   when there is none),
2. `CLAUDE.md` at the git root,
3. `.trent/*.md` at the git root, sorted by file name,
4. the same three sets in the working directory, when that is not the git root.

Nothing outside the git root or the working directory is read, and a candidate whose symlink
resolves outside them is refused rather than followed.

```yaml
workspace:
  max_file_chars: 12000       # one file; a file over it is truncated, never dropped silently
  max_total_chars: 24000      # every loaded file together
```

A file over either cap keeps its first `n` characters and carries one extra line naming the file,
its real length and the cap that cut it, so a truncation is something you are told about. The
marker is Trent's own line and is not charged to the cap. A file that arrives after the total cap
is spent is reported as a refusal, not omitted.

**A workspace is untrusted until you say otherwise**, so cloning a repository is never enough to put
text in Trent's prompt. An untrusted workspace loads nothing and returns one line naming the command
that would trust it. Trust is recorded in `<profile>/workspace-trust.json` (mode 0600), keyed by the
realpath of the root:

```
trent workspace status [path]     # root, trust, files found, refusals, characters
trent workspace trust [path]      # prints the file list, asks, then records; --yes skips the question
trent workspace untrust [path]    # forget it again
```

Editing a trusted file does not revoke trust — that would make every edit a prompt — but each load
records the content hash, and `trent workspace status` says `changed since trusted` when the set no
longer matches what was approved. Every file is scanned for prompt injection before it loads; see
[security.md](security.md), "Workspace instruction files".

### Double texting

`gateway.double_text_policy` and `repl.double_text_policy` each take `enqueue` (hold the message
and run it as the next turn, the default), `interrupt` (abort the running turn and run the new
message once it has settled) or `reject` (refuse it with one status line; the model never sees
it). `/stop` interrupts the running turn under every policy. See [gateway.md](gateway.md).

### Email needs an authenticated From

`gateway.email.require_authenticated_from` (default `true`) drops an inbound email before pairing
and routing unless the receiving mail server's own verdict authenticates the `From:` domain. Set it
to `false` only for a mail server that strips or never writes `Authentication-Results`.
`gateway.email.authserv_id` (unset by default, recommended) names that server as it names itself in
the header (RFC 8601 authserv-id); set, only its own header is read and a message without one is
refused, so a header the sender wrote can never vouch for them. Unset, the topmost header is read.
See [gateway.md](gateway.md), "Email: only an authenticated From gets through".

### Conversation history

Each REPL turn is one orchestration run, and the runs of one session are a conversation: the last
`repl.history_turns` turns (default 8), trimmed to `repl.history_chars` characters (default 6000,
oldest dropped first), travel with the next run as a message list. The line you type stays the
objective; the transcript is rendered into the seat prompt *after* the frozen fleet-memory prelude,
so the cacheable prefix does not move between turns. A turn you interrupted with Ctrl+C is kept in
the session marked `interrupted` and is never re-threaded: a fragment is not an answer. Chat threads
through the gateway get the same treatment, bounded by the same two numbers.

### Budget caps refuse a turn

`budget.alert_thresholds` warns; `budget.daily_cap` and `budget.per_run_cap` refuse. A turn whose
ledger has already reached the daily cap does not start a run at all, and a run that passes
`per_run_cap` mid-flight is stopped. Both print the cap and the spend in integer cents and name the
key to raise. `--continue` seeds the ledger from the resumed session's `total_cost_cents`, so the
cap survives a restart rather than resetting with the process.
`trent budget status` reads today's ledger against the cap by surface; `trent usage` reads the same
ledger over a period (`--since 7d|30d|YYYY-MM-DD`, month to date by default) grouped `--by surface|seat|model|provider|tool`.
Both go through the one spend report (`packages/trent-core/src/governance/spend-report.ts`), so the two never disagree about a number.

### Money is integer cents

Every monetary field in the schema is `z.number().int()`. `daily_cap: 1000` is ten dollars.
`daily_cap: 10` is ten cents. This matches the rule the rest of the platform already follows and it
is not negotiable: a float dollar value in a cents field is how a ten-dollar cap once became a
ten-cent cap, which the setup wizard rebuild found and fixed.

Percentages are the exception. `alert_thresholds` is a list of percentages of `daily_cap`.

## Context management

Two keys bound what a seat is told, and one decides when a session forgets.

```yaml
context:
  ceiling_chars: 60000       # the whole wrapper injection for one seat call
  # compact_after_chars: 12000  # optional; defaults to repl.history_chars * 2
repl:
  history_chars: 6000        # what the next run may be told about the turns before it
  history_turns: 8
```

### The three tiers

Everything the wrapper injects into a seat prompt is assembled in three tiers, in this order
(`packages/trent-core/src/fleet-memory/tiers.ts`):

| Tier | Contents | Rebuilt |
|---|---|---|
| `stable` | the named memory blocks, the `workspace-context` block, the org-tier shared skills index | once per run, and byte-identical across runs of the same profile |
| `context` | this seat's own live skills, the cross-agent recall for this objective | once per (run, seat) |
| `volatile` | the session transcript, the active personality's tone stance | whenever the surface changes it |

The stable tier is the part a provider could cache, so nothing that depends on the objective, the
seat or the turn may live in it. Before 2026-09-18 the whole prelude was memoised with the *first*
seat's scope, which handed every later seat of a run the first seat's recall and the first seat's
skills; the freeze now sits on the stable tier and on the run's view of the company, and each seat
gets its own `context` tier.

The personality reaches the `volatile` tier and nowhere else. It is never part of the system prompt
and never part of the seat prompt the improvement loop protects
(`packages/trent-core/src/improve/protected-prompt.ts`). `personality: "default"` is a personality
like any other and does inject its tone stance.

### The ceiling

`context.ceiling_chars` is measured against the assembled injection on every seat call. Over it, the
`context` and `volatile` blocks are dropped oldest-first — recall before the transcript, the
transcript before the one-line tone stance — and the `stable` tier is never trimmed: silently
deleting the company's memory is worse than a long prompt you can see. A stable tier that is on its
own over the ceiling is kept and reported.

At 80 percent of the ceiling the run emits one `step_note` naming the measured size, the estimated
token count and what was trimmed. Once per run, not once per seat call.

Characters, not tokens: a ceiling has to be checkable offline and identically on every provider. The
token figure is the gateway's own 4-chars-per-token estimate, and a provider-reported count always
wins over it.

### Compaction

When a session's stored transcript passes `context.compact_after_chars` (by default twice
`repl.history_chars`), the next persisted answer triggers one compaction:

1. the turns about to be dropped are offered to the shared memory through the same `memory` adapter
   the `memory` tool writes with, so block limits and `read_only` blocks are enforced by the one
   writer that already enforces them. With no model gateway available, nothing is written;
2. those turns are summarised into one message. If that call is unavailable **nothing is dropped** —
   forgetting turns with nothing in their place is the failure this exists to remove;
3. one compaction event is written into the session: a `system` message whose
   `metadata.compaction` carries the forgotten message ids, the summary and the sizes before and
   after. One event per compaction, so a session can say what it no longer remembers.

The most recent turns are kept verbatim, and a tool call is never separated from its result.

## Providers

Nine names are accepted. Five are routed by the wrapped application itself; the other four are
OpenAI-compatible endpoints that the gateway resolves at the boundary into the `openai` client plus
a base URL, so the same streaming path serves all of them.

| `provider` | Key | Endpoint (override with) | Default model |
|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | OpenAI (`OPENAI_BASE_URL`) | `gpt-5.6-terra` |
| `anthropic` | `ANTHROPIC_API_KEY` | Anthropic | `claude-sonnet-4-6` |
| `google` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini (`GOOGLE_BASE_URL`) | `gemini-2.5-pro` |
| `mistral` | `MISTRAL_API_KEY` | Mistral (`MISTRAL_BASE_URL`) | `mistral-large-latest` |
| `openrouter` | `OPENROUTER_API_KEY` | OpenRouter (`OPENROUTER_BASE_URL`) | `openrouter/auto` |
| `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` (`DEEPSEEK_BASE_URL`) | `deepseek-chat` |
| `groq` | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` (`GROQ_BASE_URL`) | `llama-3.3-70b-versatile` |
| `ollama` | none | `http://127.0.0.1:11434/v1` (`OLLAMA_BASE_URL`) | `llama3.2` |
| `lmstudio` | none | `http://127.0.0.1:1234/v1` (`LMSTUDIO_BASE_URL`) | `local-model` |

`ollama` and `lmstudio` need no account. The OpenAI-compatible client always sends an
`Authorization` header, so a placeholder bearer is sent to them unless you set `OLLAMA_API_KEY` or
`LMSTUDIO_API_KEY` — and a real `OPENAI_API_KEY` in your environment is deliberately NOT forwarded
to a local endpoint.

A provider that cannot be routed fails at startup with exit code 3 and says which variable to set.
It is never quietly swapped for another provider: that was the old behaviour and it billed you for
a model you did not choose.

### Model tiers

`model` is one model for everything. The wrapped application routes each seat to a `haiku`,
`sonnet` or `opus` tier from its own manifest (`SEAT_MANIFESTS[role].modelTier`) and resolves that
tier through the per-provider tier variables, so naming a model per tier is what makes a cheap seat
cheap and a planning seat strong. The `models` block is that mapping:

```yaml
provider: google
model: gemini-3.5-flash-lite   # the fallback for every tier below
models:
  fast: gemini-3.5-flash-lite  # haiku tier
  executor: gemini-3.6-flash   # sonnet tier, and the fallback for the other tiers
  planner: gemini-3.6-pro      # opus tier
  # judge: gemini-3.6-pro      # the critic, where the provider has a critic variable
```

| Key | Tier | Variable written |
|---|---|---|
| `models.fast` | `haiku` | `<PROVIDER>_MODEL_FAST` |
| `models.executor` | `sonnet` | `<PROVIDER>_MODEL_DEFAULT` |
| `models.planner` | `opus` | `<PROVIDER>_MODEL_STRONG` (and `OPENAI_MODEL_CRITIC`) |
| `models.judge` | — | `OPENAI_MODEL_CRITIC` alone; no other provider has a critic variable |

A tier nothing names falls back to `executor`, and `executor` itself to the top-level `model`, so a
profile with no `models` block reaches exactly the variables and values it reached before this key
existed. An unknown key inside the block is a config error rather than a setting that does nothing.
An environment variable you set yourself always wins over the file — only unset or empty variables
are filled — and values are never logged, only names. The OpenAI-compatible aliases (`ollama`,
`lmstudio`, `deepseek`, `groq`) resolve to `openai` plus a base URL and their tiers are written
first, so aliasing and tiering compose.

The block reaches a live run through the session runtime, which hands it to the orchestrator with
the provider and model; `trent fleet show <seat> --json` prints the model a seat would resolve to
under its manifest tier. The self-improvement loop's judge is a different setting,
`improve.judge_model`, which resolves against the planner tier (docs/improve.md).

```bash
npm run cli -- config set models.planner gemini-3.6-pro
npm run cli -- fleet show finance        # model + tier the finance seat resolves
```

## Retry and fallback

Every provider attempt is bounded: **3 attempts**, exponential backoff with full jitter, 500 ms
base, 8 s cap. Only transient failures are retried — HTTP 429, 5xx, 408 and transport errors
(`ECONNRESET`, `ETIMEDOUT`, a failed fetch). A 400, 401, 403, 404 or 422 is never retried, because
the next attempt is the same request. A `Retry-After` header (seconds or an HTTP date) is obeyed
instead of the curve, capped at 8 s. Every retry writes one line naming the provider, model,
attempt, delay, error class and status — never a credential.

When the attempts are spent the next provider in the fallback chain is tried. Once a token has
reached you the answer is half-delivered, so there is no retry and no fallback: you get the error
rather than a duplicated paragraph. Cancelling (Ctrl+C) ends a backoff wait immediately and starts
no further attempt.

## Model pricing

Cost is priced per model id, not per tier. `model_overrides` beats the shipped table:

```yaml
model_overrides:
  gemini-3.5-flash-lite:
    input_cents_per_million: 30      # CENTS per million tokens (USD 0.30 / 1M)
    output_cents_per_million: 250
    context_window: 1000000
  my-private-finetune:
    input_cents_per_million: 0
```

Rates are cents per million tokens; the cost itself is always integer cents. Models served by
`ollama` and `lmstudio` are priced at zero — the tokens were produced on your hardware. A model
nothing can price is reported with `unpriced` on the usage row and its cost is the wrapped app's
tier estimate: visibly a guess, not a bill. Add a `model_overrides` entry to make it exact.

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
`GOOGLE_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`,
`OLLAMA_API_KEY`, `LMSTUDIO_API_KEY`, `E2B_API_KEY`,
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

One exception, on by default: a provider the profile has not connected itself with `trent connect`
is read from the default profile's `.env`, read-only (`connect.inherit_default`, see
[connect.md](connect.md), "One grant per machine"). Model keys and gateway tokens are never
inherited. `npm run cli -- --profile work config set connect.inherit_default false` turns it off
for that profile; it is a `config.yaml` key (the `secrets.` prefix is the route into `.env`).

## The standalone environment contract

Four environment variables decide whether a run executes once or twice. This is measured behaviour
of the wrapped application, not a style preference.

| Variable | Required value | What goes wrong otherwise |
|---|---|---|
| `TRENT_QUEUE_FALLBACK` | `disabled` | Every job executes twice, silently |
| `TRENT_EVAL_SYNC_QUEUE` | unset | Synchronous dispatch double-runs against the explicit drain |
| `REDIS_URL` | unset or empty | `getQueue()` returns a queue and a BullMQ connection is attempted |
| `DATABASE_URL` | a postgres URL, or unset | The APP's database, never the wrapper's SQLite file. Unset selects the app's in-memory store; a postgres URL selects its Prisma store; anything else is cleared by the runtime and the app tiers are skipped (see "Company memory in the app") |

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

## Media

```yaml
media:
  backend: auto                 # auto | docker | host; auto prefers docker when trent-sandbox-media:1 exists
  hosted_transcription: false   # true sends audio to the configured provider; previewed and approved as egress
  whisper_model: ""             # path to a whisper.cpp ggml model for the host backend, when not on the default path
```

The `media` toolset (`media_probe`, `media_transcribe`, `media_scenes`, `media_clip`,
`media_thumbnail`) runs allowlisted binaries: through the media sandbox image when it exists, else
the host's own ffmpeg, whisper.cpp or faster-whisper, PySceneDetect and MediaPipe. `trent doctor`
names the backend and what is installed. No audio leaves the machine unless
`hosted_transcription` is set by hand. See [media.md](media.md).

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
- Voice transcription. There is no `voice` section in the schema, no `/voice` command in the REPL
  (typing one answers `Unknown command: /voice`), and no speech engine behind
  `packages/trent-core/src/voice/`: its one entry point always throws a `TrentError`
  (`voice.transcribe: voice transcription is not available in this release`, exit code 2). A
  `voice:` block left over in an older `config.yaml` is ignored, not migrated: the schema passes
  unknown top-level keys through untouched.
