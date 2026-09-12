import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// The most recent failed orchestrator run
const run = await prisma.orchestratorRun.findFirst({
  where: { status: "failed" },
  orderBy: { startedAt: "desc" },
  select: { id: true, status: true, objective: true, summary: true, startedAt: true, companyId: true },
});
console.log("=== Latest FAILED orchestrator run ===");
console.log(run);

if (run) {
  const steps = await prisma.orchestratorStep.findMany({
    where: { runId: run.id },
    orderBy: { seq: "asc" },
    select: { seq: true, title: true, agentRole: true, status: true, model: true, output: true },
  });
  console.log(`\n=== Steps (${steps.length}) ===`);
  for (const s of steps) {
    console.log(`#${s.seq} [${String(s.status).padEnd(9)}] ${s.agentRole} model=${s.model ?? "-"}  ${s.title.slice(0,45)}`);
    if (s.status === "failed" || s.status === "error") console.log(`     output: ${String(s.output).slice(0, 300)}`);
  }

  const events = await prisma.orchestratorEvent.findMany({
    where: { runId: run.id },
    orderBy: { seq: "asc" },
    select: { seq: true, kind: true, payload: true },
  });
  console.log(`\n=== Events (${events.length}) — error/failed kinds ===`);
  for (const e of events) {
    const p = JSON.stringify(e.payload);
    if (/error|fail|reject|denied/i.test(e.kind) || /error|fail|exception/i.test(p)) {
      console.log(`#${e.seq} [${e.kind}] ${p.slice(0, 300)}`);
    }
  }
}
await prisma.$disconnect();
