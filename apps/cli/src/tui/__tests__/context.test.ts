/**
 * A1.2 in the TUI: the context pane reports the assembly the wrapper actually performed.
 *
 * The pane itself is a few `<Text>` rows over `contextReportLines`; what has to be true is that the
 * TUI can name the (run, seat) pairs from the event stream it already consumes, and that the
 * figures it shows are the hook's own — not a second estimate that could drift from the prompt.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { wireFleetMemory } from "../../repl/fleet-memory.js";
import { ContextTracker, contextReport, contextReportLines, contextStatusLine } from "../../repl/context-report.js";
import { contextPaneLines } from "../ContextPane.js";

let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tui-context-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function event(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run-1", at: "2026-09-18T00:00:00.000Z", ...extra };
}

describe("the TUI's context pane", () => {
  it("reports the tier sizes, the estimate, the ceiling and the compaction count of the real assembly", async () => {
    const profileDir = path.join(home, "profile");
    fs.mkdirSync(path.join(profileDir, "memories"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "memories", "MEMORY.md"), "Money is integer cents.".repeat(20));
    const hook = wireFleetMemory({ profileDir, ceilingChars: 60_000, personalitySuffix: "Tone stance: be direct." });
    let injected = "";
    const seat = hook.wrapSeatModel(async (input: { subtask: { id: string; seat: string; objective: string }; dynamicPrompt?: string }) => {
      injected = input.dynamicPrompt ?? "";
      return {};
    });
    hook.runStarted({ runId: "run-1", companyId: "cmp", objective: "price the plan" });
    await seat({ subtask: { id: "s1", seat: "finance", objective: "price the plan" } });

    // The TUI learns the (run, seat) pair the same way it learns everything else: from the stream.
    const tracker = new ContextTracker();
    tracker.observe(event("run_start"));
    tracker.observe(event("step_end", { step: { id: "s1", title: "price it", agentRole: "finance" } }));

    const report = contextReport({ inspector: hook, runs: tracker.runs(), compactions: 2 });
    const lines = contextPaneLines(report);
    const measured = hook.contextFor("run-1", "finance");
    expect(measured?.chars).toBe(injected.length);
    expect(lines.join("\n")).toContain(String(measured?.stableChars));
    expect(lines.join("\n")).toContain(String(measured?.estimatedTokens));
    expect(lines.join("\n")).toContain("60000");
    expect(lines.join("\n")).toContain("2");
    expect(contextStatusLine(report)).toContain("finance");
    expect(lines).toEqual(contextReportLines(report));
  });

  it("says nothing was assembled before the first run, rather than showing zeroes", () => {
    const lines = contextPaneLines(contextReport({}));
    expect(lines.join("\n")).toMatch(/no run/i);
  });
});
