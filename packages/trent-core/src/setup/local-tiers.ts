/**
 * [L0-3] Which local model a machine should run, and what to expect of it.
 *
 * The tiers, the tags and the expectations come from 01_discovery/output/local-models-2026-09-26.md
 * section 6 (minimum viable local stack by hardware tier), read 2026-09-26. The Ollama tags were read
 * from https://ollama.com/library/qwen3.5/tags and /library/qwen3.6/tags the same day:
 *   `qwen3.5:9b`       Q4_K_M, 6.6 GB  (digest 6488c96fa5fa)  16 GB tier
 *   `qwen3.6:27b`      Q4_K_M, 18 GB   (digest 9d5803d493a9)  32 GB tier (a documented tool parser,
 *                                      `qwen3_coder`; Qwen3.8-27B's card names none)
 *   `qwen3.6:35b-a3b`  Q4_K_M, 23 GB   (digest 096fdbd02fe6)  64 GB tier (3B active per token)
 *
 * The old default, `llama3.2`, is not among them: Berkeley's leaderboard scores Llama-3.2-3B at
 * 21.95% overall and 4% multi-turn (section 2.2), the weakest defensible choice for an agent loop.
 *
 * Every expectation is three sentences, printed by setup and stated in docs/getting-started.md
 * ("Local models"); `local-setup.test.ts` fails when the page and this table drift apart.
 */

import type { Provider } from "../config/schema.js";

export type MemoryTierId = "16gb" | "32gb" | "64gb";

export interface LocalTier {
  readonly id: MemoryTierId;
  /** The memory the tier is sized for, as a person says it. */
  readonly memory: string;
  /** The Ollama tag, exactly as `ollama pull` takes it. */
  readonly ollama: string;
  /** What an LM Studio model id contains for this model (ids vary by publisher: `qwen/qwen3.5-9b`). */
  readonly lmstudio: string;
  /** Ollama's download size for the tag. */
  readonly download: string;
  /** The honest expectation, three sentences. */
  readonly expectation: string;
}

const GIB = 1024 ** 3;

export const LOCAL_TIERS: readonly LocalTier[] = [
  {
    id: "16gb",
    memory: "16 GB",
    ollama: "qwen3.5:9b",
    lmstudio: "qwen3.5-9b",
    download: "6.6 GB",
    expectation:
      "Single tool calls mostly work at 9B. Multi-step plans are unreliable and chains of three or more tool calls fail often, so keep each objective short and explicit. Every cold prompt pays for prefill first, so expect tens of seconds before the first token on a Mac.",
  },
  {
    id: "32gb",
    memory: "32 GB",
    ollama: "qwen3.6:27b",
    lmstudio: "qwen3.6-27b",
    download: "18 GB",
    expectation:
      "Tool calls work well on short chains at 27B. Planning is adequate for bounded, well-specified tasks but below hosted frontier models. Every cold prompt pays for prefill first, and a dense 27B on a Mac can spend a minute or more on one long seat prompt.",
  },
  {
    id: "64gb",
    memory: "64 GB",
    ollama: "qwen3.6:35b-a3b",
    lmstudio: "qwen3.6-35b-a3b",
    download: "23 GB",
    expectation:
      "Tool calls work well on short chains with this 35B mixture-of-experts model. Planning is adequate for bounded, well-specified tasks but below hosted frontier models. Only 3B parameters are active per token, so prefill is faster than a dense 27B, but a cold long prompt still costs seconds to tens of seconds.",
  },
];

function tier(id: MemoryTierId): LocalTier {
  return LOCAL_TIERS.find((t) => t.id === id) as LocalTier;
}

/**
 * The tier a machine's memory buys. The brief's boundaries: 32 GB and up runs a 27B, 64 GB and up
 * the 35B-A3B; anything below 32 GB (a 16 or 24 GB Mac) stays on the 9B, because a 27B at Q4 is an
 * 18 GB download before the KV cache and a Mac does not give the GPU all of its unified memory.
 * The thresholds sit a little under the nominal size so a machine reporting 31.9 GiB is not demoted.
 */
export function tierForMemory(totalBytes: number): LocalTier {
  const gib = totalBytes / GIB;
  if (gib >= 60) return tier("64gb");
  if (gib >= 30) return tier("32gb");
  return tier("16gb");
}

/** The model id setup proposes for a local provider on a machine with `totalBytes` of memory. */
export function recommendedLocalModel(provider: Provider, totalBytes: number): string {
  const chosen = tierForMemory(totalBytes);
  return provider === "lmstudio" ? chosen.lmstudio : chosen.ollama;
}

function normalise(id: string): string {
  return id.trim().toLowerCase().replace(/:latest$/, "");
}

/** The tier whose model `model` is (a quantisation suffix such as `-q4_K_M` still matches). */
export function tierForModel(model: string): LocalTier | undefined {
  const id = normalise(model);
  return LOCAL_TIERS.find((t) => id.startsWith(t.ollama) || id.replace(/[^a-z0-9.]+/g, "-").includes(t.lmstudio));
}

/** Memory in whole gigabytes as a person reads it off the box (32 GiB prints as 32). */
export function memoryGigabytes(totalBytes: number): number {
  return Math.round(totalBytes / GIB);
}
