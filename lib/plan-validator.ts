import type { AgentRole } from "@/lib/types";
import type { Subtask } from "@/lib/planner";
import type { OrchestrationPlan } from "@/lib/orchestrator-runtime";

export type PlanValidationErrorCode =
  | "cycle"
  | "dangling_dependency"
  | "off_roster_seat"
  | "budget_over_cap"
  | "missing_acceptance"
  | "missing_escalation";

export type PlanValidationError = {
  code: PlanValidationErrorCode;
  message: string;
  ids?: string[];
  totalBudgetCents?: number;
  budgetCapCents?: number;
};

export type PlanValidationResult =
  | { ok: true }
  | { ok: false; errors: PlanValidationError[] };

type ValidatablePlanNode = {
  id: string;
  seat: AgentRole;
  dependsOn: string[];
  spec?: { acceptance?: string[] };
  budgetCents: number;
  irreversible: boolean;
};

export function validatePlan(
  subtasks: Subtask[],
  opts: { seatRoster: AgentRole[]; budgetCapCents: number },
): PlanValidationResult {
  return validateNodes(
    subtasks.map((subtask) => ({
      id: subtask.id,
      seat: subtask.seat,
      dependsOn: subtask.dependsOn ?? [],
      spec: subtask.spec,
      budgetCents: subtask.budgetCents,
      irreversible: subtask.classification.reversibility === "irreversible",
    })),
    opts,
  );
}

export function validateOrchestrationPlan(
  plan: OrchestrationPlan,
  opts: { seatRoster: AgentRole[]; budgetCapCents: number },
): PlanValidationResult {
  return validateNodes(
    plan.steps.map((step) => ({
      id: step.id,
      seat: step.agentRole,
      dependsOn: step.dependsOn ?? [],
      spec: step.spec,
      budgetCents: 0,
      irreversible: step.needsApproval || step.riskLevel === "high",
    })),
    opts,
  );
}

export function formatPlanValidationErrors(errors: PlanValidationError[]): string {
  return errors.map((error) => error.message).join("; ");
}

function validateNodes(
  nodes: ValidatablePlanNode[],
  opts: { seatRoster: AgentRole[]; budgetCapCents: number },
): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  const ids = new Set(nodes.map((node) => node.id));
  const roster = new Set<AgentRole>(opts.seatRoster);

  const dangling = unique(nodes.flatMap((node) => node.dependsOn.filter((dep) => !ids.has(dep))));
  if (dangling.length > 0) {
    errors.push({
      code: "dangling_dependency",
      message: `Plan references missing dependencies: ${dangling.join(", ")}`,
      ids: dangling,
    });
  }

  const cycle = findCycle(nodes);
  if (cycle.length > 0) {
    errors.push({
      code: "cycle",
      message: `Plan contains a dependency cycle: ${cycle.join(" -> ")}`,
      ids: cycle,
    });
  }

  const offRoster = nodes.filter((node) => !roster.has(node.seat)).map((node) => node.id);
  if (offRoster.length > 0) {
    errors.push({
      code: "off_roster_seat",
      message: `Plan assigns work to seats outside the roster: ${offRoster.join(", ")}`,
      ids: offRoster,
    });
  }

  const totalBudgetCents = nodes.reduce((sum, node) => sum + node.budgetCents, 0);
  if (totalBudgetCents > opts.budgetCapCents) {
    errors.push({
      code: "budget_over_cap",
      message: `Plan budget ${totalBudgetCents}c exceeds cap ${opts.budgetCapCents}c`,
      totalBudgetCents,
      budgetCapCents: opts.budgetCapCents,
    });
  }

  const missingAcceptance = nodes
    .filter((node) => !hasAcceptance(node.spec))
    .map((node) => node.id);
  if (missingAcceptance.length > 0) {
    errors.push({
      code: "missing_acceptance",
      message: `Plan nodes missing acceptance criteria: ${missingAcceptance.join(", ")}`,
      ids: missingAcceptance,
    });
  }

  if (nodes.some((node) => node.irreversible) && !nodes.some((node) => node.seat === "escalation")) {
    errors.push({
      code: "missing_escalation",
      message: "Plan includes irreversible work without an escalation subtask",
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function hasAcceptance(spec: ValidatablePlanNode["spec"]): boolean {
  return Array.isArray(spec?.acceptance)
    && spec.acceptance.some((item) => typeof item === "string" && item.trim().length > 0);
}

function findCycle(nodes: ValidatablePlanNode[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];

  function visit(id: string): string[] {
    const existing = state.get(id);
    if (existing === "visited") return [];
    if (existing === "visiting") {
      const start = stack.indexOf(id);
      return start >= 0 ? [...stack.slice(start), id] : [id];
    }

    const node = byId.get(id);
    if (!node) return [];

    state.set(id, "visiting");
    stack.push(id);
    for (const dep of node.dependsOn) {
      const cycle = visit(dep);
      if (cycle.length > 0) return cycle;
    }
    stack.pop();
    state.set(id, "visited");
    return [];
  }

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle.length > 0) return cycle;
  }
  return [];
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
