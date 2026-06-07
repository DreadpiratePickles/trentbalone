import type { AgentRuntime } from "@/lib/agent-runtime";
import { executeSeatModel } from "@/lib/model-gateway";
import type { Subtask } from "@/lib/planner";
import { routeToolsForStep } from "@/lib/semantic-router";
import { executeExternalActionWithGuardrails } from "@/lib/external-action-guardrails";
import { adapters as defaultAdapters, type ToolAdapter } from "@/lib/tools";
import type { AgentEnvironmentConfig, ToolCallRecord } from "@/lib/types";

export type SeatLoopPendingToolCall = {
  name: string;
  action: string;
};

/** Persisted state so a mid-loop approval can resume without re-running completed tools. */
export type SeatLoopResumeSeed = {
  toolCalls: ToolCallRecord[];
  loopStep: number;
  tokens: number;
  costCents: number;
  model: string;
  pendingToolCall: SeatLoopPendingToolCall;
};

export type SeatAgentResult = {
  output: Record<string, unknown> | null;
  toolCalls: ToolCallRecord[];
  tokens: number;
  costCents: number;
  model: string;
  error?: string;
  pausedForApproval?: boolean;
  maxStepsReached?: boolean;
  pendingToolCall?: SeatLoopPendingToolCall;
  loopStep?: number;
};

export type SeatAgentInput = {
  companyId: string;
  runtime: AgentRuntime;
  subtask: Subtask;
  systemPrompt: string;
  dynamicPrompt?: string;
  maxSteps?: number;
  approvalGranted?: boolean;
  /** Prior tool history + pending call when resuming after durable approval. */
  resumeSeed?: SeatLoopResumeSeed;
  /** Injectable for tests; defaults to the global adapter registry. */
  adapters?: ToolAdapter[];
  executeSeatModelFn?: typeof executeSeatModel;
};

type SeatTurnOutput = {
  toolCall?: { name?: string; action?: string } | null;
  summary?: string | null;
  findings?: unknown;
  recommendations?: unknown;
  workRequests?: unknown;
};

function isFinalOutput(turn: SeatTurnOutput): boolean {
  if (turn.toolCall?.name && turn.toolCall?.action) return false;
  return typeof turn.summary === "string" && turn.summary.length > 0;
}

function resolveAdapter(
  name: string,
  allowedTools: Set<string>,
  registry: ToolAdapter[],
): ToolAdapter | undefined {
  return registry.find(
    (adapter) => allowedTools.has(adapter.name) && adapter.name.toLowerCase() === name.toLowerCase(),
  );
}

/** Fallback when the model names a tool ambiguously — uses semantic router with regex fallback. */
async function fallbackToolForStep(
  stepText: string,
  environment: Pick<AgentEnvironmentConfig, "tools">,
  registry: ToolAdapter[],
): Promise<ToolAdapter | undefined> {
  const ranked = await routeToolsForStep(stepText, environment, 1);
  if (ranked[0]) return ranked[0];
  const allowedTools = new Set(environment.tools);
  const haystack = stepText.toLowerCase();
  return registry.find(
    (adapter) => allowedTools.has(adapter.name) && haystack.includes(adapter.name.toLowerCase()),
  );
}

function maxStepsFallback(toolCalls: ToolCallRecord[]): Record<string, unknown> {
  const last = toolCalls.at(-1);
  const hint = last ? ` Last tool (${last.adapter}): ${last.summary}` : "";
  return {
    summary: `Stopped after max tool-use steps.${hint}`,
    findings: [],
    recommendations: [],
    workRequests: [],
  };
}

