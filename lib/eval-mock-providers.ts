import type OpenAI from "openai";
import { executeSeatModel } from "@/lib/model-gateway";
import type { OrchestrationGoldenObjective } from "@/lib/orchestration-eval";
import type { OrchestrationPlan } from "@/lib/orchestrator-runtime";
import type { WorkbenchGoldenObjective } from "@/lib/workbench-eval-suite";
import { passingInteractionDriver } from "@/lib/workbench-interaction-verify";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { WorkbenchCriticReviewer } from "@/lib/workbench-verify";
import type { CallJsonOptions } from "@/lib/ai-client";

const THREE_STEP_TEMPLATE: OrchestrationPlan = {
  objective: "",
  reasoning: "Eval mock planner output",
  steps: [
    {
      id: "s1",
      title: "Scope objective",
      rationale: "Define done",
      agentRole: "ceo",
      dependsOn: [],
      expectedOutput: "Success definition",
      riskLevel: "low",
      needsApproval: false,
    },
    {
      id: "s2",
      title: "Execute primary workstream",
      rationale: "Deliverable",
      agentRole: "engineer",
      dependsOn: ["s1"],
      expectedOutput: "First-pass deliverable",
      riskLevel: "medium",
      needsApproval: false,
    },
    {
      id: "s3",
      title: "Consolidate",
      rationale: "Wrap up",
      agentRole: "ceo",
      dependsOn: ["s2"],
      expectedOutput: "Summary",
      riskLevel: "low",
      needsApproval: false,
    },
  ],
  successCriteria: ["Deliverable produced"],
  blockers: [],
};

export const ORCHESTRATION_INTEGRATION_OBJECTIVE_IDS = [
  "orc_churn",
  "orc_launch_email",
  "orc_feature_spec",
] as const;

export const WORKBENCH_INTEGRATION_OBJECTIVE_IDS = [
  "wb_countdown",
  "wb_notes",
  "wb_faq",
] as const;

export function buildEvalOrchestrationPlan(objective: string): OrchestrationPlan {
  return {
    ...THREE_STEP_TEMPLATE,
    objective,
    reasoning: `Eval mock plan for: ${objective}`,
  };
}

export function createEvalMockCompletion(options?: {
  forceBrokenPlanner?: boolean;
}): NonNullable<CallJsonOptions["createCompletion"]> {
  return async (_model, messages) => {
    const system = messageText(messages, "system");
    const user = messageText(messages, "user");

    if (options?.forceBrokenPlanner && isPlannerPrompt(system, user)) {
      return {
        content: JSON.stringify({
          objective: "broken",
          reasoning: "invalid eval regression",
          steps: [
            {
              id: "s1",
              title: "Cycle A",
              rationale: "broken",
              agentRole: "ceo",
              dependsOn: ["s2"],
              expectedOutput: "never",
              riskLevel: "low",
              needsApproval: false,
            },
            {
              id: "s2",
              title: "Cycle B",
              rationale: "broken",
              agentRole: "engineer",
              dependsOn: ["s1"],
              expectedOutput: "never",
              riskLevel: "low",
              needsApproval: false,
            },
          ],
          successCriteria: [],
          blockers: ["forced_failure"],
        }),
        totalTokens: 12,
      };
    }

    if (isCriticPrompt(system)) {
      return {
        content: JSON.stringify({ verdict: "pass", reason: "eval mock critic pass" }),
        totalTokens: 8,
      };
    }

    if (isPlannerPrompt(system, user)) {
      const objective = extractObjective(user) ?? "eval objective";
      return {
        content: JSON.stringify(buildEvalOrchestrationPlan(objective)),
        totalTokens: 24,
      };
    }

    return {
      content: JSON.stringify({
        summary: "Eval seat deliverable complete",
        findings: ["mock finding"],
        recommendations: [],
        workRequests: [],
      }),
      totalTokens: 16,
    };
  };
}

export function createEvalExecuteSeatModel(): typeof executeSeatModel {
  return (input) => executeSeatModel({
    ...input,
    createChatCompletion: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: `Completed ${input.subtask.seat} step for eval`,
            findings: [],
            recommendations: [],
            workRequests: [],
          }),
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
    }),
  });
}

export function createEvalWorkbenchCritic(): WorkbenchCriticReviewer {
  return async () => ({
    status: "pass",
    detail: "Eval mock critic: objective satisfied",
  });
}

