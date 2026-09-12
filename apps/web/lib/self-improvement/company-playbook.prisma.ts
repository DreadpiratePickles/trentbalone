/**
 * Prisma-backed CompanyPlaybookLog implementation.
 *
 * Stores ACE playbook deltas in the CompanyPlaybookEntry table. Reads/writes
 * are wrapped in withRlsContext so RLS policies fire on Postgres (no-op on
 * SQLite/dev). Implements the CompanyPlaybookLog interface from
 * lib/self-improvement/company-playbook.ts.
 */
import { db } from "@/lib/db";
import { withRlsContext } from "@/lib/with-rls";
import type {
  CompanyPlaybookEntry,
  CompanyPlaybookLog,
  PlaybookDeltaKind,
  PlaybookEntryStatus,
} from "@/lib/self-improvement/company-playbook";

function rowToEntry(row: {
  id: string;
  companyId: string;
  kind: string;
  topic: string;
  text: string;
  sourceRunId: string | null;
  status: string;
  createdAt: Date;
}): CompanyPlaybookEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as PlaybookDeltaKind,
    topic: row.topic,
    text: row.text,
    sourceRunId: row.sourceRunId ?? undefined,
    status: row.status as PlaybookEntryStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaCompanyPlaybookLog implements CompanyPlaybookLog {
  async append(entry: CompanyPlaybookEntry): Promise<void> {
    await withRlsContext(entry.companyId, async () => {
      await db.companyPlaybookEntry.create({
        data: {
          id: entry.id,
          companyId: entry.companyId,
          kind: entry.kind,
          topic: entry.topic,
          text: entry.text,
          sourceRunId: entry.sourceRunId ?? null,
          status: entry.status,
          createdAt: new Date(entry.createdAt),
        },
      });
    });
  }

  async list(companyId: string): Promise<CompanyPlaybookEntry[]> {
    return withRlsContext(companyId, async () => {
      const rows = await db.companyPlaybookEntry.findMany({
        where: { companyId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(rowToEntry);
    });
  }

  async setStatus(companyId: string, entryId: string, status: PlaybookEntryStatus): Promise<void> {
    await withRlsContext(companyId, async () => {
      await db.companyPlaybookEntry.updateMany({
        where: { id: entryId, companyId },
        data: { status },
      });
    });
  }
}
