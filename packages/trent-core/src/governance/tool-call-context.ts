/**
 * Which run and step a tool call belongs to. The app's seat loop hands an adapter only
 * `(action, { companyId })` (`seat-agent-loop.ts` executeAdapter), so the ids cannot travel in
 * the call; instead the orchestrator's drain loop enters this context around each
 * `orchestration_step` job and the idempotent dispatch wrapper reads it back. A delegated child
 * step runs inside its parent's job, so its calls are keyed under the parent's step.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolCallContext {
  readonly runId: string;
  readonly stepId: string;
}

const storage = new AsyncLocalStorage<ToolCallContext>();

export function runWithToolCallContext<T>(context: ToolCallContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/** Undefined outside a seat turn: a direct call from the REPL or a test has no run/step to key on. */
export function currentToolCallContext(): ToolCallContext | undefined {
  return storage.getStore();
}
