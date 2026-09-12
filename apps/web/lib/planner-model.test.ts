import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCallJsonWithRepair } = vi.hoisted(() => ({
  mockCallJsonWithRepair: vi.fn(),
}));

vi.mock("@/lib/llm-json", () => ({ callJsonWithRepair: mockCallJsonWithRepair }));

import { isPlannerModelEnabled, modelDecompose } from "@/lib/planner-model";
import type { TaskClassification } from "@/lib/planner";

const STANDARD: TaskClassification = { type: "general", complexity: "standard", reversibility: "reversible" };
const IRREVERSIBLE: TaskClassification = { type: "general", complexity: "complex", reversibility: "irreversible" };

const origEnv = { ...process.env };

beforeEach(() => {
  mockCallJsonWithRepair.mockReset();
  process.env.PLANNER_MODEL_ENABLED = "1";
  process.env.OPENAI_API_KEY = "test-key";
});

afterEach(() => {
  process.env = { ...origEnv };
});

describe("planner-model (§1 P1-1 model-based decomposition)", () => {
  it("isPlannerModelEnabled reads the flag", () => {
    process.env.PLANNER_MODEL_ENABLED = "1";
    expect(isPlannerModelEnabled()).toBe(true);
    process.env.PLANNER_MODEL_ENABLED = "true";
    expect(isPlannerModelEnabled()).toBe(true);
    process.env.PLANNER_MODEL_ENABLED = "0";
    expect(isPlannerModelEnabled()).toBe(false);
    delete process.env.PLANNER_MODEL_ENABLED;
    expect(isPlannerModelEnabled()).toBe(false);
  });

  it("returns null when the flag is off — no model call, deterministic fallback", async () => {
    process.env.PLANNER_MODEL_ENABLED = "0";
    const out = await modelDecompose({ prompt: "do a thing", classification: STANDARD });
    expect(out).toBeNull();
    expect(mockCallJsonWithRepair).not.toHaveBeenCalled();
  });

  it("returns null when no API key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    const out = await modelDecompose({ prompt: "do a thing", classification: STANDARD });
    expect(out).toBeNull();
    expect(mockCallJsonWithRepair).not.toHaveBeenCalled();
  });

  it("maps validated output, drops hallucinated seats, dedupes scope, clamps budget", async () => {
    mockCallJsonWithRepair.mockResolvedValue({
      data: {
        subtasks: [
          {
            seat: "growth",
            objective: "Draft a 3-channel launch experiment brief",
            toolGuidance: ["draft only"],
            boundaries: ["no sends"],
            budgetCents: 40,
            spec: { acceptance: ["Experiment brief names channels, hypotheses, and approval gates"], inputsFrom: [] },
          },
          {
            seat: "growth",
            objective: "duplicate scope that must be dropped",
            budgetCents: 40,
            spec: { acceptance: ["This duplicate should be ignored"], inputsFrom: [] },
          },
          {
            seat: "wizard",
            objective: "not a real seat — must be dropped",
            budgetCents: 40,
            spec: { acceptance: ["Invalid seat ignored"], inputsFrom: [] },
          },
          {
            seat: "content",
            objective: "Write launch announcement copy variants",
            dependsOn: ["growth"],
            budgetCents: 9999,
            spec: { acceptance: ["Announcement variants reflect the launch experiment hypotheses"], inputsFrom: ["growth"] },
          },
        ],
      },
      tokens: 100,
      repaired: false,
    });

    const out = await modelDecompose({ prompt: "build a launch plan", classification: STANDARD });
    expect(out).not.toBeNull();
    expect(out!.map((s) => s.seat)).toEqual(["growth", "content"]);
    expect(out!.find((s) => s.seat === "content")!.budgetCents).toBe(100); // clamped to ceiling
    expect(out!.find((s) => s.seat === "growth")!.toolGuidance).toEqual(["draft only"]);
    expect(out!.find((s) => s.seat === "content")!.dependsOn).toEqual(["growth"]);
    expect(out!.find((s) => s.seat === "content")!.spec).toEqual({
      acceptance: ["Announcement variants reflect the launch experiment hypotheses"],
      inputsFrom: ["growth"],
    });
  });

  it("drops model subtasks that lack concrete acceptance criteria", async () => {
    mockCallJsonWithRepair.mockResolvedValue({
      data: {
        subtasks: [
          { seat: "engineer", objective: "Implement the import flow", budgetCents: 50 },
          {
            seat: "analyst",
            objective: "Verify imported app renders with Playwright evidence",
            budgetCents: 30,
            spec: { acceptance: ["Screenshot and console evidence are attached to the run"], inputsFrom: [] },
          },
        ],
      },
      tokens: 100,
      repaired: false,
    });

    const out = await modelDecompose({ prompt: "import and verify an app", classification: STANDARD });

    expect(out).not.toBeNull();
    expect(out!.map((s) => s.seat)).toEqual(["analyst"]);
  });

  it("always routes an escalation seat for irreversible work the model omitted", async () => {
    mockCallJsonWithRepair.mockResolvedValue({
      data: {
        subtasks: [{
          seat: "engineer",
          objective: "Prepare the deploy PR for review",
          budgetCents: 50,
          spec: { acceptance: ["Deploy PR is prepared without merging or deploying"], inputsFrom: [] },
        }],
      },
      tokens: 100,
      repaired: false,
    });
    const out = await modelDecompose({ prompt: "deploy the app to production", classification: IRREVERSIBLE });
    expect(out!.some((s) => s.seat === "escalation")).toBe(true);
  });

  it("returns null on model failure so the caller falls back deterministically", async () => {
    mockCallJsonWithRepair.mockRejectedValue(new Error("model exploded"));
    const out = await modelDecompose({ prompt: "do a thing", classification: STANDARD });
    expect(out).toBeNull();
  });

  it("returns null when the model yields zero usable seats", async () => {
    mockCallJsonWithRepair.mockResolvedValue({
      data: {
        subtasks: [{
          seat: "wizard",
          objective: "all invalid seats here",
          budgetCents: 40,
          spec: { acceptance: ["Invalid seat ignored"], inputsFrom: [] },
        }],
      },
      tokens: 10,
      repaired: false,
    });
    const out = await modelDecompose({ prompt: "do a thing", classification: STANDARD });
    expect(out).toBeNull();
  });
});
