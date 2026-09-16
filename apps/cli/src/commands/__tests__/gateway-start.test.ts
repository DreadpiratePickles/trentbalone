/**
 * `trent gateway start`: the manager it builds must carry an agent handler, or every chat message
 * that passes the pairing gate is dropped in silence (`GatewayManager.handleInbound`). Driven
 * through `runCli` with a fake headless runtime, so no proxy, sandbox or model is involved; the
 * manager is the real one, built in a scratch profile with no platform configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { GatewayManager, type GatewayManagerOptions, type InboundMessage } from "@trent/core/gateway/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { runCli } from "../index.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime, HeadlessRuntimeDeps } from "../../runtime/headless.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-gateway-start-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_gw", at: "2026-09-15T00:00:00.000Z", ...extra } as OrcEvent;
}

interface Fakes {
  overrides: CliOverrides;
  runtimeDeps: HeadlessRuntimeDeps[];
  managerOptions: GatewayManagerOptions[];
  managers: GatewayManager[];
  cleanup: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  objectives: string[];
  runtimeEvents: OrcEvent[];
  /** Platforms the manager reports as started; empty means nothing listens and the command returns. */
  listening: string[];
}

function fakes(): Fakes {
  const runtimeDeps: HeadlessRuntimeDeps[] = [];
  const managerOptions: GatewayManagerOptions[] = [];
  const managers: GatewayManager[] = [];
  const objectives: string[] = [];
  const cleanup = vi.fn(async () => undefined);
  const approve = vi.fn(async () => true);
  const runtimeEvents: OrcEvent[] = [];
  const listening: string[] = [];
  const runtime = {
    orchestrator: { approve, reject: vi.fn(async () => true) },
    companyId: "cmp_gw",
    run: (objective: string) => {
      objectives.push(objective);
      const events = runtimeEvents.length > 0 ? runtimeEvents : [ev("run_start", { run: { objective } }), ev("run_done", { run: { status: "completed", summary: `brief for: ${objective}` } })];
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
    cleanup,
  } as unknown as HeadlessRuntime;
  return {
    runtimeDeps,
    managerOptions,
    managers,
    cleanup,
    approve,
    objectives,
    runtimeEvents,
    listening,
    overrides: {
      gatewayRuntime: async (deps) => {
        runtimeDeps.push(deps);
        return runtime;
      },
      gatewayManager: (configManager, options) => {
        managerOptions.push(options);
        const manager = new GatewayManager(configManager, options);
        // No platform has a credential in the scratch profile; a test that needs a listener names one.
        vi.spyOn(manager, "startAllConfigured").mockImplementation(async () => [...listening]);
        managers.push(manager);
        return manager;
      },
    },
  };
}

const message: InboundMessage = {
  id: "m1",
  platform: "telegram",
  channelId: "555",
  senderId: "555",
  content: "summarise yesterday",
  timestamp: "2026-09-15T00:00:00.000Z",
  scope: "dm",
};

describe("trent gateway start", () => {
  it("builds the manager with an agent handler that runs the message through the runtime", async () => {
    const f = fakes();
    const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);

    expect(f.managerOptions).toHaveLength(1);
    const handler = f.managerOptions[0]?.agentHandler;
    expect(typeof handler).toBe("function");
    expect(await handler?.("ceo", message)).toBe("brief for: summarise yesterday");
    expect(f.objectives).toEqual(["summarise yesterday"]);

    const data = JSON.parse(result.stdout) as { started: string[]; agentHandler: boolean };
    expect(data.started).toEqual([]);
    expect(data.agentHandler).toBe(true);
  });

  it("the runtime is built on the command's profile config, and released when no platform stays up", async () => {
    const f = fakes();
    await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    expect(f.runtimeDeps).toHaveLength(1);
    expect(f.runtimeDeps[0]?.configManager.getProfileDir()).toBe(new ConfigManager({ profile: "default" }).getProfileDir());
    expect(f.runtimeDeps[0]?.configManager.getProfileDir().startsWith(home)).toBe(true);
    expect(f.runtimeDeps[0]?.config).toBeDefined();
    // Nothing is listening, so the process will exit: the proxy and the sandboxes go with it.
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("with gateway.owner configured, a gate on the run reaches the owner as a card that carries the step", async () => {
    const f = fakes();
    // The profile config names the owner; the fake runtime parks its run on one gated step.
    const configManager = new ConfigManager({ profile: "default" });
    const config = configManager.loadConfig();
    config.gateway = { ...config.gateway, owner: { platform: "telegram", channelId: "555" } };
    configManager.saveConfig(config);
    f.runtimeEvents.splice(0, f.runtimeEvents.length, ev("run_start"), ev("run_awaiting_approval", { step: { id: "step_1", title: "Send the invoice", agentRole: "finance" } }));
    // One platform reports up, so the command stays alive and the link stays open.
    f.listening.push("telegram");

    const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.keepAlive).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({ started: ["telegram"], approvalLink: true });
    expect(f.cleanup).not.toHaveBeenCalled();

    const manager = f.managers[0]!;
    const sendApproval = vi.spyOn(manager, "sendApproval").mockResolvedValue({ queued: "q1", sent: true });
    await f.managerOptions[0]!.agentHandler!("ceo", message);
    expect(sendApproval).toHaveBeenCalledTimes(1);
    const [request, platform, channelId] = sendApproval.mock.calls[0]!;
    expect(platform).toBe("telegram");
    expect(channelId).toBe("555");
    expect(request.runId).toBe("run_gw");
    expect(request.stepId).toBe("step_1");

    manager.getApprovalBridge().decide(request.id, "approved");
    await Promise.resolve();
    expect(f.approve).toHaveBeenCalledWith("run_gw", "step_1");
  });

  it("without gateway.owner the link is off and the report says so", async () => {
    const f = fakes();
    const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    expect(JSON.parse(result.stdout)).toMatchObject({ approvalLink: false });
  });

  it("--dry-run builds no runtime and no listener", async () => {
    const f = fakes();
    const result = await runCli(["gateway", "start", "--dry-run", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(f.runtimeDeps).toHaveLength(0);
    expect(f.managerOptions.every((o) => o.agentHandler === undefined)).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, command: "gateway start", wouldStart: [] });
  });
});
