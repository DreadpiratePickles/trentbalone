/**
 * Skill Derivation — DERIVED evolution mode (OpenSpace-inspired).
 *
 * The base foundry produces exactly one skill per task type: a one-size-fits-all
 * procedure. OpenSpace's DERIVED mode forks a *specialized* child from a proven
 * parent — same task, tuned for a narrower context — and lets it coexist with
 * the parent. That's where OpenSpace gets much of its income lift: a generic
 * pipeline forks into a compliance-tuned one without losing the original.
 *
 * In Trent the obvious specialization axis is the company's ICP/offer/brand
 * voice (the fields `agentSystemPrompt` already treats as ground truth). So the
 * growth, content, and sales seats can fork their generic outreach/content/
 * qualification skills into ICP-specialized variants.
 *
 * A derived skill is just a new task-type key — `parent@label` — so it reuses
 * the existing SkillDraftStore with no schema change. Lineage is recorded both
 * on the draft (`parentTaskType`, `specializationLabel`) and in the SKILL.md
 * frontmatter so the version DAG is reconstructable.
 *
 * Pure helpers are exported for unit testing; `deriveSpecializedSkill` is the
 * orchestrator. LLM specialization is optional — `skipLLM` yields a deterministic
 * fallback that appends a specialization section to the parent body.
 */

import OpenAI from "openai";
import { makeId, nowIso } from "@/lib/utils";
import { appendAuditLog } from "@/lib/audit-log";
import type { SkillDraft, SkillDraftStore } from "@/lib/skill-foundry";

const DERIVE_MODEL = process.env.FOUNDRY_MODEL ?? process.env.OPENAI_MODEL ?? "claude-sonnet-4-5";

/** Slugify a free-text specialization label for use in a task-type key. */
export function specializationSlug(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "variant";
}

/** Compose the derived task-type key. Idempotent: `parent@x` stays `parent@x`. */
export function derivedTaskTypeKey(parentTaskType: string, label: string): string {
  const slug = specializationSlug(label);
  return parentTaskType.includes("@") ? parentTaskType : `${parentTaskType}@${slug}`;
}

/**
 * Deterministic fallback: append a specialization block to the parent body and
 * stamp lineage into a fresh frontmatter header. Used when the LLM is skipped or
 * unavailable, and as the structural contract the LLM output must satisfy.
 */
export function buildDerivedSkillContent(
  parentContent: string,
  parentTaskType: string,
  label: string,
  specialization: string,
  now: string,
): string {
  const derivedKey = derivedTaskTypeKey(parentTaskType, label);
  const lineage = [
    "<!-- trent:lineage",
    `  kind: derived`,
    `  parent: ${parentTaskType}`,
    `  specialization: ${specializationSlug(label)}`,
    `  derivedAt: ${now}`,
    "-->",
  ].join("\n");

  const specializationSection = [
    "",
    `## Specialization — ${label}`,
    `This is a DERIVED variant of \`${parentTaskType}\` (key: \`${derivedKey}\`).`,
    "Apply the parent procedure, adjusted for this context:",
    "",
    specialization.trim() || "(no specialization notes provided)",
    "",
    "When the parent skill improves, re-derive this variant rather than diverging silently.",
  ].join("\n");

  return [lineage, "", parentContent.trim(), specializationSection, ""].join("\n");
}

/** Build the LLM prompt that specializes a parent skill for a narrower context. */
export function buildDerivePrompt(
  parentContent: string,
  parentTaskType: string,
  label: string,
  specialization: string,
): string {
  return [
    "You are Trent's Skill Foundry running in DERIVED mode.",
    `Specialize the parent skill below (task type "${parentTaskType}") for this narrower context: "${label}".`,
    "Keep the parent's effective structure. Change ONLY what the specialization requires —",
    "tighten steps, swap tools, add context-specific checks. Do not invent unrelated content.",
    "Preserve a '## Specialization' section that names the context and lists the concrete deltas.",
    "",
    "Specialization context:",
    specialization,
    "",
    "Parent skill:",
    parentContent,
    "",
    "Respond with the full SKILL.md body for the derived variant (markdown, no JSON wrapper).",
  ].join("\n");
}

function makeOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    timeout: 45_000,
  });
}

