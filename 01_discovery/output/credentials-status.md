# Credential status (Stage 00) — BLOCKER for the live-model gate

## Finding
`~/.trent/.env` contains exactly one variable, `ANTHROPIC_API_KEY`. Its value is **16 characters**
long and begins `sk-ant-`. A real Anthropic API key is ~100+ characters. **This is a placeholder
written by the previous agent, not a working credential.** No value is recorded here.

`apps/web/.env.local` does not exist, so the web app has no local provider keys either.
`ANTHROPIC_BASE_URL` in the shell is the genuine `https://api.anthropic.com` (no proxy).

## Why this matters
1. It is fresh evidence for anti-pattern #8: `trent doctor` reported
   *"1 provider key(s) detected (anthropic), active provider 'anthropic' is configured"* — green — while
   holding a placeholder. The credentials check tests only that a string is non-empty. The rebuilt
   check must validate the key shape AND make a cheap authenticated call.
2. It blocks two completion criteria that cannot be satisfied any other way:
   - Master Prompt completion criterion #2: "A real conversation with an agent from the CLI".
   - Implementation Plan Stage 03 Task 2 and Stage 04 Task 2: the live streaming test.

## What is needed from the user
One working provider key, written to `~/.trent/.env` by the user (never pasted into chat, never
committed). Anthropic is the cheapest path because its streaming path always emits a usage frame
(ai-client.ts:519), so the budget assertions work without extra flags.

## What can proceed without it
Everything else. The orchestrator runs offline against `memStore` with the inline queue and the
`runtime-eval-overrides` seam, so the DAG, events, approvals, traces, doctor, fleet, config,
sessions, TUI, installer, and desktop work can all be built and tested with no key. Only the two
live-model tests stay RED until a real key exists — and they should stay RED rather than be
weakened, per coding rule 10.
