# Model gateway wrapping contract (Stage 00)

## Verdict: CLI-importable with a small shim. This unblocks anti-pattern #1.

`lib/model-gateway.ts` -> `lib/ai-client.ts` -> `lib/model-policy.ts` import ONLY `node:crypto`,
`openai`, and `zod`. No `next/*`, no Prisma, no Redis, no `server-only`, no React cache.
A CLI process can call the real streaming path directly.

## The real streaming entry points
- Route resolver: `routeWorkbenchStream(role, policy)` — model-gateway.ts:142
- Provider failover loop: `streamArtifactWithFallback` — workbench-llm-client.ts:149 (loop at :171-183)
- Per-provider generator: `streamProviderArtifact` — workbench-llm-client.ts:103
  - Anthropic: `streamAnthropicMessages` — ai-client.ts:434 (raw fetch + manual SSE parse)
  - OpenAI-compatible: `streamOpenAiCompatibleChat` — ai-client.ts:403
  - OpenAI gpt-5/codex: `streamResponsesText` — workbench-llm-client.ts:54
- Token union: `ProviderStreamToken` — ai-client.ts:390-393 (`token` | `finish` | `usage`)

## Five traps that must be handled in the wrapper
1. **Module-load env capture.** `MODELS` (ai-client.ts:22-52) and `MAX_TOKENS` (ai-client.ts:109)
   evaluate at import time. The wrapper MUST write secrets into `process.env` and THEN
   `await import()` the gateway. Current `ConfigManager.loadSecrets()` parses `.env` but never
   writes `process.env` — that is the bug to fix first.
2. **`ai-proxy/openai-compatible.ts` is canned.** `deterministicCompletion` (:93) returns
   `"Trent proxy response <sha8>"` and `normalizeChatRequest` (:27) throws on `stream: true`.
   The CLI must NEVER route through ai-proxy. A regression test should assert output does not
   match /^Trent proxy response/.
3. **Two divergent cost tables.** model-gateway.ts:97-101 vs ai-client.ts:530-534 differ by 2.5-10x.
   Pick `estimateModelCostCents` (model-gateway.ts:194) as the single source for the budget ticker
   and document the discrepancy.
4. **Usage frames are provider-dependent.** `stream_options.include_usage` is set only for
   `provider === "openai"` (ai-client.ts:411); Anthropic always yields usage (ai-client.ts:519);
   google/mistral/openrouter yield none. Either enable the flag for openrouter/mistral or mark
   the usage event `estimated: true`.
5. **No AbortSignal support upstream.** Ctrl+C interrupt must be implemented by breaking the
   `for await` loop so the generator's `return()` closes the reader.

## Other notes
- `import OpenAI from "openai"` at model-gateway.ts:2 is unused but still pulls the SDK.
  `openai` must become a dependency of `@trent/core`.
- Type-only imports reach into `@/lib/types` and `@/lib/planner` (which is Prisma-tainted).
  They are erased at runtime, but `@trent/core` must REDECLARE those types locally rather than
  re-export them, or tsc drags in the whole web graph.
- Path alias `@/lib/*` does not exist for a published package: use relative imports or add the
  alias to `packages/trent-core/tsconfig.json`.
- Cost is NOT computed on the streaming path anywhere. The wrapper synthesizes it.

## First failing test (Stage 03 Task 2)
`packages/trent-core/src/model-gateway/ModelGateway.live.test.ts`, skipIf(!ANTHROPIC_API_KEY):
stream "Reply with exactly: PONG-7423" and assert (a) more than one token frame, (b) output
contains the sentinel, (c) output does NOT match /^Trent proxy response/, (d) usage.outputTokens > 0.
Today it fails to compile because the directory does not exist. That is our RED.
