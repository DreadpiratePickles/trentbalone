import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getGitHubCredentials,
  listGitHubRepos,
  publicGitHubConnection,
  saveGitHubConnection,
  validateGitHubConnection
} from "@/lib/github";
import { store } from "@/lib/store";
import { isHttpHeaderValueSafe } from "@/lib/http-credential";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";

const githubConnectionSchema = z.object({
  companyId: z.string().min(1).max(128),
  token: z.string().min(1).max(512).refine(isHttpHeaderValueSafe),
  owner: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
  repo: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/),
});

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  const action = url.searchParams.get("action");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  if (action === "validate") {
    return NextResponse.json({ validation: await validateGitHubConnection(companyId) });
  }

  if (action === "repos") {
    return NextResponse.json(await listGitHubRepos(companyId));
  }

  const connection = await store.getIntegration(companyId, "GitHub");
  const envReady = !!(await getGitHubCredentials());
  const validation = await validateGitHubConnection(companyId);
  return NextResponse.json({
    connection: connection ? publicGitHubConnection(connection) : undefined,
    envReady,
    validation
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const parsed = githubConnectionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid GitHub connection request" }, { status: 400 });
  }
  const body = parsed.data;

  const check = await requireRoleForRequest(user.id, "admin", { companyId: body.companyId });
  if (!check.ok) return forbidden();

  const connection = await saveGitHubConnection(body.companyId, {
    token: body.token,
    owner: body.owner,
    repo: body.repo
  });

  return NextResponse.json({ connection: publicGitHubConnection(connection) }, { status: 201 });
}
