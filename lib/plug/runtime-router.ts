import { enqueueSubtaskRun } from "@/lib/queue";
import { store } from "@/lib/store";
import type { Subtask } from "@/lib/planner";
import { makeId, nowIso } from "@/lib/utils";
import { pinPlugVersion } from "@/lib/plug/versioning";
import { plugMemoryNamespace, type PlugDefinition } from "@/lib/plug/schema-v2";
import { getDefaultWorkbenchProvider } from "@/lib/workbench-providers";

export type PlugInstallRecord = {
  companyId: string;
  plugId: string;
  version: string;
  installedAt: string;
  installJobRunId: string;
  publisherId: string;
  creatorVerified: boolean;
  ownershipHistory: PlugDefinition["publisher"]["ownershipHistory"];
};

export async function installPlugForCompany(input: {
  companyId: string;
  plug: PlugDefinition;
}): Promise<PlugInstallRecord> {
  const pin = pinPlugVersion(input.plug, input.companyId);
  const installedAt = nowIso();
  const jobRun = await store.createJobRun({
    companyId: input.companyId,
    type: "plug_install",
    status: "completed",
    trigger: "system",
    completedAt: installedAt,
    summary: `Installed Plug ${input.plug.slug}@${input.plug.version}`,
    resultCount: 1,
    metadata: {
      kind: "plug_install",
      plugId: input.plug.id,
      slug: input.plug.slug,
      version: input.plug.version,
      pinnedAt: pin.pinnedAt,
      installedAt,
      publisherId: input.plug.publisher.id,
      creatorVerified: input.plug.publisher.verified,
      ownershipHistory: input.plug.publisher.ownershipHistory,
    },
  });
  return {
    companyId: input.companyId,
    plugId: input.plug.id,
    version: input.plug.version,
    installedAt,
    installJobRunId: jobRun.id,
    publisherId: input.plug.publisher.id,
    creatorVerified: input.plug.publisher.verified,
    ownershipHistory: input.plug.publisher.ownershipHistory,
  };
}

export async function listInstalledPlugsForCompany(companyId: string): Promise<PlugInstallRecord[]> {
  const jobRuns = await store.listJobRuns(companyId);
  return jobRuns.flatMap((jobRun) => {
    if (jobRun.type !== "plug_install") return [];
    const metadata = jobRun.metadata;
    if (!isPlugInstallMetadata(metadata)) return [];
    return [{
      companyId,
      plugId: metadata.plugId,
      version: metadata.version,
      installedAt: metadata.installedAt,
      installJobRunId: jobRun.id,
      publisherId: metadata.publisherId,
      creatorVerified: metadata.creatorVerified,
      ownershipHistory: metadata.ownershipHistory,
    }];
  });
}

export async function runInstalledPlug(input: {
  install: PlugInstallRecord;
  plug: PlugDefinition;
  variables?: Record<string, string>;
  enqueueSubtaskRun?: typeof enqueueSubtaskRun;
}) {
  if (input.install.plugId !== input.plug.id) {
    throw new Error("Installed Plug does not match runtime Plug definition");
  }

  const session = await store.createWorkbenchSession({
    companyId: input.install.companyId,
    objective: `Plug ${input.plug.slug}: ${input.plug.name}`,
    agentRole: input.plug.seats[0]?.seat ?? "engineer",
    status: "queued",
    provider: getDefaultWorkbenchProvider(),
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: Math.max(...input.plug.seats.map((seat) => seat.timeoutMs / 1000), 60),
      maxCostCents: input.plug.costPerRunCents,
      approvalRequiredFor: input.plug.declaredTools.flatMap((tool) => tool.approvalRequiredActions),
      rollbackAvailable: true,
    },
  });
  const enqueue = input.enqueueSubtaskRun ?? enqueueSubtaskRun;
  const enqueuedJobRunIds: string[] = [];

  for (const seat of input.plug.seats) {
    const job = await enqueue({
      companyId: input.install.companyId,
      subtask: buildPlugSubtask(input.plug, seat, input.install.companyId, session.id, input.variables ?? {}),
      trigger: "system",
    });
    enqueuedJobRunIds.push(job.id);
  }

  const artifact = await store.addWorkbenchArtifact({
    companyId: input.install.companyId,
    sessionId: session.id,
    kind: "terminal_log",
    title: `${input.plug.name} run manifest`,
    storageKey: `plug-runs/${session.id}/manifest.json`,
    mimeType: "application/json",
    sizeBytes: JSON.stringify({ plugId: input.plug.id, enqueuedJobRunIds }).length,
  });
  await store.addWorkbenchEvent({
    companyId: input.install.companyId,
    sessionId: session.id,
    type: "artifact",
    status: "completed",
    title: "Plug run manifest created",
    content: `Queued ${enqueuedJobRunIds.length} Plug seat job${enqueuedJobRunIds.length === 1 ? "" : "s"}.`,
    artifactId: artifact.id,
  });

  return {
    sessionId: session.id,
    enqueuedJobRunIds,
    outputArtifactId: artifact.id,
  };
}

function buildPlugSubtask(
  plug: PlugDefinition,
  seat: PlugDefinition["seats"][number],
  companyId: string,
  sessionId: string,
  variables: Record<string, string>,
): Subtask {
  return {
    id: makeId("subtask"),
    seat: seat.seat,
    objective: renderTemplate(seat.promptTemplate, variables),
    outputContractId: seat.outputContract,
    toolGuidance: plug.declaredTools.map((tool) => `${tool.toolId}:${tool.allowedActions.join(",")}`),
    boundaries: [
      `memory=${plugMemoryNamespace(plug, companyId)}`,
      "execute through workbench queue",
    ],
    input: {
      plugRun: {
        plugId: plug.id,
        plugSlug: plug.slug,
        sessionId,
        variables,
      },
    },
    contextBundle: {},
    classification: { type: "plug", complexity: plug.complexityTier === "advanced" ? "complex" : "standard", reversibility: "reversible" },
    budgetCents: seat.budgetCents,
  };
}

function renderTemplate(template: string, variables: Record<string, string>) {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => variables[key.trim()] ?? "");
}

type PlugInstallMetadata = {
  kind: "plug_install";
  plugId: string;
  version: string;
  installedAt: string;
  publisherId: string;
  creatorVerified: boolean;
  ownershipHistory: PlugDefinition["publisher"]["ownershipHistory"];
};

function isPlugInstallMetadata(metadata: Record<string, unknown>): metadata is PlugInstallMetadata {
  return metadata.kind === "plug_install"
    && typeof metadata.plugId === "string"
    && typeof metadata.version === "string"
    && typeof metadata.installedAt === "string"
    && typeof metadata.publisherId === "string"
    && typeof metadata.creatorVerified === "boolean"
    && Array.isArray(metadata.ownershipHistory);
}
