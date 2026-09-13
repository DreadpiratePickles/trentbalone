/**
 * The port `delegate_task` hands work to. Trent's delegation already exists: the orchestrator
 * spawns `[delegated]` child steps (`orchestrator/index.ts`, `fleet-memory/README.md`), and
 * this interface is how that path is injected into the tool without the tool knowing the loop.
 * The orchestrator side binds an implementation; the tool never runs an agent itself.
 */
import type { ToolCallRecord } from "../types.js";

export interface DelegateRequest {
  /** What the child must accomplish; self-contained, it sees none of the parent's conversation. */
  readonly task: string;
  /** A Trent agent id (one of the 164 specialists). Omitted: the orchestrator routes. */
  readonly agent?: string;
  /** Background the child needs: paths, errors, constraints. */
  readonly context?: string;
}

export interface DelegateResult {
  readonly status: "completed" | "failed" | "blocked";
  /** The child's final answer, already within its own summary cap. */
  readonly output: string;
  readonly agent?: string;
  readonly runId?: string;
  /**
   * The child's tool calls with their statuses exactly as recorded. A delegated child's memory
   * write arrives here as `blocked` and is surfaced unchanged so the parent knows to write it.
   */
  readonly toolCalls?: readonly ToolCallRecord[];
}

export interface DelegatePort {
  delegate(request: DelegateRequest): Promise<DelegateResult>;
}
