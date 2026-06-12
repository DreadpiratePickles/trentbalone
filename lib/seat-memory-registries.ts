import { store } from "@/lib/store";
import type { AgentRole, Document, OrchestratorStep } from "@/lib/types";

type SeatRegistryConfig = {
  key: string;
  titlePrefix: string;
};

const REGISTRIES: Partial<Record<AgentRole, SeatRegistryConfig>> = {
  growth: { key: "experiments", titlePrefix: "Experiment registry" },
  sales: { key: "pipelineState", titlePrefix: "Pipeline state" },
  content: { key: "contentCalendar", titlePrefix: "Content calendar" },
};

export async function persistSeatRegistryMemory(input: {
  companyId: string;
  runId: string;
  step: Pick<OrchestratorStep, "id" | "agentRole" | "title" | "output" | "completedAt">;
}): Promise<Document | undefined> {
  const registry = REGISTRIES[input.step.agentRole];
  const output = input.step.output?.trim();
  if (!registry || !output) return undefined;

  return store.createDocument({
    companyId: input.companyId,
    type: "agent_note",
    title: `${registry.titlePrefix}: ${input.step.title.slice(0, 120)}`,
    content: [
      `Registry key: ${registry.key}`,
      `Seat: ${input.step.agentRole}`,
      `Run: ${input.runId}`,
      `Step: ${input.step.id}`,
      "",
      output.slice(0, 2400),
    ].join("\n"),
    source: `seat-registry:${input.step.agentRole}:${input.runId}:${input.step.id}`,
    memoryTier: "semantic",
    validFrom: input.step.completedAt,
  });
}
