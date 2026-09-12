import { describe, expect, it } from "vitest";
import { shouldShowWorkbenchTestMode, summarizeWorkbenchCompletion } from "@/lib/workbench-test-mode";

describe("Workbench test mode", () => {
  it("opens only for completed sessions", () => {
    expect(shouldShowWorkbenchTestMode({ status: "completed" })).toBe(true);
    expect(shouldShowWorkbenchTestMode({ status: "running" })).toBe(false);
    expect(shouldShowWorkbenchTestMode(null)).toBe(false);
  });

  it("summarizes completed outputs for the cockpit rail", () => {
    const summary = summarizeWorkbenchCompletion(
      [
        { type: "file", status: "completed" },
        { type: "test", status: "completed" },
        { type: "shell", status: "failed" },
      ],
      [
        { kind: "preview" },
        { kind: "screenshot" },
        { kind: "terminal_log" },
      ],
    );

    expect(summary).toEqual({
      completedEvents: 2,
      fileEvents: 1,
      testEvents: 1,
      artifactCount: 3,
      previewCount: 1,
      screenshotCount: 1,
    });
  });
});
