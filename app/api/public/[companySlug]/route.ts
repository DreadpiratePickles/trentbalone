import { NextResponse } from "next/server";
import { store } from "@/lib/store";

export async function GET(_: Request, { params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  const company = await store.getCompany(companySlug);
  if (!company || !company.publicVisibility) {
    return NextResponse.json({ error: "Public company not found" }, { status: 404 });
  }
  const [cycles, reports, tasks] = await Promise.all([
    store.listCycles(company.id),
    store.listReports(company.id),
    store.listTasks(company.id)
  ]);
  return NextResponse.json({
    company: {
      name: company.name,
      slug: company.slug,
      vision: company.brief.vision,
      goals: company.brief.goals,
      metrics: company.metrics,
      publicShipped: company.brief.publicShipped ?? "",
      publicLearning: company.brief.publicLearning ?? "",
      publicFocus: company.brief.publicFocus ?? "",
    },
    latestCycle: cycles[0] ? {
      id: cycles[0].id,
      status: cycles[0].status,
      startedAt: cycles[0].startedAt,
      completedAt: cycles[0].completedAt,
    } : null,
    reports: reports.slice(0, 3).map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAt,
    })),
    tasks: tasks.slice(0, 6).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      agentRole: t.agentRole,
    }))
  });
}
