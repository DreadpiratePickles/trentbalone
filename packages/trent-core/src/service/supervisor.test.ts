/**
 * The supervisor behind `trent service daemon`: components start in order and stop in reverse,
 * one log line each; a component that cannot start stops every one already started (newest
 * first) and the failure propagates, so the process exits non-zero with nothing left holding a
 * lock. The components here are plain objects, so the order is observed directly.
 */
import { describe, expect, it } from "vitest";
import { EXIT, TrentError } from "../errors/index.js";
import { ServiceSupervisor, type ServiceComponent } from "./supervisor.js";

function component(name: string, order: string[], options: { detail?: string; failStart?: Error; failStop?: Error } = {}): ServiceComponent {
  return {
    name,
    async start() {
      order.push(`start:${name}`);
      if (options.failStart !== undefined) throw options.failStart;
      return options.detail;
    },
    async stop() {
      order.push(`stop:${name}`);
      if (options.failStop !== undefined) throw options.failStop;
    },
  };
}

describe("ServiceSupervisor", () => {
  it("starts in order, stops in reverse, one line per start and stop", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const supervisor = new ServiceSupervisor({
      components: [component("gateway", order, { detail: "telegram" }), component("cron", order), component("heartbeat", order)],
      log: (line) => lines.push(line),
    });
    const report = await supervisor.start();
    expect(report).toEqual([
      { name: "gateway", state: "started", detail: "telegram" },
      { name: "cron", state: "started" },
      { name: "heartbeat", state: "started" },
    ]);
    expect(supervisor.running).toEqual(["gateway", "cron", "heartbeat"]);
    await supervisor.stop();
    expect(order).toEqual(["start:gateway", "start:cron", "start:heartbeat", "stop:heartbeat", "stop:cron", "stop:gateway"]);
    expect(lines).toEqual(["gateway started: telegram", "cron started", "heartbeat started", "heartbeat stopped", "cron stopped", "gateway stopped"]);
    expect(supervisor.running).toEqual([]);
  });

  it("a skipped component is reported and logged, never started", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const supervisor = new ServiceSupervisor({
      components: [{ name: "gateway", skipped: "gateway.enabled is false" }, component("cron", order), { name: "heartbeat", skipped: "heartbeat.enabled is false" }],
      log: (line) => lines.push(line),
    });
    // The report keeps the caller's order, skipped or not.
    expect(await supervisor.start()).toEqual([
      { name: "gateway", state: "skipped", detail: "gateway.enabled is false" },
      { name: "cron", state: "started" },
      { name: "heartbeat", state: "skipped", detail: "heartbeat.enabled is false" },
    ]);
    expect(order).toEqual(["start:cron"]);
    expect(lines).toEqual(["gateway skipped: gateway.enabled is false", "cron started", "heartbeat skipped: heartbeat.enabled is false"]);
  });

  it("a component that cannot start stops the started ones newest first, and the error propagates", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const refusal = new TrentError({ code: EXIT.CONFIG, operation: "heartbeat.start", message: "a heartbeat loop is already running for this profile (pid 7)" });
    const supervisor = new ServiceSupervisor({
      components: [component("gateway", order), component("cron", order), component("heartbeat", order, { failStart: refusal }), component("never", order)],
      log: (line) => lines.push(line),
    });
    await expect(supervisor.start()).rejects.toBe(refusal);
    // The failing one took nothing it did not give back itself, so it is not stopped; the last never started.
    expect(order).toEqual(["start:gateway", "start:cron", "start:heartbeat", "stop:cron", "stop:gateway"]);
    expect(lines).toEqual([
      "gateway started",
      "cron started",
      // A TrentError carries its operation and target in its message; the line keeps all of it.
      `heartbeat failed to start: ${refusal.message}`,
      "cron stopped",
      "gateway stopped",
    ]);
    expect(supervisor.running).toEqual([]);
  });

  it("a stop that throws is logged and the rest still stop; stop is idempotent", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const supervisor = new ServiceSupervisor({
      components: [component("gateway", order), component("cron", order, { failStop: new Error("disk full") })],
      log: (line) => lines.push(line),
    });
    await supervisor.start();
    await supervisor.stop();
    await supervisor.stop();
    expect(order).toEqual(["start:gateway", "start:cron", "stop:cron", "stop:gateway"]);
    expect(lines.slice(2)).toEqual(["cron failed to stop: disk full", "gateway stopped"]);
  });

  it("refuses to start twice", async () => {
    const supervisor = new ServiceSupervisor({ components: [component("cron", [])], log: () => undefined });
    await supervisor.start();
    await expect(supervisor.start()).rejects.toThrow(/already started/);
    await supervisor.stop();
  });
});
