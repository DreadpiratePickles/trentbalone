/**
 * `delegation`: Hermes's `delegate_task` as an ALIAS over Trent's existing delegation path.
 * No agent loop lives here. The tool validates Hermes's `tasks[{goal, context}]` shape (and the
 * legacy top-level `goal`/`context` form Hermes still accepts), hands each task to the injected
 * `DelegatePort` as `{task, agent?, context?}`, and returns the child's result with every tool
 * call status untouched — a delegated child's `blocked` memory write stays `blocked`.
 *
 * Without a port the tool says `not_available`; it never fabricates a child result.
 */
import { parseAction, record as toRecord, type ToolSpec } from "../action.js";
import { fitSummary } from "../spillover.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import type { DelegatePort, DelegateRequest, DelegateResult } from "./types.js";

export type { DelegatePort, DelegateRequest, DelegateResult } from "./types.js";

export const DELEGATE_ADAPTER_NAME = "delegation";
export const DELEGATE_SCOPES = ["delegation", "delegate_task"];
/** The orchestrator runs at most six delegated steps per run (`orchestrator/index.ts:70`). */
export const DELEGATE_MAX_TASKS = 6;
const SPECS: readonly ToolSpec[] = [{ name: "delegate_task", primary: "goal", signature: ["tasks"] }];
const ROUTING_TEXT =
  "delegate a subtask to another agent, spawn a subagent, hand off work, ask a specialist, " +
  "parallel research, split the job, have the engineer or analyst do part of this";

/**
 * Hermes `DELEGATE_TASK_SCHEMA` (`tools/delegate_tool.py:598-660`): `tasks[{goal, context,
 * output_schema, group}]` plus `action`/`subagent_id`/`message` for live control. Trent's port
 * has no steer/stop control plane and no schema validator, so only goal/context are advertised;
 * `agent` is a Trent extension naming one of the fleet's specialists.
 */
export const DELEGATE_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "delegate_task",
    description:
      "Spawn one or more subagents in isolated contexts through the orchestrator's delegation path. " +
      "Each child sees only its own goal and context, has read-only shared memory (its memory writes " +
      "come back as blocked for you to make), and returns a single result. Use it for self-contained " +
      `work that can run apart from your conversation. At most ${DELEGATE_MAX_TASKS} tasks per call.`,
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              goal: { type: "string", description: "What this subagent should accomplish. Be specific and self-contained; it knows nothing about your conversation." },
              context: { type: "string", description: "Background THIS child needs: file paths, error messages, constraints. Repeat shared background in every task that needs it." },
              agent: { type: "string", description: "Optional Trent agent id to run the task (e.g. eng-ai-engineer). Omit to let the orchestrator route." },
            },
            required: ["goal"],
          },
          description: "The subtasks to delegate; each becomes one child step.",
        },
      },
      required: ["tasks"],
    },
  },
];

export interface DelegateAdapterOptions {
  readonly profileDir: string;
  /** Bound by the orchestrator wiring. Absent in a bare seat: every call reports `not_available`. */
  readonly port?: DelegatePort;
}

function toRequests(args: Record<string, unknown>): DelegateRequest[] | string {
  const raw: unknown[] = Array.isArray(args.tasks) ? args.tasks : "goal" in args ? [args] : [];
  if (!raw.length) return 'delegate_task needs {"tasks":[{"goal":"..."}]}.';
  if (raw.length > DELEGATE_MAX_TASKS) return `delegate_task accepts at most ${DELEGATE_MAX_TASKS} tasks per call; got ${raw.length}.`;
  const requests: DelegateRequest[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") return `tasks[${i}] must be an object with a string goal.`;
    const { goal, context, agent } = item as Record<string, unknown>;
    if (typeof goal !== "string" || !goal.trim()) return `tasks[${i}].goal must be a non-empty string.`;
    requests.push({
      task: goal,
      ...(typeof context === "string" && context.trim() ? { context } : {}),
      ...(typeof agent === "string" && agent.trim() ? { agent } : {}),
    });
  }
  return requests;
}

function renderResult(index: number, request: DelegateRequest, result: DelegateResult): string {
  const head = `## Task ${index + 1}: ${request.task.slice(0, 120)}${request.task.length > 120 ? "..." : ""}`;
  const meta = [result.agent ?? request.agent, result.runId].filter(Boolean).join(", ");
  const calls = (result.toolCalls ?? []).map((c) => `- ${c.adapter} ${c.status}: ${c.summary.split("\n")[0]}`);
  return [
    `${head}${meta ? ` (${meta})` : ""}`,
    `status: ${result.status}`,
    result.output.trim() || "(no output)",
    ...(calls.length ? ["Child tool calls (statuses as recorded):", ...calls] : []),
  ].join("\n");
}

function overall(results: readonly DelegateResult[]): ToolCallRecord["status"] {
  if (results.some((r) => r.status === "blocked")) return "blocked";
  if (results.some((r) => r.status === "failed")) return "failed";
  return "completed";
}

export function createDelegateAdapter(options: DelegateAdapterOptions): TrentToolAdapter {
  const record = (action: string, status: ToolCallRecord["status"], summary: string) =>
    toRecord(DELEGATE_ADAPTER_NAME, action, status, fitSummary(summary, options.profileDir, "delegate_task"));

  return {
    name: DELEGATE_ADAPTER_NAME,
    scopes: [...DELEGATE_SCOPES],
    availability: options.port ? "real" : "unavailable",
    instructions: renderToolInstructions(DELEGATE_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => (options.port ? "connected" : "needs_credentials"),
    estimateCost: () => 0,
    requiresApproval: () => false,
    async execute(action) {
      const { args, error } = parseAction(action, SPECS);
      if (error) return record(action, "failed", error);
      const requests = toRequests(args);
      if (typeof requests === "string") return record(action, "failed", requests);
      const port = options.port;
      if (!port) {
        return record(action, "failed", "delegate_task not_available: no delegation port is bound to this seat, so nothing was delegated. Do the work yourself or report that delegation is off.");
      }
      try {
        const results = await Promise.all(requests.map((request) => port.delegate(request)));
        const body = results.map((result, i) => renderResult(i, requests[i]!, result)).join("\n\n");
        return record(action, overall(results), body);
      } catch (err) {
        return record(action, "failed", `delegate_task failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    async dryRun(action) {
      return record(action, "mocked", `delegate_task dry-run: would delegate "${action.slice(0, 200)}".`);
    },
    async cleanup() {},
  };
}
