/**
 * Skill Foundry — Phase 2 of the Trent self-improvement loop.
 *
 * When a run crosses a Hermes-style distillation trigger (≥5 tool calls, an
 * error-recovery path, human correction, or a high-score novel task type), the
 * Foundry asks an LLM to distill the session traces into a reusable SKILL.md
 * document in agentskills.io format.
 *
 * Drafts land in a quarantine directory/store — nothing is promoted to live
 * skill storage until the Eval Gate (Phase 1) signs off. Every write is
 * audit-logged.
 *
 * Six skill actions mirror Hermes: create, patch, edit.  Default is `patch`
 * when a skill already exists so improvements are minimal and auditable.
 *
 * See docs/superpowers/plans/2026-06-02-self-improvement-loop-plan.md Phase 2.
 */

import OpenAI from "openai";
import { makeId, nowIso } from "@/lib/utils";
import {
  shouldDistillSkill,
  type TraceRecord,
  type DistillDecision,
  type DistillOptions,
} from "@/lib/trace-store";
import { appendAuditLog } from "@/lib/audit-log";

const FOUNDRY_MODEL = process.env.FOUNDRY_MODEL ?? process.env.OPENAI_MODEL ?? "claude-sonnet-4-5";

export type SkillAction = "create" | "patch" | "edit";

export type SkillDraft = {
  id: string;
  companyId: string;
  taskType: string;
  action: SkillAction;
  /** Full SKILL.md content (create or edit). Empty string for patch. */
  content: string;
  /** For patch action: the substring being replaced. */
  oldString?: string;
  /** For patch action: the replacement string. */
  newString?: string;
  triggeredBy: DistillDecision["triggers"];
  status: "quarantine" | "live" | "rejected";
  createdAt: string;
  promotedAt?: string;
  /**
   * Evolution lineage (OpenSpace modes). Absent on legacy drafts.
   *   - "captured": brand-new skill from a successful run (the default path).
   *   - "fix": in-place repair of a degraded skill (metric/cascade triggered).
   *   - "derived": a specialized child that coexists with its parent.
   */
  kind?: "captured" | "fix" | "derived";
  /** For derived skills: the parent task type this was specialized from. */
  parentTaskType?: string;
  /** For derived skills: the specialization label (e.g. an ICP slug). */
  specializationLabel?: string;
};

/** Minimal injectable abstraction for skill draft persistence. */
export interface SkillDraftStore {
  /** Write a draft to quarantine.  Returns the draft id. */
  writeQuarantine(companyId: string, taskType: string, content: string): Promise<string>;
  /** Read the current quarantine content for a task type, or undefined if none. */
  readQuarantine(companyId: string, taskType: string): Promise<string | undefined>;
  /** Promote a quarantine draft to live. */
  promote(companyId: string, taskType: string): Promise<void>;
  /** Read the live skill for a task type, or undefined. */
  readLive(companyId: string, taskType: string): Promise<string | undefined>;
  /** List all live skill task types for a company. */
  listLiveTaskTypes(companyId: string): Promise<string[]>;
}

/** In-memory draft store — use for tests and local dev. */
export class InMemorySkillDraftStore implements SkillDraftStore {
  private quarantine = new Map<string, string>();
  private live = new Map<string, string>();

  private key(companyId: string, taskType: string): string {
    return `${companyId}::${taskType}`;
  }

  async writeQuarantine(companyId: string, taskType: string, content: string): Promise<string> {
    this.quarantine.set(this.key(companyId, taskType), content);
    return makeId("qdraft");
  }

  async readQuarantine(companyId: string, taskType: string): Promise<string | undefined> {
    return this.quarantine.get(this.key(companyId, taskType));
  }

  async promote(companyId: string, taskType: string): Promise<void> {
    const content = this.quarantine.get(this.key(companyId, taskType));
    if (content !== undefined) {
      this.live.set(this.key(companyId, taskType), content);
    }
  }

  async readLive(companyId: string, taskType: string): Promise<string | undefined> {
    return this.live.get(this.key(companyId, taskType));
  }

