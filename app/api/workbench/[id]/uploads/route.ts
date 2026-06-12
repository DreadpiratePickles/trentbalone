import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import "@/lib/workbench-providers";
import { recordEvent } from "@/lib/workbench-build-helpers";
import {
  DEFAULT_UPLOAD_LIMITS,
  expandUploads,
  summarizeUpload,
  type UploadFileInput,
} from "@/lib/workbench-upload";

/**
 * POST /api/workbench/:id/uploads — upload files/folders/zips into the
 * session workspace (Fix Plan Slice 4, RC1).
 *
 * multipart/form-data:
 *   files  — one or more file parts
 *   paths  — optional JSON array of workspace-relative paths aligned with
 *            the file parts (used for folder uploads via webkitRelativePath)
 *
 * Zips are extracted server-side preserving directory structure; traversal
 * entries are rejected; limits produce explicit per-file skip reasons.
 * Every written file becomes a Workbench event so the run has evidence.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data with one or more 'files' parts" }, { status: 400 });
  }

  const parts = form.getAll("files").filter((part): part is File => part instanceof File);
  if (parts.length === 0) {
    return NextResponse.json({ error: "no files provided — append file parts under the 'files' field" }, { status: 400 });
  }

  let paths: string[] = [];
  const rawPaths = form.get("paths");
  if (typeof rawPaths === "string" && rawPaths.trim()) {
    try {
      const parsed = JSON.parse(rawPaths) as unknown;
      if (Array.isArray(parsed)) paths = parsed.map((p) => String(p));
    } catch {
      return NextResponse.json({ error: "'paths' must be a JSON array of relative paths" }, { status: 400 });
    }
  }

  const inputs: UploadFileInput[] = [];
  for (let i = 0; i < parts.length; i++) {
    const file = parts[i];
    inputs.push({
      name: file.name,
      relativePath: paths[i],
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }

  const { entries, errors } = expandUploads(inputs, DEFAULT_UPLOAD_LIMITS);
  const provider = getWorkbenchProvider(session.provider);
  const written: Array<{ path: string; bytes: number }> = [];
  const failed: Array<{ path: string; reason: string }> = [];

  await withRlsContext(session.companyId, async () => {
    for (const entry of entries) {
      if (entry.status !== "ok" || entry.content === undefined) continue;
      try {
        await provider.writeFile(session, entry.path, entry.content);
        written.push({ path: entry.path, bytes: entry.size });
        await recordEvent(
          session, "file", "completed",
          `Uploaded ${entry.path}`,
          `${entry.size} bytes (${entry.source === "zip" ? "extracted from zip" : "direct upload"})`,
        );
      } catch (err) {
        failed.push({ path: entry.path, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    const summary = summarizeUpload(entries, [...errors, ...failed.map((f) => `${f.path}: ${f.reason}`)]);
    await recordEvent(session, "system", failed.length || errors.length ? "failed" : "completed", "Upload batch", summary);
  });

  const skipped = entries
    .filter((e) => e.status === "skipped")
    .map((e) => ({ path: e.path, size: e.size, reason: e.reason ?? "skipped" }));

  return NextResponse.json({
    written,
    skipped,
    failed,
    errors,
    summary: summarizeUpload(entries, [...errors, ...failed.map((f) => `${f.path}: ${f.reason}`)]),
  }, { status: failed.length && written.length === 0 ? 500 : 201 });
}
