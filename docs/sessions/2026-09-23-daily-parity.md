# Daily progress and Hermes parity check, 2026-09-23

Standing instruction (Bobby, 2026-09-20): every day at 02:00 ask how much progress we made and, as
researchers at Anthropic, what would make Trent as good as Hermes Agent is today. This run was
triggered by hand at 18:43Z ("do the nightly sweep now"); the 02:00 task did not produce a file for
today. Previous check: docs/sessions/2026-09-22-daily-parity.md.

## 1. Since the previous check (HEAD 65562aa then, 7e043a1 now)
1. One commit landed: the 2026-09-22 daily check itself (7e043a1), carrying 38 upstream inventory
   items and two new proposals (price cached prompt tokens; profile secrets fall back to default).
2. No production code has changed on the branch since 2026-09-21 (a1a4e04). Three daily checks have
   now produced six standing proposals and none is implemented, because the daily instruction says
   to propose and not to build. That backlog is the honest headline of this sweep.
3. Nothing is in flight: no agent running, no uncommitted work, branch level with origin.
4. Blocked on Bobby: platform applications (Meta, YouTube, TikTok, Google Business Profile), Gemini
   image quota (429 on image generation), the release-checklist steps that are his.
5. Blocked on a measurement: RAG reranker / query prefixes, pending recall@8 on real documents.
6. Hermes A2A interop stands where 09-21 left it: discovery and calls work live with zero spend;
   Hermes cannot answer an `input-required` task because its client never resends a taskId.
7. Operational finding this sweep: the machine rebooted (uptime 1 day, was 6), which wiped
   `/private/tmp`, and with it the scratchpad copies of the isolation helpers. The committed
   `scripts/dev/` copies are intact and were used with `TRENT_DEV_SCRATCH` pointed at the new
   scratchpad. This is exactly why those scripts were committed; no action needed.
8. CI flake watch: `browser.chromium.test.ts` 60 s timeout, seen once on 09-20, not since.
9. The six standing proposals, in the order this sweep would build them: cached-token pricing,
   one gateway per host with a live-writer lock, profile secret fallback, `reasoning_effort`,
   per-job cron model pin, and (only after a measurement) the RAG reranker.
10. Working tree clean at check time.

## 2. Hermes since the last check (primary sources; one Opus agent, no subagents)
Appended to 01_discovery/output/hermes-feature-inventory-2026-09.md as "New since 2026-09-22
(checked 2026-09-23)": 40 items. No release and no tag was cut; newest is still v2026.9.21 = 0.21.4,
and `main` is 1,019 commits ahead of it. Newest upstream commit 16fe260a at 2026-09-23T18:35Z.
Most consequential upstream: "Bot Screen", a per-bot VNC desktop streamed into Hermes Desktop with
take-over and hand-back; Hindsight unbundled from the tree (memory providers 8 -> 7, installs from
the catalog); `gateway.standalone: true` with per-profile parking, partly reversing the 09-22
multiplex-only row; a pinned cron job no longer falls back to the global provider chain, it fails;
and email now requires an authenticated `From:` (DMARC or aligned SPF/DKIM) before any inbound mail
is acted on, allowlist entries matching whole addresses only.

Breakage check against Trent (the agent diffed the distribution writer, the MCP enable rules and the
A2A plugin): none. `export-hermes.ts` never writes the `profile.yaml` whose handling changed;
`mcp_servers.trent` without an `enabled` key is still treated as on; `import-hermes.ts` degrades
unknown keys to notes; `plugins/platforms/a2a/` has a zero-byte diff across the window. One
deployment-config watch item: a Hermes profile switched to `gateway.standalone` leaves the host's
`/p/<profile>/` ingress, and Trent builds no such URLs, so this is an operator concern only.

## 3. Judgement: outcomes, not feature count (rulebook principle 1)
One of the 40 is a security defect in Trent, found by checking rather than assuming. It goes to the
top of the list and displaces yesterday's ordering.

1. **Email pairing trusts a spoofable `From:`.** Trent's sender policy is default-deny with pairing
   codes keyed on `(platform, senderId, scope)` (`gateway/security/PairingManager.ts`). For email,
   `senderId` is `bareAddress(h.from)` (`gateway/platforms/email.ts:107`), and the IMAP client
   fetches only `FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES`
   (`gateway/platforms/email/imap.ts:24`), so no verification header is ever read. Anyone who knows
   a paired address can forge `From:` and be routed to an agent at that sender's tier. The nonce
   still protects an approval decision, but commanding the agent needs only the spoof. Hermes shipped
   exactly this fix in the window. Files: `email/imap.ts` (add `AUTHENTICATION-RESULTS` and
   `RECEIVED-SPF` to `HEADER_FIELDS`), `email.ts` (parse the MTA's verdict; act only on `dmarc=pass`,
   or an aligned `spf=pass`/`dkim=pass` against the From domain; anything else is dropped with one
   log line naming the address and the verdict, never the body), a `gateway.email.require_auth`
   config key defaulting to true with an explicit opt-out for a server that strips the header.
   Failing test: `email.wire.test.ts`, "a message whose Authentication-Results says dmarc=fail is
   never handed to the message handler and never issues a pairing code"; "a dmarc=pass message from
   a paired sender is handled as today"; "with require_auth false the old behaviour returns".
   Cost: ~120 lines, no spend, half a day. This is the single most important item on the branch.
2. **One gateway per host, with a live-writer lock** (09-21 proposal 1+3), amended by this window:
   Hermes re-added per-profile parking under the host, so the lock is per profile with a host-level
   view, not one process per machine. Same files, same tests, one extra case: "a second start on a
   DIFFERENT profile is allowed and both appear in `trent gateway status`".
3. **Price cached prompt tokens** (09-22 proposal 1): unchanged, still the cheapest way to prove or
   disprove the three-tier prompt's core claim.
4. **A pinned model never falls back silently.** Hermes made a pinned cron job fail rather than be
   rescued by the global chain. Trent's gateway falls back across providers for every request, so a
   seat pinned to a cheap tier can be answered by an expensive one and the ledger records the cost
   after the fact. Files: `model-gateway/index.ts` (an explicit per-run model opts out of the chain),
   `config/sections/models.ts` (`models.fallback_on_pin: false` default). Failing test: "a request
   naming a model explicitly fails with the provider's own error instead of falling back, and the
   ledger records no second attempt". Cost: ~60 lines.
5. **Profile secrets fall back to the default profile's file** (09-22 proposal 2): unchanged, lowest
   priority of the five; `reasoning_effort` and the per-job cron pin stay on the standing list below.
Not proposed: Bot Screen (a VNC desktop subsystem; Trent's desktop wrapper is deferred and no user
has asked to watch a browser), Hindsight unbundling (Trent has its own brain), the catalog and
picker rows, Desktop tray and HUD polish.

## 4. Status
- Tests on HEAD 7e043a1 (clean worktree, scripts/dev/isolate.sh, whole core + CLI suite): tsc 0,
  core build 0, repo-scan 0, vitest 3608 passed / 1 skipped, 370 files. The reboot had wiped the
  scratchpad and left a stale worktree registration; `git worktree prune` plus
  `TRENT_DEV_SCRATCH` pointed at the new scratchpad restored the harness, and the committed
  `scripts/dev/` copies were intact.
- CI: run 35696439826 on 7e043a1 succeeded.
- Most important next action: fix the email sender verification (proposal 1). It is a live
  spoofing hole in a default-deny design, it needs no spend and no decision from Bobby, and three
  sweeps of proposals are now stacked behind a branch whose code has not changed since 09-21.
