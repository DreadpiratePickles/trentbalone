# Parity push, 2026-09-25

Bobby (21:00Z, session model switched to Fable 5.1): "resume working on this, go through everything
and make sure we're on parity with hermes ... make sure that i can really gain some popularity based
on this project". Fable plans and lands; Opus agents read and implement; at most six at once;
isolation commits via scripts/dev/isolate.sh; push to feature/trent-fleet-v2 only.

## State at start
- HEAD 1d1418c (the 09-23 sweep). No production code since a1a4e04 (09-21). Tree clean.
- CI on 1d1418c FAILED: `tools/browser/browser.chromium.test.ts` again, this time
  `net::ERR_NETWORK_CHANGED` on the runner (second occurrence; 09-20 was a 60 s timeout). Rerun
  requested; the test gets a real fix this session.
- The 02:00 daily task produced no file on 09-24 or 09-25 (scheduled task did not fire or did not
  commit); to check after the waves.
- Standing proposals from three sweeps (09-21..23), none implemented: email authenticated From
  (security), per-profile gateway lock + live-writer lock, cached-token pricing + tiered-prompt
  measurement, pinned model never falls back silently, profile secrets fallback, reasoning_effort,
  per-job cron model pin, RAG reranker (after a measurement).

## Wave P1 (launched 21:10Z, six Opus agents, no subagents, no commits)
- P1-A email: Authentication-Results/Received-SPF fetched and enforced before pairing or routing.
- P1-B locks: per-profile gateway lock (host view), live-writer lock, maintenance refuses under it.
- P1-C model gateway: cached prompt tokens priced + measured live; pinned model no silent fallback;
  reasoning_effort on the call, measured live.
- P1-D secrets fallback to the default profile's file; per-job cron model pin.
- P1-E parity scorecard: every Hermes capability area vs the tree, file evidence, ranked gaps.
- P1-F public-readiness audit: what a visitor sees, README truth, install path, launch drafts.
Landing order after reports: A (security) first, then B, C, D; E and F feed wave P2.

