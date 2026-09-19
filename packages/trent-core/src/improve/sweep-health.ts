/**
 * The sweep's read-only health signals, wrapped from the app's pure modules: which of an agent's
 * live skills the metric monitor calls degraded (`skill-health.ts`), and which task types a
 * degraded tool drags down with it (`tool-health.ts`). Split out of `sweep.ts` to keep that file
 * inside the 500-line rule; the behaviour is unchanged.
 */

import type { TraceRecord } from "../traces/trace-store.js";
import type { AgentSweepReport } from "./sweep.js";

export type Health = {
  degraded: Set<string>;
  degradedSkills: AgentSweepReport["degradedSkills"];
  degradedTools: AgentSweepReport["degradedTools"];
};

/** The metric monitor and the tool cascade, from the wrapped pure modules. */
export async function assessHealth(traces: readonly TraceRecord[], byTaskType: Map<string, TraceRecord[]>, liveSkills: Map<string, string>): Promise<Health> {
  const [{ computeSkillHealth, isSkillDegraded, describeDegradation }, { cascadeDegradedSkills }] = await Promise.all([
    import("@/lib/skill-health"),
    import("@/lib/tool-health"),
  ]);
  const health: Health = { degraded: new Set(), degradedSkills: [], degradedTools: [] };
  for (const [taskType, group] of byTaskType) {
    if (!liveSkills.has(taskType)) continue;
    const h = computeSkillHealth(taskType, group as unknown as Parameters<typeof computeSkillHealth>[1]);
    if (isSkillDegraded(h)) {
      health.degraded.add(taskType);
      health.degradedSkills.push({ taskType, reasons: describeDegradation(h) });
    }
  }
  const cascade = cascadeDegradedSkills(traces as unknown as Parameters<typeof cascadeDegradedSkills>[0], liveSkills);
  for (const taskType of cascade.degradedTaskTypes) health.degraded.add(taskType);
  health.degradedTools = cascade.tools.map((t) => ({ tool: t.tool, successRate: t.successRate }));
  return health;
}

