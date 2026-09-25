# P1-D: profile secrets fall back to default's file; per-job cron model pin (2026-09-25)

Wave P1 agent D (Opus, no subagents, no commits). Specs: docs/sessions/2026-09-22-daily-parity.md
proposal 3, docs/sessions/2026-09-21-daily-parity.md proposal 4. Base HEAD 1d1418c; other agents
edit the tree concurrently (gateway, model-gateway, profile, email).

## Discovery (read before any test)
- `connect/store.ts` reads `<profile>/.env` through `ConfigManager.loadSecrets({ force: true })`,
  which also EXPORTS every key into `process.env`. Reading the default profile's file the same way
  from another profile would leak all of default's secrets (the model key included) into this
  process's environment as a side effect of one token lookup, so the fallback file is parsed
  without export.
- Refresh writes: `resolver.ts` refreshes an oauth2 token through `refreshOAuth(store, ...)`, which
  writes back to the store it read. Square uses PKCE with `refresh_token`, whose refresh tokens are
  single use, so copying an inherited token into the profile on refresh would invalidate the
  default profile's grant; writing it back to default's file is what the spec forbids. Decision:
  an inherited token is handed out while valid (inside the 5-minute window too) and never
  refreshed from the other profile; an expired inherited token is an AUTH error naming default's
  file and `trent --profile default connect refresh <id>`.
- `store.tokens`/`store.field` feed the flows (`connect`, `refresh`, `remove` in `flow.ts` and the
  CLI), which write back to the profile's own file, so they stay own-file. `read`/`list` (metadata,
  no values) become inheritance-aware and carry `source`, so `trent connect list --json`, the
  business/social doctor lines and `tools/social/publish.ts`'s connected gate see an inherited
  provider without their files changing. The resolver reads values through a read-only view.
- Granularity: per provider, not per key. The profile's own file wins whenever it names ANY of the
  provider's env names (a half-finished connect here is this profile's); default's file is used only
  when the profile names none of them and default has the provider connected. Per-key layering
  would pair one grant's access token with another's refresh token or expiry.
- `secrets.inherit_default` key name conflict: `config/secrets-policy.ts` `isSecretKey` treats any
  `secrets.`-prefixed key as an explicit secrets-file name, so `trent config set
  secrets.inherit_default false` writes `inherit_default=false` into `.env` and changes nothing.
  Kept the name the spec gives; documented that the key is edited in config.yaml; reported.
- Scope: `trent connect` providers only. Model keys and gateway bot tokens stay per profile (a
  second gateway inheriting one bot token would answer every message twice).
- `trent connect status` does not exist (`connect.ts` has list/remove/refresh); `list` is not in
  this agent's files. Its `--json` carries the new `source` field automatically.
- Cron: `cron/config-schema.ts` is the `cron:` config block, not the job schema. The job type is
  `CronJob`/`CronJobInput`/`newCronJob` in `tools/cron/index.ts` (3 small additions there).
- The pin has no consumer downstream: `HeadlessRunOptions` and `OrchestratorRunOptions` carry no
  model, and the model reaches the gateway through a process-wide env bridge set once per process,
  first write wins (`orchestrator/model-env.ts` `setIfUnset`). One `CronRunner` exists
  (`apps/cli/src/commands/groups/cron.ts`). Passing the pin into a runtime that ignores it would run
  a job pinned to a cheap model on the configured one, silently. Decision: the runner passes the
  pin (spec); the CLI wiring refuses a pinned run with a CONFIG error that names the pin, so the
  row records a failed run and no model is called, until the runtime honours `options.model`.
- docs-truth counts commands and subcommands, not options: `--model` changes no count. A new
  top-level config key must appear in a yaml block in docs/configuration.md.

## Log
- RED part 1 (TRENT_QUEUE_FALLBACK=disabled, repo root): `npx vitest run connect/resolver.test.ts
  connect/doctor.test.ts doctor/checks/credentials.test.ts config/secrets-schema.test.ts` -> 11
  failed, every existing test still green. Reasons: resolver "Stripe/Google is not connected" for
  the inherited cases, `source` undefined, `DEFAULT_CONFIG.secrets` undefined and the `secrets`
  block accepted a string (no schema), doctor stripe line `skip` for work, credentials ok message
  without the secrets path.
