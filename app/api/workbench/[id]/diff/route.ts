import { NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import "@/lib/workbench-providers";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const provider = getWorkbenchProvider(session.provider);

  try {
    return await withRlsContext(session.companyId, async () => {
      const checkpoint = await store.getWorkbenchCheckpoint(session.id).catch(() => undefined);

      if (provider.diffSinceCheckpoint) {
        const diff = await provider.diffSinceCheckpoint(session, checkpoint?.fileTreeHash);
        return NextResponse.json({ diff, checkpoint });
      }

      const files = provider.getFileTree
        ? await provider.getFileTree(session, { depth: 8 })
        : await provider.listFiles(session);
      return NextResponse.json({
        diff: {
          changedPaths: files.filter((file) => !file.isDir).map((file) => file.path),
          summary: "Provider does not expose a diff; returning current file list.",
          fromHash: checkpoint?.fileTreeHash,
        },
        checkpoint,
      });
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to compute diff" }, { status: 400 });
  }
}
