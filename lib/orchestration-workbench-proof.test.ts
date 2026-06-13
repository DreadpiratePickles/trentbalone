import { describe, expect, it } from "vitest";
import type { StepRecord } from "@/lib/orchestrator-runtime";
import {
  buildWorkbenchProofPlan,
  buildWorkbenchSessionProofAction,
  createWorkbenchProofCompletion,
  createWorkbenchProofSeatModel,
  summarizeOrchestrationWorkbenchProof,
} from "@/lib/orchestration-workbench-proof";

describe("orchestration Workbench proof helpers", () => {
  it("builds a deterministic plan whose engineer step explicitly requires workbench:session", () => {
    const plan = buildWorkbenchProofPlan("prove seats have hands");
    const engineer = plan.steps.find((step) => step.agentRole === "engineer");

    expect(engineer?.title).toMatch(/Workbench Sandbox/);
    expect(engineer?.expectedOutput).toMatch(/workbench:session/);
    expect(engineer?.spec?.acceptance).toEqual(expect.arrayContaining([
      "A Workbench Sandbox tool call completed.",
      "The tool ran npm test with exit code 0.",
    ]));
  });

  it("drives the engineer model turn to call Workbench Sandbox, then finish from the real tool result", async () => {
    const seatModel = createWorkbenchProofSeatModel();
    const first = await seatModel({
      companyId: "company_1",
      subtask: {
        id: "s2",
        seat: "engineer",
        objective: "Use Workbench Sandbox",
        outputContractId: "orchestration:s2",
        toolGuidance: ["workbench:session"],
        boundaries: [],
        input: {},
        contextBundle: {},
        classification: { type: "engineer", complexity: "standard", reversibility: "reversible" },
        budgetCents: 100,
      },
      systemPrompt: "",
      toolLoopContext: { step: 1, maxSteps: 15, toolHistory: [], availableTools: ["workbench:session"] },
    });

    expect(first.output).toMatchObject({
      toolCall: {
        name: "workbench:session",
        action: expect.stringContaining("package.json"),
      },
    });
    expect(JSON.parse(buildWorkbenchSessionProofAction())).toMatchObject({
      command: "npm test",
    });

    const second = await seatModel({
      companyId: "company_1",
      subtask: {
        id: "s2",
        seat: "engineer",
        objective: "Use Workbench Sandbox",
        outputContractId: "orchestration:s2",
        toolGuidance: ["workbench:session"],
        boundaries: [],
        input: {},
        contextBundle: {},
        classification: { type: "engineer", complexity: "standard", reversibility: "reversible" },
        budgetCents: 100,
      },
      systemPrompt: "",
      toolLoopContext: {
        step: 2,
        maxSteps: 15,
        availableTools: ["workbench:session"],
        toolHistory: [{
          adapter: "Workbench Sandbox",
          action: buildWorkbenchSessionProofAction(),
          result: {
            adapter: "Workbench Sandbox",
            action: buildWorkbenchSessionProofAction(),
            status: "completed",
            summary: "Workbench Sandbox session workbench_1 wrote package.json. Ran `npm test` with exit code 0. Diff: diff --git a/package.json b/package.json",
          },
        }],
      },
    });

    expect(second.output).toMatchObject({
      toolCall: null,
      summary: expect.stringContaining("Engineer Workbench proof complete"),
    });
  });

  it("summarizes durable trace evidence using the weakest-line rule", () => {
    const steps = [{
      id: "s2",
      title: "Use Workbench Sandbox",
      rationale: "",
      agentRole: "engineer",
      dependsOn: [],
      expectedOutput: "",
      riskLevel: "medium",
      needsApproval: false,
      status: "completed",
      output: "done",
      toolCalls: [{
        adapter: "Workbench Sandbox",
        action: buildWorkbenchSessionProofAction(),
        status: "completed",
        summary: "Workbench Sandbox session workbench_1 wrote package.json, test.js. Ran `npm test` with exit code 0. Diff: diff --git a/package.json b/package.json",
      }],
    }] as StepRecord[];

    expect(summarizeOrchestrationWorkbenchProof({
      run: {
        id: "orc_1",
        companyId: "company_1",
        objective: "prove",
        status: "completed",
        steps,
        startedAt: "2026-06-13T00:00:00.000Z",
        trigger: "manual",
      },
      steps,
    })).toMatchObject({
      passed: true,
      engineerStepId: "s2",
      workbenchToolStatus: "completed",
      failures: [],
    });

    expect(summarizeOrchestrationWorkbenchProof({
      run: {
        id: "orc_1",
        companyId: "company_1",
        objective: "prove",
        status: "running",
        steps: [],
        startedAt: "2026-06-13T00:00:00.000Z",
        trigger: "manual",
      },
      steps: [],
    }).failures).toEqual(expect.arrayContaining([
      "Run did not complete; status=running.",
      "No engineer step with a Workbench Sandbox tool call was persisted.",
    ]));
  });

  it("returns the proof plan through the planner completion hook", async () => {
    const completion = createWorkbenchProofCompletion();
    const result = await completion("model", [
      { role: "system", content: "You are Trent's chief orchestrator." },
      { role: "user", content: "Objective: prove Workbench" },
    ], 1000);

    expect(JSON.parse(result.content ?? "{}")).toMatchObject({
      objective: "prove Workbench",
      steps: expect.arrayContaining([
        expect.objectContaining({ agentRole: "engineer" }),
      ]),
    });
  });
});