export function createEvalWorkbenchProvider(
  objective: WorkbenchGoldenObjective,
  options?: { forceBrokenBuild?: boolean },
): WorkbenchProviderAdapter {
  const domText = objectiveDomText(objective);
  return {
    name: "mock_local",
    start: async () => undefined,
    stop: async () => undefined,
    exec: async () => ({
      stdout: options?.forceBrokenBuild ? "build failed" : "ok",
      stderr: "",
      exitCode: options?.forceBrokenBuild ? 1 : 0,
      durationMs: 5,
    }),
    readFile: async () => "",
    writeFile: async () => undefined,
    listFiles: async () => [],
    runTests: async () => ({
      passed: options?.forceBrokenBuild ? 0 : 3,
      failed: options?.forceBrokenBuild ? 1 : 0,
      skipped: 0,
      durationMs: 9,
      output: options?.forceBrokenBuild ? "1 failing" : "3 passing",
      exitCode: options?.forceBrokenBuild ? 1 : 0,
    }),
    screenshot: async () => ({
      dataUri: "data:image/png;base64,ZXZhbA==",
      width: 1280,
      height: 720,
      storageKey: "screenshots/eval.png",
    }),
    getPreviewUrl: async () => "http://localhost:3000",
    inspectPreview: async (_session, url) => ({
      url,
      screenshot: {
        dataUri: "data:image/png;base64,ZXZhbA==",
        width: 1280,
        height: 720,
        storageKey: "screenshots/eval.png",
      },
      domText,
      visibleElements: 6,
      consoleErrors: [],
      pageErrors: [],
    }),
    captureArtifact: async () => {
      throw new Error("captureArtifact not used in eval mocks");
    },
  } as WorkbenchProviderAdapter;
}

export function buildEvalWorkbenchStreamArtifact(
  objective: WorkbenchGoldenObjective,
  options?: { forceBrokenBuild?: boolean },
) {
  const html = objectiveHtml(objective, options?.forceBrokenBuild);
  const xml =
    `<boltArtifact id="eval" title="${objective.id}">\n` +
    `<boltAction type="file" filePath="index.html">${html}</boltAction>\n` +
    `<boltAction type="shell">npm install</boltAction>\n` +
    `<boltAction type="start">npm run dev</boltAction>\n` +
    `</boltArtifact>`;

  return async function* streamArtifact() {
    yield { type: "token" as const, content: xml };
    yield { type: "finish" as const, reason: "stop" as const };
    yield { type: "usage" as const, inputTokens: 80, outputTokens: 160 };
  };
}

export function buildEvalWorkbenchDeps(objective: WorkbenchGoldenObjective, options?: {
  forceBrokenBuild?: boolean;
}) {
  return {
    provider: createEvalWorkbenchProvider(objective, options),
    streamArtifact: buildEvalWorkbenchStreamArtifact(objective, options),
    acceptanceSteps: [{ action: "click start", expect: "timer responds" }],
    interactionDriver: passingInteractionDriver(),
    criticReviewer: createEvalWorkbenchCritic(),
  };
}

function messageText(messages: OpenAI.Chat.ChatCompletionMessageParam[], role: string): string {
  const msg = messages.find((item) => item.role === role);
  if (!msg || typeof msg.content !== "string") return "";
  return msg.content;
}

function isPlannerPrompt(system: string, user: string): boolean {
  return system.includes("chief orchestrator")
    || system.includes("orchestration planner")
    || user.includes("Objective:");
}

function isCriticPrompt(system: string): boolean {
  return system.includes("quality supervisor") || system.includes("Workbench critic");
}

function extractObjective(user: string): string | undefined {
  const match = /Objective:\s*(.+)/i.exec(user);
  return match?.[1]?.trim();
}

function objectiveDomText(objective: WorkbenchGoldenObjective): string {
  return objectiveHtml(objective).replace(/<[^>]+>/g, " ");
}

function objectiveHtml(objective: WorkbenchGoldenObjective, broken = false): string {
  if (broken) return "<div>broken</div>";
  switch (objective.id) {
    case "wb_countdown":
      return "<h1>Countdown Timer controls</h1><button>Start</button><button>Pause</button><button>Reset</button>";
    case "wb_notes":
      return "<h1>Notes App</h1><button>Add note</button><button>Edit note</button><button>Delete note</button>";
    case "wb_faq":
      return "<h1>FAQ Accordion interactions</h1><button>Expand</button><button>Collapse</button>";
    default:
      return `<h1>${objective.objective}</h1><button>Start</button>`;
  }
}

export function pickIntegrationOrchestrationObjectives(
  objectives: OrchestrationGoldenObjective[],
): OrchestrationGoldenObjective[] {
  return ORCHESTRATION_INTEGRATION_OBJECTIVE_IDS
    .map((id) => objectives.find((item) => item.id === id))
    .filter((item): item is OrchestrationGoldenObjective => Boolean(item));
}

export function pickIntegrationWorkbenchObjectives(
  objectives: WorkbenchGoldenObjective[],
): WorkbenchGoldenObjective[] {
  return WORKBENCH_INTEGRATION_OBJECTIVE_IDS
    .map((id) => objectives.find((item) => item.id === id))
    .filter((item): item is WorkbenchGoldenObjective => Boolean(item));
}
