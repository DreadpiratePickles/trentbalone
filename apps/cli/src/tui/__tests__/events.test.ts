/**
 * 3.10 in the TUI: what the panes show is what the orchestrator emitted.
 *
 * A scripted event stream stands in for `createOrchestrator().run()`. The session store and
 * the budget ledger are the real ones, so a fabricated cost, latency or reply would have
 * to come from `handleOrcEvent` itself — and these assertions say it does not.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager, SessionManager } from "@trent/core";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { BudgetLedger, formatCents } from "../../repl/budget.js";
import { handleOrcEvent, stepDurationMs, type EventSinks, type OrchestratorApprovalDetails } from "../events.js";
import type { TuiActivityItem } from "../types.js";

const RUN_ID = "run-1";
const AT = "2026-09-12T10:00:00.000Z";

function event(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: RUN_ID, at: AT, ...extra };
}

interface Harness {
  sinks: EventSinks;
  ledger: BudgetLedger;
  sessions: SessionManager;
  sessionId: string;
  activities: Array<Omit<TuiActivityItem, "id" | "timestamp">>;
  approvals: Array<OrchestratorApprovalDetails & { agent: string; action: string }>;
}

describe("handleOrcEvent", () => {
  let tempDir: string;
  let h: Harness;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tui-events-"));
    const configManager = new ConfigManager({ baseDir: tempDir });
    const config = configManager.loadConfig();
    const sessions = new SessionManager(configManager);
    const session = sessions.startSession("ceo", config.model, config.provider);
    const ledger = new BudgetLedger({
      capCents: config.budget.daily_cap,
      thresholds: config.budget.alert_thresholds,
    });
    const activities: Harness["activities"] = [];
    const approvals: Harness["approvals"] = [];
    h = {
      ledger,
      sessions,
      sessionId: session.id,
      activities,
      approvals,
      sinks: {
        sessionAgent: session.agent,
        recordCost: (cents) => {
          ledger.record(cents);
          return ledger.takeCrossed().map((t) => ledger.warningText(t));
        },
        appendAgentMessage: (agent, text, metadata = {}) => {
          sessions.appendMessage(session.id, {
            role: "assistant",
            agent,
            content: text,
            metadata: {
              ...(Number.isInteger(metadata.costCents) ? { cost_cents: metadata.costCents } : {}),
              ...(metadata.durationMs !== undefined ? { duration_ms: metadata.durationMs } : {}),
            },
          });
        },
        pushActivity: (item) => activities.push(item),
        openApproval: (input) => approvals.push(input),
      },
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const messages = () => h.sessions.getSession(h.sessionId)!.messages;

  it("sums real integer-cent costs from step_end and consolidate_end, and nothing else", () => {
    handleOrcEvent(event("step_start", { step: { id: "s1", title: "Research", agentRole: "researcher" } }), h.sinks);
    handleOrcEvent(
      event("step_end", { step: { id: "s1", title: "Research", agentRole: "researcher", output: "found it", costCents: 37 } }),
      h.sinks,
    );
    handleOrcEvent(event("step_end", { step: { id: "s2", title: "No cost reported", agentRole: "writer" } }), h.sinks);
    handleOrcEvent(event("consolidate_end", { step: { id: "c", costCents: 5 } }), h.sinks);
    handleOrcEvent(event("heartbeat"), h.sinks);

    expect(h.ledger.spentCents).toBe(42);
    expect(h.sessions.getSession(h.sessionId)!.total_cost_cents).toBe(37);
  });

  it("refuses a float cost rather than rounding it into the ledger", () => {
    const record = () => handleOrcEvent(event("step_end", { step: { id: "s1", costCents: 0.5, output: "x" } }), h.sinks);
    // A non-integer cost is not recorded and does not throw: the ledger never sees it.
    record();
    expect(h.ledger.spentCents).toBe(0);
    expect(messages()[0]!.metadata?.cost_cents).toBeUndefined();
  });

  it("writes the step's own output, cost and measured duration into the session", () => {
    handleOrcEvent(
      event("step_end", {
        step: {
          id: "s1",
          agentRole: "engineer",
          title: "Build",
          output: "the build is green",
          costCents: 120,
          startedAt: "2026-09-12T10:00:00.000Z",
          completedAt: "2026-09-12T10:00:02.500Z",
        },
      }),
      h.sinks,
    );
    const [msg] = messages();
    expect(msg!.agent).toBe("engineer");
    expect(msg!.content).toBe("the build is green");
    expect(msg!.metadata?.cost_cents).toBe(120);
    expect(msg!.metadata?.duration_ms).toBe(2500);
  });

  it("leaves duration and cost absent when the orchestrator did not report them", () => {
    handleOrcEvent(event("step_end", { step: { id: "s1", agentRole: "engineer", output: "done" } }), h.sinks);
    const [msg] = messages();
    expect(msg!.metadata?.cost_cents).toBeUndefined();
    expect(msg!.metadata?.duration_ms).toBeUndefined();
    expect(stepDurationMs({ startedAt: AT })).toBeUndefined();
  });

  it("does not append a reply for a step with no output", () => {
    handleOrcEvent(event("step_end", { step: { id: "s1", agentRole: "engineer", costCents: 3 } }), h.sinks);
    expect(messages()).toEqual([]);
    expect(h.ledger.spentCents).toBe(3);
  });

  it("announces each configured threshold once, in the ledger's words", () => {
    const cap = h.ledger.capCents;
    const thresholds = new ConfigManager({ baseDir: tempDir }).loadConfig().budget.alert_thresholds;
    const lowest = Math.min(...thresholds);
    const cents = Math.ceil((cap * lowest) / 100);

    handleOrcEvent(event("step_end", { step: { id: "s1", costCents: cents } }), h.sinks);
    handleOrcEvent(event("step_end", { step: { id: "s2", costCents: 1 } }), h.sinks);

    const alerts = h.activities.filter((a) => a.agent === "budget").map((a) => a.action);
    expect(alerts).toEqual([
      `Budget alert: ${lowest}% of the daily cap used (${formatCents(cents)} of ${formatCents(cap)}).`,
    ]);
    expect(alerts.join("\n")).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("opens an approval carrying the run and step ids so a decision can route back", () => {
    handleOrcEvent(
      event("step_awaiting_approval", {
        step: { id: "s9", title: "Send the email", agentRole: "sales" },
        detail: "external side effect",
      }),
      h.sinks,
    );
    expect(h.approvals).toEqual([
      { agent: "sales", action: "Send the email", runId: RUN_ID, stepId: "s9", reason: "external side effect" },
    ]);
  });

  it("shows the run's consolidated summary as the session agent, and failures verbatim", () => {
    handleOrcEvent(event("run_done", { run: { summary: "Shipped." } }), h.sinks);
    handleOrcEvent(event("run_failed", { detail: "gateway unreachable" }), h.sinks);
    expect(messages().map((m) => [m.agent, m.content])).toEqual([
      ["ceo", "Shipped."],
      ["orchestrator", "Run failed: gateway unreachable"],
    ]);
  });
});

describe("the context-pressure notice on the TUI", () => {
  let tempDir: string;
  let activities: Array<Omit<TuiActivityItem, "id" | "timestamp">>;
  let sinks: EventSinks;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tui-pressure-"));
    const configManager = new ConfigManager({ baseDir: tempDir });
    const sessions = new SessionManager(configManager);
    const session = sessions.startSession("ceo", "m", "p");
    activities = [];
    sinks = {
      sessionAgent: session.agent,
      recordCost: () => [],
      appendAgentMessage: () => undefined,
      pushActivity: (item) => activities.push(item),
      openApproval: () => undefined,
    };
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("shows the wrapper's pressure notice, which rides the bus as a step_note, once", () => {
    // The fleet-memory hook emits one notice per run; the orchestrator bridges it to `step_note`
    // (`orchestrator/run-hooks.ts`). Before this, the TUI dropped the kind on the floor.
    const detail =
      "context pressure on run run-1, seat engineer: the wrapper's injection is 49000 chars " +
      "(~12250 tokens, estimated) against a 60000-char ceiling, 82 percent; trimmed: fleet-recall";
    handleOrcEvent(event("step_note", { detail }), sinks);
    const shown = activities.filter((item) => item.action.includes("context pressure"));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.action).toContain("82 percent");
  });

  it("ignores a note with nothing in it", () => {
    handleOrcEvent(event("step_note", {}), sinks);
    expect(activities).toHaveLength(0);
  });
});
