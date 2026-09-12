import type {
  WorkbenchArtifact,
  WorkbenchEvent,
  WorkbenchFileEntry,
  WorkbenchSession,
} from "@/lib/types";

export type WorkbenchProgressStatus = "pending" | "running" | "completed" | "failed" | "needs_approval";

export type WorkbenchProgressStep = {
  key: "session" | "plan" | "sandbox" | "test" | "screenshot" | "files" | "artifacts";
  label: string;
  status: WorkbenchProgressStatus;
  title: string;
};

export type WorkbenchProgress = {
  steps: WorkbenchProgressStep[];
  current?: WorkbenchProgressStep;
  completedCount: number;
};

type WorkbenchProgressInput = {
  session: WorkbenchSession | null;
  events: WorkbenchEvent[];
  files: WorkbenchFileEntry[];
  artifacts: Partial<WorkbenchArtifact>[];
};

const statusRank: Record<WorkbenchProgressStatus, number> = {
  failed: 5,
  needs_approval: 4,
  running: 3,
  pending: 2,
  completed: 1,
};

export function deriveWorkbenchProgress(input: WorkbenchProgressInput): WorkbenchProgress {
  const latestByType = new Map<WorkbenchEvent["type"], WorkbenchEvent>();
  for (const event of input.events) {
    const previous = latestByType.get(event.type);
    if (!previous || event.createdAt >= previous.createdAt) latestByType.set(event.type, event);
  }

  const plan = latestByType.get("plan");
  const test = latestByType.get("test");
  const screenshot = latestByType.get("screenshot");
  const sandbox = input.events.find((event) =>
    event.type === "system" && /provisioned|started|ready/i.test(`${event.title} ${event.content}`)
  );

  const sessionStatus: WorkbenchProgressStatus =
    input.session?.status === "failed"
      ? "failed"
      : input.session
      ? "completed"
      : "pending";

  const sandboxStatus: WorkbenchProgressStatus = sandbox
    ? eventStatus(sandbox)
    : input.session?.status === "running" || input.session?.status === "completed"
    ? "completed"
    : "pending";

  const steps: WorkbenchProgressStep[] = [
    {
      key: "session",
      label: "Session",
      status: sessionStatus,
      title: input.session ? "Workbench session created" : "No session selected",
    },
    eventStep("plan", "Plan", plan, "Execution plan pending"),
    {
      key: "sandbox",
      label: "Sandbox",
      status: sandboxStatus,
      title: sandbox?.title ?? "Sandbox pending",
    },
    eventStep("test", "Tests", test, "Tests not run"),
    eventStep("screenshot", "Screenshot", screenshot, "Screenshot not captured"),
    {
      key: "files",
      label: "Files",
      status: input.files.length > 0 ? "completed" : "pending",
      title: input.files.length > 0 ? `${input.files.length} file${input.files.length === 1 ? "" : "s"} visible` : "No files loaded",
    },
    {
      key: "artifacts",
      label: "Artifacts",
      status: input.artifacts.length > 0 ? "completed" : "pending",
      title: input.artifacts.length > 0 ? `${input.artifacts.length} artifact${input.artifacts.length === 1 ? "" : "s"} captured` : "No artifacts captured",
    },
  ];

  const current =
    steps.find((step) => step.status === "failed") ??
    steps.find((step) => step.status === "needs_approval") ??
    steps.find((step) => step.status === "running") ??
    steps.find((step) => step.status === "pending") ??
    steps.at(-1);

  return {
    steps,
    current,
    completedCount: steps.filter((step) => step.status === "completed").length,
  };
}

function eventStep(
  key: WorkbenchProgressStep["key"],
  label: string,
  event: WorkbenchEvent | undefined,
  fallbackTitle: string
): WorkbenchProgressStep {
  return {
    key,
    label,
    status: event ? eventStatus(event) : "pending",
    title: event?.title ?? fallbackTitle,
  };
}

function eventStatus(event: WorkbenchEvent): WorkbenchProgressStatus {
  return event.status in statusRank ? event.status : "pending";
}
