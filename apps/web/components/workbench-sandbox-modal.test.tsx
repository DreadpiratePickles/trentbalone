import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkbenchSandboxModal, WORKBENCH_SANDBOX_TABS } from "@/components/workbench-sandbox-modal";

describe("WorkbenchSandboxModal", () => {
  it("renders a preview-first IDE shell with all Workbench sandbox tabs", () => {
    (globalThis as typeof globalThis & { React?: typeof React }).React = React;
    const html = renderToStaticMarkup(
      <WorkbenchSandboxModal
        url="/api/workbench/ws_1/preview/"
        objective="Build a notes app"
        status="completed"
        sessionId="ws_1"
        rollbackMode="text_files_only"
        rollbackDescription="Rollback can restore text files only."
        events={[
          {
            id: "evt_1",
            type: "shell",
            status: "failed",
            title: "npm run build",
            content: "vite build failed",
            command: "npm run build",
            createdAt: "2026-06-04T00:00:00.000Z",
          },
        ]}
        artifacts={[
          {
            id: "art_1",
            kind: "screenshot",
            title: "Verification screenshot",
            storageKey: "screens/ws_1.png",
            mimeType: "image/png",
            sizeBytes: 1234,
            createdByAgent: "engineer",
            createdAt: "2026-06-04T00:00:01.000Z",
          },
        ]}
        activity={[]}
        onRefreshSession={async () => {}}
        onClose={() => {}}
      />
    );

    expect(WORKBENCH_SANDBOX_TABS.map((tab) => tab.key)).toEqual([
      "preview",
      "files",
      "diff",
      "terminal",
      "tests",
      "artifacts",
      "screenshots",
    ]);
    for (const tab of WORKBENCH_SANDBOX_TABS) {
      expect(html).toContain(tab.label);
    }
    expect(html).toContain("SANDBOX · LIVE BUILD");
    expect(html).toContain("Build a notes app");
    expect(html).toContain("/api/workbench/ws_1/preview/");
    expect(html).toContain("Workbench tabs");
    expect(html).toContain("text-files-only rollback");
    expect(html).toContain("Rollback can restore text files only.");
  });
});
