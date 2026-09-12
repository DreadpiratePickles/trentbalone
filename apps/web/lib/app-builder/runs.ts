import type { WorkbenchSession } from "@/lib/types";
import { createWorkbenchSession } from "@/lib/workbench";
import { createAppBuilderManifest } from "./manifest";
import type { AppBuilderFramework, AppBuilderRun, AppBuilderSandboxProvider } from "./types";

export async function startAppBuilderRun(input: {
  companyId: string;
  prompt: string;
  framework?: AppBuilderFramework;
  sandboxProvider?: AppBuilderSandboxProvider;
  repoUrl?: string;
}): Promise<AppBuilderRun> {
  const manifest = createAppBuilderManifest({
    companyId: input.companyId,
    prompt: input.prompt,
    framework: input.framework,
  });
  const session = await createWorkbenchSession({
    companyId: input.companyId,
    objective: formatObjective(manifest.prompt),
    agentRole: "engineer",
    provider: input.sandboxProvider,
    repoUrl: input.repoUrl,
    allowedHosts: input.repoUrl ? ["github.com"] : [],
    enqueue: false,
  });

  return { id: session.id, companyId: input.companyId, manifest, session };
}

export function listAppBuilderRuns(sessions: WorkbenchSession[]): AppBuilderRun[] {
  return sessions
    .filter((session) => session.objective.startsWith("App Builder:"))
    .map((session) => ({
      id: session.id,
      companyId: session.companyId,
      manifest: createAppBuilderManifest({
        companyId: session.companyId,
        prompt: session.objective.replace(/^App Builder:\s*/, ""),
      }),
      session,
    }));
}

function formatObjective(prompt: string) {
  return `App Builder: ${prompt}`;
}
