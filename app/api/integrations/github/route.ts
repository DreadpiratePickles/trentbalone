import { NextResponse } from "next/server";
import {
  getGitHubCredentials,
  listGitHubRepos,
  publicGitHubConnection,
  saveGitHubConnection,
  validateGitHubConnection
} from "@/lib/github";
import { store } from "@/lib/store";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";

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

  const body = await request.json();
  if (!body.companyId || !body.token || !body.owner || !body.repo) {
    return NextResponse.json(
      { error: "companyId, token, owner, and repo are required" },
      { status: 400 }
    );
  }

  const check = await requireRoleForRequest(user.id, "admin", { companyId: body.companyId });
  if (!check.ok) return forbidden();

  const connection = await saveGitHubConnection(body.companyId, {
    token: String(body.token),
    owner: String(body.owner),
    repo: String(body.repo)
  });

  return NextResponse.json({ connection: publicGitHubConnection(connection) }, { status: 201 });
}

