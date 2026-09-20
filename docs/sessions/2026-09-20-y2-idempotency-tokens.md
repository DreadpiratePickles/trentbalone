# 2026-09-20 — Y2: `quote` / `appointment` idempotency tokens

Governance follow-up from `2026-09-19-upgrade-round.md` ("quote / appointment idempotency tokens").
Branch `feature/trent-fleet-v2`; edits left uncommitted in the working tree.

## What changed

`SIDE_EFFECT_SCOPE_TOKENS` (`packages/trent-core/src/governance/idempotent-dispatch.ts`) gains
`quote` and `appointment` under a `[Y2]` comment, so `stripe_quote_create`,
`calendar_appointment_create` and `calendar_appointment_cancel` are keyed by the wrapper like every
other business write. The provider-side keys (Stripe `Idempotency-Key`, Square `idempotency_key`,
the Calendar client event id) stay: belt and braces for a replay that reaches the provider anyway.

Pre-check before adding the tokens: every registered tool name (`tools/tool-names.ts`
`BUILTIN_TOOLS_BY_TOOLSET`, `SOCIAL_TOOL_NAMES`, `MEDIA_TOOL_NAMES`, `BUSINESS_TOOL_NAMES`, the app
adapters `GitHub` / `Steel Browser` / `Camofox`) was grepped for `quote` and `appointment`; only the
three business writes carry either word. MCP and plugin tool names are third-party and dynamic;
over-inclusion there is the documented safe direction.

Class floor: unchanged. `classFloorOf` reads `policy-rules.ts` `tokenRule` regexes, not the
scope-token list; the registration test's floor loop (every write floored, every read not) passed
unchanged after the edit.

## Files

- `packages/trent-core/src/governance/idempotent-dispatch.ts` — the two tokens, docstring.
- `packages/trent-core/src/governance/idempotent-dispatch.test.ts` — `[Y2]` classification test;
  the three business names join the per-token-family replay loop.
- `packages/trent-core/src/tools/business/registration.test.ts` — every `WRITE_TOOLS` name is
  side-effecting; `customer_search` / `calendar_list` are not; the "rest carry provider-side"
  comment goes.
- `packages/trent-core/src/tools/business/stripe.test.ts` — the quote replay is answered from the
  store (one POST each to prices, quotes, finalize); a second test drives the bare adapter past
  the wrapper in the same step and shows the same `Idempotency-Key` on the second POST.
- `packages/trent-core/src/tools/business/calendar.test.ts` — same split for the appointment
  insert: store replay (one POST) through the wrapper; bare adapter replays into the 409 path and
  reports the same event.
- `packages/trent-core/src/tools/business/index.ts`, `types.ts` — header comments.
- `docs/business.md` ("Idempotency:" paragraph), `docs/security.md` ("The tokens.").

## Evidence

Failing first (before the token edit), `TRENT_QUEUE_FALLBACK=disabled npx vitest run` on the four
test files: 5 failed / 26 passed, exit 1. The failures were exactly the new assertions
(`isSideEffecting("business","stripe_quote_create")` false; second POST observed on the quote and
appointment replays). The two bare-adapter provider-side tests passed on both sides, as designed.

After the edit:

- `npx vitest run packages/trent-core/src/governance packages/trent-core/src/tools/business packages/trent-core/src/tools`
  — 52 files, 463 tests passed, exit 0.
- `npm run build` in `packages/trent-core` (`tsc --noEmit`) — exit 0.
- `node scripts/ci/repo-scan.mjs` — PASS, exit 0.

Note: `docs/security.md` was already 636 lines before this session (now 639); every source file
touched is under 500 lines.
