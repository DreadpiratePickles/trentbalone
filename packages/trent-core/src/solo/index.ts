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