- GREEN part 1: `config/sections/secrets.ts` (`SecretsConfigSchema`, strict, inherit_default
  default true), composed in `config/schema.ts` and shipped in `config/defaults.ts` before
  `personality:` (the file's own convention; two files outside the brief, two small hunks each),
  `schema-split.input.json` sets it false. `connect/store.ts`: `view(id)` picks the file per
  provider, `read`/`list` carry `source`, `tokens`/`field` stay own-file, default's file parsed with
  dotenv and never exported. `connect/resolver.ts`: `source` on every result; inherited oauth2
  handed out while valid, expired -> AUTH naming the path and `trent --profile default connect
  refresh <id>`. `connect/doctor.ts` names the file; `doctor/checks/credentials.ts` message names
  the file or "the process environment". Same 4 files -> 34 passed, exit 0.
- Snapshot: another agent's regen (P1-A/P1-B are editing config concurrently) had already
  captured the `secrets` key (true in defaults, false in the fixture) before my config run, so
  `npx vitest run packages/trent-core/src/config` -> 11 files / 62 passed, exit 0, without a regen
  by me.
- Concurrency: P1-B edits `cron/CronRunner.ts` + test (writer lock in start/stop). My hunks there
  are `CronRunOptions` and the one run call only.
- RED part 2: `npx vitest run packages/trent-core/src/cron/CronRunner.test.ts
  apps/cli/src/commands/__tests__/cron.test.ts` -> exit 1, 3 failed / 27 passed. Reasons: the
  pinned job's run input was `{ trigger: "scheduled" }`; the CLI exited 2 (USAGE, unknown option
  `--model`) on both CLI tests.
- GREEN part 2: `CronJob.model`/`CronJobInput.model`/`newCronJob` (tools/cron/index.ts, conditional
  spread so an unpinned record has no key); `CronRunOptions.model` + the one run call in
  `CronRunner.execute`; CLI `add --model <id>` (blank refused, CONFIG), `list` shows `model <id>`,
  `refusePin` in `run <id>` (before the runtime) and in `openRunner`'s `run` (a tick records the
  failed row). Same 2 files -> 30 passed, exit 0.
- Docs: connect.md "One grant per machine" section + `source` in the resolver signature;
  configuration.md `secrets.inherit_default` yaml line + Profiles paragraph (with the config-set
  caveat); jobs.md "A cron job's model pin" (one-row table + the refusal).
- Evidence, key-name trap (scratch TRENT_HOME, fixture value): `tsx apps/cli/src/index.ts --profile
  work config set secrets.inherit_default false` -> exit 0, prints "set inherit_default (secret,
  value not echoed)", writes `profiles/work/.env` with the name `inherit_default`, no config.yaml.
