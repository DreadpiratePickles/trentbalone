/**
 * 3.3 — the streaming render loop.
 *
 * A recorded event sequence goes in; the exact transcript a user would see comes out.
 * The load-bearing assertion is the mid-stream colour switch: a step that enters
 * `awaiting_approval` must re-render with the EMBER dot even though its category
 * colour says otherwise. State outranks identity.
 */

import { describe, it, expect } from "vitest";
import { createTheme, EMBER_SGR, PULSE_SGR, sgrCodesIn, AGENT_CATEGORY_HEX } from "../../ui/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { TranscriptRenderer, renderTranscript, identityForRole } from "../render.js";

const plain = createTheme("none");
const colour = createTheme("truecolor");

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_1", at: "2026-09-12T00:00:00.000Z", ...extra } as OrcEvent;
}

const RECORDED: readonly OrcEvent[] = [
  ev("run_start", { run: { objective: "ship the repl" } }),
  ev("plan_start"),
  ev("plan_end", { run: { plan: { objective: "ship the repl", reasoning: "", steps: [], successCriteria: [], blockers: [] } } }),
  ev("step_start", { step: { id: "s1", title: "Reading files", agentRole: "eng-ai-engineer" } }),
  ev("step_output", { step: { id: "s1" }, detail: "found 3 modules" }),
  ev("step_awaiting_approval", { step: { id: "s1", title: "Reading files", agentRole: "eng-ai-engineer" } }),
  ev("step_approved", { step: { id: "s1" } }),
  ev("step_end", { step: { id: "s1", title: "Reading files", agentRole: "eng-ai-engineer", status: "completed" } }),
  ev("run_done", { run: { status: "completed", summary: "done" } }),
];

describe("transcript renderer", () => {
  it("renders a recorded sequence into the transcript a user sees", () => {
    const lines = renderTranscript(RECORDED, { theme: plain });
    expect(lines).toEqual([
      "· Objective: ship the repl",
      "· Planning...",
      "· Plan ready",
      "● [AI Engineer] Reading files...",
      "    found 3 modules",
      "◆ [AI Engineer] Reading files — awaiting your approval",
      "● [AI Engineer] Reading files...",
      "✓ [AI Engineer] Reading files",
      "✓ Run complete",
    ]);
  });

  it("emits zero escape sequences in monochrome mode", () => {
    for (const line of renderTranscript(RECORDED, { theme: plain })) {
      expect(line).not.toMatch(/\x1b\[/);
    }
  });

  it("switches the dot to ember mid-stream when a step enters awaiting_approval", () => {
    const r = new TranscriptRenderer({ theme: colour });
    const running = r.handle(ev("step_start", { step: { id: "s1", title: "Reading files", agentRole: "eng-ai-engineer" } }));
    const awaiting = r.handle(
      ev("step_awaiting_approval", { step: { id: "s1", title: "Reading files", agentRole: "eng-ai-engineer" } }),
    );

    expect(running).toHaveLength(1);
    expect(awaiting).toHaveLength(1);

    // The SGR the engineering category paints with, taken from the theme itself.
    const engineering = sgrCodesIn(colour.agentName("x", "engineering"))[0]!;

    // Running: pulse dot, engineering-category name.
    expect(sgrCodesIn(running[0]!)).toContain(PULSE_SGR.truecolor);
    expect(sgrCodesIn(running[0]!)).toContain(engineering);

    // Awaiting: ember dot AND ember name. The category colour is gone entirely.
    const codes = sgrCodesIn(awaiting[0]!);
    expect(codes.filter((c) => c === EMBER_SGR.truecolor)).toHaveLength(2);
    expect(codes).not.toContain(engineering);
    expect(AGENT_CATEGORY_HEX.engineering).toBe("#67E8F9"); // guards the assumption above
  });

  it("marks every agent line as degraded when the planner is running offline", () => {
    const lines = renderTranscript(RECORDED, { theme: plain, degraded: true });
    const agentLines = lines.filter((l) => l.includes("[AI Engineer]"));
    expect(agentLines.length).toBeGreaterThan(0);
    for (const line of agentLines) expect(line).toContain("DEGRADED");
    // A non-degraded render must NOT contain the marker, or the marker means nothing.
    for (const line of renderTranscript(RECORDED, { theme: plain })) {
      expect(line).not.toContain("DEGRADED");
    }
  });

  it("renders failure with the danger glyph and cancellation distinctly", () => {
    expect(renderTranscript([ev("run_failed", { detail: "provider refused" })], { theme: plain })).toEqual([
      "✗ Run failed: provider refused",
    ]);
    expect(renderTranscript([ev("run_cancelled")], { theme: plain })).toEqual(["· Run cancelled"]);
  });

  it("never emits an emoji", () => {
    const all = renderTranscript(RECORDED, { theme: colour }).join("\n");
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("agent identity", () => {
  it("maps catalog role ids onto the 13 style-contract categories", () => {
    expect(identityForRole("eng-ai-engineer")).toMatchObject({ category: "engineering", displayName: "AI Engineer" });
    expect(identityForRole("support-responder").category).toBe("support");
    expect(identityForRole("finance-controller").category).toBe("finance");
    expect(identityForRole("ceo").category).toBe("project-management");
  });

  it("falls back to the neutral category rather than inventing a colour", () => {
    expect(identityForRole("some-unknown-seat").category).toBe("specialized");
  });
});

describe("D3 — step output renders once", () => {
  it("prints step.output exactly once when both step_output and step_critic carry it", () => {
    const output = "Executed the CEO scoping objective by verifying the tool result.";
    const step = { id: "s1", title: "Scope objective", agentRole: "ceo", output };
    const lines = renderTranscript(
      [
        ev("step_start", { step: { id: "s1", title: "Scope objective", agentRole: "ceo" } }),
        ev("step_output", { step }),
        ev("step_critic", { step }),
        ev("step_end", { step: { ...step, status: "completed" } }),
      ],
      { theme: plain },
    );
    expect(lines.filter((line) => line.includes(output))).toHaveLength(1);
    expect(lines).toEqual(["● [CEO] Scope objective...", `    ${output}`, "✓ [CEO] Scope objective"]);
  });

  it("still prints a critic verdict when the critic event carries its own detail", () => {
    const step = { id: "s1", title: "Scope objective", agentRole: "ceo", output: "the output" };
    const lines = renderTranscript(
      [ev("step_output", { step }), ev("step_critic", { step, detail: "critic: pass" })],
      { theme: plain },
    );
    expect(lines).toEqual(["    the output", "    critic: pass"]);
  });
});
