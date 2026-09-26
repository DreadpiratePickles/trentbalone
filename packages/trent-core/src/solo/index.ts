/**
 * [S1] Solo mode: one agent, one conversation, one tool loop, behind the `AgentRunner` port.
 * 02_plan/output/solo-harness-design-2026-09-26.md. S2 wires the surfaces to `createSoloRunner`.
 */
export { createSoloRunner } from "./runner.js";
export { createRunLedgerMeter, type RunLedgerMeterOptions } from "./meter.js";
export { SoloEvents, modelFailureVerdict, stopVerdict, type SoloEvent, type SoloStep, type SoloStepFrame, type StepUsage } from "./events.js";
export { parseReply, resolveAdapter, toolNamesOf, TOOL_CALL_CLOSE, TOOL_CALL_OPEN, type ParsedReply, type SoloAction } from "./parse.js";
export {
  DEFAULT_SOLO_PERSONA,
  SOLO_PERSONA_FILE,
  SOLO_TOOL_PROTOCOL,
  assembleTurnContext,
  buildSystemPrompt,
  historyMessages,
  readSoloPersona,
  renderToolDisclosure,
  renderToolResult,
  soloPersonaPath,
} from "./prompt.js";
export { repairPrompt, type TurnEnd } from "./turn.js";
export {
  DEFAULT_SOLO_MAX_TOOL_CALLS,
  SOLO_MISUSE_REPEATS,
  SOLO_SEAT,
  type SoloCheckpoints,
  type SoloConfig,
  type SoloGateway,
  type SoloMemory,
  type SoloMemoryRequest,
  type SoloMemoryTiers,
  type SoloMessage,
  type SoloMessageRole,
  type SoloMeter,
  type SoloModelCall,
  type SoloParkedCall,
  type SoloRunner,
  type SoloRunnerDeps,
  type SoloSession,
  type SoloTools,
} from "./types.js";
// [S3] continuity: compaction, memory writes behind the provenance gate, skills on demand, delegation.
export { DEFAULT_SOLO_COMPACT_AFTER_CHARS, SOLO_SUMMARY_HEADINGS, SOLO_SUMMARY_PROMPT, compactConversation, createSoloCompactor, describeCompaction, pruneToolResults, soloCompactionLimits, type SoloCompactionOutcome, type SoloCompactionSettings } from "./compaction.js";
export { gatedMemoryAdapters, type MemoryGateOptions } from "./memory-gate.js";
export { INVOKED_SKILLS_BLOCK, SKILLS_INDEX_BLOCK, invokedSkillOf, invokedSkillsBlock, profileSoloSkills, skillsIndexBlock, type SoloSkills } from "./skills.js";
export { DEFAULT_SOLO_MAX_DELEGATION_DEPTH, SOLO_DELEGATE_MODES, childAdapters, childObjective, createSoloDelegation, seededState, soloChildFactory, type SoloChild, type SoloChildConversation, type SoloChildSpec, type SoloDelegateMode, type SoloDelegation } from "./delegate.js";
export { bindSoloDelegation, isTainted, mergeSessionTaint, sliceMeter } from "./delegate-route.js";
