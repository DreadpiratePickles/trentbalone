import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { store } from "@/lib/store";
import { listAppBuilderRuns, startAppBuilderRun } from "@/lib/app-builder/runs";
import { withRlsContext } from "@/lib/with-rls";
import type {
  AppBuilderBackendProfile,
  AppBuilderFramework,
  AppBuilderSandboxProvider,
} from "@/lib/app-builder/types";

const frameworks: AppBuilderFramework[] = ["nextjs", "vite_react", "remix", "sveltekit", "astro", "nuxt", "expo"];
const backendProfiles: AppBuilderBackendProfile[] = ["none", "prisma_supabase_neon"];
const sandboxProviders: AppBuilderSandboxProvider[] = ["mock_local", "e2b", "daytona"];

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const sessions = await store.listWorkbenchSessions(company.id);
    return NextResponse.json({ runs: listAppBuilderRuns(sessions) });
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const parsed = parseBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: parsed.value.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.value.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(parsed.value.companyId, async () => {
    const company = await store.getCompany(parsed.value.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const run = await startAppBuilderRun({ ...parsed.value, companyId: company.id });
    return NextResponse.json({ run }, { status: 201 });
  });
}

function parseBody(body: Record<string, unknown>):
  | {
      ok: true;
      value: {
        companyId: string;
        prompt: string;
        framework?: AppBuilderFramework;
        backendProfile?: AppBuilderBackendProfile;
        sandboxProvider?: AppBuilderSandboxProvider;
        repoUrl?: string;
      };
    }
  | { ok: false; error: string } {
  const companyId = stringValue(body.companyId);
  const prompt = stringValue(body.prompt);
  if (!companyId || !prompt) return { ok: false, error: "companyId and prompt are required" };
  const framework = body.framework === undefined ? undefined : stringValue(body.framework);
  if (framework && !frameworks.includes(framework as AppBuilderFramework)) {
    return { ok: false, error: "Unsupported framework" };
  }
  const backendProfile = body.backendProfile === undefined ? undefined : stringValue(body.backendProfile);
  if (backendProfile && !backendProfiles.includes(backendProfile as AppBuilderBackendProfile)) {
    return { ok: false, error: "Unsupported backendProfile" };
  }
  const sandboxProvider = body.sandboxProvider === undefined ? undefined : stringValue(body.sandboxProvider);
  if (sandboxProvider && !sandboxProviders.includes(sandboxProvider as AppBuilderSandboxProvider)) {
    return { ok: false, error: "Unsupported sandboxProvider" };
  }
  const repoUrl = body.repoUrl === undefined ? undefined : stringValue(body.repoUrl);
  if (body.repoUrl !== undefined && !repoUrl) return { ok: false, error: "repoUrl must be a string" };
  return {
    ok: true,
    value: {
      companyId,
      prompt,
      framework: framework as AppBuilderFramework | undefined,
      backendProfile: backendProfile as AppBuilderBackendProfile | undefined,
      sandboxProvider: sandboxProvider as AppBuilderSandboxProvider | undefined,
      repoUrl,
    },
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
