import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentActivityFeed } from "@/components/agent-activity/agent-activity-feed";
import { AgentStep } from "@/components/agent-activity/agent-step";
import { CodeBlock } from "@/components/agent-activity/code-block";
import { mapWorkbenchChunk } from "@/components/agent-activity/mappers/workbench-chunk";
import { mapTraceTimelineItem } from "@/components/agent-activity/mappers/trace-timeline";
import { NarrationText } from "@/components/agent-activity/narration-text";
import type { ActivityStep } from "@/components/agent-activity/types";

const completedStep: ActivityStep = {
  id: "step-1",
  icon: "write",
  verb: "Writing",
  target: "src/App.tsx",
  chip: "1.2 KB",
  status: "completed",
};

describe("Agent activity system", () => {
  it("renders a completed step with status metadata", () => {
    const html = renderToStaticMarkup(<AgentStep step={completedStep} index={0} reducedMotion />);
    expect(html).toContain('data-status="completed"');
    expect(html).toContain("Writing");
    expect(html).toContain("src/App.tsx");
  });

  it("renders a collapsible code block with copy control and hidden tail lines", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const html = renderToStaticMarkup(
      <CodeBlock block={{ content: lines, language: "typescript", filename: "App.tsx" }} />,
    );
    expect(html).toContain("App.tsx");
    expect(html).toContain("Show 8 more lines");
    expect(html).toContain('aria-label="Copy code"');
  });

  it("renders historical narration instantly and live narration with a caret", () => {
    const staticHtml = renderToStaticMarkup(<NarrationText text="Hello world" live={false} />);
    const liveHtml = renderToStaticMarkup(<NarrationText text="Hello world" live />);
    expect(staticHtml).toContain('data-testid="narration-static"');
    expect(staticHtml).toContain("Hello world");
    expect(liveHtml).toContain('data-testid="narration-live"');
    expect(liveHtml).toContain('class="caret"');
  });

  it("renders feed steps with aria-live and running/completed states", () => {
    const html = renderToStaticMarkup(
      <AgentActivityFeed
        steps={[
          { ...completedStep, id: "running", status: "running", verb: "Reading", target: "App.tsx" },
          completedStep,
        ]}
        live
      />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-status="completed"');
  });

  it("disables step animation when reducedMotion is enabled on AgentStep", () => {
    const html = renderToStaticMarkup(
      <AgentStep step={{ ...completedStep, status: "running", verb: "Reading" }} index={0} reducedMotion />,
    );
    expect(html).toContain("agent-step--no-motion");
  });

  it("maps failed Workbench verification chunks to trace rows that name failed checks", () => {
    const step = mapWorkbenchChunk(
      {
        type: "verify",
        passed: false,
        checks: [
          { name: "tests", status: "fail", detail: "1 regression failed" },
          { name: "preview", status: "pass", detail: "Rendered preview" },
        ],
      },
      0,
    );

    expect(step).toMatchObject({
      icon: "verify",
      verb: "Verify",
      target: "tests failed",
      chip: "1 failed",
      status: "failed",
    });
    expect(step?.narration).toContain("tests: fail — 1 regression failed");
  });

  it("maps passing Workbench verification chunks to a readable success target", () => {
    const step = mapWorkbenchChunk(
      {
        type: "verify",
        passed: true,
        checks: [{ name: "preview", status: "pass", detail: "Rendered preview" }],
      },
      0,
    );

    expect(step).toMatchObject({
      icon: "verify",
      verb: "Verify",
      target: "all checks passed",
      chip: "passed",
      status: "completed",
    });
  });

  it("maps structured handoff timeline events with next actions, risks, and not-done notes", () => {
    const step = mapTraceTimelineItem({
      id: "handoff_1",
      seq: 3,
      kind: "handoff_event",
      status: "completed",
      payload: {
        from: "analyst",
        to: "growth",
        severity: "amber",
        summary: "Enterprise segment is highest intent.",
        nextActions: ["Test founder-led LinkedIn copy."],
        risks: ["Sample size is small."],
        whatIDidNotDo: ["Did not contact prospects."],
        payloadRef: "artifact_1",
        contractVersion: "handoff.v1",
      },
    });

    expect(step).toMatchObject({
      icon: "narration",
      verb: "Handoff",
      target: "analyst -> growth",
      chip: "amber",
      status: "completed",
    });
    expect(step.narration).toContain("SUMMARY: Enterprise segment is highest intent.");
    expect(step.narration).toContain("NEXT ACTIONS:");
    expect(step.narration).toContain("- Test founder-led LinkedIn copy.");
    expect(step.narration).toContain("RISKS:");
    expect(step.narration).toContain("- Sample size is small.");
    expect(step.narration).toContain("NOT DONE:");
    expect(step.narration).toContain("- Did not contact prospects.");
    expect(step.narration).toContain("PAYLOAD: artifact_1");
    expect(step.narration).toContain("CONTRACT: handoff.v1");
  });
});
