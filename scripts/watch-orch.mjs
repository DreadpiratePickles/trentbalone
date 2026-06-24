import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const startedAt = new Date();
let runSeen = null;
let lastKey = "";

process.stdout.write(`watching for new orchestrator runs since ${startedAt.toISOString()}\n`);

for (let i = 0; i < 90; i++) {
  try {
    const run = await prisma.orchestratorRun.findFirst({
      orderBy: { startedAt: "desc" },
      select: { id: true, status: true, objective: true, startedAt: true },
    });
    if (run && run.startedAt > startedAt) {
      if (!runSeen) {
        runSeen = run.id;
        process.stdout.write(`NEW CYCLE: "${run.objective.slice(0, 55)}" [${run.status}]\n`);
      }
      const steps = await prisma.orchestratorStep.findMany({
        where: { runId: run.id },
        orderBy: { seq: "asc" },
        select: { seq: true, agentRole: true, status: true, title: true },
      });
      const done = steps.filter((s) => ["completed", "failed", "skipped"].includes(s.status)).length;
      const failed = steps.filter((s) => s.status === "failed");
      const key = `${run.status}|${done}/${steps.length}|${failed.length}`;
      if (key !== lastKey) {
        lastKey = key;
        process.stdout.write(`[run:${run.status}] steps ${done}/${steps.length} done, ${failed.length} failed\n`);
        for (const s of failed.slice(0, 2)) process.stdout.write(`   FAILED #${s.seq} ${s.agentRole}: ${s.title.slice(0, 50)}\n`);
      }
      if (["completed", "failed", "cancelled", "awaiting_approval"].includes(run.status)) {
        process.stdout.write(`CYCLE ENDED: status=${run.status} (${done}/${steps.length} steps, ${failed.length} failed)\n`);
        // did the memory/analyze step fail on Vault Memory?
        const mem = steps.find((s) => /memory|analyze|inspect|state/i.test(s.title));
        if (mem) process.stdout.write(`memory/analyze step: #${mem.seq} [${mem.status}] ${mem.title.slice(0,50)}\n`);
        break;
      }
    }
  } catch (e) {
    process.stdout.write(`poll error: ${String(e.message).slice(0, 80)}\n`);
  }
  await new Promise((r) => setTimeout(r, 7000));
}
await prisma.$disconnect();
