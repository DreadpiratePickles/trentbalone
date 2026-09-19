/**
 * `@trent/core/fleet-memory` — one company memory for the whole fleet. See README.md.
 */

export { DEFAULT_FLEET_MEMORY_CONFIG, resolveFleetMemoryConfig, type FleetMemoryConfig } from "./config.js";
export { lexicalEmbed, lexicalEmbedFn, scoreAgainst, fullTextScore, tokenize, cosine, cosineSimilarity, type EmbedFn } from "./lexical.js";
// [C3] hybrid recall: the lexical/vector blend, and the embedder behind the `EmbedFn` seam.
export { HYBRID_LEXICAL_WEIGHT, HYBRID_VECTOR_FLOOR, HYBRID_VECTOR_WEIGHT, blendScores, vectorCredit } from "./hybrid.js";
export {
  DEFAULT_EMBED_BATCH_SIZE,
  DEFAULT_EMBED_TIMEOUT_MS,
  EMBEDDER_ROUTES,
  MAX_EMBED_BATCH_SIZE,
  MAX_EMBED_INPUT_CHARS,
  createEmbedder,
  embedderForProfile,
  selectEmbedderProvider,
  type Embedder,
  type EmbedderConfigSource,
  type EmbedderProfileSource,
  type EmbedderProvider,
  type EmbedderProviderSetting,
  type EmbedderRoute,
  type EmbedderSelection,
  type EmbedderSettings,
} from "./embedder.js";
export {
  InMemoryFleetSource,
  freezeFleetSource,
  isDelegatedObjective,
  isDelegatedStep,
  type FleetMemorySource,
  type FleetPlaybookEntry,
  type FleetRun,
  type FleetStep,
} from "./source.js";
export { createAppFleetSource } from "./app-source.js";
export { DEFAULT_MEMORY_BLOCKS, type MemoryBlock } from "../tools/memory/index.js";
export { recallForObjective, type RecallInput, type RecallItem, type RecallKind, type RecallResult } from "./recall.js";
export { createFleetSearchAdapter, FLEET_SEARCH_ADAPTER_NAME, FLEET_SEARCH_TOOL_SCHEMAS, type FleetSearchAdapterOptions } from "./search.js";
export { listSharedSkills, renderSharedSkillsIndex, findSharedSkill, SHARED_SKILLS_HEADING, type SharedSkill, type SharedSkillTier } from "./shared-skills.js";
export {
  CHARS_PER_TOKEN,
  CONTEXT_BLOCKS,
  DEFAULT_CONTEXT_CEILING_CHARS,
  PRESSURE_WARNING_RATIO,
  TIER_ORDER,
  WORKSPACE_CONTEXT_BLOCK,
  assembleContext,
  estimateTokens,
  type AssembledContext,
  type ContextBlock,
  type ContextLimits,
  type ContextTier,
} from "./tiers.js";
export {
  createFleetMemoryHook,
  renderConversation,
  type ContextNotice,
  type ConversationTurn,
  type FleetMemoryHook,
  type FleetMemoryHookOptions,
  type FleetSeatInput,
  type RunStartedInput,
} from "./orchestrator-hook.js";
export {
  CONSOLIDATE_TRIGGER,
  MEMORY_DRAFT_AGENT,
  MEMORY_DRAFT_KIND,
  MEMORY_DRAFT_TASK_TYPE,
  applyMemoryBytes,
  consolidateMemory,
  consolidationSystemPrompt,
  consolidationUserPrompt,
  decodeMemoryDraft,
  encodeMemoryDraft,
  parseConsolidationReply,
  promoteMemoryDraft,
  readMemoryBytes,
  type ConsolidateMemoryOptions,
  type ConsolidateMemoryResult,
  type MemoryBytes,
  type MemoryDraftPayload,
  type PromoteMemoryDraftOptions,
} from "./consolidate.js";
