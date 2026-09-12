/**
 * Prisma-backed SkillDraftStore implementation.
 *
 * Stores skill drafts in the SkillDraft table with status lifecycle:
 *   quarantine → live (on promote) / rejected (when superseded).
 *
 * At most ONE quarantine row per (companyId, taskType) is enforced by
 * writeQuarantine (delete-then-create). promote() uses a transaction to
 * archive any existing live row as "rejected" before promoting the quarantine
 * row to "live".
 *
 * Implements the SkillDraftStore interface from lib/skill-foundry.ts.
 */

import { db } from "@/lib/db";
import { withRlsContext } from "@/lib/with-rls";
import type { SkillDraftStore } from "@/lib/skill-foundry";

export class PrismaSkillDraftStore implements SkillDraftStore {
  async writeQuarantine(companyId: string, taskType: string, content: string): Promise<string> {
    return withRlsContext(companyId, async () => {
      // Ensure at most one quarantine row per (companyId, taskType).
      await db.skillDraft.deleteMany({
        where: { companyId, taskType, status: "quarantine" },
      });
      const row = await db.skillDraft.create({
        data: {
          companyId,
          taskType,
          status: "quarantine",
          content,
        },
      });
      return row.id;
    });
  }

  async readQuarantine(companyId: string, taskType: string): Promise<string | undefined> {
    return withRlsContext(companyId, async () => {
      const row = await db.skillDraft.findFirst({
        where: { companyId, taskType, status: "quarantine" },
      });
      return row?.content ?? undefined;
    });
  }

  async promote(companyId: string, taskType: string): Promise<void> {
    await withRlsContext(companyId, async () => {
      const quarantine = await db.skillDraft.findFirst({
        where: { companyId, taskType, status: "quarantine" },
      });
      if (!quarantine) return;

      await db.$transaction(async (tx) => {
        // Archive any existing live row(s) as rejected.
        await tx.skillDraft.updateMany({
          where: { companyId, taskType, status: "live" },
          data: { status: "rejected" },
        });
        // Promote the quarantine row to live.
        await tx.skillDraft.update({
          where: { id: quarantine.id },
          data: { status: "live", promotedAt: new Date() },
        });
      });
    });
  }

  async readLive(companyId: string, taskType: string): Promise<string | undefined> {
    return withRlsContext(companyId, async () => {
      const row = await db.skillDraft.findFirst({
        where: { companyId, taskType, status: "live" },
      });
      return row?.content ?? undefined;
    });
  }

  async listLiveTaskTypes(companyId: string): Promise<string[]> {
    return withRlsContext(companyId, async () => {
      const rows = await db.skillDraft.findMany({
        where: { companyId, status: "live" },
        select: { taskType: true },
        distinct: ["taskType"],
      });
      return rows.map((r) => r.taskType);
    });
  }
}
