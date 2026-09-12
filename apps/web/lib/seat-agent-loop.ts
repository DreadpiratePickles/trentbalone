import type { AgentRuntime } from "@/lib/agent-runtime";
import { executeSeatModel } from "@/lib/model-gateway";
import type { Subtask } from "@/lib/planner";
import { routeToolsForStep } from "@/lib/semantic-router";
import { executeExternalActionWithGuardrails } from "@/lib/external-action-guardrails";
import { adapters as defaultAdapters, type ToolAdapter } from "@/lib/tools";
import { INTERNAL_ACTIONS, runInternalAction } from "@/lib/internal-actions";
import {
  buildAdvertisedToolSet,
  buildSeatToolContracts,
  contractsForSeat,
  type SeatToolContract,
  type ToolReadiness,
} from "@/lib/seat-tool-contracts";
import { guardSeatOutputClaims } from "@/lib/seat-output-claim-guard";
import { evaluateAutonomyGate } from "@/lib/orchestrator-autonomy-gate";
import type { AgentEnvironmentConfig, AgentRole, CompanyAutonomySettings, ToolCallRecord } from "@/lib/types";

type AutonomySeatContext = {
  settings: CompanyAutonomySettings;
  runContext?: "scheduled" | "manual" | "debug";
};

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
  /**
   * Autonomy Control Plane enforcement. When provided, connected write-capable
   * tools are gated by company mode (manual/supervised/autonomous) BEFORE they
   * run. Absent → no autonomy gating (unchanged legacy behavior).
   */
  autonomy?: AutonomySeatContext;
};

type SeatTurnOutput = {
  toolCall?: { name?: string; action?: string } | null;
  summary?: string | null;
  findings?: unknown;
  recommendations?: unknown;
  riskNotes?: unknown;
  whatIDidNotDo?: unknown;
  workRequests?: unknown;
};

const TOOL_MISUSE_DEGRADE_AFTER = 2;
const DEFAULT_TOOL_LOOP_STEPS = 6;
const EXTENDED_TOOL_LOOP_STEPS = 15;

function isFinalOutput(turn: SeatTurnOutput): boolean {
  if (turn.toolCall?.name && turn.toolCall?.action) return false;
  return typeof turn.summary === "string" && turn.summary.length > 0;
}

function sourceGroundingText(contextBundle: unknown): string {
  if (!contextBundle || typeof contextBundle !== "object") return "";
  const bundle = contextBundle as Record<string, unknown>;
  return [bundle.sourceCoverage, bundle.sourceDocuments]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
}

function hasSourceGroundingContext(contextBundle: unknown): boolean {
  const text = sourceGroundingText(contextBundle);
  return /\bAvailable:\s*(?!none of the required sources\b).+\bdoc\b/i.test(text);
}

function isRecoverableToolMisuse(record: ToolCallRecord): boolean {
  if (record.status !== "failed") return false;
  return /not allowed for this seat|requires payload|invalid payload|missing payload|required payload/i.test(record.summary);
}

function repeatedToolMisuse(toolCalls: ToolCallRecord[]): ToolCallRecord | undefined {
  const recoverable = toolCalls.filter(isRecoverableToolMisuse);
  const latest = recoverable.at(-1);
  if (!latest) return undefined;
  const signature = `${latest.adapter.toLowerCase()}::${latest.summary.toLowerCase()}`;
  const count = recoverable.filter((record) =>
    `${record.adapter.toLowerCase()}::${record.summary.toLowerCase()}` === signature,
  ).length;
  return count >= TOOL_MISUSE_DEGRADE_AFTER ? latest : undefined;
}

function sourceLabels(contextBundle: unknown): string[] {
  const text = sourceGroundingText(contextBundle);
  const labels = new Set<string>();
  for (const line of text.split("\n")) {
    const docLine = line.match(/^\s*\[[^\]]+\]\s+(.+?)\s*$/);
    if (docLine?.[1]) labels.add(docLine[1].trim());
    const coverageLine = line.match(/\bAvailable:\s*(.+)$/i);
    if (coverageLine?.[1]) labels.add(coverageLine[1].trim());
  }
  return [...labels].slice(0, 4);
}

