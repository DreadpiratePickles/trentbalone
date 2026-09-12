/**
 * lib/custom-skill-store.ts — §3.2 client-added skills persistence.
 *
 * Instruction-style procedures a client authors in Settings (markdown
 * procedures, brand rules, "how we qualify leads"). Instruction-only — no
 * client code, so there is nothing to sandbox. These flow into seat prompts
 * through buildCustomSkillPrelude (lib/agent-skill-instructions.ts), the same
 * prelude path used by granted/distilled skills.
 */
import { db } from "@/lib/db";
import { makeId } from "@/lib/utils";

export type CompanyCustomSkillRecord = {
  id: string;
  companyId: string;
  name: string;
  trigger: string;
  instructions: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  companyId: string;
  name: string;
  trigger: string;
  instructions: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function fromRow(row: Row): CompanyCustomSkillRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    trigger: row.trigger,
    instructions: row.instructions,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listCustomSkills(companyId: string): Promise<CompanyCustomSkillRecord[]> {
  const rows = await db.companyCustomSkill.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(fromRow);
}

export async function createCustomSkill(input: {
  companyId: string;
  name: string;
  trigger?: string;
  instructions: string;
  enabled?: boolean;
}): Promise<CompanyCustomSkillRecord> {
  const row = await db.companyCustomSkill.create({
    data: {
      id: makeId("cskill"),
      companyId: input.companyId,
      name: input.name,
      trigger: input.trigger ?? "",
      instructions: input.instructions,
      enabled: input.enabled ?? true,
    },
  });
  return fromRow(row);
}

export async function updateCustomSkill(
  companyId: string,
  id: string,
  patch: Partial<Pick<CompanyCustomSkillRecord, "name" | "trigger" | "instructions" | "enabled">>,
): Promise<CompanyCustomSkillRecord | null> {
  const { count } = await db.companyCustomSkill.updateMany({
    where: { id, companyId },
    data: patch,
  });
  if (count === 0) return null;
  const row = await db.companyCustomSkill.findUnique({ where: { id } });
  return row ? fromRow(row) : null;
}

export async function deleteCustomSkill(companyId: string, id: string): Promise<boolean> {
  const { count } = await db.companyCustomSkill.deleteMany({ where: { id, companyId } });
  return count > 0;
}
