import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { WorkbenchCriticReviewer } from "@/lib/workbench-verify";
import type { AcceptanceStep, InteractionDriver } from "@/lib/workbench-interaction-verify";
import type { WorkbenchAgentMode } from "@/lib/types";
import { MODELS } from "@/lib/ai-client";

export type WorkbenchAgentChunk =
  | { type: "status";  phase: string; detail?: string }
  | { type: "content"; content: string }
  | { type: "plan";    steps: AgentPlanStep[] }
  | { type: "file";    path: string; action: "create" | "update"; bytes: number }
  | { type: "command"; command: string; exitCode: number; output: string }
  | { type: "test";    passed: number; failed: number; healed: boolean }
  | { type: "verify";  passed: boolean; checks: { name: string; status: string; detail: string }[] }
  | { type: "preview"; url: string }
  | { type: "error";   message: string }
  | { type: "done";    messageId: string };

export type AgentPlanStep = { kind: string; summary?: string; path?: string; command?: string };

export type BuildAttemptState = {
  packageChanged: boolean;
  executedCommands: string[];
};

export type ArtifactStreamToken =
  | { type: "token";  content: string }
  | { type: "finish"; reason: "stop" | "length" | string }
  | { type: "usage";  inputTokens: number; outputTokens: number };

export type StreamInput = {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
};

export type AgentDeps = {
  /** Stream artifact XML tokens (build mode). */
  streamArtifact: (input: StreamInput) => AsyncGenerator<ArtifactStreamToken>;
  /** Stream assistant text tokens (research/design modes). */
  stream: (input: { system: string; user: string }) => AsyncGenerator<string>;
  provider: WorkbenchProviderAdapter;
  acceptanceSteps?: AcceptanceStep[];
  interactionDriver?: InteractionDriver;
  criticReviewer?: WorkbenchCriticReviewer;
};

export const PLANNER_MODEL    = MODELS.PLANNER;
export const EXECUTOR_MODEL   = MODELS.EXECUTOR;
export const MAX_SEGMENTS     = 2;
export const MAX_BUILD_ATTEMPTS = Math.max(1, Number.parseInt(process.env.WORKBENCH_BUILD_MAX_ATTEMPTS ?? "5", 10) || 5);
export const CONTINUE_PROMPT  =
  "Continue the <boltArtifact> exactly where you left off. " +
  "Do NOT repeat already-emitted content. Resume from the exact point of truncation.";

export const AGENT_PERSONAS: Record<WorkbenchAgentMode, string> = {
  build: "",
  research:
    "You are Trent's deep research analyst. Scope the question, surface structured " +
    "findings with sources, synthesise a recommendation. Be thorough but scannable: " +
    "headers, bullets, code where useful.",
  design:
    "You are Trent's product designer and UI/UX expert. Give a design vision, " +
    "concrete decisions (layout, components, colour, type, interaction, copy), " +
    "then an implementation-ready spec.",
};