function degradedSourceOutput(subtask: Subtask, last: ToolCallRecord): Record<string, unknown> {
  const labels = sourceLabels(subtask.contextBundle);
  const sources = labels.length ? labels.join("; ") : "the available source documents in the run context";
  return {
    summary: [
      `DEGRADED: The seat could not use ${last.adapter} because ${last.summary}`,
      `I did not claim that tool succeeded. I continued from ${sources}.`,
      `Use this step with that caveat and cite the available source documents in downstream outputs.`,
    ].join(" "),
    findings: [
      `Tool degraded: ${last.adapter} ${last.action} -> ${last.summary}`,
      `Source context available: ${sources}`,
    ],
    recommendations: [
      "Continue the orchestration from the available source context, and flag any metric or web-specific claim that still needs tool-backed verification.",
    ],
    workRequests: [],
  };
}

function resolveAdapter(
  name: string,
  allowedTools: Set<string>,
  registry: ToolAdapter[],
): ToolAdapter | undefined {
  return registry.find(
    (adapter) => isAdapterAllowed(adapter, allowedTools) && adapterMatchesNameOrScope(adapter, name),
  );
}

function isAdapterAllowed(adapter: ToolAdapter, allowedTools: Set<string>) {
  return allowedTools.has(adapter.name) || adapter.scopes.some((scope) => allowedTools.has(scope));
}

function adapterMatchesNameOrScope(adapter: ToolAdapter, name: string) {
  const normalized = name.toLowerCase();
  return adapter.name.toLowerCase() === normalized || adapter.scopes.some((scope) => scope.toLowerCase() === normalized);
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
    (adapter) => isAdapterAllowed(adapter, allowedTools) && (
      haystack.includes(adapter.name.toLowerCase())
      || adapter.scopes.some((scope) => isSpecificScopeAlias(scope) && haystack.includes(scope.toLowerCase()))
    ),
  );
}

