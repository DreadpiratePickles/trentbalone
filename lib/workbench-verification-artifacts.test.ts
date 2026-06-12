import { beforeEach, describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import { persistVerificationBrowserTraceArtifact } from "@/lib/workbench-verification-artifacts";
import type { VerifyVerdict } from "@/lib/workbench-verify";

describe("workbench verification artifacts", () => {
  beforeEach(async () => {
    await (store as unknown as { clearAll?: () => Promise<void> }).clearAll?.();
  });

  it("persists browser trace evidence as a perf_trace artifact", async () => {
    const company = await store.createCompany({
      name: `Trace Co ${makeId("test")}`,
      brief: { vision: "verify browser evidence" },
    });
    const session = await store.createWorkbenchSession({
      companyId: company.id,
      agentRole: "engineer",
      agentMode: "build",
      status: "running",
      provider: "mock_local",
      objective: "Build a dashboard",
      costCents: 0,
      metadata: {
        networkPolicy: "deny_all",
        allowedHosts: [],
        maxRuntimeSeconds: 1800,
        maxCostCents: 250,
        approvalRequiredFor: [],
        rollbackAvailable: true,
      },
    });
    const verdict: VerifyVerdict = {
      passed: true,
      checks: [],
      previewUrl: "http://localhost:3000",
      browserTrace: {
        storageKey: `workbench/${session.id}/playwright-trace-1.json`,
        mimeType: "application/json",
        sizeBytes: 42,
        content: JSON.stringify({ previewUrl: "http://localhost:3000", visibleText: "hello" }),
      },
    };

    const artifactId = await persistVerificationBrowserTraceArtifact({ session, verdict, attemptNo: 1 });

    const artifacts = await store.listWorkbenchArtifacts(session.id);
    const events = await store.listWorkbenchEvents(session.id);
    expect(artifactId).toBeTruthy();
    expect(artifacts.find((artifact) => artifact.id === artifactId)).toMatchObject({
      kind: "perf_trace",
      title: "Playwright verification trace",
      mimeType: "application/json",
    });
    expect(events.find((event) => event.artifactId === artifactId)).toMatchObject({
      type: "browser",
      title: "Playwright verification trace captured",
    });
  });
});
