// Does Workbench work persist durably (checkpoints + artifacts in DB), or only live in the container/sandbox?
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_PUBLIC_URL } } });

const sessions = await prisma.workbenchSession.findMany({
  orderBy: { startedAt: "desc" }, take: 8,
  select: { id: true, objective: true, status: true, provider: true, previewUrl: true, storageKey: true, startedAt: true },
});
console.log("=== 8 most recent Workbench sessions ===");
for (const s of sessions) {
  const [ar, ev] = await Promise.all([
    prisma.workbenchArtifact.count({ where: { sessionId: s.id } }),
    prisma.workbenchEvent.count({ where: { sessionId: s.id } }),
  ]);
  const ck = await prisma.workbenchCheckpoint.count({ where: { sessionId: s.id } }).catch(() => "n/a");
  console.log(`- ${s.id} [${s.status}] prov=${s.provider ?? "-"} artifacts=${ar} ckpt=${ck} events=${ev} preview=${s.previewUrl ? "yes" : "no"} storageKey=${s.storageKey ? "yes" : "NO"}  "${String(s.objective).slice(0,30)}" @${s.startedAt?.toISOString().slice(0,16)}`);
}

const ckTotal = await prisma.workbenchCheckpoint.count();
const arTotal = await prisma.workbenchArtifact.count();
const withStorage = await prisma.workbenchSession.count({ where: { storageKey: { not: null } } });
const total = await prisma.workbenchSession.count();
console.log(`\nTOTALS -> sessions:${total}  with storageKey(durable snapshot):${withStorage}  checkpoints:${ckTotal}  artifacts:${arTotal}`);
await prisma.$disconnect();
