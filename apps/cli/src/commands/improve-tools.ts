/**
 * [D5] `trent improve tools` — the tool side of the loop, from the command line.
 *
 * The sweep measures every tool it has traces for and proposes a rewritten description for the
 * ones whose arguments the model keeps getting wrong (`improve/tool-health.ts`). This is where a
 * human reads that: four rates per tool, whether each is over the threshold a proposal needs, the
 * drafts waiting on a decision, and which descriptions the seats are currently reading from an
 * improvement rather than from the code.
 *
 * Read-only. The decisions stay where every other decision in this loop is:
 * `trent improve promote <draftId>` and `trent improve reject <draftId>`.
 */

import {
  DEFAULT_TOOL_HEALTH_MIN_CALLS,
  DEFAULT_TOOL_HEALTH_THRESHOLD,
  readToolOverrides,
  toolHealth,
  toolsOverThreshold,
  type ToolHealth,
} from "@trent/core/improve/index.js";
import type { ToolDescriptionOverride } from "@trent/core/tools/index.js";
import { storeInfo, withStore } from "./improve-sweep.js";
import type { CommandContext } from "./context.js";
import type { CommandSpec } from "./registry.js";

interface ToolDraftRow {
  id: string;
  status: string;
  createdAt: string;
}

interface ToolRow extends ToolHealth {
  /** Whether this tool's evidence is enough for the sweep to propose a rewrite. */
  overThreshold: boolean;
  override: ToolDescriptionOverride | null;
  drafts: ToolDraftRow[];
}

interface ToolsData {
  companyId: string;
  thresholds: { threshold: number; minCalls: number };
  tools: ToolRow[];
  /** Every promoted description this profile serves, including any whose tool has no traces yet. */
  overrides: ToolDescriptionOverride[];
  store: ReturnType<typeof storeInfo>;
}

export const improveToolsSpec: CommandSpec = {
  name: "tools",
  description: "Tool health per tool (calls, failure, invalid-argument and re-call rates) and the descriptions an improvement is serving",
  options: [{ flags: "--tool <name>", description: "One tool only" }],
  run: (ctx, opts) =>
    withStore(ctx, async (opened, cfg) => {
      const only = typeof opts.tool === "string" ? opts.tool : undefined;
      const thresholds = { threshold: DEFAULT_TOOL_HEALTH_THRESHOLD, minCalls: DEFAULT_TOOL_HEALTH_MIN_CALLS };
      const measured = toolHealth(await opened.store.listTraces(cfg.companyId));
      const over = new Set(toolsOverThreshold(measured, thresholds).map((h) => h.tool));
      const overrides = readToolOverrides(ctx.config().getProfileDir());
      const drafts = await opened.store.listDrafts(cfg.companyId, { kind: "tool" });
      const tools: ToolRow[] = measured
        .filter((health) => only === undefined || health.tool === only)
        .map((health) => ({
          ...health,
          overThreshold: over.has(health.tool),
          override: overrides.find((row) => row.tool === health.tool) ?? null,
          drafts: drafts
            .filter((draft) => draft.taskType === health.tool && draft.status !== "rejected")
            .map((draft) => ({ id: draft.id, status: draft.status, createdAt: draft.createdAt })),
        }));
      const data: ToolsData = { companyId: cfg.companyId, thresholds, tools, overrides, store: storeInfo(opened) };
      return { data: data as unknown as Record<string, unknown> };
    }),
  render(data, ctx) {
    const d = data as unknown as ToolsData;
    const lines = [
      `  ${ctx.theme.meta("company")} ${ctx.theme.value(d.companyId)}   ${ctx.theme.meta("threshold")} ${d.thresholds.threshold} over ${d.thresholds.minCalls} calls`,
    ];
    if (d.tools.length === 0) lines.push(`  ${ctx.theme.meta("no tool calls in this profile's traces yet")}`);
    for (const tool of d.tools) {
      lines.push(
        `  ${ctx.theme.value(tool.tool.padEnd(18))} calls=${tool.calls} failed=${tool.failureRate} invalid-args=${tool.invalidArgumentRate} re-called=${tool.retryRate} args=${tool.meanArgsBytes}b${
          tool.overThreshold ? `   ${ctx.theme.needsApproval("over threshold")}` : ""
        }`,
      );
      // [D5] The one line that says a seat is not reading the shipped description any more.
      if (tool.override) lines.push(`    ${ctx.theme.success("description from improvement")} ${ctx.theme.value(tool.override.draftId)} (${tool.override.promotedAt})`);
      for (const draft of tool.drafts) lines.push(`    ${ctx.theme.meta("draft")} ${ctx.theme.value(draft.id)} ${draft.status} (promote it with: trent improve promote ${draft.id})`);
      for (const example of tool.examples) lines.push(`    ${ctx.theme.meta("refusal")} ${example}`);
    }
    for (const override of d.overrides.filter((row) => !d.tools.some((tool) => tool.tool === row.tool))) {
      lines.push(`  ${ctx.theme.value(override.tool.padEnd(18))} ${ctx.theme.success("description from improvement")} ${override.draftId} (no calls measured yet)`);
    }
    return lines;
  },
};

/** The profile directory a promotion writes its tool overrides into. */
export function toolOverrideTarget(ctx: CommandContext): { profileDir: string } {
  return { profileDir: ctx.config().getProfileDir() };
}
