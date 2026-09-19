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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT } from "@trent/core/errors/index.js";
import { a2aObjective, A2A_PROTOCOL_VERSION, A2A_WELL_KNOWN_PATH, type A2AAgentCard, type A2ALegacyTask } from "@trent/core/a2a/index.js";
import { ACP_PROTOCOL_VERSION } from "@trent/core/acp/index.js";
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
    const task = (await res.json()) as A2ALegacyTask;
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

describe("trent acp --http", () => {
  it("binds a server whose agent/chat runs the headless runtime", async () => {
    const f = fakes();
    const result = await runCli(["acp", "--http", "--json", "--port", "7863"], { overrides: f.overrides });
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

describe("trent a2a card", () => {
  it("prints the card the server actually publishes, with one skill per seat", async () => {
    const f = fakes();
    const result = await runCli(["a2a", "card", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);

    const card = JSON.parse(result.stdout) as A2AAgentCard;
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    expect(card.skills).toHaveLength(9);
    expect(card.capabilities.streaming).toBe(true);
    expect(card.url).toContain("http://127.0.0.1:");
    // It is the SERVER's card: fetching the well-known path gives the same object.
    const served = await runCli(["a2a", "serve", "--json", "--port", "7864"], { overrides: f.overrides });
    const port = (JSON.parse(served.stdout) as { port: number }).port;
    const live = (await (await fetch(`http://127.0.0.1:${port}${A2A_WELL_KNOWN_PATH}`)).json()) as A2AAgentCard;
    expect(live.skills.map((s) => s.id)).toEqual(card.skills.map((s) => s.id));
    await f.signals.raise("SIGINT");
  });

  it("narrows the card to one seat when a seat is named, and rejects an unknown one", async () => {
    const f = fakes();
    const one = await runCli(["a2a", "card", "engineer", "--json"], { overrides: f.overrides });
    expect(one.exitCode).toBe(EXIT.OK);
    expect((JSON.parse(one.stdout) as A2AAgentCard).skills.map((s) => s.id)).toEqual(["engineer"]);

    const bad = await runCli(["a2a", "card", "chief-vibes-officer", "--json"], { overrides: f.overrides });
    expect(bad.exitCode).not.toBe(EXIT.OK);
  });
});

/** Spawns `trent acp` as a real child process and talks newline-delimited JSON-RPC down its pipes. */
function acpChild(homeDir: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runner = path.join(here, "acp-stdio-runner.ts");
  const repoRoot = path.resolve(here, "../../../../..");
  const child = spawn("npx", ["tsx", runner, "acp"], {
    cwd: repoRoot,
    env: { ...process.env, TRENT_HOME: homeDir, TRENT_QUEUE_FALLBACK: "disabled" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const frames: any[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") frames.push(JSON.parse(line));
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return {
    frames,
    send: (frame: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(frame)}\n`),
    async waitFor(match: (f: any) => boolean): Promise<any> {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const found = frames.find(match);
        if (found !== undefined) return found;
        if (child.exitCode !== null) throw new Error(`child exited ${String(child.exitCode)}: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no frame matched; saw ${JSON.stringify(frames)} / ${stderr}`);
    },
    async close(): Promise<number | null> {
      child.stdin.end();
      return new Promise((resolve) => {
        // A child that does not leave when its pipe closes is a failure of this command, not a
        // reason to hang the suite: kill it and let the assertion report the non-zero code.
        const giveUp = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.on("exit", (code) => {
          clearTimeout(giveUp);
          resolve(code);
        });
      });
    },
  };
}

describe("trent acp over stdio", () => {
  it("is a subprocess an editor can drive: initialize, session/new, session/prompt", async () => {
    const child = acpChild(home);
    try {
      child.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} } });
      const ready = await child.waitFor((f) => f.id === 1);
      expect(ready.result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);

      child.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
      const session = await child.waitFor((f) => f.id === 2);
      const sessionId = session.result.sessionId as string;
      expect(typeof sessionId).toBe("string");

      child.send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "why is the build red?" }] },
      });
      const turn = await child.waitFor((f) => f.id === 3);
      expect(turn.result.stopReason).toBe("end_turn");

      const chunks = child.frames
        .filter((f) => f.method === "session/update" && f.params.update.sessionUpdate === "agent_message_chunk")
        .map((f) => f.params.update.content.text as string);
      expect(chunks).toContain("brief for: why is the build red?");
    } finally {
      expect(await child.close()).toBe(0);
    }
  }, 120_000);
});
