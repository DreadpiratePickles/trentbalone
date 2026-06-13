/**
 * Shared CompanyPlaybookLog accessor: Prisma-backed when a DB is configured,
 * else a process-wide in-memory log so DB-less dev/test keeps deltas across
 * calls within the process. Both seat-prompt injection (orchestrator-runtime)
 * and reflection emission (goal-reflection) go through this seam.
 */
import { InMemoryCompanyPlaybookLog, type CompanyPlaybookLog } from "@/lib/self-improvement/company-playbook";
import { PrismaCompanyPlaybookLog } from "@/lib/self-improvement/company-playbook.prisma";

let livePlaybookLog: CompanyPlaybookLog | null = null;

export function getCompanyPlaybookLog(): CompanyPlaybookLog {
  if (livePlaybookLog) return livePlaybookLog;
  livePlaybookLog = process.env.DATABASE_URL
    ? new PrismaCompanyPlaybookLog()
    : new InMemoryCompanyPlaybookLog();
  return livePlaybookLog;
}

/** Test seam: swap the playbook log (pass null to reset to the default). */
export function setCompanyPlaybookLogForTests(log: CompanyPlaybookLog | null): void {
  livePlaybookLog = log;
}
