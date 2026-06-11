import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkbenchEvidenceRail } from "@/components/workbench-evidence-rail";

describe("WorkbenchEvidenceRail", () => {
  it("renders the derived verification and artifact summary", () => {
    const html = renderToStaticMarkup(
      <WorkbenchEvidenceRail
        active={{ id: "ws_1", status: "completed", previewUrl: "http://localhost:3000" }}
        events={[
          {
            id: "evt_verify",
            type: "test",
            title: "Verification failed",
            content: "tests failed",
            status: "failed",
            createdAt: "2026-06-11T00:00:00.000Z",
            metadata: {
              checks: [
                { name: "tests", status: "fail", detail: "1 failed" },
                { name: "dom", status: "pass", detail: "Rendered" },
              ],
            },
          },
        ]}
        artifacts={[
          {
            id: "art_screen",
            kind: "screenshot",
            title: "Preview screenshot",
            storageKey: "screenshots/test.png",
            mimeType: "image/png",
            sizeBytes: 10,
            createdAt: "2026-06-11T00:00:00.000Z",
          },
          {
            id: "art_file",
            kind: "file",
            title: "src/App.tsx",
            storageKey: "workbench/ws_1/files/src/App.tsx",
            mimeType: "text/typescript",
            sizeBytes: 10,
            path: "src/App.tsx",
            createdAt: "2026-06-11T00:00:00.000Z",
          },
        ]}
        activity={[]}
        streaming={false}
        onRefreshSession={async () => undefined}
        onOpenSandbox={() => undefined}
      />,
    );

    expect(html).toContain("failing");
    expect(html).toContain("1 pass / 1 failed / 0 skipped");
    expect(html).toContain("1 shot / 1 file / 2 artifacts");
    expect(html).toContain("failed: tests");
  });
});
