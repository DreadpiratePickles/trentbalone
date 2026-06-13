/**
 * workbench-build-editor-runner.ts — the real per-file editor used by the
 * multi-agent build. Streams the executor model scoped to ONE file, parses the
 * single-file artifact, rejects it if it doesn't parse (syntax gate), and writes
 * it through the provider. Wrapped so `runEditorWaves` can call it in parallel.
 *
 * The streaming + provider are injected, so this is unit-testable without a key.
 */

import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { AgentDeps } from "@/lib/workbench-agent-types";
import type { BuildPlan } from "@/lib/workbench-build-planner";
import type { BuildPlanFile } from "@/lib/workbench-build-graph";
import type { EditorResult } from "@/lib/workbench-build-editors";
import { buildEditorPrompt } from "@/lib/workbench-build-planner";
import { parseArtifact } from "@/lib/workbench-artifact-parser";
import { syntaxErrorSummary } from "@/lib/workbench-syntax-gate";
import { safeWrite } from "@/lib/workbench-build-helpers";
import { normalizeArtifactFilePath } from "@/lib/workbench-build-helpers";

export function createWorkbenchEditFile(input: {
  session: WorkbenchSession;
  deps: Pick<AgentDeps, "streamArtifact">;
  provider: WorkbenchProviderAdapter;
  systemPrompt: string;
  plan: BuildPlan;
}): (file: BuildPlanFile) => Promise<EditorResult> {
  const { session, deps, provider, systemPrompt, plan } = input;

  return async (file: BuildPlanFile): Promise<EditorResult> => {
    let existingContent: string | undefined;
    try {
      existingContent = await provider.readFile(session, file.path);
    } catch {
      existingContent = undefined;
    }

    const user = buildEditorPrompt({ plan, file, existingContent });
    let full = "";
    for await (const tok of deps.streamArtifact({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: user },
      ],
    })) {
      if (tok.type === "token") full += tok.content;
    }

    const artifact = parseArtifact(full);
    const action = artifact?.actions.find((a) => a.type === "file");
    if (!action || action.type !== "file") {
      return { path: file.path, ok: false, detail: "editor returned no <boltAction type=\"file\">" };
    }

    // The editor was told to write exactly this path; trust the planned path
    // over a possibly-relative artifact path, but normalise either way.
    const content = action.content;
    const targetPath = normalizeArtifactFilePath(file.path);

    const syntaxError = await syntaxErrorSummary(targetPath, content).catch(() => undefined);
    if (syntaxError) {
      return { path: file.path, ok: false, detail: `syntax error, not written: ${syntaxError}` };
    }

    const write = await safeWrite(provider, session, targetPath, content);
    return write.ok
      ? { path: file.path, ok: true, detail: `wrote ${content.length} bytes`, bytes: content.length }
      : { path: file.path, ok: false, detail: write.error };
  };
}
