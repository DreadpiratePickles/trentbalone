# 2026-09-20 W6: the `social` toolset

Branch `feature/trent-fleet-v2`, from 6255d94. Implementation agent for B1 (design section 3;
review sections 3 and 6.8). Nothing committed by this agent; `git add` left to the orchestrator.
`TRENT_QUEUE_FALLBACK=disabled` in every shell. No live platform was called: every test runs on
`tools/social/testing/fake-platforms.ts`, a loopback server the fetch seam rewrites hosts to.

## What landed
- `packages/trent-core/src/tools/social/`: `schemas.ts`, `types.ts`, `matrix.ts` (the real
  adapter capability table plus `PLATFORM_PROVIDER`, caveats, review state, route decision),
  `bluesky.ts` (AT Protocol: createSession, createRecord, getRecord, listNotifications,
  getPosts), `buffer.ts` (GraphQL: organizations, channels, createPost text-only),
  `publish.ts` (routes, typed `SocialToolError`s, Buffer spend on the ledger), `queue.ts`
  (one-shot handled job on `cron/jobs.json`, tick-time handler re-reading the bound approval and
  publishing through `executeWithIdempotency`), `index.ts` (the adapter; `requireBoundApproval`
  inside `execute` on every write, keyed exactly as the wrapper keys it).
- Cron: `CronJob.handler` and `payload`; `CronRunner` `handlers` dispatch; the CLI cron command
  registers `social_publish`.
- Registration: `ToolsetSchema`, `IMPLEMENTED_TOOLSETS`, the builder branch, `TOOLSET_BY_ADAPTER`,
  `BUILTIN_TOOLS_BY_TOOLSET`, `CAPABILITY_TOOLSETS` (`social:draft`, `X`) and `GATED_TOOLSETS`,
  `TOOLSET_APPROVAL_GATES` (`social.publish`), `MCP_TOOLS_BY_TOOLSET` (one line; the exhaustive
  record forced it), blank-slate `disabled_toolsets`, quick setup gated on a connected provider.
- Doctor `check_social`; docs/social.md; rows in docs/tools.md and docs/doctor.md; the count in
  README and docs/doctor.md moved to 22 (business is 21, social 22).

## Decisions worth knowing
- Read tools are `social_platforms_list`, `social_inbox_list`, `social_insights_read`: the
  classifier's scope fallback would otherwise give them `external_send` from `social_post`.
- The tick-time publish is a handler, not a prompt: a model-driven `social_post` at tick time
  would hit the class floor under a new run id and park forever. The queue-time approval row is
  the one the handler re-reads; the idempotency key is that same call.
- X, LinkedIn and TikTok have no `trent connect` provider, so their direct paths are unreachable
  from the CLI and the tool says so; Buffer is the route. TikTok's direct path would be
  SELF_ONLY anyway. Buffer media input is undocumented on the fetched pages: refused, not dropped.

## Evidence
See the final report for the exact commands and exit codes.
