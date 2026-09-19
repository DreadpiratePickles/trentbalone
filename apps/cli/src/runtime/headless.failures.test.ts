/**
 * [W3.1 item 1] The failure channel, end to end through the runtime every surface is built on.
 *
 * C5 built the channel — `FleetMemoryHook.traceSink` turns a failed step into a redacted
 * `[failure]` entry under the brain, and recall ranks those entries into the next run's prelude —
 * and then wired it to nothing: `createHeadlessRuntime` built the orchestrator without a
 * `traceSink`, so in a real run no step ever reached the hook and the brain learned nothing. The
 * module tests (`fleet-memory/failures.hook.test.ts`) call the sink by hand and therefore cannot
 * see that gap; this test drives it the way a run does, through the runtime's own object graph.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import type { OrcEvent, Orchestrator, OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { FAILURE_MARKER } from "@trent/core/fleet-memory/failures.js";
import type { FleetSeatInput } from "@trent/core/fleet-memory/orchestrator-hook.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime, type HeadlessRuntimeDeps } from "./headless.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const COMPANY_ID = "cmp_failures";
const OBJECTIVE = "migrate the billing invoices to the new provider";
const REASON = "the provider CLI refused the batch import twice";
const SEAT = "finance";

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-headless-failures-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const runtimes: HeadlessRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
});

/**
 * A fake seat, executed the way the real orchestrator executes one: the run is opened on the
 * fleet-memory hook, every event goes to the injected `traceSink`, and the run is closed. Nothing
 * here writes a failure itself — that is the wiring under test.
 */
function fakeOrchestrator(
  received: OrchestratorDepsWithImprove[],
  step: Record<string, unknown>,
): (deps: OrchestratorDepsWithImprove) => Orchestrator {
  return (deps = {}) => {
    received.push(deps);
    return {
      run: (options) => {
        const runId = `run_${received.length}`;
        const iterable = (async function* () {
          deps.fleetMemory?.runStarted({ runId, companyId: options.companyId, objective: options.objective });
          const events: OrcEvent[] = [
            { kind: "run_start", runId, at: "2026-09-18T00:00:00.000Z", run: { objective: options.objective } } as OrcEvent,
            { kind: "step_end", runId, at: "2026-09-18T00:00:01.000Z", step } as unknown as OrcEvent,
            { kind: "run_done", runId, at: "2026-09-18T00:00:02.000Z", run: { status: "failed" } } as OrcEvent,
          ];
          for (const event of events) {
            deps.traceSink?.(event);
            yield event;
          }
          deps.fleetMemory?.runFinished(runId);
        })();
        return Object.assign(iterable, {
          runId,
          started: Promise.resolve(runId),
          result: async () => {
            throw new Error("this fake never settles a result");
          },
          cancel: async () => false,
        });
      },
      ensureCompany: vi.fn(async () => COMPANY_ID),
      snapshot: async () => undefined,
      approve: async () => true,
      reject: async () => true,
    };
  };
}

function fakes(step: Record<string, unknown>): { deps: HeadlessRuntimeDeps; received: OrchestratorDepsWithImprove[]; profileDir: string } {
  profileN += 1;
  const configManager = new ConfigManager({ profile: `headless-failures-${profileN}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  // Versioning off: this test is about the failure channel, not about git being installed.
  config.brain = { ...config.brain, enabled: true, versioning: "off" };
  configManager.saveConfig(config);

  const received: OrchestratorDepsWithImprove[] = [];
  const adapter = {
    name: "fake_tool",
    scopes: ["read"],
    instructions: "",
    routingText: "",
    execute: async () => ({ ok: true, output: "" }),
    cleanup: async () => undefined,
  } as unknown as TrentToolAdapter;
  const handle: EgressHandle = {
    port: 1,
    url: "http://127.0.0.1:1",
    token: "t",
    caCertPath: "/dev/null",
    isListening: () => true,
    stop: async () => undefined,
  };

  return {
    profileDir: configManager.getProfileDir(),
    received,
    deps: {
      configManager,
      workspace: REPO_ROOT,
      createOrchestrator: fakeOrchestrator(received, step) as unknown as HeadlessRuntimeDeps["createOrchestrator"],
      buildAdapters: () => [adapter],
      startEgress: async () => handle,
      probeDocker: async () => ({ daemon: false, imagePresent: false }),
      openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
    },
  };
}

/** Every `brain/memory/*.md` note this profile holds, concatenated. */
function brainNotes(profileDir: string): string {
  const dir = path.join(profileDir, "brain", "memory");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return "";
  }
  return names.map((name) => readFileSync(path.join(dir, name), "utf8")).join("\n");
}

/** The prelude one seat of `runId` was handed, built the way `wrapSeatModel` builds it in a run. */
async function preludeFor(runtime: HeadlessRuntime, runId: string, seat: string): Promise<string> {
  runtime.fleetMemory.runStarted({ runId, companyId: runtime.companyId, objective: OBJECTIVE });
  const input: FleetSeatInput = { companyId: runtime.companyId, subtask: { id: `t_${seat}`, seat, objective: OBJECTIVE } };
  await runtime.fleetMemory.wrapSeatModel(async (i: FleetSeatInput) => i)(input);
  return runtime.fleetMemory.preludeFor(runId, seat) ?? "";
}

describe("the headless runtime carries a failed step to the brain", () => {
  const failedStep = {
    id: "s1",
    agentRole: SEAT,
    title: "import the invoices",
    status: "failed",
    output: REASON,
    toolCalls: [{ adapter: "terminal", action: "terminal_run", status: "failed", summary: REASON }],
  };

  it("a run whose seat fails leaves a [failure] entry in the brain's daily note", async () => {
    const f = fakes(failedStep);
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    for await (const _ of runtime.run(OBJECTIVE)) void _;

    const notes = brainNotes(f.profileDir);
    expect(notes).toContain(FAILURE_MARKER);
    expect(notes).toContain(REASON);
    expect(notes).toContain(SEAT);
  });

  it("the next run's recall carries that failure into the seat's prelude, marked as one", async () => {
    const f = fakes(failedStep);
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    for await (const _ of runtime.run(OBJECTIVE)) void _;
    const prelude = await preludeFor(runtime, "run_next", SEAT);

    expect(prelude).toContain(FAILURE_MARKER);
    expect(prelude).toContain("refused the batch import");
  });

  it("a step that completed writes no failure, so success never arrives as one", async () => {
    const f = fakes({ id: "s1", agentRole: SEAT, title: "import the invoices", status: "completed", output: "imported 412 invoices" });
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    for await (const _ of runtime.run(OBJECTIVE)) void _;

    expect(brainNotes(f.profileDir)).not.toContain(FAILURE_MARKER);
  });
});
