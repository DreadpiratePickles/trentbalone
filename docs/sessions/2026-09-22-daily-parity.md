# Daily progress and Hermes parity check, 2026-09-22

Standing instruction (Bobby, 2026-09-20): every day at 02:00 ask how much progress we made and, as
researchers at Anthropic, what would make Trent as good as Hermes Agent is today. Run started
06:32Z. Previous check: docs/sessions/2026-09-21-daily-parity.md.

## 1. Since the previous check (HEAD 844da15 then, 65562aa now)
1. One commit landed: the 2026-09-21 daily check itself (65562aa), carrying 72 upstream inventory
   items and four proposals (one gateway per host; reasoning_effort on the model call; maintenance
   refusing under a live writer; per-job cron model pin).
2. No code changed on the branch in the last 24 hours; no agent was in flight; Bobby has not
   replied since "get back to work" on 2026-09-20.
3. The one-shot reminder for the deferred decisions fired on 09-21 and was answered from the log:
   four of five were decided on 09-20; only the platform applications remain Bobby's, "last".
4. State at the last close stands: upgrade round waves 1-3 and the follow-up wave landed; clean
   HEAD 3608 passed / 1 skipped; CI green on 844da15 (run 35549968714).
5. Hermes A2A interop: discovery and calls work live with zero spend; Hermes cannot answer an
   `input-required` task because its client never resends a taskId (Hermes-side).
6. Blocked on Bobby: platform applications (Meta, YouTube, TikTok, Google Business Profile),
   Gemini image quota (429), release checklist steps in 05_release/output/release-checklist-v1.md.
7. Blocked on a measurement: RAG reranker / query prefixes (recall@8 on real documents).
8. Yesterday's proposals are unimplemented by design (the daily check proposes; Bobby decides
   what gets built). They stand; today's judgement adds to or reorders them, it does not repeat them.
9. CI flake watch: `browser.chromium.test.ts` 60 s timeout seen once on 09-20, not since.
10. Working tree clean at check time; branch level with origin.

## 2. Hermes in the last 7 days (primary sources; one Opus agent, no subagents)
Appended to 01_discovery/output/hermes-feature-inventory-2026-09.md as "New since 2026-09-21
(checked 2026-09-22)": 38 items not previously listed. A release was cut: v2026.9.21 = 0.21.4
(2026-09-21T18:10Z, tag d337b736), a roll-up patch with no curated notes; this machine runs 0.21.3,
one patch behind. Newest `main` commit c3021aff at 2026-09-22T06:31Z. Most consequential upstream:
multiplex-only gateway topology (per-profile gateways retired, breaking); named profiles read the
root `auth.json` again (reverting the 09-20 per-profile credential isolation); `prompt_caching.
cache_ttl: auto` (1 h for human-paced sessions, 5 m for cron/subagent/webhook); `terminal(background,
heartbeat=N)` periodic output notices; image rejections no longer erase session images; Telegram
`update_id` replay suppression; scratch pruning by idle time that also kills the processes inside.

## 3. Judgement: outcomes, not feature count (rulebook principle 1)
Checked against Trent before judging: the Telegram adapter already persists its poll offset in the
gateway store (`gateway/platforms/telegram.ts:119-132`), so restart replay is handled; the terminal
tool already runs `background: true` jobs behind `process_manage`; `trent connect` secrets are per
profile (`connect/store.ts`); the model gateway's usage frame carries `inputTokens` and
`outputTokens` only, so cached prompt tokens are neither read nor priced. Yesterday's four proposals
stand unchanged; today adds two and reorders:

1. **Price cached prompt tokens, and measure the three-tier prompt.** Google's OpenAI-compatible
   endpoint reports `usage.prompt_tokens_details.cached_tokens` and bills them at the cached rate;
   Trent's `tierCostCents` (`model-gateway/index.ts:263`) prices every input token at full rate, so
   the ledger overstates cost and the STABLE/CONTEXT/VOLATILE assembly's whole point (a stable
   prefix that caches) has never been measured. Files: `model-gateway/attempts.ts` (read
   `cached_tokens` into the usage frame), `model-gateway/index.ts` (cached rate per tier),
   `governance/spend-ledger.ts` row gains `cachedInputTokens`. Failing test: "a usage frame with
   cached_tokens prices them at the cached rate and the ledger row records them"; live proof: two
   consecutive seat runs on the key, the second showing cached tokens > 0 in `trent usage --json`.
   Cost: ~90 lines plus two live runs (cents). This is the highest-value item today because it
   turns an existing design claim into a number.
2. **One gateway per host, with a live-writer lock** (yesterday's 1 and 3, now reinforced: Hermes
   made multiplex-only the sole topology and removed the opt-out). Unchanged spec; do first with 1.
3. **Profile secrets fall back to the default profile's file.** Hermes reverted per-profile
   credential isolation within a day because one OAuth grant per machine is what people want; a
   second Trent profile today re-runs every `trent connect`. File: `connect/resolver.ts` (read the
   profile's secrets file, then `default`'s, never write to the fallback), `doctor/checks/
   credentials.ts` names which file resolved. Failing test: `resolver.test.ts`, "a provider absent
   from the profile's file and present in default's resolves, and the resolution names the file";
   "a value present in both resolves from the profile's". Cost: ~50 lines, docs/connect.md one
   paragraph. No secret value is ever printed (rule 3).
4. **`reasoning_effort` on the model call** (yesterday's 2): unchanged.
5. **Per-job cron model pin** (yesterday's 4): unchanged, lowest priority.
Not proposed: `terminal` heartbeat notices (poll exists; no gateway user has asked), the image
strip-on-send change (Trent's vision toolset does not persist session images), scratch pruning
(Trent's sandbox is per run), the Desktop items (Tauri wrapper deferred), catalog growth to 237.

## 4. Status
- Tests on HEAD 65562aa (clean worktree, scripts/dev/isolate.sh, whole core + CLI suite): tsc 0,
  core build 0, repo-scan 0, vitest 3608 passed / 1 skipped, 370 files.
- CI: run 35603711065 on 65562aa succeeded.
- Most important next action: proposal 1 (price cached tokens and measure the tiered prompt), since
  it costs cents and either proves or disproves the cheapest design decision on the branch; then the
  gateway lock. Everything else open waits on Bobby.