export async function runSeatAgent(input: SeatAgentInput): Promise<SeatAgentResult> {
  const maxSteps = input.maxSteps ?? 6;
  const approvalGranted = input.approvalGranted ?? false;
  const registry = input.adapters ?? defaultAdapters;
  const runModel = input.executeSeatModelFn ?? executeSeatModel;
  const allowedTools = new Set(
    input.subtask.toolGuidance?.length
      ? input.subtask.toolGuidance.filter((name) => input.runtime.environment.tools.includes(name))
      : input.runtime.environment.tools,
  );
  const availableTools = registry
    .filter((adapter) => allowedTools.has(adapter.name))
    .map((adapter) => adapter.name);

  const seed = input.resumeSeed;
  const toolCalls: ToolCallRecord[] = seed
    ? seed.toolCalls.filter((record) => record.status !== "needs_approval")
    : [];
  let tokens = seed?.tokens ?? 0;
  let costCents = seed?.costCents ?? 0;
  let model = seed?.model ?? "unknown";
  let lastError: string | undefined;
  let startStep = 1;

  if (seed && approvalGranted && seed.pendingToolCall) {
    const pending = seed.pendingToolCall;
    let adapter = resolveAdapter(pending.name, allowedTools, registry);
    if (!adapter) {
      adapter = await fallbackToolForStep(`${pending.name} ${pending.action}`, input.runtime.environment, registry);
    }
    if (!adapter) {
      toolCalls.push({
        adapter: pending.name,
        action: pending.action,
        status: "failed",
        summary: `Tool "${pending.name}" is not allowed for this seat.`,
      });
      return {
        output: {
          summary: `Approved tool "${pending.name}" is not allowed for this seat.`,
          findings: [],
          recommendations: [],
          workRequests: [],
        },
        toolCalls,
        tokens,
        costCents,
        model,
        error: `Tool "${pending.name}" is not allowed for this seat.`,
      };
    }
    const record = await executeAdapter(adapter, pending.action, input.companyId, true);
    toolCalls.push(record);
    if (record.status === "blocked") {
      return {
        output: { summary: record.summary, findings: [], recommendations: [], workRequests: [] },
        toolCalls,
        tokens,
        costCents,
        model,
        error: record.summary,
      };
    }
    startStep = seed.loopStep + 1;
  }

  for (let step = startStep; step <= maxSteps; step += 1) {
    const seatResult = await runModel({
      companyId: input.companyId,
      subtask: input.subtask,
      systemPrompt: input.systemPrompt,
      dynamicPrompt: input.dynamicPrompt,
      toolLoopContext: {
        step,
        maxSteps,
        toolHistory: toolCalls.map((result) => ({
          adapter: result.adapter,
          action: result.action,
          result,
        })),
        availableTools,
      },
    });
    tokens += seatResult.tokens;
    costCents += seatResult.costCents;
    model = seatResult.model;
    if (seatResult.error) lastError = seatResult.error;

    const turn = normalizeTurnOutput(seatResult.output);
    if (isFinalOutput(turn)) {
      return {
        output: {
          summary: turn.summary,
          findings: turn.findings ?? [],
          recommendations: turn.recommendations ?? [],
          workRequests: turn.workRequests ?? [],
        },
        toolCalls,
        tokens,
        costCents,
        model,
        error: lastError,
      };
    }

    const toolCall = turn.toolCall;
    if (!toolCall?.name || !toolCall?.action) {
      const fallback = await fallbackToolForStep(input.subtask.objective, input.runtime.environment, registry);
      if (fallback && step === 1) {
        const record = await executeAdapter(fallback, input.subtask.objective, input.companyId, approvalGranted);
        toolCalls.push(record);
        if (record.status === "blocked") {
          return {
            output: { summary: record.summary, findings: [], recommendations: [], workRequests: [] },
            toolCalls,
            tokens,
            costCents,
            model,
            error: record.summary,
          };
        }
        if (record.status === "needs_approval" && !approvalGranted) {
          return pauseForApproval(toolCalls, tokens, costCents, model, lastError, step, {
            name: fallback.name,
            action: input.subtask.objective,
          });
        }
        continue;
      }
      return {
        output: {
          summary: typeof turn.summary === "string" ? turn.summary : "Model returned an invalid tool-use turn.",
          findings: turn.findings ?? [],
          recommendations: turn.recommendations ?? [],
          workRequests: turn.workRequests ?? [],
        },
        toolCalls,
        tokens,
        costCents,
        model,
        error: lastError,
      };
    }

    let adapter = resolveAdapter(toolCall.name, allowedTools, registry);
    if (!adapter) {
      adapter = await fallbackToolForStep(`${toolCall.name} ${toolCall.action}`, input.runtime.environment, registry);
    }
    if (!adapter) {
      toolCalls.push({
        adapter: toolCall.name,
        action: toolCall.action,
        status: "failed",
        summary: `Tool "${toolCall.name}" is not allowed for this seat.`,
      });
      continue;
    }

    const record = await executeAdapter(adapter, toolCall.action, input.companyId, approvalGranted);
    toolCalls.push(record);
    if (record.status === "blocked") {
      return {
        output: {
          summary: record.summary,
          findings: [],
          recommendations: [],
          workRequests: [],
        },
        toolCalls,
        tokens,
        costCents,
        model,
        error: record.summary,
      };
    }
    if (record.status === "needs_approval" && !approvalGranted) {
      return pauseForApproval(toolCalls, tokens, costCents, model, lastError, step, {
        name: adapter.name,
        action: toolCall.action,
      });
    }
  }

  return {
    output: maxStepsFallback(toolCalls),
    toolCalls,
    tokens,
    costCents,
    model,
    error: lastError,
    maxStepsReached: true,
  };
}

function normalizeTurnOutput(output: unknown): SeatTurnOutput {
  if (!output || typeof output !== "object") return {};
  return output as SeatTurnOutput;
}

async function executeAdapter(
  adapter: ToolAdapter,
  action: string,
  companyId: string,
  approvalGranted: boolean,
): Promise<ToolCallRecord> {
  return executeExternalActionWithGuardrails({
    adapter,
    action,
    payload: { companyId },
    approvalGranted,
  });
}

function pauseForApproval(
  toolCalls: ToolCallRecord[],
  tokens: number,
  costCents: number,
  model: string,
  error: string | undefined,
  loopStep: number,
  pendingToolCall: SeatLoopPendingToolCall,
): SeatAgentResult {
  return {
    output: null,
    toolCalls,
    tokens,
    costCents,
    model,
    error,
    pausedForApproval: true,
    loopStep,
    pendingToolCall,
  };
}
