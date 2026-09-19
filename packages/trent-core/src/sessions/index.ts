// `dollarsToCents` / `centsToDollars` are deliberately NOT re-exported here: `setup/money.ts`
// exports the same names with different semantics (it throws, and floors at one cent). Import
// them from `./schema.js` directly.
export {
  SESSION_SCHEMA_VERSION,
  migrateSessionRecord,
  needsMigration,
} from "./schema.js";
export type {
  SessionData,
  SessionMessage,
  SessionMessageMetadata,
  SessionStatus,
} from "./schema.js";
export * from "./SessionStore.js";
// A3: full-text search over the transcripts (`trent sessions search`, the `session_search` tool).
export {
  searchSessions,
  snippetAround,
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MAX_LIMIT,
  type SessionSearchBackend,
  type SessionSearchHit,
  type SessionSearchOptions,
  type SessionSearchResult,
} from "./search.js";
export * from "./SessionManager.js";
export {
  COMPACTION_CONTENT_PREFIX,
  COMPACTION_SUMMARY_ROLE,
  DEFAULT_FLUSH_BLOCK,
  MIN_KEPT_MESSAGES,
  compactSession,
  createMemoryFlush,
  isCompactionEvent,
  planCompaction,
  shouldCompact,
  transcriptChars,
  type CompactionInput,
  type CompactionLimits,
  type CompactionOutcome,
  type CompactionPlan,
  type CompactionRecord,
  type FlushGateway,
  type MemoryFlushOptions,
  type MemoryFlushReport,
  type MemoryWritePort,
} from "./compaction.js";