function isSpecificScopeAlias(scope: string) {
  return scope.includes(":") || scope.length >= 8;
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

const AGENT_ROLES: AgentRole[] = ["ceo", "engineer", "growth", "content", "support", "analyst", "finance", "escalation", "sales"];

export async function runSeatAgent(input: SeatAgentInput): Promise<SeatAgentResult> {
  const maxSteps = input.maxSteps ?? defaultToolLoopSteps(input.subtask.seat);
  const approvalGranted = input.approvalGranted ?? false;
  const registry = input.adapters ?? defaultAdapters;
  const runModel = input.executeSeatModelFn ?? executeSeatModel;
  const allowedTools = new Set(
    input.subtask.toolGuidance?.length
      ? input.subtask.toolGuidance.filter((name) => input.runtime.environment.tools.includes(name))
      : input.runtime.environment.tools,
  );
  const activeEnvironment = { ...input.runtime.environment, tools: [...allowedTools] };
  const contracts = buildRuntimeSeatContracts(input.subtask.seat, activeEnvironment, registry);
  const seatContracts = contractsForSeat(contracts, input.subtask.seat);
  const availableTools = [...buildAdvertisedToolSet(contracts, input.subtask.seat)];
  const toolInstructions = buildToolInstructions(availableTools);

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
    const record = await executeNamedToolCall({
      name: pending.name,
      action: pending.action,
      companyId: input.companyId,
      seat: input.subtask.seat,
      approvalGranted: true,
      allowedTools,
      registry,
      environment: activeEnvironment,
      contracts: seatContracts,
      autonomy: input.autonomy,
    });
    if (!record) {
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
        toolInstructions,
      },
    });
    tokens += seatResult.tokens;
    costCents += seatResult.costCents;
    model = seatResult.model;
    if (seatResult.error) lastError = seatResult.error;

    const turn = normalizeTurnOutput(seatResult.output);
    if (isFinalOutput(turn)) {
      return {
        output: guardSeatOutputClaims({
          output: {
            summary: turn.summary,
            findings: turn.findings ?? [],
            recommendations: turn.recommendations ?? [],
            riskNotes: turn.riskNotes ?? [],
            whatIDidNotDo: turn.whatIDidNotDo ?? [],
            workRequests: turn.workRequests ?? [],
          },
          contracts: seatContracts,
          toolCalls,
        }).output,
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
        output: guardSeatOutputClaims({
          output: {
            summary: typeof turn.summary === "string" ? turn.summary : "Model returned an invalid tool-use turn.",
            findings: turn.findings ?? [],
            recommendations: turn.recommendations ?? [],
            riskNotes: turn.riskNotes ?? [],
            whatIDidNotDo: turn.whatIDidNotDo ?? [],
            workRequests: turn.workRequests ?? [],
          },
          contracts: seatContracts,
          toolCalls,
        }).output,
        toolCalls,
        tokens,
        costCents,
        model,
        error: lastError,
      };
    }

    const record = await executeNamedToolCall({
      name: toolCall.name,
      action: toolCall.action,
      companyId: input.companyId,
      seat: input.subtask.seat,
      approvalGranted,
      allowedTools,
      registry,
      environment: activeEnvironment,
      contracts: seatContracts,
      autonomy: input.autonomy,
    });
    if (!record) {
      toolCalls.push({
        adapter: toolCall.name,
        action: toolCall.action,
        status: "failed",
        summary: `Tool "${toolCall.name}" is not allowed for this seat.`,
      });
      const degraded = hasSourceGroundingContext(input.subtask.contextBundle)
        ? repeatedToolMisuse(toolCalls)
        : undefined;
      if (degraded) {
        return {
          output: degradedSourceOutput(input.subtask, degraded),
          toolCalls,
          tokens,
          costCents,
          model,
          error: lastError,
        };
      }
      continue;
    }

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
        name: record.adapter,
        action: toolCall.action,
      });
    }
    const degraded = hasSourceGroundingContext(input.subtask.contextBundle)
      ? repeatedToolMisuse(toolCalls)
      : undefined;
    if (degraded) {
      return {
        output: degradedSourceOutput(input.subtask, degraded),
        toolCalls,
        tokens,
        costCents,
        model,
        error: lastError,
      };
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

function buildRuntimeSeatContracts(
  seat: AgentRole,
  environment: AgentEnvironmentConfig,
  registry: ToolAdapter[],
) {
  const slotEnvironments = Object.fromEntries(
    AGENT_ROLES.map((role) => [
      role,
      role === seat
        ? environment
        : { ...environment, memoryNamespace: `${environment.memoryNamespace}:${role}`, tools: [] },
    ]),
  ) as Record<AgentRole, AgentEnvironmentConfig>;
  return buildSeatToolContracts({
    slotEnvironments,
    adapters: registry,
    internalActions: INTERNAL_ACTIONS,
    mcpToolNames: mcpToolNames(registry),
    healthByAdapter: staticHealthByAdapter(registry),
  });
}

function mcpToolNames(registry: ToolAdapter[]) {
  return new Set(
    registry
      .filter((adapter) => adapter.name.startsWith("mcp_"))
      .flatMap((adapter) => [adapter.name, ...adapter.scopes]),
  );
}

function staticHealthByAdapter(registry: ToolAdapter[]) {
  return new Map<string, ToolReadiness>(
    registry.map((adapter) => {
      if (adapter.availability === "test_only") return [adapter.name, "mocked" as const];
      if (adapter.availability === "unavailable") return [adapter.name, "unavailable" as const];
      return [adapter.name, "needs_credentials" as const];
    }),
  );
}

async function executeNamedToolCall(input: {
  name: string;
  action: string;
  companyId: string;
  seat: AgentRole;
  approvalGranted: boolean;
  allowedTools: Set<string>;
  registry: ToolAdapter[];
  environment: AgentEnvironmentConfig;
  contracts: SeatToolContract[];
  autonomy?: AutonomySeatContext;
}): Promise<ToolCallRecord | undefined> {
  const contract = contractForTool(input.contracts, input.name);

  // Autonomy Control Plane enforcement (server-side). When a company autonomy
  // posture is supplied and the action is not already approval-granted, gate the
  // tool by company mode before it runs. A non-proceed decision returns a
  // needs_approval / blocked record the existing approval + critic machinery
  // handles — the policy reason is preserved in the run evidence.
  if (input.autonomy && contract && !input.approvalGranted) {
    const gate = evaluateAutonomyGate(
      { settings: input.autonomy.settings, seat: input.seat, contract, runContext: input.autonomy.runContext },
      input.action,
    );
    if (!gate.proceed) return gate.record;
  }

  if (contract?.binding === "internal_action") {
    if (contract.approvalRequired && !input.approvalGranted) {
      return {
        adapter: contract.tool,
        action: input.action,
        status: "needs_approval",
        summary: `Internal action "${contract.tool}" requires approval before execution.`,
      };
    }
    return runInternalAction(contract.tool, input.action, {
      companyId: input.companyId,
      actor: input.seat,
      payload: { action: input.action },
    });
  }

  const adapter = resolveAdapter(input.name, input.allowedTools, input.registry);
  if (adapter) {
    return executeAdapter(adapter, input.action, input.companyId, input.approvalGranted);
  }

  if (contract?.binding === "unavailable_marker") {
    return {
      adapter: contract.tool,
      action: input.action,
      status: "failed",
      summary: `Tool "${contract.tool}" is intentionally unavailable. Connect a real provider before this seat can use it.`,
    };
  }

  if (contract) {
    return contractedToolMiss(contract, input.action);
  }

  const fallback = await fallbackToolForStep(`${input.name} ${input.action}`, input.environment, input.registry);
  return fallback ? executeAdapter(fallback, input.action, input.companyId, input.approvalGranted) : undefined;
}

function contractForTool(contracts: SeatToolContract[], name: string) {
  const normalized = name.trim().toLowerCase();
  return contracts.find((contract) => contract.tool.toLowerCase() === normalized);
}

function contractedToolMiss(contract: SeatToolContract, action: string): ToolCallRecord {
  const summary = `Contracted tool "${contract.tool}" has binding "${contract.binding ?? "orphan"}" but no executable adapter or internal action resolved.`;
  if (process.env.NODE_ENV !== "production") {
    throw new Error(summary);
  }
  return {
    adapter: contract.tool,
    action,
    status: "failed",
    summary,
  };
}

function defaultToolLoopSteps(seat: Subtask["seat"]) {
  return seat === "engineer" || seat === "analyst"
    ? EXTENDED_TOOL_LOOP_STEPS
    : DEFAULT_TOOL_LOOP_STEPS;
}

function buildToolInstructions(availableTools: string[]): string[] {
  const normalized = new Set(availableTools.map((tool) => tool.toLowerCase()));
  const instructions: string[] = [];
  if (
    normalized.has("workbench sandbox")
    || normalized.has("workbench:session")
    || normalized.has("sandbox:exec")
  ) {
    instructions.push([
      "For Workbench Sandbox code-writing work, use toolCall.name \"workbench:session\".",
      "toolCall.action must be a JSON string with keys \"kind\":\"workbench:session\", \"objective\", \"writeFiles\", and \"command\".",
      "Example action: {\"kind\":\"workbench:session\",\"objective\":\"write and test proof\",\"writeFiles\":[{\"path\":\"package.json\",\"content\":\"{\\\"scripts\\\":{\\\"test\\\":\\\"node test.js\\\"},\\\"type\\\":\\\"module\\\"}\"},{\"path\":\"test.js\",\"content\":\"console.log('ok')\\n\"}],\"command\":\"npm test\"}.",
      "Do not use natural language actions such as \"start\", \"create\", or \"run\" for workbench:session; they will be rejected.",
    ].join(" "));
  }
  return instructions;
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
