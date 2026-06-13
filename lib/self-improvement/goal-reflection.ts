/**
 * lib/self-improvement/goal-reflection.ts — §3.1 self-improvement loop.
 *
 * After the CEO's goal review, mine the round's traces (per-seat critic outcomes)
 * for patterns and write them as SKILL DRAFTS into quarantine. Drafts DO NOT go
 * live on vibes — promotion stays gated by the existing eval harness
 * (lib/self-improvement/promotion.ts) and injection stays behind
 * SKILL_INJECTION_ENABLED. This module only closes the "traces → drafts" hop:
 * the rest of the loop (eval gate → injection → measure → keep/kill) already
 * exists. Tenant-isolated by companyId.
 */
import { PrismaSkillDraftStore } from "@/lib/self-improvement/skill-draft-store.prisma";
import { buildSkillFrontmatter } from "@/lib/skill-foundry";
import {
  buildPlaybookDelta,
  type CompanyPlaybookLog,
} from "@/lib/self-improvement/company-playbook";
import { getCompanyPlaybookLog } from "@/lib/self-improvement/company-playbook-log";
import type { Company } from "@/lib/types";
import type { Goal } from "@/lib/goal-types";

type ExecutedTrace = { seat: string; ok: boolean; verdict: string; objective: string };

const REFLECTION_ENABLED = process.env.GOAL_REFLECTION_ENABLED !== "false";

export async function deriveSkillDraftsFromGoalRound(input: {
  company: Company;
  goal: Goal;
  executed: ExecutedTrace[];
  playbookLog?: CompanyPlaybookLog;
}): Promise<{ draftsWritten: number; playbookDeltas: number }> {
  if (!REFLECTION_ENABLED || input.executed.length === 0) return { draftsWritten: 0, playbookDeltas: 0 };

  // Aggregate per-seat outcomes for this round.
  const bySeat = new Map<string, { passes: number; total: number; objectives: string[] }>();
  for (const e of input.executed) {
    const agg = bySeat.get(e.seat) ?? { passes: 0, total: 0, objectives: [] };
    agg.total += 1;
    if (e.ok && e.verdict === "pass") {
      agg.passes += 1;
      agg.objectives.push(e.objective);
    }
    bySeat.set(e.seat, agg);
  }

  const store = new PrismaSkillDraftStore();
  let draftsWritten = 0;

  for (const [seat, agg] of bySeat) {
    // Only mine seats that produced a clean, accepted artifact this round — the
    // signal that there is a reusable procedure worth capturing.
    if (agg.passes === 0 || agg.objectives.length === 0) continue;
    const taskType = `goal-seat-${seat}`;
    const exemplar = agg.objectives[0];
    const frontmatter = buildSkillFrontmatter(
      taskType,
      input.company.id,
      `Reusable procedure distilled from a goal round where the ${seat} seat produced a critic-accepted artifact.`,
      ["goal-loop", seat],
      new Date().toISOString(),
    );
    const content = [
      frontmatter,
      `# ${seat} — goal-round procedure`,
      "",
      `When working a goal round as the **${seat}** seat, the following approach passed the evidence critic:`,
      "",
      `1. Read the targeted success criteria first and shape the artifact to satisfy them directly.`,
      `2. Produce a concrete, self-contained artifact (not a prose claim) — e.g. "${exemplar.slice(0, 140)}".`,
      `3. Cite which criterion the artifact advances so the CEO review can map evidence.`,
      "",
      `_Captured from goal "${input.goal.objective.slice(0, 120)}". Quarantined — promotion is eval-gated._`,
    ].join("\n");

    try {
      await store.writeQuarantine(input.company.id, taskType, content);
      draftsWritten += 1;
    } catch {
      /* best-effort: a draft-store failure must never break a goal round */
    }
  }

  const playbookLog = input.playbookLog ?? getCompanyPlaybookLog();
  let playbookDeltas = 0;
  for (const [seat, agg] of bySeat) {
    const delta = agg.passes > 0
      ? buildPlaybookDelta({
          companyId: input.company.id,
          kind: "revise",
          topic: `goal.${seat}`,
          text: `Proven approach for ${seat} goal work: shape a self-contained artifact directly to the success criteria (last accepted: "${(agg.objectives[0] ?? "").slice(0, 100)}").`,
        })
      : agg.total > 0
        ? buildPlaybookDelta({
            companyId: input.company.id,
            kind: "revise",
            topic: `goal.${seat}.caution`,
            text: `Every ${seat} artifact failed the critic last goal round - re-read the success criteria first and produce evidence-bearing artifacts, not prose claims.`,
          })
        : undefined;
    if (!delta) continue;
    try {
      await playbookLog.append(delta);
      playbookDeltas += 1;
    } catch {
      /* best-effort: playbook failures must never break a goal round */
    }
  }

  return { draftsWritten, playbookDeltas };
}
