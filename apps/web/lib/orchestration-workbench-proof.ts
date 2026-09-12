import type { CallJsonOptions } from "@/lib/ai-client";
import type { SeatModelExecutionInput, SeatModelExecutionResult, executeSeatModel } from "@/lib/model-gateway";
import type { OrchestrationPlan, OrchestrationRun } from "@/lib/orchestrator";
import type { ToolCallRecord } from "@/lib/types";

export const WORKBENCH_ORCHESTRATION_PROOF_OBJECTIVE = [
  "Prove the engineer seat can use a real Workbench Sandbox from inside a durable orchestration run.",
  "The engineer must call workbench:session, write a tiny project, run npm test, and return the diff and command result.",
].join(" ");

export function buildWorkbenchSessionProofAction(): string {
  return JSON.stringify({
    kind: "workbench:session",
    objective: "Durable orchestration engineer seat proof: write files, run npm test, and return a diff.",
    writeFiles: [
      {
        path: "package.json",
        content: JSON.stringify({
          name: "trent-orchestration-workbench-proof",
          version: "0.0.0",
          private: true,
          type: "module",
          scripts: { test: "node test.js" },
        }, null, 2),
      },
      {
        path: "test.js",
        content: [
          "import assert from 'node:assert/strict';",
          "import fs from 'node:fs';",
          "assert.equal(2 + 2, 4);",
          "assert.equal(fs.readFileSync('src/seat-proof.txt', 'utf8').trim(), 'engineer seat workbench proof');",
          "console.log('orchestration workbench proof passed');",
          "",
        ].join("\n"),
      },
      {
        path: "src/seat-proof.txt",
        content: "engineer seat workbench proof\n",
      },
    ],
    command: "npm test",
  });
}

export function buildWorkbenchProofPlan(objective = WORKBENCH_ORCHESTRATION_PROOF_OBJECTIVE): OrchestrationPlan {
  return {
    objective,
    reasoning: "Deterministic eval plan: drive the real durable queue and real Workbench Sandbox adapter without relying on stochastic tool choice.",
    steps: [
      {
        id: "s1",
        title: "Scope durable Workbench proof",
        rationale: "Define the exact proof artifact and keep the run reversible.",
        agentRole: "ceo",
        dependsOn: [],
        expectedOutput: "State that the engineer must prove Workbench Sandbox execution with a file write, npm test, and diff evidence.",
        riskLevel: "low",
        needsApproval: false,
        spec: {
          acceptance: ["Engineer proof requirements are explicit."],
          inputsFrom: [],
        },
      },
      {
        id: "s2",
        title: "Use Workbench Sandbox workbench:session to write and test code",
        rationale: "Engineer seats need hands: code execution must happen through the Workbench Sandbox adapter.",
        agentRole: "engineer",
        dependsOn: ["s1"],
        expectedOutput: "Call workbench:session, write package.json/test.js/src/seat-proof.txt, run npm test, and return session, diff, and command output evidence.",
        riskLevel: "medium",
        needsApproval: false,
        spec: {
          acceptance: [
            "A Workbench Sandbox tool call completed.",
            "The tool wrote files in a Workbench session.",
            "The tool ran npm test with exit code 0.",
            "The output includes diff evidence.",
          ],
          inputsFrom: ["s1"],
        },
      },
      {
        id: "s3",
        title: "Consolidate durable Workbench proof",
        rationale: "The final run summary must point to the persisted trace evidence.",
        agentRole: "ceo",
        dependsOn: ["s2"],
        expectedOutput: "Summarize whether the engineer seat opened Workbench, wrote files, ran npm test, and returned a diff.",
        riskLevel: "low",
        needsApproval: false,
        spec: {
          acceptance: ["Final summary cites the engineer Workbench evidence."],
          inputsFrom: ["s2"],
        },
      },
    ],
    successCriteria: [
      "Durable orchestration run reaches completed status.",
      "Engineer step contains a completed Workbench Sandbox tool call.",
      "Workbench Sandbox summary includes npm test exit code 0 and diff evidence.",
    ],
    blockers: [],
  };
}