## Landed while wave P1 runs
- Chromium flake, real fix: `navigate` retries page.goto once on ERR_NETWORK_CHANGED /
  CONNECTION_RESET / CLOSED / ABORTED (red-first unit tests) = daab6e6; the two navigating
  real-Chromium tests get `{ timeout: 120_000, retry: 1 }` = the follow-up commit (daab6e6's
  message claimed that part before it had applied; corrected in the follow-up's message).
- CI rerun of 35905708927 (1d1418c) succeeded, so the branch is green again before P1 lands.
- Daily task: `list_scheduled_tasks` shows it fired only on 09-20, 09-23 (Bobby's "run now") and
  09-25 21:00Z; nothing on 09-21/22 as separate runs (those prompts arrived in this session) and
  nothing on 09-24. The 21:00Z run is a separate session, stalled after two commands (last activity
  21:00:18Z); it stages explicit paths and isolates under /tmp/trent-dev, so it cannot collide with
  wave P1; left alone. If it wakes and pushes, my next push rebases onto it.

## P1 reports
- P1-A (email auth) reported: `email/auth-results.ts` parser (RFC 8601; all header copies kept in
  order, topmost = receiving MTA's), `require_authenticated_from` under `gateway.email` (config had
  no email keys; IMAP/SMTP settings are env/secrets), refusal before pairing and routing with one
  warning `{from, verdict}`; red first 6 failed / 3 passed (the spoof reached the handler, a
  spoofed APPROVE approved), then 25 passed. Alignment: equal, or one inside the other on a dot
  boundary with the shorter still carrying a dot. Residual it flagged: topmost header trusted
  without checking who wrote it; resumed to add an authserv-id setting before landing.
- P1-A landed 4328956 (email authenticated From + authserv_id; 32 email tests; isolation 1296
  passed / 1 skipped over gateway, config, CLI command and wrapped-modules suites). Not run against
  a live mail server; Bobby's IMAP account is the only real target and that is his call.
- P1-B landed 7eb7502 (profile locks; isolation 1556 passed / 1 skipped over profile, gateway,
  cron, CLI command, runtime, REPL and wrapped-modules suites).
- P1-D reported; decisions taken: key renamed to `connect.inherit_default` (anything under
  `secrets.` is routed to the secrets file by `config/secrets-policy.ts`, so the first name could
  not be set from the CLI); the cron pin stays stored-and-refused until a per-run model path
  exists (P2-1, after P1-C lands: the model is set once per process in `orchestrator/model-env.ts`,
  first write wins); inherited OAuth tokens are never refreshed from a second profile (exit 4
  naming the file and `trent --profile default connect refresh`). Agent resumed for the rename.
- P1-E scorecard landed at 02_plan/output/hermes-parity-scorecard-2026-09-25.md: 44 areas; parity
  7, ahead 9, partial 21, missing 4, deliberately-not 3. Top gaps: no tag so nothing installable
  (Bobby); no service install, gateway/cron/heartbeat are three foreground processes; inbound SMS
  (deliberately out, Bobby); voice notes never transcribed though the function exists; no inbound
  webhook routes (design doc: later decision). Retractions: README says 13 toolsets (16), says no
  release workflow (two exist, never run), stale test counts, "install a specialist with its
  tools" (164 specialists have toolsCount 0 and never run), `setup --portal` is quick setup,
  reserved-name list misses six `social_*` tools, `brain_read`, `fleet_skill_view` (a plugin can
  shadow them: code fix), AGENTS.md defect 9 lists four fixed defects, "cacheable prefix" is
  unmeasured (P1-C is measuring), CONTEXT.md points at superseded plans, and the small-business
  and social packs say their toolsets "haven't landed" while none of their nine skills calls a
  business or social tool.

## Wave P2 plan (after P1 lands)
- P2-1 per-run model override: `trent run --model`, cron pin honoured (delete `refusePin`), seat
  pins already per request in the gateway; after P1-C.
- P2-2 `trent service install|uninstall|status`: launchd (macOS) / systemd user unit (Linux) running
  gateway + cron + heartbeat as one supervised `trent daemon` under the profile locks.
- P2-3 gateway voice notes transcribed through the media transcribe path (Telegram, WhatsApp,
  Signal, Discord attachments), replied to as text; no TTS.
- P2-4 packs truth: each pack's skills call the tools its toolsets provide (business, social,
  media), state lines and "haven't landed" text fixed, a static test that a pack's skills name
  only tools its toolsets expose.
- P2-5 truth bundle from P1-E's retractions + P1-F's README draft: README, AGENTS.md defect 9,
  CONTEXT.md, reserved-name list (code + test), cache wording after P1-C's numbers.
- P2-6 recall@8 measurement on a real corpus (this repo's docs/) with the Gemini embedder, then
  the reranker decision that has waited since 09-20.
- P1-F audit landed at 05_release/output/public-readiness-audit-2026-09-25.md (+ README draft,
  launch post draft). Findings: the default branch `main` has NO README, LICENSE or .github (236
  commits behind the feature branch, fast-forwardable), GitHub detects no license, community score
  14%, repo named "trentbalone", no topics/homepage; the first release would FAIL because
  `.gitignore` `*.pem` keeps the ECDSA PUBLIC key out of git (render.sh --check exits 2, release.yml
  key check exits 1; the key is already embedded in install.sh); under Node the store is in-memory
  on a fresh clone (no prisma generate on install); a no-key first launch exits 3 instead of the
  DEGRADED REPL the README promises; `trent setup` exits 0 on failure and `--json` is invalid;
  TRENT_QUEUE_FALLBACK must be exported by hand; no screenshot or recording exists. Bobby's steps:
  put the product on the default branch (fast-forward main or change the default branch), cut the
  tag, rename the repo (seven hardcoded places), topics/About. Launch gate: email spoof fix landed
  (4328956).
- Wave P2 launched (six slots: P1-C, P1-D resumed, P2-A1 release path, P2-A2 first run + community
  files, P2-F packs use their tools, P2-D `trent service`). Waiting: P2-1 per-run model, P2-3 voice
  notes, P2-6 recall@8.
- P1-D landed 3891b55 (connect.inherit_default; cron pin stored and refused; isolation 1390
  passed / 1 skipped over connect, doctor, cron, tools/cron, config, CLI command, wrapped-modules).
- P1-C reported (unlanded, resumed for one adjustment). Landed in its tree: Trent-side
  OpenAI-compatible client for Google calls (`model-gateway/openai-compat.ts`: the app's client asks
  Google for no usage, so every Google call had been estimated from character count; Google also
  leaves thinking tokens out of completion_tokens, now billed as output), cached tokens priced at 0.1
  of input for Gemini (Google's pricing page) and 0.25 elsewhere, `cachedInputTokens` on the ledger
  row, report and `trent usage`; `models.fallback_on_pin` (default false); `models.reasoning_effort`
  sent only on Google calls. LIVE (15 cents metered + ~4 cents probes): gemini-3.5-flash-lite
  cached 0 of 10,543 on the second call in 7 tries; gemini-3.6-flash cached 8,164 of 10,543;
  reasoning_effort low 169 output tokens vs high 321 on the same prompt, both answered correctly.
  FINDINGS: (1) the default model never caches, so the stable-prefix design saves nothing on it;
  (2) in real seat prompts the STABLE tier comes AFTER the objective, so it is not a shared prefix
  even on a caching model (0 cached in the seat-layout case on 3.6-flash); (3) seat calls go
  through apps/web's executeSeatModel, priced by Anthropic tier: a flash-lite seat is recorded at
  $3.00/M input, 10x its price, its cached tokens cannot reach the ledger, and planner/critic/
  consolidator costs never reach the ledger at all; (4) no production caller sets the pinned-model
  field yet. DECISIONS: default stays flash-lite, cache saving recorded as zero; the cache live
  test asserts on a caching model with the default model's number logged, not failed; docs stop
  saying "cacheable prefix". New P2 items: P2-7 stable tier first in seat prompts (the seat-layout
  live case is the acceptance); P2-8 spend truth (real list price per model on seat rows;
  planner/critic/consolidator spend on the ledger; the scoped orchestrator-runtime.ts exception if
  the app's seat path must call the wrapper's gateway); P2-1 also wires the pinned field.
- P1-C landed 3061f90 (isolation 2061 passed / 1 skipped over model-gateway, governance, config,
  orchestrator, fleet-memory, CLI command, runtime, REPL, wrapped-modules). All four P1 builds are
  on the branch. Spend today so far: ~25 cents on the key (P1-C live proofs).
- Live keyed run on the clean HEAD worktree (README material, saved at
  05_release/output/first-run-transcript-2026-09-25.txt): "Write a one-line tagline for a
  neighbourhood bakery that opens at 6 am" -> Content drafted three, CEO selected one, exit 0,
  10.3 s, ledger 17 cents / 13,677 tokens / 0 cached (seat rows at the app's tier price, so the
  true cost is lower; P2-8). The `[Worker] Starting job` lines are the app's stdout in text mode;
  the README transcript is captured again after P2-8 and after that noise is quieted (P2-B).
- CI: 4328956 green; 981218c and 3891b55 red only on the Windows binary run (EBUSY removing the
  smoke test's temp dirs while the binary's handles linger; fixed by retrying rmSync, this commit);
  7eb7502 red on core tests: `repl/__tests__/approvals.restart.test.ts` child process under Bun
  "Cannot find module './internal/class'", not seen on the next commit's core job (3891b55 core
  passed); both reruns requested; if the Bun error recurs it gets its own task.
- P2-A1 landed (public key committed + installer-render CI job; postinstall prisma generate +
  cli:bun; TRENT_QUEUE_FALLBACK set by the CLI). For the README owner: delete the export line,
  the manual prisma generate, and the "no release workflow" claims. Left for P2-B: the "needs
  Bun" message blames Bun even when the generated client is what is missing
  (improve-sweep.ts:160, repl/index.ts:299); doctor hint says "Export" (environment.ts:42).
- P2-F landed (packs call their tools; static pack-skills test). Open, for P2-5: `tools/tool-names.ts`
  has no `social` entry, so a plugin could claim `social_post` (with P1-E retraction 7); posts with
  media stop at the owner (Bluesky attaches no image, Buffer refuses a media URL).
- P2-A2 landed (keyless first run opens DEGRADED REPL; setup exit codes and JSON; no-terminal
  refusal; SECURITY/CONTRIBUTING/CoC/templates/docs index). Bobby: enable private vulnerability
  reporting in the repo settings. For P2-5: getting-started still says "thirteen names" (16);
  completion-port.ts:60 names five key variables where setup detects eight; the REPL has no /exit.
- P2-3 landed (voice notes transcribed after pairing; real transcript via the media image). For
  P2-5/follow-up: `mediaImagePresent()` false-negative on Docker 29.5.3 (`docker inspect --type
  image` vs `docker image ls`), so `media.backend: auto` silently uses the host.
- P2-6 (recall@8 on docs/) and P2-7 (stable tier first in seat prompts) launched.
- P2-5a launched (truth bundle: derived reserved tool names, mediaImagePresent on Docker 29.5.3,
  "needs Bun" message causes, doctor hint, completion-port key names from the setup table,
  getting-started toolset count, AGENTS.md defect 9, CONTEXT.md pointers, /exit). README waits for
  P2-D (counts), P2-8 (true costs) and P2-5a (its reported README lines): that is P2-B.
- CI: 4c05f65 and 499cd14 green; ba5d2b0 red again on Windows EBUSY despite the retries (the
  runner's file scanner holds fresh files), so the smoke test's cleanup is now best-effort with a
  warning (this commit). Windows binary behaviour itself passed in every run.
- P2-D landed (`trent service`; README counts 35/151). Follow-up: service-daemon.ts duplicates
  cron.ts wiring (delivery, incident alert, social publish handler, pin refusal); share it once
  P2-1 lands. For the README owner: add `trent service install` to the commands list.
- P2-7 reported (unlanded, resumed): the stable tier now leads the seat SYSTEM prompt (the hook
  already receives systemPrompt via orchestrator/index.ts:209; no apps/web edit needed); same bytes,
  reordered (1,744 both ways, company memory from offset 413 to 0); live on gemini-3.6-flash the
  second objective got 8,164 cached in one of two runs (Google's implicit cache is best-effort; two
  more attempts hit 429), 4 cents. Decisions: fix the two REPL tests that looked for company
  memory in dynamicPrompt; skill injection inserts after the stable tier (it could push it off the
  front); the analyst semantic cache key in apps/web excludes systemPrompt, so the context tier
  carries a "Stable tier version: <hash>" line (wrapper-side mitigation; the one-line app fix is
  Bobby's call); company memory in the system message accepted because its writes are
  provenance-tagged and held; the live seat case tries up to three fresh pairs before failing.
- P2-8 landed (true costs: $0.17 -> $0.02 on the same run; six ledger rows; seats through the
  wrapper's gateway with no apps/web change). Follow-ups: `trent usage` text does not name the
  estimated/unpriced flags (usage.ts); the run-override setting is process-wide; an app cache hit
  on an analyst step meters 0; OpenAI-key consolidator usage stays inside the app.
- P2-1 landed ec2e7b3 (per-run model as its own process; cron pin honoured). P2-7 landed (stable
  tier first; skill injection after it; stable-tier version line; company memory in the system
  message accepted). NOTE: the key is on Google's FREE TIER: gemini-3.6-flash allows 20 requests
  per day and today's proofs used them; per-minute 429s on other models. Live proofs for the rest
  of today are limited; the nightly live tests will read the quota, not a defect.
- P2-10 (follow-ups bundle), P2-11 (run without a verdict), P2-12 (media on social posts) launched.
- P2-5a landed 423f202; deliverable docs committed da0c385; P2-6 landed (recall measured: hybrid
  0.400 -> 0.629 after the gate fix; paraphrased 0.417; reranker now decided with numbers).
  Launching P2-13 rerank (task-type embeddings first, then opt-in LLM rerank over the union pool,
  metered), P2-9 A2A client toolset, P2-10 follow-ups bundle, P2-11 run without a verdict,
  P2-12 media on social posts.
- Secret scan note: the one `AIza` match in the docs-corpus fixture is the four-letter prefix
  named in docs/doctor.md:102 (how the doctor recognises a Google key), public since 761f652.
- True-cost transcript captured after P2-8 (2 cents, 26,867 tokens, 5 rows) and saved over
  05_release/output/first-run-transcript-2026-09-25.txt for the README (P2-B).
- Wave P2 second half launched (six): P2-13 rerank (task-type embeddings, then opt-in LLM rerank
  over the union pool, metered), P2-9 A2A client toolset (a2a_list/discover/send/history through
  the egress client, behind the gate, untrusted-tagged replies), P2-10 follow-ups bundle (usage
  flags in text, daemon honours the pin via cronJobRun and shares cron.ts wiring, one program
  resolver, TUI /exit cleanup), P2-12 media on social posts (Bluesky blobs/embeds, Buffer per its
  docs, queue with media), P2-B README from the audited draft with the true-cost keyed transcript
  plus text-mode `[Worker]` lines routed to logs/run.log, P2-11 a run that loses model calls
  mid-way ends with failedSteps/summary/retryAfter instead of "without a verdict".
- CI: a23efa5 red on the same Bun child-process error as 7eb7502 ("Cannot find module
  './internal/class'", approvals.restart.test.ts), both green on rerun; cause: four suites spawn
  Bun children that transpile the generated client concurrently; they now run in the exclusive
  (serial) vitest project (this commit). Every other landed commit is green.
- P2-B landed (README rewritten with proofs; text-mode run log). P2-12 landed (media on Bluesky;
  Buffer by hosted URL). Follow-ups for P2-14: queue editing drops a post's files and `cron queue
  list` does not show them; FleetPacks.ts:177 "text only", FleetPacks.ts:188 / pack-personas.ts:54
  "owner posts every clip", pack-skills.test.ts:204 stale message; Buffer alt text/thumbnail/multi
  asset; EXIF strip. README after P2-9: seventeen toolsets with a2a, an a2a Tools row, the Hermes
  A2A row "server and client", the not-done A2A line.
- P2-10 landed. P2-B is held: run.ts in the tree also carries P2-11's unlanded verdict import
  (tsc fails in isolation), so README + text-mode log + verdict land together after P2-11.

## Landing record, wave P2 second half
- P2-B + P2-11 landed ac9a0e3 (README rewritten with proofs; text-mode run log; a run that loses
  model calls ends with a verdict: reason, failed_steps with provider/status/retry_after_seconds,
  consolidation state, exit 5 for model_calls_failed; a mid-run 429 had been reported as
  `completed` because the app keeps only the last provider's error).
- P2-13 landed 0f740e6 (task-type embeddings and LLM rerank built, measured, off by default: rerank
  0.571 vs hybrid 0.629 on 300-char snippets, 0.21 cents/query; task-type re-measure blocked by
  the free tier's 1,000 embeddings/day; next: whole-chunk snippets, ~15 cents).
- P2-9 landed dec2a54 (a2a toolset: list/discover/send/history, live against trent a2a serve with
  zero spend; SECURITY: the egress proxy replaced any tool's Authorization with the model key for
  non-Anthropic/Google hosts; a2a keeps its own bearer via x-trent-own-credential; business and
  MCP http paths fixed in P2-14). README: seventeen toolsets.
- P2-10 landed 4f164ca; P2-12 landed 3dd461c; stray `.1` removed (next commit).
- P2-14 launched: business/MCP through the own-credential header (red-first through the real
  proxy), service-log test hygiene, queue editing keeps files, pack wording, seat-wiring a2a gate.

## Bobby's steps (unchanged, all one command each)
1. Put the product on the default branch: `git push origin feature/trent-fleet-v2:main` (fast
   forward; main is behind) or `gh repo edit --default-branch feature/trent-fleet-v2`.
2. Tag v1.0.0 on that branch (05_release/output/release-checklist-v1.md steps 5-7, 10-12).
3. Rename the repo from trentbalone (seven hardcoded places listed in the audit), set the About
   text and topics.
4. Enable private vulnerability reporting (SECURITY.md points there).
5. Platform applications (Meta, YouTube, TikTok, Google Business Profile) when ready.
- Day close on f0d0ce4 (clean worktree, whole core + CLI suite via scripts/dev/isolate.sh):
tsc exit=0
core build exit=0
repo-scan exit=0
      Tests  4089 passed | 2 skipped (4091)
 Test Files  415 passed (415)
vitest exit=0
  CI green on 68894ea, fb90bcb, 3dd461c, 4f164ca, 0f740e6, ac9a0e3 (dec2a54 superseded,
  f0d0ce4 in progress). Since this morning: 3608 -> 4089 tests, 370 -> 415 files.
- P2-14 landed ccd9430 (business/MCP tokens keep their own credential through the proxy, proven
  red-first behind the real proxy; service-log tests confined to temp dirs; queue edits keep files;
  pack wording; a2a gate map). Every P1 and P2 task is on the branch. Open, small: `tailServiceLog("")`
  still reads `.1` from the working directory; the docs-corpus fixture snapshot carries the old
  "text only" wording (regenerated with the next re-record).

## State at close (2026-09-26 ~01:30Z)
HEAD ccd9430, tree clean except this log, CI green on every commit since 68894ea at the last
check. 32 commits today. Everything left is Bobby's (default branch, tag, rename, topics, private
vulnerability reporting, platform applications) or waits on quota (task-type embeddings re-record,
whole-chunk rerank measurement) or a real reboot (service). Tomorrow's 02:00 sweep resumes from
here.
- CI confirmed after close: f0d0ce4 36204031785, ccd9430 36205331142 and c9a5e12 36205351513 all
  success.
