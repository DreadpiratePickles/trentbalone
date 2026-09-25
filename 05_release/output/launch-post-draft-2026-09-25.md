# Launch post draft (Show HN), 2026-09-25

Written by the public-readiness audit (`public-readiness-audit-2026-09-25.md`). Not posted, and not to
be posted until the gates below are met. First person is Bobby's voice; replace the "Why" paragraph
with your own reason if you have a sharper one.

## Do not post until

1. A visitor sees the README on the default branch (audit fix 1). Today
   `gh api repos/DreadpiratePickles/trentbalone/readme` returns 404.
2. The email `From:` verification fix (P1-A) is committed and CI is green.
3. The README draft has replaced `README.md` and the keyless first run exits non-zero with an
   accurate message (audit fixes 3 and 4), so the post and the first run agree.
4. Preferably v1.0.0 is released and `https://agent.let-trent.uk/install.sh` answers 200 (audit fix 7).
   If not, keep the "run it from a clone" sentence below exactly as it is.
5. Replace the repo URL if the repository is renamed (audit fix 8).

## Title

**Show HN: Trent – nine agent seats with budgets in cents and per-call approvals**

Alternatives:
1. Show HN: Trent – AI agents that ask before they send, charge or book
2. Show HN: An agent team for small businesses where every seat has a budget
3. Show HN: Trent – a multi-agent CLI that Hermes Agent can call over A2A

<!-- all four titles are 80 characters or fewer; checked with awk '{print length}' -->

## Body

<!-- BODY START -->
Hi HN. Trent is an agent team that runs in your terminal, on your machine, with your own model key.
A planner splits an objective into steps and hands each one to one of nine role seats: CEO,
engineer, growth, sales, content, support, analyst, finance and escalation. Each seat has a written
record of what it may do, what it may not, which actions wait for you, and what it may spend:

    $ trent fleet show finance
      denied       file_ops, terminal, code, social
      gates        charge, refund, subscription.change, budget.increase, payout, ...
      budget       125 cents per run

Why: the surveys I read say small businesses try generative AI far more often than they let it do
real work. The US Chamber reports 58% of small businesses using it; the Census Bureau puts AI in
production at under 20% of firms with fewer than 20 employees. Creator surveys say a person reviews
everything before it goes out. So Trent is built around the review, not around autonomy.

What is different:

- Spend is enforced, not just reported. Per-run and daily caps in integer cents sit on one ledger
  that every surface writes to (REPL, one-shot runs, messaging gateway, cron), and
  `trent run --max-cost-cents 200` stops a run and exits 6.
- A call that sends a message, moves money or touches a customer asks you at every autonomy level,
  and your yes is bound to that call's exact arguments. Change one argument and it asks again.
- The self-improvement loop (per-seat eval suites, a judge whose quotes are checked, one GEPA pass)
  only produces drafts in quarantine. Nothing goes live until you run `trent improve promote`.
- It works with Hermes Agent rather than against it: Hermes discovers and calls Trent over A2A v1.0.

Trent wraps an existing Next.js app's orchestrator instead of rewriting it; the CLI, TUI, gateway and
A2A server sit on top. About 6,400 tests pass in CI, which also builds four single-file binaries and
runs each on its own OS.

What is not done: there is no release yet, so you run it from a clone (Node 22 and `npm install`; 16
seconds on the machine I measured). Under Node the store lives in the process; the durable SQLite
store needs Bun. The business and social toolsets (Stripe, Square, Twilio, Google Calendar, Meta,
Bluesky, Buffer) are tested against local fake servers only. Hermes is well ahead on breadth: 24+
messaging platforms to our eight, a plugin catalog we do not have, and a packaged desktop app where
ours is unpackaged.

Without a key you can still install a crew, inspect every seat, and watch a run get planned and
refused at $0.00, which is the quickest way to see how it fits together.

I would like feedback on three things: are per-seat budgets and argument-bound approvals the right
primitives, does the first run tell you enough, and which live integration should be finished first?

https://github.com/DreadpiratePickles/trentbalone
<!-- BODY END -->

## Proof for each claim in the body

| Claim | Proof |
|---|---|
| Nine seats, planner assigns steps | `trent fleet list --json` (173 agents incl. the nine); `trent run` transcript in the README draft ([CEO], [Engineer] steps) |
| `fleet show finance` lines | captured on a fresh profile, clone at 981218c (README draft, "First run") |
| 58% / under 20% / creators review | `01_discovery/output/market-agents-research-2026-09-19.md` section 0 (US Chamber 2025-08-18; Census BTOS May 2026; Kit April 2026 89.2% always review; Adobe May 2026 85% final decision stays with the creator) |
| One ledger, every surface | `trent budget status` ("every surface appends to .../spend.ndjson"); `apps/cli/src/runtime/headless.ts` ("[G3.1] the one daily spend ledger"; surfaces repl, run, gateway, cron, heartbeat, a2a, acp) |
| `--max-cost-cents`, exit 6 | `trent --help` ("6 over --max-cost-cents"); `docs/getting-started.md:248` |
| Every autonomy level; bound to arguments | `docs/security.md:494-540` ("a changed argument is a different approval") |
| Drafts in quarantine, promote | `README.md` "Self-improvement"; `docs/improve.md` |
| Hermes calls Trent over A2A v1.0 | `docs/a2a.md:52-70`; `docs/sessions/2026-09-20-a2a-v1-wire.md` |
| Wraps an existing Next.js app | `AGENTS.md` "Purpose"; `README.md:9-11` |
| About 6,400 tests | CI run 35905708927 on 1d1418c: 3588 (core + CLI) + 2829 (web) = 6417 passed |
| Four binaries run on their OS | same run, four `binaries / RUN trent-* on <os>` jobs `success` |
| No release; 16 seconds | `gh release list` empty; audit 1.7 (clone 3 s, `npm install` 13 s) |
| Store in-process under Node | `apps/cli/src/runtime/headless.ts:211-219`; the REPL warning |
| Fake servers only | `docs/business.md:13`; `docs/social.md:1-10` |
| 24+ platforms, catalog, desktop | `01_discovery/output/hermes-feature-inventory-2026-09.md` lines 96, 698, 406; Trent: `packages/trent-core/src/gateway/platforms/` (8) |
| Keyless run refused at $0.00 | README draft transcript (`trent run`, exit 1, `$0.00`) |