export function createWorkbenchProofCompletion(): NonNullable<CallJsonOptions["createCompletion"]> {
  return async (_model, messages) => {
    const system = messageText(messages, "system");
    const user = messageText(messages, "user");
    if (/chief orchestrator/i.test(system)) {
      return {
        content: JSON.stringify(buildWorkbenchProofPlan(extractObjective(user) ?? WORKBENCH_ORCHESTRATION_PROOF_OBJECTIVE)),
        totalTokens: 64,
      };
    }
    if (/quality supervisor/i.test(system)) {
      return {
        content: JSON.stringify({ verdict: "pass", reason: "Workbench proof criteria satisfied in durable trace." }),
        totalTokens: 12,
      };
    }
    return {
      content: JSON.stringify({ summary: "Workbench proof run consolidated.", findings: [], recommendations: [], workRequests: [] }),
      totalTokens: 16,
    };
  };
}

export function createWorkbenchProofSeatModel(): typeof executeSeatModel {
  return async (input: SeatModelExecutionInput): Promise<SeatModelExecutionResult> => {
    const history = input.toolLoopContext?.toolHistory ?? [];
    const workbenchCall = history.find((turn) => turn.adapter === "Workbench Sandbox");
    if (input.subtask.seat === "engineer" && !workbenchCall) {
      return {
        output: {
          toolCall: {
            name: "workbench:session",
            action: buildWorkbenchSessionProofAction(),
          },
          summary: null,
        },
        model: "deterministic-workbench-proof",
        tokens: 24,
        costCents: 0,
        fallback: false,
      };
    }

    const summary = workbenchCall
      ? `Engineer Workbench proof complete. ${workbenchCall.result.summary}`
      : `${input.subtask.seat} step complete for Workbench orchestration proof.`;
    return {
      output: {
        toolCall: null,
        summary,
        findings: workbenchCall ? [workbenchCall.result.summary] : [],
        recommendations: [],
        riskNotes: [],
        whatIDidNotDo: [],
        workRequests: [],
      },
      model: "deterministic-workbench-proof",
      tokens: 18,
      costCents: 0,
      fallback: false,
    };
  };
}

export type OrchestrationWorkbenchProofReport = {
  passed: boolean;
  runId: string;
  companyId: string;
  runStatus: string;
  engineerStepId?: string;
  workbenchToolStatus?: ToolCallRecord["status"];
  workbenchSummaryPreview?: string;
  failures: string[];
};

export function summarizeOrchestrationWorkbenchProof(input: {
  run: OrchestrationRun;
  steps: Array<{ id: string; agentRole: string; toolCalls?: ToolCallRecord[] }>;
}): OrchestrationWorkbenchProofReport {
  const failures: string[] = [];
  const engineerStep = input.steps.find((step) =>
    step.agentRole === "engineer"
    && step.toolCalls?.some((call) => call.adapter === "Workbench Sandbox"),
  );
  const workbenchCall = engineerStep?.toolCalls?.find((call) => call.adapter === "Workbench Sandbox");

  if (input.run.status !== "completed") failures.push(`Run did not complete; status=${input.run.status}.`);
  if (!engineerStep) failures.push("No engineer step with a Workbench Sandbox tool call was persisted.");
  if (!workbenchCall) failures.push("No Workbench Sandbox tool call was persisted.");
  if (workbenchCall && workbenchCall.status !== "completed") failures.push(`Workbench Sandbox tool call status was ${workbenchCall.status}.`);
  if (workbenchCall && !/wrote .*package\.json/i.test(workbenchCall.summary)) failures.push("Workbench summary does not show file writes.");
  if (workbenchCall && !/npm test.*exit code 0/i.test(workbenchCall.summary)) failures.push("Workbench summary does not show npm test exit code 0.");
  if (workbenchCall && !/diff --git|Diff:/i.test(workbenchCall.summary)) failures.push("Workbench summary does not include diff evidence.");

  return {
    passed: failures.length === 0,
    runId: input.run.id,
    companyId: input.run.companyId,
    runStatus: input.run.status,
    engineerStepId: engineerStep?.id,
    workbenchToolStatus: workbenchCall?.status,
    workbenchSummaryPreview: workbenchCall?.summary.slice(0, 900),
    failures,
  };
}

function messageText(messages: Parameters<NonNullable<CallJsonOptions["createCompletion"]>>[1], role: "system" | "user"): string {
  return messages
    .filter((message) => message.role === role)
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("\n");
}

function extractObjective(userPrompt: string): string | undefined {
  return userPrompt.match(/Objective:\s*(.+)/i)?.[1]?.trim();
}
