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
  type FleetMemoryEntry,
  type FleetMemorySource,
  type FleetPlaybookEntry,
  type FleetRun,
  type FleetStep,
} from "./source.js";
export { createAppFleetSource, type AppFleetSourceOptions } from "./app-source.js";
// [C1] app memory: the web app's own tiered company memory, read as recall candidates and
// written back through the app's own writers. See README.md, "Company memory in the app".
export {
  APP_MEMORY_SOURCES,
  DEFAULT_APP_MEMORY_BUDGETS,
  activeAppDocuments,
  buildAppMemoryEntries,
  classifyAppDocument,
  createAppMemoryReader,
  loadAppMemoryModules,
  type AppDocument,
  type AppMemoryBudgets,
  type AppMemoryModules,
  type AppMemoryReader,
  type AppMemorySourceName,
} from "./app-tiers.js";
export {
  loadAppWriteModules,
  seatEpisodeCycleId,
  semanticFactSource,
  withAppEpisodicMirror,
  writeConsolidatedFacts,
  writeSeatEpisode,
  type AppEpisodicMirrorOptions,
  type AppMemoryWriteModules,
  type AppMirrorCaller,
  type AppWriteOutcome,
} from "./app-writes.js";
// [/C1]
// [C2] the brain repository: the truth for identity, standing decisions and episodic notes.
export {
  BRAIN_DECISIONS_DIR,
  BRAIN_DIR,
  BRAIN_DOCS_DIR,
  BRAIN_MEMORY_DIR,
  BRAIN_SEATS_DIR,
  BRAIN_SKILLS_INDEX,
  BRAIN_SYSTEM_DIR,
  BRAIN_SYSTEM_FILES,
  BRAIN_SYSTEM_LIMIT_CHARS,
  brainDay,
  brainRelativePath,
  brainRoot,
  createBrain,
  decisionSlug,
  nodeBrainExec,
  resolveBrainPath,
  walkBrain,
  type Brain,
  type BrainAuthor,
  type BrainCommit,
  type BrainExec,
  type BrainExecResult,
  type BrainOptions,
  type BrainStatus,
  type BrainVersioning,
  type BrainWriteResult,
} from "./brain.js";
export { brainSystemFileFor, migrateBlocksToBrain, type MigrateBlocksResult, type MigratedBlock } from "./brain-migrate.js";
export { BRAIN_BLOCK_HEADING, BRAIN_TREE_MAX_ENTRIES, renderBrainBlock, type BrainBlockOptions } from "./brain-prompt.js";
export {
  BRAIN_DOCS_NOTE,
  brainCitation,
  brainIndexDir,
  brainVersion,
  buildBrainIndex,
  loadBrainIndex,
  recallFromBrain,
  type BrainEntryKind,
  type BrainIndex,
  type BrainIndexEntry,
  type BrainRecallInput,
  type BrainRecallItem,
  type BrainRecallResult,
} from "./brain-index.js";
// [E] `trent brain import`: documents in, chunks with citations out. See docs/brain.md.
export {
  DEFAULT_MAX_FILE_BYTES,
  collectImportFiles,
  docSlug,
  forgetBrainDoc,
  ingestDocuments,
  listBrainDocs,
  resolveDocReference,
  type BrainDocSummary,
  type ForgetResult,
  type IngestFileResult,
  type IngestOptions,
  type IngestResult,
  type IngestSkipped,
  type IngestStatus,
} from "./ingest/index.js";
export { DEFAULT_CHUNK_CHARS, DEFAULT_CHUNK_OVERLAP, chunkMarkdown, chunkUnits, locationTag, parseChunkId, type ChunkOptions, type DocumentChunk, type DocumentUnit } from "./ingest/chunk.js";
export { chunkBrainFile, chunkIdHead, pathForChunkHead, type ChunkedBrainFile } from "./ingest/brain-chunks.js";
export { SUPPORTED_EXTENSIONS, extractDocument, extractorAvailability, formatOf, type DocumentFormat, type ExtractedDocument, type ExtractorAvailability } from "./ingest/extract.js";
export { DOC_PROVENANCE, parseDocFile, renderDocFile, type DocMeta } from "./ingest/doc-file.js";
export { BRAIN_READ_ADAPTER_NAME, BRAIN_READ_MAX_CHARS, BRAIN_READ_TOOL_SCHEMAS, createBrainReadAdapter } from "../tools/memory/brain-read.js";
export { DEFAULT_MEMORY_BLOCKS, type MemoryBlock } from "../tools/memory/index.js";
export { recallForObjective, type RecallInput, type RecallItem, type RecallKind, type RecallResult } from "./recall.js";
export { createFleetSearchAdapter, FLEET_SEARCH_ADAPTER_NAME, FLEET_SEARCH_TOOL_SCHEMAS, type FleetSearchAdapterOptions } from "./search.js";
export { listSharedSkills, renderSharedSkillsIndex, findSharedSkill, SHARED_SKILLS_HEADING, type SharedSkill, type SharedSkillTier } from "./shared-skills.js";
export {
  BRAIN_BLOCK,
  BRAIN_RECALL_BLOCK,
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
