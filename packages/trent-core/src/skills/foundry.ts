/**
 * `@trent/core` wrapper over `apps/web/lib/skill-foundry.ts`.
 *
 * The Foundry distills a run's traces into a reusable SKILL.md draft and parks
 * it in quarantine until the eval gate signs off. It is IMPURE — an OpenAI call
 * plus an audit-log write — so it is exposed as an async factory that takes its
 * dependencies injected:
 *
 *   - `draftStore`: the quarantine/live store (an in-memory one ships here);
 *   - `auditLog`:   the audit writer, so nothing reaches the app's Prisma path;
 *   - `skipLLM`:    defaults to TRUE, so the CLI produces the deterministic
 *                   fallback skill offline unless a caller opts into a model.
 *
 * Added alongside the existing SkillsHub / SkillLoader / SecurityScan modules
 * in this directory; none of those are touched.
 *
 * Wraps: apps/web/lib/skill-foundry.ts
 */

import { InMemorySkillDraftStore as LibInMemorySkillDraftStore } from "@/lib/skill-foundry";
// Trace types come from the traces wrapper; import them from "@trent/core/traces"
// rather than re-exporting here, so the package barrel has one home per type.
import type { DistillOptions, DistillTrigger, TraceRecord } from "../traces/trace-store.js";

export type SkillAction = "create" | "patch" | "edit";

export type SkillDraft = {
  id: string;
  companyId: string;
  taskType: string;
  action: SkillAction;
  /** Full SKILL.md content (create or edit). Empty for a patch. */
  content: string;
  /** For a patch: the substring replaced. */
  oldString?: string;
  /** For a patch: the replacement. */
  newString?: string;
  triggeredBy: DistillTrigger[];
  status: "quarantine" | "live" | "rejected";
  createdAt: string;
  promotedAt?: string;
  kind?: "captured" | "fix" | "derived";
  parentTaskType?: string;
  specializationLabel?: string;
};

/** Injectable persistence port for skill drafts. */
export interface SkillDraftStore {
  writeQuarantine(companyId: string, taskType: string, content: string): Promise<string>;
  readQuarantine(companyId: string, taskType: string): Promise<string | undefined>;
  promote(companyId: string, taskType: string): Promise<void>;
  readLive(companyId: string, taskType: string): Promise<string | undefined>;
  listLiveTaskTypes(companyId: string): Promise<string[]>;
}

/** Injectable audit writer. Same positional shape as the app's `appendAuditLog`. */
export type AuditLogWriter = (
  companyId: string,
  actor: string,
  action: string,
  objectType: string,
  objectId: string,
  summary: string,
) => Promise<unknown>;

/** In-memory quarantine/live store for standalone mode and tests. */
export class InMemorySkillDraftStore implements SkillDraftStore {
  private readonly inner = new LibInMemorySkillDraftStore();

  writeQuarantine(companyId: string, taskType: string, content: string): Promise<string> {
    return this.inner.writeQuarantine(companyId, taskType, content);
  }

  readQuarantine(companyId: string, taskType: string): Promise<string | undefined> {
    return this.inner.readQuarantine(companyId, taskType);
  }

  promote(companyId: string, taskType: string): Promise<void> {
    return this.inner.promote(companyId, taskType);
  }

  readLive(companyId: string, taskType: string): Promise<string | undefined> {
    return this.inner.readLive(companyId, taskType);
  }

  listLiveTaskTypes(companyId: string): Promise<string[]> {
    return this.inner.listLiveTaskTypes(companyId);
  }
}

export type SkillFoundryOptions = {
  companyId: string;
  draftStore: SkillDraftStore;
  /**
   * Skip the distillation model call and emit the deterministic fallback skill.
   * Defaults to TRUE so `@trent/core` runs offline out of the box.
   */
  skipLLM?: boolean;
  /**
   * Where audit entries go. Defaults to a no-op rather than the app's
   * `appendAuditLog`, which would open a database connection from the CLI.
   */
  auditLog?: AuditLogWriter;
};

export type DistillRequest = DistillOptions & {
  /** Deterministic draft id for tests. */
  id?: string;
  now?: string;
};

export type SkillFoundry = {
  /** Build the agentskills.io frontmatter block for a skill. */
  frontmatter(taskType: string, description: string, tags: string[], now: string): string;
  /** The deterministic fallback SKILL.md for a run, with no model involved. */
  fallbackSkill(taskType: string, traces: readonly TraceRecord[], now: string): string;
  /** The prompt the Foundry would send to a model. */
  distillPrompt(traces: readonly TraceRecord[], taskType: string, existingContent?: string): string;
  /**
   * Full pipeline: trigger check -> distillation -> quarantine write -> audit.
   * Returns null when no distillation trigger fired.
   */
  distill(
    traces: readonly TraceRecord[],
    taskType: string,
    request?: DistillRequest,
  ): Promise<SkillDraft | null>;
};

/**
 * Build a Skill Foundry. Async because the impure half of `lib/skill-foundry.ts`
 * is imported on demand, after the caller's environment contract is in place.
 */
export async function createSkillFoundry(options: SkillFoundryOptions): Promise<SkillFoundry> {
  const {
    buildDistillPrompt,
    buildFallbackSkill,
    buildSkillFrontmatter,
    distillSkillFromTraces,
  } = await import("@/lib/skill-foundry");

  const skipLLM = options.skipLLM ?? true;
  const auditLog: AuditLogWriter = options.auditLog ?? (async () => undefined);

  return {
    frontmatter(taskType, description, tags, now) {
      return buildSkillFrontmatter(taskType, options.companyId, description, tags, now);
    },

    fallbackSkill(taskType, traces, now) {
      return buildFallbackSkill(
        taskType,
        options.companyId,
        traces as unknown as Parameters<typeof buildFallbackSkill>[2],
        now,
      );
    },

    distillPrompt(traces, taskType, existingContent) {
      return buildDistillPrompt(
        traces as unknown as Parameters<typeof buildDistillPrompt>[0],
        taskType,
        existingContent,
      );
    },

    async distill(traces, taskType, request = {}) {
      const draft = await distillSkillFromTraces(
        traces as unknown as Parameters<typeof distillSkillFromTraces>[0],
        taskType,
        {
          ...request,
          companyId: options.companyId,
          draftStore: options.draftStore as unknown as Parameters<
            typeof distillSkillFromTraces
          >[2]["draftStore"],
          skipLLM,
          auditLog: auditLog as unknown as Parameters<typeof distillSkillFromTraces>[2]["auditLog"],
        },
      );
      return draft as unknown as SkillDraft | null;
    },
  };
}
