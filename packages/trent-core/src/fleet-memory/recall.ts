/**
 * Requirement 2: before a run, the most relevant learnings from ANY agent in the company —
 * completed step outputs, consolidated run briefs, live skills (own and org tier) and playbook
 * bullets — ranked against the objective, cut at a hard character budget, rendered once.
 *
 * The block is what L8 calls the difference between the maintainer and the contractor: the
 * context the seat would otherwise not have. It is bounded so the prefix stays cacheable and the
 * cost per prompt stays fixed (cs329a-applied section 2, item 1).
 */

import { deriveTaskType } from "../improve/trace-writer.js";
import { DEFAULT_FLEET_MEMORY_CONFIG, type FleetMemoryConfig } from "./config.js";
import { scoreAgainst, type EmbedFn } from "./lexical.js";
import { listSharedSkills } from "./shared-skills.js";
import { isDelegatedStep, type FleetMemorySource } from "./source.js";

export type RecallKind = "step" | "summary" | "skill" | "playbook";

export interface RecallItem {
  readonly kind: RecallKind;
  /** The agent that produced it: a seat role, a specialist id, `__org__`, or `playbook`. */
  readonly agentId: string;
  readonly runId: string | null;
  readonly label: string;
  readonly text: string;
  readonly score: number;
}

export interface RecallResult {
  /** The rendered block, or "" when nothing related exists. Always `<= config.recallBudgetChars`. */
  readonly block: string;
  readonly chars: number;
  readonly items: readonly RecallItem[];
  /** Related items that did not fit the budget. */
  readonly dropped: number;
}

export interface RecallInput {
  readonly companyId: string;
  readonly seat: string;
  readonly objective: string;
  /** The run being prepared; its own (partial) steps are never recalled. */
  readonly excludeRunId?: string;
  readonly config?: FleetMemoryConfig;
  readonly embed?: EmbedFn;
}

interface Candidate extends Omit<RecallItem, "score"> {
  readonly recency: number;
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, Math.max(0, n - 3))}...`;
}

const shortId = (id: string) => (id.length > 12 ? id.slice(0, 12) : id);

async function collectCandidates(source: FleetMemorySource, input: RecallInput, config: FleetMemoryConfig): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const runs = (await source.listRuns(input.companyId)).filter((r) => r.id !== input.excludeRunId).slice(0, config.recallRunWindow);
  runs.forEach((run, recency) => {
    for (const step of run.steps) {
      if (step.status !== "completed" || !step.output?.trim()) continue;
      const tag = isDelegatedStep(step) ? `${step.agentRole}, delegated` : step.agentRole;
      out.push({ kind: "step", agentId: step.agentRole, runId: run.id, recency, label: `${tag} | ${clip(step.title, 60)} | run ${shortId(run.id)}`, text: step.output });
    }
    if (run.summary?.trim()) {
      out.push({ kind: "summary", agentId: "consolidated", runId: run.id, recency, label: `consolidated | ${clip(run.objective, 60)} | run ${shortId(run.id)}`, text: run.summary });
    }
  });
  if (source.improve) {
    for (const skill of await listSharedSkills(source.improve, input.companyId, input.seat)) {
      out.push({ kind: "skill", agentId: skill.agentId, runId: null, recency: 0, label: `${skill.tier} skill | ${skill.taskType}`, text: skill.content });
    }
  }
  if (source.listPlaybook) {
    for (const entry of await source.listPlaybook(input.companyId)) {
      if (!entry.text.trim()) continue;
      out.push({ kind: "playbook", agentId: "playbook", runId: null, recency: 0, label: `playbook | ${entry.topic}`, text: entry.text });
    }
  }
  return out;
}

export async function recallForObjective(source: FleetMemorySource, input: RecallInput): Promise<RecallResult> {
  const config = input.config ?? DEFAULT_FLEET_MEMORY_CONFIG;
  const candidates = await collectCandidates(source, input, config);
  const query = `${input.objective} ${deriveTaskType(input.objective).replace(/-/g, " ")}`;
  const scores = await scoreAgainst(query, candidates.map((c) => `${c.label} ${c.text}`), input.embed);
  const related = candidates
    .map((c, i) => ({ ...c, score: scores[i] ?? 0 }))
    .filter((c) => c.score >= config.recallMinScore)
    .sort((a, b) => b.score - a.score || a.recency - b.recency || a.label.localeCompare(b.label));

  const header = `## Fleet recall (what other seats learned; frozen for this run; ${config.recallBudgetChars}-char cap)`;
  const lines: string[] = [];
  const kept: RecallItem[] = [];
  let used = header.length;
  for (const c of related) {
    const line = `- [${c.label}] ${clip(c.text, config.recallSnippetChars)}`;
    if (used + 1 + line.length > config.recallBudgetChars) continue;
    lines.push(line);
    used += 1 + line.length;
    const { recency: _recency, ...item } = c;
    kept.push(item);
  }
  if (kept.length === 0) return { block: "", chars: 0, items: [], dropped: related.length };
  const block = `${header}\n${lines.join("\n")}`;
  return { block, chars: block.length, items: kept, dropped: related.length - kept.length };
}
