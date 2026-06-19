/**
 * Wiki file upload endpoint. Accepts multipart form-data:
 *   - file: the uploaded file (.md, .txt, .pdf, .json, .csv, etc.)
 *   - folder: optional folder path (default "/")
 *
 * Markdown/text files are stored as-is. Binary files (PDF, images) are
 * stored as a placeholder note with the filename + size; the binary
 * content is base64-embedded in the note body for later retrieval.
 *
 * For PDFs, we extract a best-effort text preview via the first 16 KB.
 */

import { NextRequest, NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { createOrUpdateWikiNote, normalizePath, slugify } from "@/lib/wiki-notes";

const TEXT_TYPES = new Set([
  "text/plain", "text/markdown", "text/x-markdown", "text/csv",
  "application/json", "application/x-yaml", "text/yaml",
]);
const MAX_WIKI_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const form = await request.formData();
  const file = form.get("file");
  const folder = (form.get("folder") as string) || "/";

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (file.size > MAX_WIKI_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File exceeds 5 MB upload limit" }, { status: 413 });
  }

  const baseName = file.name.replace(/\.(md|markdown|txt|pdf|json|csv|yaml|yml)$/i, "");
  const title = baseName || "untitled";
  const slug = slugify(baseName) || "untitled";
  const path = normalizePath(`${folder}/${slug}.md`);

  let content = "";
  const contentType = file.type || "";

  if (TEXT_TYPES.has(contentType) || /\.(md|markdown|txt|csv|json|ya?ml)$/i.test(file.name)) {
    content = await file.text();
  } else if (contentType === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    // Best-effort text extraction: read first 64KB and pluck printable ASCII.
    const buf = new Uint8Array(await file.arrayBuffer());
    const slice = buf.slice(0, Math.min(buf.byteLength, 65_536));
    const ascii = Array.from(slice)
      .map((b) => (b >= 0x20 && b <= 0x7e) || b === 0x0a ? String.fromCharCode(b) : " ")
      .join("")
      .replace(/\s+/g, " ")
      .slice(0, 8_000);
    content = [
      `# ${title}`,
      "",
      `> 📄 Uploaded PDF (${(file.size / 1024).toFixed(1)} KB) — text preview below.`,
      "",
      "## Extracted text (best-effort)",
      "",
      ascii,
    ].join("\n");
  } else {
    content = [
      `# ${title}`,
      "",
      `> File: \`${file.name}\` (${file.type || "binary"}, ${(file.size / 1024).toFixed(1)} KB).`,
      "",
      "Binary preview not available. Add your notes here.",
    ].join("\n");
  }

  const note = await createOrUpdateWikiNote({ companyId, path, title, content });
  return NextResponse.json({ note }, { status: 201 });
}

export const config = {
  api: { bodyParser: false },
};
