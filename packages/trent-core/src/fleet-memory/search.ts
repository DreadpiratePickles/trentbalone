/**
 * Requirement 3 (and the read half of 4): the `fleet_search` toolset.
 *
 *   fleet_search {"query": "...", "limit": 5}   full text over EVERY agent's completed step
 *     outputs and consolidated summaries in the company store — Hermes hides subagent sessions
 *     from search; here delegated steps are included and tagged `[<seat>, delegated]`.
 *   fleet_skill_view {"skill": "<task type or id>"}   the body of an org-tier or own live skill.
 *
 * Read-only by construction: the adapter has no write path and never needs approval.
 */

import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { intArg, parseAction, record as toRecord, stringArg, type ToolSpec } from "../tools/action.js";
import { renderToolInstructions, type ToolSchema } from "../tools/web/schemas.js";
import { DEFAULT_FLEET_MEMORY_CONFIG, type FleetMemoryConfig } from "./config.js";
import { fullTextScore } from "./lexical.js";
import { findSharedSkill, listSharedSkills } from "./shared-skills.js";
import { isDelegatedStep, type FleetMemorySource } from "./source.js";

export const FLEET_SEARCH_ADAPTER_NAME = "fleet_search";

const SPECS: readonly ToolSpec[] = [
  { name: "fleet_search", primary: "query", signature: ["query"] },
  { name: "fleet_skill_view", primary: "skill", signature: ["skill"] },
];

const ROUTING_TEXT =
  "search what other agents did, previous runs, what did the analyst find, past work on this, " +
  "company history, earlier results, look up a shared skill, org skill";

export const FLEET_SEARCH_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "fleet_search",
    description:
      "Full-text search over every agent's completed step outputs and run briefs in this company, " +
      "delegated steps included. Each hit names the agent that produced it and the run.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for." },
        limit: { type: "number", description: `Hits to return (default ${DEFAULT_FLEET_MEMORY_CONFIG.searchDefaultLimit}, max ${DEFAULT_FLEET_MEMORY_CONFIG.searchMaxLimit}).` },
      },
      required: ["query"],
    },
  },
  {
    name: "fleet_skill_view",
    description: "The full body of a shared skill listed in your prelude: an org-tier skill any agent earned, or one of your own.",
    parameters: {
      type: "object",
      properties: { skill: { type: "string", description: "The task type (or id) from the shared skills index." } },
      required: ["skill"],
    },
  },
];

export interface FleetSearchAdapterOptions {
  readonly source: FleetMemorySource;
  readonly config?: FleetMemoryConfig;
  /** The seat currently calling, for `fleet_skill_view`'s "own" tier. Defaults to org-only. */
  readonly seat?: () => string | undefined;
}

interface Hit {
  readonly line: string;
  readonly score: number;
  readonly order: number;
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, Math.max(0, n - 3))}...`;
}

export function createFleetSearchAdapter(options: FleetSearchAdapterOptions): TrentToolAdapter {
  const config = options.config ?? DEFAULT_FLEET_MEMORY_CONFIG;
  const record = (action: string, status: ToolCallRecord["status"], summary: string) => toRecord(FLEET_SEARCH_ADAPTER_NAME, action, status, summary);

  async function search(action: string, args: Record<string, unknown>, companyId: string): Promise<ToolCallRecord> {
    const query = stringArg(args, "query")?.trim();
    if (!query) return record(action, "failed", 'fleet_search requires "query".');
    const limit = intArg(args.limit, config.searchDefaultLimit, 1, config.searchMaxLimit);
    const hits: Hit[] = [];
    let order = 0;
    for (const run of await options.source.listRuns(companyId)) {
      for (const step of run.steps) {
        if (!step.output?.trim()) continue;
        const score = fullTextScore(query, `${step.title} ${step.output}`);
        if (score === 0) continue;
        const tag = isDelegatedStep(step) ? `${step.agentRole}, delegated` : step.agentRole;
        hits.push({ score, order: order++, line: `- [${tag}] run ${run.id} step "${clip(step.title, 60)}" (${step.status}): ${clip(step.output, config.searchSnippetChars)}` });
      }
      if (run.summary?.trim()) {
        const score = fullTextScore(query, `${run.objective} ${run.summary}`);
        if (score > 0) hits.push({ score, order: order++, line: `- [consolidated] run ${run.id} "${clip(run.objective, 60)}": ${clip(run.summary, config.searchSnippetChars)}` });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    if (hits.length === 0) return record(action, "completed", `No completed work in this company matches "${clip(query, 80)}".`);
    const shown = hits.slice(0, limit);
    const header = `${shown.length} of ${hits.length} hit(s) across all agents for "${clip(query, 80)}":`;
    return record(action, "completed", `${header}\n${shown.map((h) => h.line).join("\n")}`);
  }

  async function skillView(action: string, args: Record<string, unknown>, companyId: string): Promise<ToolCallRecord> {
    const key = stringArg(args, "skill")?.trim();
    if (!key) return record(action, "failed", 'fleet_skill_view requires "skill".');
    if (!options.source.improve) return record(action, "failed", "No skill store is attached to this company.");
    const seat = options.seat?.() ?? "__org__";
    const skills = await listSharedSkills(options.source.improve, companyId, seat);
    const found = findSharedSkill(skills, key);
    if (!found) return record(action, "failed", `No shared skill "${clip(key, 60)}" is visible to the ${seat} seat. The index in your prompt lists what is.`);
    return record(action, "completed", `# ${found.taskType} [${found.tier} skill, earned by ${found.agentId}]\n\n${found.content.trim()}`);
  }

  return {
    name: FLEET_SEARCH_ADAPTER_NAME,
    scopes: [FLEET_SEARCH_ADAPTER_NAME, "fleet_skill_view", "fleet:read"],
    availability: "real",
    instructions: renderToolInstructions(FLEET_SEARCH_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    async cleanup() {},
    async execute(action, payload) {
      const { tool, args, error } = parseAction(action, SPECS);
      if (error) return record(action, "failed", error);
      const companyId = typeof payload.companyId === "string" ? payload.companyId : "";
      if (!companyId) return record(action, "failed", "fleet_search: no company in the call context.");
      try {
        return tool === "fleet_skill_view" ? await skillView(action, args, companyId) : await search(action, args, companyId);
      } catch (err) {
        return record(action, "failed", `${tool} failed: ${(err as Error).message}`);
      }
    },
    async dryRun(action) {
      return record(action, "mocked", `fleet_search dry-run: would run "${action}" (read-only).`);
    },
  };
}
