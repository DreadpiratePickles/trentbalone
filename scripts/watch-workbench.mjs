import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const startedAt = new Date();
let lastKey = "";
let sessionSeen = null;

process.stdout.write(`watching for new workbench runs since ${startedAt.toISOString()}\n`);

for (let i = 0; i < 120; i++) {
  try {
    const s = await prisma.workbenchSession.findFirst({
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, objective: true, createdAt: true },
    });
    if (s && s.createdAt > startedAt) {
      if (!sessionSeen) {
        sessionSeen = s.id;
        process.stdout.write(`NEW RUN: "${s.objective.slice(0, 50)}" [${s.status}] id=${s.id}\n`);
      }
      const ev = await prisma.workbenchEvent.findFirst({
        where: { sessionId: s.id },
        orderBy: { createdAt: "desc" },
        select: { type: true, status: true, title: true },
      });
      const key = `${s.status}|${ev?.title ?? ""}`;
      if (key !== lastKey) {
        lastKey = key;
        process.stdout.write(`[${s.status}] ${ev ? `${ev.type}/${ev.status}: ${ev.title.slice(0, 80)}` : "(starting)"}\n`);
      }
      if (["completed", "failed", "cancelled"].includes(s.status)) {
        process.stdout.write(`RUN ENDED: status=${s.status}\n`);
        break;
      }
    }
  } catch (e) {
    process.stdout.write(`poll error: ${String(e.message).slice(0, 80)}\n`);
  }
  await new Promise((r) => setTimeout(r, 8000));
}
await prisma.$disconnect();
