/**
 * `trent a2a serve` and `trent acp`: both are advertised surfaces whose task endpoints must reach
 * the REAL agent runtime. They used to answer with strings the servers composed themselves
 * (`A2AServer.ts:88,92`, `ACPServer.ts:123`), which AGENTS.md invariant 2 forbids.
 *
 * Driven through `runCli` with a fake headless runtime, so no proxy, sandbox or model is involved:
 * the assertion is that the text coming back over HTTP is the one the runtime produced, and that
 * Ctrl+C releases that runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@trent/core/errors/index.js";
import { a2aObjective, type A2ATask } from "@trent/core/a2a/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { runCli } from "../index.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime, HeadlessRuntimeDeps } from "../../runtime/headless.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-servers-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_srv", at: "2026-09-18T00:00:00.000Z", ...extra } as OrcEvent;
}

/** A `process` stand-in: the command claims the interrupt, and the test raises it to shut down. */
function fakeSignals(order: string[]) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    once(event: string, listener: () => void): unknown {
      const forEvent = listeners.get(event) ?? [];
      forEvent.push(listener);
      listeners.set(event, forEvent);
      return undefined;
    },
    exit(code: number): void {
      order.push(`exit:${code}`);
    },
    async raise(event: string): Promise<void> {
      for (const listener of listeners.get(event) ?? []) listener();
      for (let i = 0; i < 200 && !order.some((entry) => entry.startsWith("exit:")); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
}

function fakes() {
  const objectives: string[] = [];
  const order: string[] = [];
  const runtimeDeps: HeadlessRuntimeDeps[] = [];
  const cleanup = vi.fn(async () => {
    order.push("cleanup");
    return undefined;
  });
  const runtime = {
    orchestrator: {},
    companyId: "cmp_srv",
    run: (objective: string) => {
      objectives.push(objective);
      return (async function* () {
        yield ev("run_start", { run: { objective } });
        yield ev("run_done", { run: { status: "completed", summary: `brief for: ${objective}` } });
      })();
    },
    cleanup,
  } as unknown as HeadlessRuntime;
  const signals = fakeSignals(order);
  const overrides: CliOverrides = {
    signals,
    gatewayRuntime: async (deps) => {
      runtimeDeps.push(deps);
      return runtime;
    },
  };
  return { objectives, order, runtimeDeps, cleanup, signals, overrides };
}

const payload = {
  taskId: "task-cli-1",
  originAgent: "remote-partner-agent",
  targetAgent: "engineer",
  taskType: "architecture-review",
  parameters: { repo: "acme/backend" },
};

describe("trent a2a serve", () => {
  it("binds a server whose task endpoint runs the headless runtime", async () => {
    const f = fakes();
    const result = await runCli(["a2a", "serve", "--json", "--port", "7861"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.keepAlive).toBe(true);
    const data = JSON.parse(result.stdout) as { port: number; runner: boolean };
    expect(data.runner).toBe(true);
    expect(f.runtimeDeps).toHaveLength(1);

    const res = await fetch(`http://127.0.0.1:${data.port}/a2a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const task = (await res.json()) as A2ATask;
    expect(res.status).toBe(200);
    expect(task.status.state).toBe("completed");
    expect(task.artifacts[0]?.parts[0]?.text).toBe(`brief for: ${a2aObjective(payload)}`);
    expect(f.objectives).toEqual([a2aObjective(payload)]);

    // Ctrl+C releases the runtime the server was built on, then exits.
    await f.signals.raise("SIGINT");
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(["cleanup", `exit:${EXIT.INTERRUPT}`]);
  });

  it("--dry-run reports the port and builds no runtime", async () => {
    const f = fakes();
    const result = await runCli(["a2a", "serve", "--json", "--dry-run", "--port", "7862"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, port: 7862 });
    expect(f.runtimeDeps).toEqual([]);
  });
});

describe("trent acp", () => {
  it("binds a server whose agent/chat runs the headless runtime", async () => {
    const f = fakes();
    const result = await runCli(["acp", "--json", "--port", "7863"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { port: number; runner: boolean };
    expect(data.runner).toBe(true);

    const res = await fetch(`http://127.0.0.1:${data.port}/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent/chat", params: { agent: "engineer", prompt: "why is the build red?" } }),
    });
    const body = (await res.json()) as { result?: { response?: string }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result?.response).toBe("brief for: why is the build red?");
    expect(f.objectives).toEqual(["why is the build red?"]);

    await f.signals.raise("SIGINT");
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });
});
