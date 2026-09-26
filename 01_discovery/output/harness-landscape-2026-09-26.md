# Harness landscape: where Trent stands, precisely (2026-09-26)

Synthesis over harness-openai, harness-anthropic, harness-others, local-models, the Trent local-path
audit and harness-matrix (all 2026-09-26, primary sources with URLs), on HEAD 412f5b0.

## The one-paragraph answer
Against OpenAI's Codex and Agents API, Anthropic's Claude Code and Managed Agents, Perplexity
Computer, the best of the field (Goose, OpenClaw, OpenHands, Cline, Cursor, Devin, Manus, Amp) and
Hermes Agent, Trent is at parity on 14 of 56 capability areas, ahead of all of them on 6 (bound
approvals with idempotency, a signed hash-chained audit with rules over tool sequences, nine role
seats with per-seat budgets and eval suites, human-promoted self-improvement judged on a held-out
split, one spend ledger with true prices, a local clip studio, and two-way agent portability),
partial on 24 and missing on 9. The two gaps a user hits first are that nothing is installable
(no tag has ever been pushed) and that local models do not work (the audit ran it: seats are sent
cloud model names, a 60 s timeout, and a leak of a "mistral"-named model to Mistral's API).

## The ten gaps, ranked by who notices, and what happens to each
| # | Gap | Best in field | What Trent does about it |
|---|---|---|---|
| 1 | Nothing installable: 0 tags | Claude Code (one line, auto-update) | Bobby: tag v1.0.0; the workflows and key are ready (499cd14) |
| 2 | Local models break | Goose (llama.cpp built in), Hermes (managed llama.cpp) | Wave L0 in flight (routing, timeouts, setup, doctor, embeddings), then L1 (constrained output, repair, prompt budget, escalation with approval), L2 (`setup --mode local`) |
| 3 | No free way to start | Codex free plan, Gemini CLI free tier, Hermes OAuth logins | Local models ARE the free tier; a subscription login through another vendor's OAuth is not ours to build |
| 4 | Nothing runs with the laptop closed | Claude Routines/Cowork, Perplexity Computer (cloud) | `trent service` runs at login and restarts (a23efa5); a hosted runner is a product decision for Bobby |
| 5 | 8 chat platforms, no personal WhatsApp/iMessage | OpenClaw 20+, Hermes ~30 | Wave H4: Matrix, Mattermost, LINE, ntfy (clean APIs); personal WhatsApp/iMessage are ToS-risky, not now |
| 6 | No inbound SMS, no spoken replies | Hermes (Twilio in, 10 TTS backends) | Inbound SMS stays out (Bobby's decision); local TTS (piper/kokoro) is a later item |
| 7 | No OAuth 2.1 for MCP connectors | Perplexity 400+ connectors, Hermes OAuth 2.1 | Wave H2 |
| 8 | Events cannot start the agent | Cursor Projects, Claude Routines API triggers, Hermes webhook routes | Wave H3: signed webhook routes that start a run (the upgrade design called this a later decision; Bobby's "apply it" is that decision) |
| 9 | Browser cannot act in the owner's logged-in accounts | Claude in Chrome, Manus Browser Operator | Wave H5: attach the browser toolset to the owner's Chrome over CDP, behind the gate |
| 10 | Every approval reaches the human | Claude auto-mode classifier, Codex auto-review | Wave H1: a reviewer model (local or hosted) that decides held calls inside a written policy, default off, every decision logged and reversible |

## The base harness (solo mode)
The matrix's "agent shape" row is the other thing people ask for: one agent, one conversation, a
tool loop, memory and skills, on every surface. The design is in 02_plan/output/solo-harness-
design-2026-09-26.md: a second runner behind the AgentRunner port; waves S1-S4.

## Where Trent stays ahead, in the words the README can keep
Bound approvals that ask at every autonomy level and never send twice; a signed audit anyone can
verify offline; nine seats with cents budgets; self-improvement a human promotes; one ledger at
list price; a clip studio that runs on the laptop; agents that export to Claude Code, Codex and
Hermes and import theirs.

## What the field does that we adopt on the way
Perplexity's on-device pattern (compact core prompt, connectors as small CLI tools, skills on
demand, escalation to a frontier model only with approval after a privacy preview) shapes L1 and
solo mode. Codex's and Claude's credential masking is already Trent's egress broker; the
`x-trent-own-credential` header (dec2a54, ccd9430) closed the one hole. Claude's compaction that
re-injects instructions, memory and the plan is the rule for solo compaction (S3). Codex's
Programmatic Tool Calling and Claude's dynamic workflows are noted, not scheduled.

## Order of work from here
L0 (in flight) -> S1 + design review -> S2/S3 -> L1 -> S4 -> H1, H2, H3 -> L2 -> H4, H5.
Bobby's steps stay: tag, default branch, rename, topics, vulnerability reporting, platform apps.
