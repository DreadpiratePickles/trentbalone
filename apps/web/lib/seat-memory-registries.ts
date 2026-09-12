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

/** Roles that own a compounding registry the scheduler/critic can recall. */
export const SEAT_REGISTRY_ROLES = Object.keys(REGISTRIES) as AgentRole[];

export function seatRegistryConfig(role: AgentRole): SeatRegistryConfig | undefined {
  return REGISTRIES[role];
}

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

const REGISTRY_HEADER_RE = /^(Registry key|Seat|Run|Step):.*$/gm;

function stripRegistryHeader(content: string): string {
  return content.replace(REGISTRY_HEADER_RE, "").replace(/\n{2,}/g, "\n").trim();
}

/**
 * Consume side of the compounding loop: load a seat's most recent registry
 * entries so the next scheduled durable run (and the critic reviewing it) can
 * see what experiments/pipeline/content already happened, instead of starting
 * blind each cycle.
 */
export async function readSeatRegistryMemory(
  companyId: string,
  role: AgentRole,
  limit = 3,
): Promise<Document[]> {
  if (!REGISTRIES[role]) return [];
  const prefix = `seat-registry:${role}:`;
  const documents = await store.listDocuments(companyId).catch(() => []);
  return documents
    .filter((doc) => doc.source?.startsWith(prefix))
    .sort((a, b) =>
      (b.validFrom ?? b.createdAt ?? "").localeCompare(a.validFrom ?? a.createdAt ?? ""),
    )
    .slice(0, Math.max(0, limit));
}

/**
 * Render a recall block for a seat's registry, suitable for injection into the
 * seat runtime / scheduler context. Returns "" when there is nothing to recall.
 */
export async function buildSeatRegistryRecall(
  companyId: string,
  role: AgentRole,
  limit = 3,
): Promise<string> {
  const registry = REGISTRIES[role];
  if (!registry) return "";
  const documents = await readSeatRegistryMemory(companyId, role, limit);
  if (!documents.length) return "";
  return [
    `${registry.titlePrefix.toUpperCase()} (recalled — registry key: ${registry.key})`,
    "Continue these instead of restarting; reference prior entries explicitly.",
    ...documents.map(
      (doc) => `- [${doc.id}] ${doc.title}: ${stripRegistryHeader(doc.content).slice(0, 220)}`,
    ),
  ].join("\n");
}
