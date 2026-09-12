import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { getWorkbenchProvider, type WorkbenchFileEntry } from "@/lib/workbench-provider";
import type { WorkbenchArtifact } from "@/lib/types";
import "@/lib/workbench-providers";

const PROVIDER_BOOTSTRAP_ROOT_FILES = new Set(["README.md"]);

/** GET /api/workbench/:id/files?path=  — list files */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const rawDirPath = new URL(request.url).searchParams.get("path") ?? undefined;
  const dirPath = rawDirPath?.trim() || undefined;
  const provider = getWorkbenchProvider(session.provider);

  try {
    const { files, artifacts } = await withRlsContext(session.companyId, async () => {
      const files = await provider.listFiles(session, dirPath);
      const artifacts = await store.listWorkbenchArtifacts(session.id).catch(() => []);
      return { files, artifacts };
    });
    return NextResponse.json({ files: filterProviderBootstrapFiles(files, artifacts, dirPath) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to list files" }, { status: 400 });
  }
}

/** POST /api/workbench/:id/files  — read or write a file */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const body = await request.json().catch(() => ({})) as {
    op: "read" | "write";
    path?: string;
    content?: string;
  };

  if (body.op !== "read" && body.op !== "write") {
    return NextResponse.json({ error: "op must be 'read' or 'write'" }, { status: 400 });
  }

  const role = body.op === "write" ? "member" : "viewer";
  const check = await requireRoleForRequest(user.id, role, { companyId: session.companyId });
  if (!check.ok) return forbidden();

  if (!body.path?.trim()) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  const provider = getWorkbenchProvider(session.provider);
  // Hoist narrowed path before entering the closure (preserves TS narrowing).
  const filePath = body.path.trim();

  if (body.op === "write" && body.content === undefined) {
    return NextResponse.json({ error: "content is required for write" }, { status: 400 });
  }

  try {
    if (body.op === "read") {
      const content = await withRlsContext(session.companyId, () => provider.readFile(session, filePath));
      return NextResponse.json({ content });
    } else {
      // body.content is guaranteed defined — checked above and hoisted into a const.
      const fileContent = body.content as string;
      await withRlsContext(session.companyId, () => provider.writeFile(session, filePath, fileContent));
      return NextResponse.json({ ok: true });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "File operation failed" }, { status: 400 });
  }
}

function filterProviderBootstrapFiles(
  files: WorkbenchFileEntry[],
  artifacts: WorkbenchArtifact[],
  dirPath?: string,
): WorkbenchFileEntry[] {
  if (dirPath) return files;
  const artifactFilePaths = new Set(
    artifacts
      .filter((artifact) => artifact.kind === "file" && typeof artifact.path === "string" && artifact.path.trim().length > 0)
      .map((artifact) => artifact.path!.trim()),
  );

  return files.filter((file) => (
    file.isDir
    || !PROVIDER_BOOTSTRAP_ROOT_FILES.has(file.path)
    || artifactFilePaths.has(file.path)
  ));
}
