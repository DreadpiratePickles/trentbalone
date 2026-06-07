/**
 * Tool Health & Degradation Cascade (OpenSpace-inspired).
 *
 * OpenSpace's quality monitor tracks tool-call success rates, and when a tool
 * degrades it finds every skill that depends on that tool and batch-evolves them
 * — keeping the system coherent when an upstream API breaks. This is Trent's
 * version.
 *
 * Trent doesn't record per-tool success directly; it records step-level status
 * and the critic's verdict. So a tool's "implicated failure" is approximate: a
 * tool counts against its own health when it appears in a step that failed or
 * had to fall back (retry/replan/escalate). That's a deliberately conservative
 * signal — it over-flags rather than missing a quietly broken integration.
 *
 * Pure functions only. The heartbeat sweep uses `degradedTools` +
 * `skillsDependentOnTool` to decide which live skills to force-FIX.
 */

import type { TraceRecord } from "@/lib/trace-store";

export type ToolHealth = {
  tool: string;
  /** Total step-appearances of this tool across the trace set. */
  appearances: number;
  /** Appearances in a failed or fallback step. */
  implicatedFailures: number;
  /** 1 − implicatedFailures / appearances. */
  successRate: number;
};

export type ToolHealthThresholds = {
  /** Need at least this many appearances before health is trustworthy. */
  minAppearances: number;
  /** Below this success rate → degraded. */
  minSuccessRate: number;
};

export const DEFAULT_TOOL_HEALTH_THRESHOLDS: ToolHealthThresholds = {
  minAppearances: 3,
  minSuccessRate: 0.7,
};

const FALLBACK_VERDICTS = new Set(["retry", "replan", "escalate"]);

function isImplicated(t: TraceRecord): boolean {
  return t.status === "failed" || (!!t.critiqueVerdict && FALLBACK_VERDICTS.has(t.critiqueVerdict));
}

/** Compute per-tool health across a company's traces. */
export function computeToolHealth(traces: readonly TraceRecord[]): Map<string, ToolHealth> {
  const acc = new Map<string, { appearances: number; implicated: number }>();
  for (const t of traces) {
    const implicated = isImplicated(t);
    // De-dupe tools within a single step so one step can't double-count a tool.
    for (const tool of new Set(t.toolCalls)) {
      const cur = acc.get(tool) ?? { appearances: 0, implicated: 0 };
      cur.appearances++;
      if (implicated) cur.implicated++;
      acc.set(tool, cur);
    }
  }

  const out = new Map<string, ToolHealth>();
  for (const [tool, { appearances, implicated }] of acc) {
    out.set(tool, {
      tool,
      appearances,
      implicatedFailures: implicated,
      successRate: appearances === 0 ? 1 : 1 - implicated / appearances,
    });
  }
  return out;
}

/** Tools whose success rate has dropped below threshold, worst-first. */
export function degradedTools(
  health: Map<string, ToolHealth>,
  thresholds: ToolHealthThresholds = DEFAULT_TOOL_HEALTH_THRESHOLDS,
): ToolHealth[] {
  return [...health.values()]
    .filter((h) => h.appearances >= thresholds.minAppearances && h.successRate < thresholds.minSuccessRate)
    .sort((a, b) => a.successRate - b.successRate);
}

/**
 * Find live skills that depend on a tool. A skill "depends on" a tool when the
 * tool name appears in its SKILL.md body (the foundry writes a "## Tools used"
 * section, so this is reliable for auto-captured skills). Match is
 * case-insensitive and word-boundary-ish to avoid `sql` matching `sqlite`.
 */
export function skillsDependentOnTool(
  tool: string,
  liveSkills: Map<string, string>,
): string[] {
  const needle = tool.toLowerCase();
  const dependents: string[] = [];
  for (const [taskType, content] of liveSkills) {
    if (mentionsTool(content, needle)) dependents.push(taskType);
  }
  return dependents;
}

function mentionsTool(content: string, needleLower: string): boolean {
  const haystack = content.toLowerCase();
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needleLower, from);
    if (idx === -1) return false;
    const before = idx === 0 ? "" : haystack[idx - 1];
    const after = haystack[idx + needleLower.length] ?? "";
    const boundary = (ch: string) => ch === "" || !/[a-z0-9_]/.test(ch);
    if (boundary(before) && boundary(after)) return true;
    from = idx + needleLower.length;
  }
}

/**
 * Convenience: given all traces and the live skill bodies, return the set of
 * task types whose skill should be force-FIXed because a tool they depend on
 * has degraded. The heartbeat sweep unions this with skill-health degradation.
 */
export function cascadeDegradedSkills(
  traces: readonly TraceRecord[],
  liveSkills: Map<string, string>,
  thresholds: ToolHealthThresholds = DEFAULT_TOOL_HEALTH_THRESHOLDS,
): { degradedTaskTypes: Set<string>; tools: ToolHealth[] } {
  const tools = degradedTools(computeToolHealth(traces), thresholds);
  const degradedTaskTypes = new Set<string>();
  for (const t of tools) {
    for (const taskType of skillsDependentOnTool(t.tool, liveSkills)) {
      degradedTaskTypes.add(taskType);
    }
  }
  return { degradedTaskTypes, tools };
}
