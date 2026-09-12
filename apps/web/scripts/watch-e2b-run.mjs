import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const startedAt = new Date();
let seen = null, lastKey = "";

process.stdout.write(`watching for new E2B workbench runs since ${startedAt.toISOString()}\n`);

for (let i = 0; i < 150; i++) {
  try {
    const s = await prisma.workbenchSession.findFirst({
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, provider: true, objective: true, createdAt: true },
    });
    if (s && s.createdAt > startedAt) {
      if (!seen) {
        seen = s.id;
        process.stdout.write(`NEW RUN: "${s.objective.slice(0,45)}" provider=${s.provider} id=${s.id}\n`);
        if (s.provider !== "e2b") process.stdout.write(`  ⚠️ provider is '${s.provider}', expected 'e2b'\n`);
      }
      // surface E2B sandbox + preview events
      const ev = await prisma.workbenchEvent.findFirst({
        where: { sessionId: s.id }, orderBy: { createdAt: "desc" },
        select: { type: true, status: true, title: true, content: true },
      });
      const key = `${s.status}|${ev?.title ?? ""}`;
      if (key !== lastKey) {
        lastKey = key;
        let line = `[${s.status}] ${ev ? `${ev.type}/${ev.status}: ${ev.title.slice(0,70)}` : "(starting)"}`;
        if (ev && /e2b|sandbox|preview|\.e2b\.app/i.test(`${ev.title} ${ev.content ?? ""}`)) {
          const url = (ev.content ?? "").match(/https?:\/\/[^\s"]+e2b\.app[^\s"]*/);
          if (url) line += `\n   🔗 ${url[0]}`;
          else if (/sandbox/i.test(ev.title)) line += `\n   📦 ${(ev.content ?? "").slice(0,80)}`;
        }
        process.stdout.write(line + "\n");
      }
      if (["completed","failed","cancelled"].includes(s.status)) {
        const sb = await prisma.workbenchEvent.findFirst({ where:{ sessionId:s.id, title:{ contains:"sandbox" } }, select:{ content:true }});
        process.stdout.write(`RUN ENDED: status=${s.status} provider=${s.provider}\n`);
        if (sb) process.stdout.write(`sandbox: ${(sb.content??"").slice(0,90)}\n`);
        break;
      }
    }
  } catch (e) { process.stdout.write(`poll error: ${String(e.message).slice(0,80)}\n`); }
  await new Promise(r => setTimeout(r, 7000));
}
await prisma.$disconnect();
