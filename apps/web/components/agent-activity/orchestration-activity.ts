import { mapOrcEventName, type OrcStreamInput } from "@/components/agent-activity/mappers/orc-event";
import type { ActivityStep } from "@/components/agent-activity/types";

export type OrchestrationActivityState = {
  runId: string;
  steps: ActivityStep[];
  runningStepIds: Set<string>;
  seenOutputs: Set<string>;
  seenCritiques: Set<string>;
  planDone: boolean;
  index: number;
};

export function createOrchestrationActivityState(runId: string): OrchestrationActivityState {
  return {
    runId,
    steps: [{
      id: `${runId}-start`,
      icon: "status",
      verb: "Orchestrator run started",
      target: runId,
      status: "running",
    }],
    runningStepIds: new Set(),
    seenOutputs: new Set(),
    seenCritiques: new Set(),
    planDone: false,
    index: 0,
  };
}

export type OrchestrationActivityResult = {
  steps: ActivityStep[];
  done: boolean;
  runStatus?: string;
  summary?: string;
};

export function applyOrchestrationActivityEvent(
  state: OrchestrationActivityState,
  eventName: string,
  payload: OrcStreamInput,
): OrchestrationActivityResult {
  const stepId = payload.step?.id;

  if (eventName === "step_start" && stepId) {
    completeRunningSteps(state);
    state.runningStepIds.add(stepId);
  }

  if (eventName === "step_output" && stepId) {
    if (state.seenOutputs.has(stepId)) return snapshot(state);
    state.seenOutputs.add(stepId);
    completeRunningSteps(state, stepId);
  }

  if (eventName === "step_critic" && stepId) {
    if (state.seenCritiques.has(stepId)) return snapshot(state);
    state.seenCritiques.add(stepId);
  }

  if (eventName === "plan_end") {
    if (state.planDone) return snapshot(state);
    state.planDone = true;
  }

  const mapped = mapOrcEventName(eventName, payload, state.index++);
  if (mapped) {
    if (eventName === "step_start" && stepId) {
      const existing = state.steps.findIndex((s) => s.id === stepId);
      if (existing >= 0) state.steps[existing] = { ...mapped, id: stepId };
      else state.steps.push(mapped);
    } else if (mapped.id && state.steps.some((s) => s.id === mapped.id)) {
      // skip duplicate terminal events
    } else {
      state.steps.push(mapped);
    }
  }

  if (eventName === "step_end" && stepId) {
    state.runningStepIds.delete(stepId);
    const idx = state.steps.findIndex((s) => s.id === stepId);
    if (idx >= 0) {
      state.steps[idx] = {
        ...state.steps[idx],
        status: payload.step?.status === "failed" || payload.step?.status === "blocked" ? "failed" : "completed",
        chip: payload.step?.status,
      };
    }
  }

  if (eventName === "run_done") {
    completeRunningSteps(state);
    markRunStartCompleted(state);
    return { ...snapshot(state), done: true, runStatus: "completed", summary: payload.run?.summary };
  }
  if (eventName === "run_failed") {
    completeRunningSteps(state, undefined, "failed");
    markRunStartCompleted(state, "failed");
    return { ...snapshot(state), done: true, runStatus: "failed", summary: payload.run?.summary };
  }
  if (eventName === "run_cancelled") {
    completeRunningSteps(state, undefined, "failed");
    return { ...snapshot(state), done: true, runStatus: "cancelled" };
  }

  return snapshot(state);
}

function completeRunningSteps(state: OrchestrationActivityState, exceptId?: string, finalStatus: ActivityStep["status"] = "completed") {
  for (const id of state.runningStepIds) {
    if (exceptId && id === exceptId) continue;
    const idx = state.steps.findIndex((s) => s.id === id);
    if (idx >= 0 && state.steps[idx].status === "running") {
      state.steps[idx] = { ...state.steps[idx], status: finalStatus };
    }
  }
  if (exceptId) state.runningStepIds.delete(exceptId);
  else state.runningStepIds.clear();
}

function markRunStartCompleted(state: OrchestrationActivityState, status: ActivityStep["status"] = "completed") {
  const idx = state.steps.findIndex((s) => s.id === `${state.runId}-start`);
  if (idx >= 0) state.steps[idx] = { ...state.steps[idx], status };
}

function snapshot(state: OrchestrationActivityState): OrchestrationActivityResult {
  return { steps: [...state.steps], done: false };
}
