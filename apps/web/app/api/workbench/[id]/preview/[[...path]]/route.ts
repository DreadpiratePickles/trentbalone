import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { isHostAppPreviewUrl } from "@/lib/workbench-preview";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string; path?: string[] }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id, path = [] } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  if (!session.previewUrl) {
    return NextResponse.json({ error: "preview is not ready" }, { status: 404 });
  }
  if (isHostAppPreviewUrl(session.previewUrl)) {
    return NextResponse.json({
      error: "preview points at the Trent app port, not a sandbox server",
    }, { status: 409 });
  }

  const target = buildPreviewTarget(session.previewUrl, path, new URL(request.url).search);
  if (!target) {
    return NextResponse.json({ error: "invalid preview url" }, { status: 400 });
  }

  try {
    const upstream = await fetch(target, { redirect: "manual" });
    const headers = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    headers.set("Cache-Control", "no-store");
    const contentType = headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      const html = await upstream.text();
      headers.delete("content-length");
      return new Response(rewritePreviewHtml(html, `/api/workbench/${id}/preview/`), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : "preview proxy failed",
    }, { status: 502 });
  }
}

function rewritePreviewHtml(html: string, href: string): string {
  const base = `<base href="${href}">`;
  const withBase = /<base\s/i.test(html)
    ? html
    : /<head[^>]*>/i.test(html)
      ? html.replace(/<head([^>]*)>/i, `<head$1>${base}`)
      : `${base}${html}`;

  return withBase.replace(/\b(src|href)=["']\/(?!\/|api\/workbench\/)([^"']*)["']/gi, (_match, attr: string, assetPath: string) => {
    return `${attr}="${href}${assetPath}"`;
  }).replace(/url\(["']?\/(?!\/|api\/workbench\/)([^)"']+)["']?\)/gi, (_match, assetPath: string) => {
    return `url("${href}${assetPath}")`;
  });
}

function buildPreviewTarget(previewUrl: string, pathSegments: string[], search: string): string | undefined {
  try {
    const target = new URL(previewUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
    const basePath = target.pathname.endsWith("/") ? target.pathname : `${target.pathname}/`;
    const relativePath = pathSegments
      // Never let a crafted path walk above the preview root on the upstream.
      .filter((segment) => segment !== ".." && segment !== ".")
      // encodeURIComponent would turn Vite's internal "@vite/client" and
      // "@react-refresh" into "%40vite/…", which Vite's middleware does NOT
      // match — it falls through to the index.html fallback and the browser
      // rejects the module ("MIME type text/html"), white-screening the
      // preview while every request reads 200. Keep "@" literal.
      .map((segment) => encodeURIComponent(segment).replace(/%40/gi, "@"))
      .join("/");
    target.pathname = relativePath ? `${basePath}${relativePath}`.replace(/\/{2,}/g, "/") : basePath;
    target.search = search;
    return target.toString();
  } catch {
    return undefined;
  }
}
