import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import "@/lib/workbench-providers";
import { recordEvent } from "@/lib/workbench-build-helpers";
import { ensureWorkbenchSandboxReady } from "@/lib/workbench-orchestrator";
import {
  DEFAULT_UPLOAD_LIMITS,
  expandUploads,
  summarizeUpload,
  type UploadFileInput,
  type UploadEntry,
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
 * Text files are written to the workspace; binary image/assets become artifact
 * records and stay out of model context.
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
  const assets: Array<{ path: string; bytes: number; mimeType: string }> = [];
  const failed: Array<{ path: string; reason: string }> = [];

  await withRlsContext(session.companyId, async () => {
    await ensureWorkbenchSandboxReady(session);
    for (const entry of entries) {
      if (entry.status === "artifact") {
        try {
          await provider.captureArtifact(session, {
            title: `Uploaded asset: ${entry.path}`,
            kind: "file",
            mimeType: entry.mimeType ?? "application/octet-stream",
            sizeBytes: entry.size,
            path: entry.path,
            metadata: {
              schemaVersion: "workbench.upload.v1",
              source: entry.source,
              artifactOnly: true,
              reason: entry.reason,
            },
          });
          assets.push({ path: entry.path, bytes: entry.size, mimeType: entry.mimeType ?? "application/octet-stream" });
        } catch (err) {
          failed.push({ path: entry.path, reason: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      if (entry.status !== "ok" || entry.content === undefined) continue;
      try {
        await provider.writeFile(session, entry.path, entry.content);
        await ingestUploadForRetrieval(session, entry);
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
    assets,
    skipped,
    failed,
    errors,
    summary: summarizeUpload(entries, [...errors, ...failed.map((f) => `${f.path}: ${f.reason}`)]),
  }, { status: failed.length && written.length === 0 ? 500 : 201 });
}

const MAX_UPLOAD_RETRIEVAL_CHARS = 80_000;
const SECRET_PATH_RE = /(^|\/)(\.env|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|secrets?\.|credentials?\.|.*secret.*|.*token.*|.*key.*)(\/|$)/i;
const SECRET_CONTENT_RE = /\b(?:OPENAI|ANTHROPIC|GITHUB|STRIPE|POSTMARK|RESEND|E2B|DAYTONA|RAILWAY|VERCEL|AWS|GOOGLE|META|SLACK|SENTRY|DATABASE|REDIS)_[A-Z0-9_]*\s*=\s*['"]?[^'"\s]+/i;

async function ingestUploadForRetrieval(
  session: NonNullable<Awaited<ReturnType<typeof store.getWorkbenchSession>>>,
  entry: UploadEntry,
): Promise<void> {
  if (entry.status !== "ok" || entry.content === undefined) return;
  if (SECRET_PATH_RE.test(entry.path) || SECRET_CONTENT_RE.test(entry.content)) return;
  const truncated = entry.content.length > MAX_UPLOAD_RETRIEVAL_CHARS
    ? `${entry.content.slice(0, MAX_UPLOAD_RETRIEVAL_CHARS)}\n\n[Truncated for retrieval context at ${MAX_UPLOAD_RETRIEVAL_CHARS} characters.]`
    : entry.content;

  await store.createDocument({
    companyId: session.companyId,
    type: "agent_note",
    title: `Workbench upload: ${entry.path}`,
    content: [
      `# Workbench upload: ${entry.path}`,
      "",
      `- sessionId: ${session.id}`,
      `- source: ${entry.source}`,
      `- bytes: ${entry.size}`,
      "",
      truncated,
    ].join("\n"),
    source: `workbench-upload:${session.id}:${entry.path}`,
    version: 1,
    memoryTier: "semantic",
  });
}
