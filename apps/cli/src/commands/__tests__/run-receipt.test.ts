/**
 * [D16] `trent run` ends with the run's security receipt: a footer in text mode, a `securityReceipt`
 * key on the `--json` result and on the stream's final `result` line. It is read off the runtime's
 * collector (`runtime.tools.security`) after the stream ends, and it never changes an exit code:
 * a failed run still exits 1, and a collector that throws costs the receipt, not the run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { buildSecurityReceipt } from "@trent/core/governance/security-receipt.js";
import { createRunSecurityCollector, type RunSecurityCollector } from "@trent/core/governance/security-receipt-collector.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import type { CliOverrides } from "../context.js";
import { runCli } from "../index.js";

const RUN = "run_receipt";
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-receipt-"));
  process.env.TRENT_HOME = home;
  const manager = new ConfigManager({ profile: "default" });
  manager.updateConfig({ ...manager.loadConfig(), provider: "openai", model: "gpt-5" });
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const ev = (kind: OrcEvent["kind"], extra: Record<string, unknown> = {}): OrcEvent =>
  ({ kind, runId: RUN, at: "2026-09-26T10:00:00.000Z", ...extra }) as unknown as OrcEvent;

const DONE: OrcEvent[] = [ev("run_start", { run: { objective: "x", status: "planning" } }), ev("run_done", { run: { status: "completed", summary: "ok" } })];
const FAILED: OrcEvent[] = [ev("run_start", { run: { objective: "x", status: "planning" } }), ev("run_failed", { run: { status: "failed" }, detail: "boom" })];

/** A collector that saw one allowed provider request, one refused host and one hardline refusal. */
function seenCollector(): RunSecurityCollector {
  const c = createRunSecurityCollector({ backend: "local", offline: false, egressState: "on", credentialProvider: "openai" });
  c.egressDecision({ host: "api.openai.com", port: 443, verdict: "allowed", credential: "injected" });
  c.egressDecision({ host: "exfil.example", port: 443, verdict: "refused", rule: "host_not_allowlisted" });
  return c;
}

function overridesFor(stream: readonly OrcEvent[], security: unknown): CliOverrides {
  const runtime = {
    companyId: "cmp",
    durable: true,
    store: {},
    mode: "fleet",
    tools: { security },
    run: () => (async function* () { for (const event of stream) yield event; })(),
    cleanup: async () => undefined,
  } as unknown as HeadlessRuntime;
  return { gatewayRuntime: async () => runtime };
}

describe("trent run — the security receipt", () => {
  it("text mode prints the receipt as the run's footer", async () => {
    const result = await runCli(["run", "go", "--no-color"], { overrides: overridesFor(DONE, seenCollector()) });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("Security receipt");
    expect(result.stdout).toContain("api.openai.com ×1");
    expect(result.stdout).toContain("exfil.example ×1 (host_not_allowlisted)");
    expect(result.stdout).toContain("terminal local (not isolated)");
    expect(result.stdout.indexOf("Security receipt")).toBeGreaterThan(result.stdout.indexOf("run run_receipt"));
  });

  it("--json carries it under securityReceipt, equal to the pure view of the collector", async () => {
    const collector = seenCollector();
    const result = await runCli(["run", "go", "--json"], { overrides: overridesFor(DONE, collector) });
    expect(result.exitCode).toBe(EXIT.OK);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.securityReceipt).toEqual(buildSecurityReceipt(collector.snapshot()));
  });

  it("the stream's final result line carries it too", async () => {
    const result = await runCli(["run", "go", "--format", "stream-json"], { overrides: overridesFor(DONE, seenCollector()) });
    const lines = result.stdout.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = lines.at(-1)!;
    expect(last.type).toBe("result");
    expect((last.securityReceipt as { egress: { refused: number } }).egress.refused).toBe(1);
  });

  it("never changes the exit code: a failed run still exits 1 with its receipt", async () => {
    const result = await runCli(["run", "go", "--json"], { overrides: overridesFor(FAILED, seenCollector()) });
    expect(result.exitCode).toBe(EXIT.RUN_FAILED);
    expect((JSON.parse(result.stdout) as Record<string, unknown>).securityReceipt).toBeDefined();
  });

  it("a collector that throws costs the receipt, never the run or its exit code", async () => {
    const broken = { snapshot: () => { throw new Error("collector failure"); } };
    const json = await runCli(["run", "go", "--json"], { overrides: overridesFor(DONE, broken) });
    expect(json.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(json.stdout) as Record<string, unknown>).not.toHaveProperty("securityReceipt");
    const text = await runCli(["run", "go", "--no-color"], { overrides: overridesFor(DONE, broken) });
    expect(text.exitCode).toBe(EXIT.OK);
    expect(text.stdout).not.toContain("Security receipt");
  });

  it("a runtime with no collector reports no receipt rather than an invented one", async () => {
    const result = await runCli(["run", "go", "--json"], { overrides: overridesFor(DONE, undefined) });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout) as Record<string, unknown>).not.toHaveProperty("securityReceipt");
  });
});
