import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function recent(model, label, fields) {
  try {
    const rows = await prisma[model].findMany({
      orderBy: { startedAt: "desc" },
      take: 5,
      select: fields,
    }).catch(async () =>
      prisma[model].findMany({ orderBy: { createdAt: "desc" }, take: 5, select: fields }),
    );
    console.log(`\n=== ${label} (latest ${rows.length}) ===`);
    for (const r of rows) {
      const when = (r.startedAt ?? r.createdAt)?.toISOString?.() ?? "?";
      const txt = r.objective ?? r.summary ?? r.goal ?? "";
      console.log(`${when} [${String(r.status).padEnd(10)}] ${String(txt).slice(0, 55)}`);
    }
    // status histogram
    const all = await prisma[model].groupBy({ by: ["status"], _count: true }).catch(() => []);
    if (all.length) console.log("   totals:", all.map((a) => `${a.status}=${a._count}`).join("  "));
  } catch (e) {
    console.log(`\n=== ${label} === ERROR: ${e.message.slice(0, 120)}`);
  }
}

await recent("orchestratorRun", "Orchestrator runs", { status: true, objective: true, startedAt: true });
await recent("cycle", "Cycles", { status: true, summary: true, createdAt: true });
await recent("agentMissionRun", "Agent missions", { status: true, objective: true, startedAt: true });

const companies = await prisma.company.count();
console.log(`\nCompanies: ${companies}`);
await prisma.$disconnect();