  async listLiveTaskTypes(companyId: string): Promise<string[]> {
    const prefix = `${companyId}::`;
    return [...this.live.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }
}

/**
 * Build the agentskills.io-format SKILL.md frontmatter block for a new skill.
 */
export function buildSkillFrontmatter(
  taskType: string,
  companyId: string,
  description: string,
  tags: string[],
  now: string,
): string {
  return [
    "---",
    `name: ${taskType.toLowerCase().replace(/\s+/g, "-")}`,
    `description: ${description}`,
    "version: 1.0.0",
    "metadata:",
    "  trent:",
    `    taskType: ${taskType}`,
    `    companyId: ${companyId}`,
    `    tags: [${tags.map((t) => t.replace(/\s+/g, "_").toLowerCase()).join(", ")}]`,
    `    createdAt: ${now}`,
    "---",
  ].join("\n");
}

/**
 * Build a fallback SKILL.md when the LLM is unavailable.
 * Captures the essential trace shape so a human can fill it in.
 */
export function buildFallbackSkill(
  taskType: string,
  companyId: string,
  traces: readonly TraceRecord[],
  now: string,
): string {
  const toolCallsSeen = [...new Set(traces.flatMap((t) => t.toolCalls))];
  const rolesSeen = [...new Set(traces.map((t) => t.agentRole))];
  const recoveries = traces.filter((t) => t.critiqueVerdict === "retry" && t.improvement);

  const frontmatter = buildSkillFrontmatter(
    taskType,
    companyId,
    `Auto-captured procedure for ${taskType} (review before promoting)`,
    rolesSeen,
    now,
  );

  const steps = traces
    .map((t, i) =>
      `${i + 1}. ${t.stepTitle} [${t.agentRole}]${t.toolCalls.length ? ` — tools: ${t.toolCalls.join(", ")}` : ""}`,
    )
    .join("\n");

  const recoverySection =
    recoveries.length > 0
      ? [
          "",
          "## Recovery patterns",
          ...recoveries.map((t) => `- ${t.stepTitle}: ${t.improvement}`),
        ].join("\n")
      : "";

  const toolsSection =
    toolCallsSeen.length > 0
      ? [
          "",
          "## Tools used",
          ...toolCallsSeen.map((t) => `- ${t}`),
        ].join("\n")
      : "";

  return [
    frontmatter,
    "",
    "## Steps",
    steps,
    recoverySection,
    toolsSection,
    "",
    "<!-- TODO: Review and enrich this auto-captured skill before promoting. -->",
  ]
    .filter((s) => s !== undefined)
    .join("\n");
}

type LLMDistillResponse = {
  action: "create" | "patch";
  content?: string;
  old_string?: string;
  new_string?: string;
};

/**
 * Build the LLM prompt for skill distillation.
 * Existing content triggers patch mode; absence triggers create mode.
 */
export function buildDistillPrompt(
  traces: readonly TraceRecord[],
  taskType: string,
  existingContent?: string,
): string {
  const runSummary = traces
    .map(
      (t, i) =>
        `Step ${i + 1}: "${t.stepTitle}" [${t.agentRole}]` +
        (t.toolCalls.length ? ` — tools: ${t.toolCalls.join(", ")}` : "") +
        ` — verdict: ${t.critiqueVerdict ?? "none"}` +
        (t.improvement ? ` — improvement noted: "${t.improvement}"` : ""),
    )
    .join("\n");

  const modeBlock = existingContent
    ? [
        "An existing skill is shown below. Respond with JSON:",
        '{ "action": "patch", "old_string": "...", "new_string": "..." }',
        "Change only the section that can be improved — minimal diff preferred.",
        "",
        "Existing skill:",
        existingContent,
      ].join("\n")
    : [
        "No existing skill for this task type. Respond with JSON:",
        '{ "action": "create", "content": "<full SKILL.md with agentskills.io frontmatter>" }',
        "Include: frontmatter (name, description, version, metadata.trent.taskType), Steps section,",
        "optional Recovery patterns section, optional Key decisions section.",
      ].join("\n");

  return [
    "You are Trent's Skill Foundry. Extract a reusable agent procedure from the run below.",
    "Focus on WHAT WORKED — effective step order, tool call sequence, recovery patterns.",
    "Produce a skill document a future agent can follow WITHOUT re-deriving the steps.",
    "",
    `Task type: ${taskType}`,
    "",
    "Run trace:",
    runSummary,
    "",
    modeBlock,
  ].join("\n");
}

function makeOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    timeout: 45_000,
  });
}

