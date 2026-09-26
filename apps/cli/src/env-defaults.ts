/**
 * Environment defaults the `trent` entry applies before any other module is evaluated.
 *
 * `apps/cli/src/index.ts` imports this module FIRST. ES modules evaluate their static imports in
 * order, depth first, so this body runs before any module that could read the variable, including
 * one that reads it at load time. Today `apps/web/lib/queue.ts` reads it at call time, and every run
 * surface also applies `applyStandaloneEnv()` in-process; the default here is what makes
 * `trent doctor` agree without the user exporting anything.
 *
 * Without `TRENT_QUEUE_FALLBACK=disabled` the wrapped app's inline queue fallback races the CLI's
 * own drain loop and every job executes twice (`packages/trent-core/src/runtime/env.ts`). An empty
 * value enables that fallback exactly as an unset one does, so both get the default. Any other value
 * is the user's and is left alone, so `trent doctor` still reports it.
 *
 * [L0-1] The profile's model NAMES, for the same reason (local-path audit 2026-09-26, G1/G5/G14):
 * `apps/web/lib/ai-client.ts` builds `MODELS` from `OPENAI_MODEL_*` / `ANTHROPIC_MODEL_*` when it is
 * first evaluated, and the CLI's static graph evaluates it at start (`commands -> improve ->
 * gepa/index.ts -> apps/web/lib/gepa.ts`). Unless the names are in the environment before that,
 * every seat and the consolidator ask for the app's defaults (`gpt-5.2`, `gpt-4.1-mini`) whatever the
 * profile says, and the ledger records those names. The only import below is app-free by
 * construction (`env-defaults.test.ts` walks its static graph), reads just `provider`, `model` and
 * `models` from the active profile's `config.yaml`, keeps every `OPENAI_MODEL_*` the operator
 * exported, forces a `trent run --model` pin, and never throws: a broken config is the command's to report.
 */

import { applyProfileModelEnv } from "@trent/core/orchestrator/model-env-early.js";

if (!process.env.TRENT_QUEUE_FALLBACK) process.env.TRENT_QUEUE_FALLBACK = "disabled";

applyProfileModelEnv({ argv: process.argv.slice(2), env: process.env }); // [L0-1]

export {};