async function callDeriveLLM(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return "";
  try {
    const completion = await makeOpenAIClient().chat.completions.create({
      model: DERIVE_MODEL,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    });
    return completion.choices[0]?.message.content?.trim() ?? "";
  } catch (err) {
    console.error("skill_derive.llm_failed", err);
    return "";
  }
}

export type DeriveOptions = {
  companyId: string;
  draftStore: SkillDraftStore;
  /** The narrower context, e.g. an ICP slug or segment name. */
  label: string;
  /** Free-text specialization guidance (e.g. the company's ICP + offer fields). */
  specialization: string;
  skipLLM?: boolean;
  auditLog?: typeof appendAuditLog;
  id?: string;
  now?: string;
};

/**
 * Fork a specialized child skill from a live parent skill. Returns null when the
 * parent has no live skill to derive from (you can't specialize what doesn't exist).
 */
export async function deriveSpecializedSkill(
  parentTaskType: string,
  options: DeriveOptions,
): Promise<SkillDraft | null> {
  const { companyId, draftStore, label, specialization } = options;
  const parentContent = await draftStore.readLive(companyId, parentTaskType);
  if (!parentContent) return null;

  const now = options.now ?? nowIso();
  const derivedKey = derivedTaskTypeKey(parentTaskType, label);

  let content: string;
  if (options.skipLLM) {
    content = buildDerivedSkillContent(parentContent, parentTaskType, label, specialization, now);
  } else {
    const raw = await callDeriveLLM(
      buildDerivePrompt(parentContent, parentTaskType, label, specialization),
    );
    content = raw || buildDerivedSkillContent(parentContent, parentTaskType, label, specialization, now);
  }

  await draftStore.writeQuarantine(companyId, derivedKey, content);

  const draft: SkillDraft = {
    id: options.id ?? makeId("skill"),
    companyId,
    taskType: derivedKey,
    action: "create",
    content,
    triggeredBy: [],
    status: "quarantine",
    createdAt: now,
    kind: "derived",
    parentTaskType,
    specializationLabel: specializationSlug(label),
  };

  const auditFn = options.auditLog ?? appendAuditLog;
  await auditFn(
    companyId,
    "agent",
    "skill.derived",
    "skill_draft",
    draft.id,
    `Derived "${derivedKey}" from parent "${parentTaskType}" (specialization: ${label})`,
  ).catch(() => {});

  return draft;
}

export type ProposeDerivedOptions = {
  companyId: string;
  draftStore: SkillDraftStore;
  /** Specialization label, typically a company ICP descriptor. */
  label: string;
  /** Free-text specialization guidance (e.g. ICP + offer fields). */
  specialization: string;
  /** Restrict to these parent task types; defaults to all live parents. */
  taskTypes?: string[];
  /** Cap derivations per sweep so the review queue doesn't flood. */
  maxDerivations?: number;
  skipLLM?: boolean;
  auditLog?: typeof appendAuditLog;
  now?: string;
};

/**
 * The deliberate, human-gated DERIVED trigger. For a company's live skills,
 * propose ICP-specialized child variants into quarantine (never auto-promoted —
 * the escalation seat / eval gate reviews them, like every other self-evolution).
 *
 * Idempotent: skips a parent whose variant already exists (quarantine or live),
 * and never derives from an already-derived skill. Returns the drafts created.
 */
export async function proposeDerivedSkillsForCompany(
  opts: ProposeDerivedOptions,
): Promise<SkillDraft[]> {
  const live = await opts.draftStore.listLiveTaskTypes(opts.companyId);
  const liveSet = new Set(live);
  const parents = (opts.taskTypes ?? live)
    .filter((tt) => !tt.includes("@") && liveSet.has(tt))
    .slice(0, opts.maxDerivations ?? 3);

  const drafts: SkillDraft[] = [];
  for (const parent of parents) {
    const derivedKey = derivedTaskTypeKey(parent, opts.label);
    const [existsQ, existsL] = await Promise.all([
      opts.draftStore.readQuarantine(opts.companyId, derivedKey),
      opts.draftStore.readLive(opts.companyId, derivedKey),
    ]);
    if (existsQ || existsL) continue;

    const draft = await deriveSpecializedSkill(parent, {
      companyId: opts.companyId,
      draftStore: opts.draftStore,
      label: opts.label,
      specialization: opts.specialization,
      skipLLM: opts.skipLLM,
      auditLog: opts.auditLog,
      now: opts.now,
    });
    if (draft) drafts.push(draft);
  }
  return drafts;
}