async function callFoundryLLM(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return "";
  try {
    const completion = await makeOpenAIClient().chat.completions.create({
      model: FOUNDRY_MODEL,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    });
    return completion.choices[0]?.message.content?.trim() ?? "";
  } catch (err) {
    console.error("skill_foundry.llm_failed", err);
    return "";
  }
}

/**
 * Parse the LLM's JSON response into a structured distillation response.
 * Falls back to `{ action: "create", content: raw }` when the JSON is malformed.
 */
export function parseDistillResponse(raw: string): LLMDistillResponse {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    if (json.action === "patch" && json.old_string && json.new_string) {
      return { action: "patch", old_string: json.old_string, new_string: json.new_string };
    }
    if (json.action === "create" && json.content) {
      return { action: "create", content: json.content };
    }
  } catch {
    // fall through
  }
  return { action: "create", content: raw || undefined };
}

export type FoundryOptions = DistillOptions & {
  companyId: string;
  draftStore: SkillDraftStore;
  /** Skip the LLM and use the fallback skill. Useful for tests. */
  skipLLM?: boolean;
  /** Injectable audit writer — defaults to appendAuditLog. */
  auditLog?: typeof appendAuditLog;
  /** Deterministic id for the draft record. */
  id?: string;
  now?: string;
};

/**
 * Full Foundry pipeline: trigger-check → LLM distillation → quarantine write → audit.
 * Returns the draft if distillation ran, or null if the trigger check failed.
 */
export async function distillSkillFromTraces(
  traces: readonly TraceRecord[],
  taskType: string,
  options: FoundryOptions,
): Promise<SkillDraft | null> {
  const decision = shouldDistillSkill(traces, options);
  if (!decision.shouldDistill) return null;

  const now = options.now ?? nowIso();
  const companyId = options.companyId;
  const existingContent = await options.draftStore.readQuarantine(companyId, taskType);

  let action: SkillAction;
  let content: string;
  let oldString: string | undefined;
  let newString: string | undefined;

  if (options.skipLLM) {
    content = buildFallbackSkill(taskType, companyId, traces, now);
    action = existingContent ? "edit" : "create";
  } else {
    const prompt = buildDistillPrompt(traces, taskType, existingContent);
    const raw = await callFoundryLLM(prompt);
    const response = raw ? parseDistillResponse(raw) : { action: "create" as const, content: undefined };

    if (response.action === "patch" && existingContent && response.old_string && response.new_string) {
      content = existingContent.replace(response.old_string, response.new_string);
      action = "patch";
      oldString = response.old_string;
      newString = response.new_string;
    } else {
      content = response.content ?? buildFallbackSkill(taskType, companyId, traces, now);
      action = existingContent ? "edit" : "create";
    }
  }

  await options.draftStore.writeQuarantine(companyId, taskType, content);

  const draft: SkillDraft = {
    id: options.id ?? makeId("skill"),
    companyId,
    taskType,
    action,
    content,
    oldString,
    newString,
    triggeredBy: decision.triggers,
    status: "quarantine",
    createdAt: now,
  };

  const auditFn = options.auditLog ?? appendAuditLog;
  await auditFn(
    companyId,
    "agent",
    "skill.distilled",
    "skill_draft",
    draft.id,
    `Skill draft (${action}) for task type "${taskType}" — triggers: ${decision.triggers.join(", ")}`,
  ).catch(() => {});

  return draft;
}
