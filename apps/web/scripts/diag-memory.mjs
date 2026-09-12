// Diagnose whether agent/orchestrator work is actually persisted to memory (Documents).
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_PUBLIC_URL } } });

const docCount = await prisma.document.count();
const byTier = await prisma.document.groupBy({ by: ["memoryTier"], _count: true }).catch(() => []);
const vaultDocs = await prisma.document.count({ where: { source: { startsWith: "vault:" } } });
console.log("=== Documents (memory) ===");
console.log("total documents:", docCount, "| vault-sourced:", vaultDocs);
console.log("by memoryTier:", byTier.map((t) => `${t.memoryTier}:${t._count}`).join("  ") || "(none)");

const recent = await prisma.document.findMany({
  orderBy: { createdAt: "desc" }, take: 5,
  select: { title: true, type: true, source: true, memoryTier: true, createdAt: true },
});
console.log("\n=== 5 most recent documents ===");
for (const d of recent) console.log(`- [${d.memoryTier ?? "-"}] ${d.type} "${String(d.title).slice(0,40)}" src=${String(d.source).slice(0,32)} @${d.createdAt.toISOString().slice(0,16)}`);

console.log("\n=== Most recent orchestrator run vs whether its outputs were saved as memory ===");
const run = await prisma.orchestratorRun.findFirst({
  orderBy: { startedAt: "desc" },
  select: { id: true, status: true, objective: true, startedAt: true, companyId: true },
});
console.log("run:", run?.id, run?.status, "@", run?.startedAt?.toISOString().slice(0,16));
if (run) {
  const steps = await prisma.orchestratorStep.findMany({
    where: { runId: run.id }, orderBy: { seq: "asc" },
    select: { seq: true, agentRole: true, status: true, output: true },
  });
  const withOutput = steps.filter((s) => s.output && String(s.output).length > 0);
  console.log(`steps: ${steps.length} | steps with output saved on the step row: ${withOutput.length}`);
  // did any Document get created from this run's window?
  const since = run.startedAt;
  const docsAfter = await prisma.document.count({ where: { companyId: run.companyId, createdAt: { gte: since } } });
  console.log(`Documents created for this company since the run started: ${docsAfter}  <-- if 0, outputs were NOT promoted to memory`);
}
await prisma.$disconnect();
