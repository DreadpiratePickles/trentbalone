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
// [P3] the heartbeat the gateway carries runs the auto reviewer's pass
import { FileGatewayStore } from "@trent/core/gateway/index.js";
import type { ReviewGateway } from "@trent/core/governance/auto-review.js";
import { createBoundApprovalStore, type BoundCall } from "@trent/core/governance/bound-approvals.js";
import { setAutoReviewGatewayForTests } from "../groups/service-daemon.js";

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

/**
 * A stand-in for `process`: it records the order of what happened, so a test can say the shutdown
 * hook finished BEFORE the exit, which is the whole point of owning Ctrl+C.
 */
function fakeSignals(order: string[]) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    order,
    once(event: string, listener: () => void): unknown {
      const forEvent = listeners.get(event) ?? [];
      forEvent.push(listener);
      listeners.set(event, forEvent);
      return undefined;
    },
    exit(code: number): void {
      order.push(`exit:${code}`);
    },
    handled(event: string): boolean {
      return (listeners.get(event) ?? []).length > 0;
    },
    async raise(event: string): Promise<void> {
      for (const listener of listeners.get(event) ?? []) listener();
      // Give the release its turns; stop as soon as the process would have gone, or after 100.
      for (let i = 0; i < 100 && !order.some((entry) => entry.startsWith("exit:")); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
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
  /** What happened, in order: the release steps, then the exit. */
  order: string[];
  /** The `process` the command's signal handling runs against; the worker's own is left alone. */
  signals: ReturnType<typeof fakeSignals>;
}

function fakes(): Fakes {
  const runtimeDeps: HeadlessRuntimeDeps[] = [];
  const managerOptions: GatewayManagerOptions[] = [];
  const managers: GatewayManager[] = [];
  const objectives: string[] = [];
  const order: string[] = [];
  const cleanup = vi.fn(async () => {
    // A real cleanup awaits the proxy and the sandboxes; the await is what a synchronous exit pre-empts.
    await new Promise((resolve) => setTimeout(resolve, 1));
    order.push("cleanup");
    return undefined;
  });
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
  const signals = fakeSignals(order);
  return {
    order,
    signals,
    runtimeDeps,
    managerOptions,
    managers,
    cleanup,
    approve,
    objectives,
    runtimeEvents,
    listening,
    overrides: {
      signals,
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
    // The link rides on the runtime's bus hooks, so a run started anywhere on this runtime
    // (REPL, cron, heartbeat) reaches it — not only one the agent handler started.
    const hooks = f.runtimeDeps[0]?.busHooks ?? [];
    expect(hooks).toHaveLength(1);
    for (const event of f.runtimeEvents) hooks[0]!.sink(event);
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

  it("Ctrl+C is owned by the command: the shutdown hook finishes before the exit, as SIGTERM and SIGHUP already do", async () => {
    const f = fakes();
    f.listening.push("telegram");
    const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.keepAlive).toBe(true);
    expect(f.signals.handled("SIGINT")).toBe(true);

    const stopAll = vi.spyOn(f.managers[0]!, "stopAll").mockImplementation(async () => {
      f.order.push("stopAll");
    });
    expect(f.cleanup).not.toHaveBeenCalled();

    await f.signals.raise("SIGINT");
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    // The release ran to completion first; only then did the process go.
    expect(f.order).toEqual(["stopAll", "cleanup", `exit:${String(EXIT.INTERRUPT)}`]);
  });

  it("--dry-run builds no runtime and no listener", async () => {
    const f = fakes();
    const result = await runCli(["gateway", "start", "--dry-run", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(f.runtimeDeps).toHaveLength(0);
    expect(f.managerOptions.every((o) => o.agentHandler === undefined)).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, command: "gateway start", wouldStart: [] });
  });

  // [P3] the heartbeat this command carries runs the auto reviewer's pass on each of its ticks.
  it("with the heartbeat and governance.auto_review on, a held call inside the policy is decided on the heartbeat's next tick", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const configManager = new ConfigManager({ profile: "default" });
      const config = configManager.loadConfig();
      configManager.saveConfig({
        ...config,
        heartbeat: { ...config.heartbeat, enabled: true, interval_minutes: 15 },
        governance: { ...config.governance, auto_review: { enabled: true, model: "fake-reviewer", max_class: "external_send", max_amount_cents: 0, currency: "usd", recipients: ["+15550100"] } },
      } as typeof config);
      const args = { to: "+15550100", from: "+15550000", body: "Your table is booked for 7pm tonight." };
      const call: BoundCall = { adapter: "business", action: `sms_send ${JSON.stringify(args)}`, tool: "sms_send", args, classes: ["external_send", "customer_facing"] };
      const id = createBoundApprovalStore({ profileDir: configManager.getProfileDir() }).require(call, "SMS to +15550100: Your table is booked for 7pm tonight.").row!.id;
      const reviewer: ReviewGateway = {
        complete: async () => ({ text: JSON.stringify({ decision: "approve", reason: "allowlisted number, booking text" }), provider: "openai", model: "fake-reviewer", modelTier: "haiku", inputTokens: 1, outputTokens: 1, costCents: 0, estimated: false, priced_as_default: false, finishReason: "stop" }),
      };
      setAutoReviewGatewayForTests(async () => reviewer);
      const f = fakes();
      f.listening.push("telegram");
      const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
      expect(JSON.parse(result.stdout)).toMatchObject({ heartbeat: true });
      const status = () => new FileGatewayStore(path.join(configManager.getProfileDir(), "gateway.json")).snapshot().approvals[id];
      expect(status()?.status).toBe("pending");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(status()).toMatchObject({ status: "approved", decidedBy: "auto-review:fake-reviewer" });
      await f.signals.raise("SIGTERM");
    } finally {
      setAutoReviewGatewayForTests(undefined);
      vi.useRealTimers();
    }
  });
});
