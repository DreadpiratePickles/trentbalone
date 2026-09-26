/**
 * [S3] The solo child path of `delegate_task` (item 4; council A11).
 *
 * The adapter is built once per tool build, bound to the orchestrator's port, before any runner
 * exists; the orchestrator's port only knows fleet runs, so from a solo run it answered that no
 * orchestration run was active. A solo run instead registers, for its own run id and only while it
 * drives, the route its calls delegate through: a child solo run, a child fleet run, or a refusal
 * (`solo/delegate-route.ts`). The adapter asks the route of the run the CALL belongs to, which the
 * tool-call context names, before the port it was built with; a fleet seat's call has no route and
 * goes to the orchestrator's port exactly as before.
 *
 * Bounded like the session-taint bindings: a run left bound by a crash cannot grow the map.
 */
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import type { DelegateRequest, DelegateResult } from "./types.js";

export interface DelegateRoute {
  delegate(request: DelegateRequest): Promise<DelegateResult>;
}

const ROUTES = new Map<string, DelegateRoute>();
const MAX_ROUTES = 1024;

/** Binds `runId`'s delegation route for as long as the run may call tools. */
export function bindDelegateRoute(runId: string, route: DelegateRoute): void {
  ROUTES.delete(runId);
  if (ROUTES.size >= MAX_ROUTES) ROUTES.delete(ROUTES.keys().next().value as string);
  ROUTES.set(runId, route);
}

export function unbindDelegateRoute(runId: string): void {
  ROUTES.delete(runId);
}

/** The route of the run the current tool call belongs to, when that run bound one. */
export function currentDelegateRoute(): DelegateRoute | undefined {
  const context = currentToolCallContext();
  return context === undefined ? undefined : ROUTES.get(context.runId);
}
