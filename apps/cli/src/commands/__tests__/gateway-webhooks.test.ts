/**
 * [H3] `trent gateway start` serves `gateway.webhooks.routes` through the runtime's runner port,
 * and `trent gateway status` shows the routes and the last deliveries. Driven through `runCli`
 * with a fake headless runtime whose runner records its input, so nothing reaches a provider.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { GatewayManager } from "@trent/core/gateway/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { openDeliveryStore } from "@trent/core/webhooks/store.js";
import { createBoundApprovalStore, UNTRUSTED_INBOUND_FIELD } from "@trent/core/governance/bound-approvals.js"; // [P3]
import { runCli } from "../index.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";

const SECRET_ENV = "H3_CLI_TEST_WEBHOOK_SECRET";
const SECRET = "h3-cli-test-secret-not-a-real-one";
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-gateway-webhooks-"));
  process.env.TRENT_HOME = home;
  process.env[SECRET_ENV] = SECRET;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  delete process.env[SECRET_ENV];
  fs.rmSync(home, { recursive: true, force: true });
});

function configureRoutes(): ConfigManager {
  const configManager = new ConfigManager({ profile: "default" });
  const config = configManager.loadConfig();
  (config.gateway as Record<string, unknown>).webhooks = {
    port: 0,
    routes: [{ name: "gh-issues", path: "/hooks/gh-issues", secret_env: SECRET_ENV, signature: "github", objective_template: "Triage #{{payload.issue.number}}", dedupe_key: "{{payload.delivery}}", max_cost_cents: 40 }],
  };
  configManager.saveConfig(config);
  return configManager;
}

function fakeSignals(order: string[]) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    once(event: string, listener: () => void): unknown {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined;
    },
    exit(code: number): void {
      order.push(`exit:${String(code)}`);
    },
    async raise(event: string): Promise<void> {
      for (const listener of listeners.get(event) ?? []) listener();
      for (let i = 0; i < 200 && !order.some((entry) => entry.startsWith("exit:")); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    },
  };
}

function fakes(started: readonly string[] = []) { // [P3] the platforms the manager reports as started
  const order: string[] = [];
  const inputs: Array<Record<string, unknown>> = [];
  const runtime = {
    orchestrator: { approve: vi.fn(async () => true), reject: vi.fn(async () => true) },
    companyId: "cmp_h3",
    mode: "fleet",
    runner: {
      mode: "fleet",
      label: "fleet",
      run: (input: Record<string, unknown>) => {
        inputs.push(input);
        return (async function* frames(): AsyncGenerator<OrcEvent> {
          yield { kind: "run_start", runId: "run_h3_cli", at: "2026-09-26T09:00:00.000Z" };
          yield { kind: "run_done", runId: "run_h3_cli", at: "2026-09-26T09:00:01.000Z", run: { status: "completed", summary: "triaged" } };
        })();
      },
    },
    run: () => (async function* none() {})(),
    cleanup: vi.fn(async () => {
      order.push("cleanup");
    }),
  } as unknown as HeadlessRuntime;
  const signals = fakeSignals(order);
  const overrides: CliOverrides = {
    signals,
    gatewayRuntime: async () => runtime,
    gatewayManager: (configManager, options) => {
      const manager = new GatewayManager(configManager, options);
      // No platform is configured: the webhook routes alone keep the gateway up.
      vi.spyOn(manager, "startAllConfigured").mockImplementation(async () => [...started]); // [P3]
      return manager;
    },
  };
  return { order, inputs, signals, overrides };
}

const signed = (payload: unknown): { body: string; headers: Record<string, string> } => {
  const body = JSON.stringify(payload);
  return { body, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}` } };
};

describe("[H3] trent gateway start with webhook routes", () => {
  it("serves the routes with no platform up, starts a run through the runner port, and closes them on shutdown", async () => {
    configureRoutes();
    const f = fakes();
    const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.keepAlive).toBe(true);
    const data = JSON.parse(result.stdout) as { webhooks?: { listen: string; routes: string[] } };
    expect(data.webhooks?.routes).toEqual(["gh-issues"]);
    const url = `http://${data.webhooks!.listen}/hooks/gh-issues`;

    const request = signed({ delivery: "cli-1", issue: { number: 12 } });
    const res = await fetch(url, { method: "POST", headers: request.headers, body: request.body });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { run_id: string }).run_id).toBe("run_h3_cli");
    expect(f.inputs[0]).toMatchObject({ surface: "webhook", maxCostCents: 40, provenance: "untrusted" });
    expect(String(f.inputs[0]?.objective)).toContain("[provenance: untrusted via webhook:gh-issues]");

    await f.signals.raise("SIGTERM");
    expect(f.order).toContain("cleanup");
    await expect(fetch(url, { method: "POST", headers: request.headers, body: request.body })).rejects.toThrow();
  });

  it("gateway status reports the routes and the last deliveries", async () => {
    const configManager = configureRoutes();
    openDeliveryStore(configManager.getProfileDir()).append({ at: "2026-09-26T09:00:00.000Z", delivery: "whd_1", route: "gh-issues", verdict: "started", status: 202, key: "cli-2", run_id: "run_h3_status" });
    const json = await runCli(["gateway", "status", "--json"]);
    expect(json.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(json.stdout) as { webhooks: { routes: Array<{ name: string }>; last: Array<{ verdict: string; run_id: string }> } };
    expect(data.webhooks.routes.map((route) => route.name)).toEqual(["gh-issues"]);
    expect(data.webhooks.last[0]).toMatchObject({ verdict: "started", run_id: "run_h3_status" });
    const text = await runCli(["gateway", "status"]);
    expect(text.stdout).toContain("last deliveries:");
    expect(text.stdout).toContain("gh-issues started 202 run_h3_status key cli-2");
  });
});

// [P3] the listener opens for a webhook-only adapter too, not only for a signed route.
const LINE_TEST_SECRET = "p3-line-channel-secret-test-value";

function listenerBlockOnly(): ConfigManager {
  const configManager = new ConfigManager({ profile: "default" });
  const config = configManager.loadConfig();
  (config.gateway as Record<string, unknown>).webhooks = { port: 0 };
  configManager.saveConfig(config);
  return configManager;
}

describe("[P3] trent gateway start opens the listener for a webhook-only adapter", () => {
  it("LINE up and no route: the listener opens where gateway.webhooks says, and /webhooks/line reaches the adapter", async () => {
    listenerBlockOnly().set("LINE_CHANNEL_SECRET", LINE_TEST_SECRET);
    const f = fakes(["line"]);
    const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.keepAlive).toBe(true);
    const data = JSON.parse(result.stdout) as { started: string[]; webhooks?: { listen: string; routes: string[]; adapters?: string[] } };
    expect(data.started).toEqual(["line"]);
    expect(data.webhooks).toMatchObject({ routes: [], adapters: ["line"] });
    const body = JSON.stringify({ destination: "U0", events: [] });
    const signature = crypto.createHmac("sha256", LINE_TEST_SECRET).update(body).digest("base64");
    const url = `http://${data.webhooks!.listen}/webhooks/line`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": signature }, body });
    expect(res.status).toBe(200);
    const forged = await fetch(url, { method: "POST", headers: { "x-line-signature": "forged" }, body });
    expect(forged.status).toBe(401);
    await f.signals.raise("SIGTERM");
    expect(f.order).toContain("cleanup");
    await expect(fetch(url, { method: "POST", body })).rejects.toThrow();
  });

  it("a route with no platform up still opens it (the route case), and the report names no adapter", async () => {
    configureRoutes();
    const f = fakes();
    const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    const data = JSON.parse(result.stdout) as { webhooks?: { routes: string[]; adapters?: string[] } };
    expect(data.webhooks).toMatchObject({ routes: ["gh-issues"], adapters: [] });
    await f.signals.raise("SIGTERM");
  });

  it("a platform that is not webhook-only (telegram polling) and no route: nothing listens", async () => {
    listenerBlockOnly();
    const f = fakes(["telegram"]);
    const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { started: string[]; webhooks?: unknown };
    expect(data.started).toEqual(["telegram"]);
    expect(data.webhooks).toBeUndefined();
    await f.signals.raise("SIGTERM");
  });
});

// [P3] a held call in a webhook-started run records that its run read outside text.
describe("[P3] a webhook-started run's held calls carry untrusted_inbound", () => {
  it("the gateway notes the seeded run, so a call it parks is stamped; a call from another run is not", async () => {
    const configManager = configureRoutes();
    const f = fakes();
    const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    const data = JSON.parse(result.stdout) as { webhooks: { listen: string } };
    const request = signed({ delivery: "p3-1", issue: { number: 7 } });
    const res = await fetch(`http://${data.webhooks.listen}/hooks/gh-issues`, { method: "POST", headers: request.headers, body: request.body });
    expect(((await res.json()) as { run_id: string }).run_id).toBe("run_h3_cli");
    const bindings = createBoundApprovalStore({ profileDir: configManager.getProfileDir() });
    const args = { to: "+15550100", body: "Issue 7 is triaged." };
    const call = (runId: string) => ({ adapter: "business", action: `sms_send ${JSON.stringify(args)}`, tool: "sms_send", args, runId, stepId: "s1", classes: ["external_send"] });
    expect(bindings.require(call("run_h3_cli"), "SMS to +15550100: Issue 7 is triaged.").row?.details[UNTRUSTED_INBOUND_FIELD]).toBe(true);
    expect(bindings.require(call("run_other"), "SMS to +15550100: Issue 7 is triaged.").row?.details[UNTRUSTED_INBOUND_FIELD]).toBeUndefined();
    await f.signals.raise("SIGTERM");
  });
});
