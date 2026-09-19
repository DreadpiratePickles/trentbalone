/**
 * [C5] The failure channel and the provenance tag, through the hook a run actually uses.
 *
 * Two assertions the module tests cannot make on their own: a step that failed in run 1 is in the
 * seat's prelude in run 2, and a step whose tool calls were untrusted is still marked untrusted
 * when another seat recalls its output a run later.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrain } from "./brain.js";
import { FAILURE_MARKER } from "./failures.js";
import { createFleetMemoryHook, type FleetSeatInput } from "./orchestrator-hook.js";
import { UNTRUSTED_MARKER } from "./recall.js";
import { InMemoryFleetSource, type FleetRun } from "./source.js";

const COMPANY = "co-1";
const OBJECTIVE = "migrate the billing invoices to the new provider";
let profileDir = "";

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-failure-hook-"));
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function hookFor(source: InMemoryFleetSource) {
  return createFleetMemoryHook({ source, profileDir, brain: createBrain({ profileDir, versioning: "off" }) });
}

async function preludeOf(hook: ReturnType<typeof hookFor>, runId: string, seat: string): Promise<string> {
  const input: FleetSeatInput = { companyId: COMPANY, subtask: { id: `t-${seat}`, seat, objective: OBJECTIVE } };
  await hook.wrapSeatModel(async (i: FleetSeatInput) => i)(input);
  return hook.preludeFor(runId, seat) ?? "";
}

function completedRun(overrides: Partial<FleetRun> = {}): FleetRun {
  return {
    id: "run-1",
    companyId: COMPANY,
    objective: OBJECTIVE,
    status: "completed",
    summary: null,
    completedAt: "2026-09-17T00:00:00.000Z",
    steps: [],
    ...overrides,
  };
}

describe("the failure channel through the hook", () => {
  it("puts run 1's failed step in run 2's prelude as a [failure] line", async () => {
    const source = new InMemoryFleetSource();
    const hook = hookFor(source);
    hook.runStarted({ runId: "run-1", companyId: COMPANY, objective: OBJECTIVE });
    hook.traceSink({
      kind: "step_end",
      runId: "run-1",
      at: "2026-09-17T00:00:00.000Z",
      step: { id: "s1", agentRole: "finance", title: "import the invoices", status: "failed", output: "the provider CLI refused the batch import twice" },
    });
    hook.runFinished("run-1");

    hook.runStarted({ runId: "run-2", companyId: COMPANY, objective: OBJECTIVE });
    const prelude = await preludeOf(hook, "run-2", "finance");
    expect(prelude).toContain(FAILURE_MARKER);
    expect(prelude).toContain("the provider CLI refused the batch import");
    expect(prelude).toContain("finance");
  });

  it("does not tag a step that completed, so success never arrives as a failure", async () => {
    const source = new InMemoryFleetSource();
    const hook = hookFor(source);
    hook.runStarted({ runId: "run-1", companyId: COMPANY, objective: OBJECTIVE });
    hook.traceSink({
      kind: "step_end",
      runId: "run-1",
      at: "2026-09-17T00:00:00.000Z",
      step: { id: "s1", agentRole: "finance", title: "import the invoices", status: "completed", output: "imported 412 invoices" },
    });
    hook.runFinished("run-1");

    hook.runStarted({ runId: "run-2", companyId: COMPANY, objective: OBJECTIVE });
    expect(await preludeOf(hook, "run-2", "finance")).not.toContain(FAILURE_MARKER);
  });
});

describe("provenance on a recalled step output", () => {
  it("carries the tag the run's tool calls earned into the next run's recall", async () => {
    const source = new InMemoryFleetSource();
    const hook = hookFor(source);
    hook.runStarted({ runId: "run-1", companyId: COMPANY, objective: OBJECTIVE });
    hook.traceSink({
      kind: "step_end",
      runId: "run-1",
      at: "2026-09-17T00:00:00.000Z",
      step: {
        id: "s1",
        agentRole: "analyst",
        title: "read the provider migration guide",
        status: "completed",
        output: "the new provider requires billing invoices to be uploaded in batches of 100",
        toolCalls: [{ adapter: "web", action: "web_extract", status: "completed", summary: "fetched the guide", provenance: "untrusted" }],
      },
    } as Parameters<typeof hook.traceSink>[0]);
    hook.runFinished("run-1");
    source.addRun(
      completedRun({
        steps: [
          {
            id: "s1",
            runId: "run-1",
            agentRole: "analyst",
            title: "read the provider migration guide",
            status: "completed",
            output: "the new provider requires billing invoices to be uploaded in batches of 100",
          },
        ],
      }),
    );

    hook.runStarted({ runId: "run-2", companyId: COMPANY, objective: OBJECTIVE });
    const prelude = await preludeOf(hook, "run-2", "finance");
    expect(prelude).toContain("uploaded in batches of 100");
    expect(prelude).toContain(UNTRUSTED_MARKER);
    expect(hook.stepProvenance("run-1", "s1")).toBe("untrusted");
  });
});
