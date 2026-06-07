import { NextResponse } from "next/server";
import { artifactToCsv, artifactToHtml } from "@/lib/artifacts";
import { artifactToPdf, artifactToXlsx } from "@/lib/artifact-exporters";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const artifact = await store.getArtifact(id);
  if (!artifact) return NextResponse.json({ error: "artifact not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: artifact.companyId });
  if (!check.ok) return forbidden();

  const format = new URL(request.url).searchParams.get("format") ?? artifact.exportFormat;
  const slug = artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "artifact";

  if (format === "html") {
    return new NextResponse(artifactToHtml(artifact), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slug}.html"`
      }
    });
  }

  if (format === "pdf") {
    const pdf = artifactToPdf(artifact);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${slug}.pdf"`
      }
    });
  }

  if (format === "csv") {
    return new NextResponse(artifactToCsv(artifact), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slug}.csv"`
      }
    });
  }

  if (format === "xlsx") {
    const workbook = artifactToXlsx(artifact);
    return new NextResponse(new Uint8Array(workbook), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${slug}.xlsx"`
      }
    });
  }

  if (format === "dashboard_json") {
    return NextResponse.json({
      id: artifact.id,
      title: artifact.title,
      summary: artifact.summary,
      metrics: artifact.content.match(/KPI cards: ([^\n]+)/)?.[1] ?? "",
      provenance: artifact.provenance
    }, {
      headers: {
        "Content-Disposition": `attachment; filename="${slug}.dashboard.json"`
      }
    });
  }

  return new NextResponse(artifact.content, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}.md"`
    }
  });
}