- Evidence, end to end (scratch TRENT_HOME, fixture stripe key in default's .env only): `--profile
  work connect list --json` -> exit 0; stripe connected, source {path: <home>/.env, profile:
  default, inherited: true}; google source is work's own path; the fixture value appears 0 times in
  the output; no file created under profiles/work.
- docs-truth caught two of my phrasings ("a `trent connect` provider" in prose and the same words in
  the yaml comment parse as `trent connect provider`); reworded. No count changed: `--model` is an
  option, and docs-truth counts commands and subcommands (README claim untouched).
- Verification (repo root, TRENT_QUEUE_FALLBACK=disabled):
  - `npx vitest run packages/trent-core/src/connect packages/trent-core/src/doctor
    packages/trent-core/src/cron packages/trent-core/src/config apps/cli/src/commands/__tests__
    packages/trent-core/src/wrapped-modules.test.ts` -> exit 0, 77 files / 1375 tests passed.
  - consumers of the touched types: `npx vitest run packages/trent-core/src/tools/cron
    packages/trent-core/src/tools/social packages/trent-core/src/tools/business` -> exit 0,
    10 files / 67 passed.
  - `cd packages/trent-core && npm run build` -> exit 0. `npx tsc --noEmit -p
    apps/cli/tsconfig.json` -> exit 0. `node scripts/ci/repo-scan.mjs` -> exit 0.
  - These ran on the shared tree with other agents' uncommitted work present; an isolated
    clean-HEAD run of only these hunks is the lander's job (scripts/dev/isolate.sh).
- Files over 500 lines: none of the code files touched (largest CronRunner.ts 408).
  docs/configuration.md was already 976 lines at HEAD (prose page).

## Open for the lander / Bobby
1. `secrets.inherit_default` cannot be set with `trent config set` (the `secrets.` prefix routes
   to .env). Either rename the key (e.g. `connect.inherit_default`) or exempt config-schema keys
   from rule 1 in `config/secrets-policy.ts`. Documented as edit-by-hand meanwhile.
2. The cron pin is refused at fire time until a per-run model seam exists: `HeadlessRunOptions`
   (apps/cli/src/runtime/headless.ts) -> `OrchestratorRunOptions` (orchestrator/types.ts) -> the
   model gateway, which today reads process-wide env set once (`orchestrator/model-env.ts`
   `setIfUnset`). When it lands, delete `refusePin` in apps/cli/src/commands/groups/cron.ts.
3. An inherited OAuth token is not refreshed from another profile; Google access tokens last an
   hour, so a second profile using Google leans on the default profile refreshing. If one shared
   grant should also be kept fresh from any profile, the answer is refresh-and-write-back under the
   DEFAULT profile's lock, which the spec forbade; that is Bobby's call.
4. `trent connect list` (human render, apps/cli/src/commands/groups/connect.ts, not this agent's
   file) does not print `source`; its `--json` does. docs/cron.md (not this agent's file) could
   point to jobs.md "A cron job's model pin".

## Coordinator decisions (after the first report) and the rename
- Decisions: (1) rename to `connect.inherit_default` in a new `config/sections/connect.ts`;
  (2) keep the cron pin refusal, one sentence in jobs.md naming the next task; (3) inherited OAuth
  tokens accepted as designed. Open items 1 and 2 above are thereby closed / scheduled.
- RED rename: `config/connect-schema.test.ts` (replaces my untracked `secrets-schema.test.ts`) +
  resolver test switched to `updateConfig({ connect: ... })` -> exit 1, 4 failed / 19 passed:
  "expected [ 'version', 'profile', ...(39) ] to not include 'secrets'" (the old key still parsed
  as a schema key), `connect` undefined, `connect.inherit_default: "no"` accepted (passthrough), and
  the resolver still inherited (store read the old key).
- GREEN rename: `sections/connect.ts` (`ConnectConfigSchema`, strict, default true); `sections/
  secrets.ts` back to HEAD byte for byte; schema.ts = marker+import after `[X5]` and one block
  `// [P1-D] connect inherit` before `personality:`; defaults.ts one block before `personality:`;
  input.json `connect: false`; store reads `loadConfig().connect.inherit_default`; docs switched and
  the config-set caveat replaced by the working command. `npx tsx scripts/dev/regen-snapshot.mjs`
  -> exit 0 ("snapshot keys: 42"). The regen also captured P1-C's `models` fixture keys
  (`fallback_on_pin`, `reasoning_effort`) from the shared input file: only the two `connect` hunks
  of the snapshot are this agent's. Rename tests + schema-split -> 28 passed, exit 0.
- Proof, scratch TRENT_HOME (fixture stripe key in default's .env): `--profile work config set
  connect.inherit_default false` -> exit 0, "set connect.inherit_default"; files: <home>/.env and
  <home>/profiles/work/config.yaml only (no work .env); config.yaml holds `connect:` /
  `inherit_default: false`; `config get` -> "connect.inherit_default false", exit 0; `connect list
  --json` -> stripe not connected, source work's own path; after `config set ... true` -> stripe
  connected, source <home>/.env, profile default, inherited true; fixture value 0 times in output.
- Verification (repo root, TRENT_QUEUE_FALLBACK=disabled; P1-A and P1-B have landed as 4328956
  and 7eb7502, P1-C still uncommitted in the tree): requested vitest set -> exit 0, 77 files / 1376
  passed; tools/cron+social+business -> exit 0, 10 / 67; core build -> 0; cli tsc -> 0;
  repo-scan -> 0.
