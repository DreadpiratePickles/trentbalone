import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const sessions = await prisma.workbenchSession.findMany({
  orderBy: { createdAt: "desc" },
  take: 5,
  select: { id: true, status: true, provider: true, agentMode: true, objective: true, createdAt: true },
});

console.log("=== Recent Workbench sessions ===");
for (const s of sessions) {
  console.log(`${s.createdAt.toISOString()} [${s.status.padEnd(9)}] "${s.objective.slice(0, 45)}" id=${s.id}`);
}

const latest = sessions[0];
if (latest) {
  const evs = await prisma.workbenchEvent.findMany({
    where: { sessionId: latest.id },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, type: true, status: true, title: true },
  });
  console.log(`\n=== Full timeline: "${latest.objective.slice(0,40)}" (${latest.status}), ${evs.length} events ===`);
  if (evs.length) {
    const first = evs[0].createdAt.getTime();
    const last = evs[evs.length - 1].createdAt.getTime();
    console.log(`duration: ${((last - first) / 1000).toFixed(0)}s  (${evs[0].createdAt.toISOString()} → ${evs[evs.length-1].createdAt.toISOString()})`);
    for (const e of evs) {
      const dt = ((e.createdAt.getTime() - first) / 1000).toFixed(0).padStart(4);
      console.log(`+${dt}s [${e.type}/${e.status}] ${e.title.slice(0, 70)}`);
    }
  }
}

await prisma.$disconnect();
