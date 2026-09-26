/**
 * [P2-11] `trent run` on a run that lost model calls part-way: the verdict the orchestrator puts on
 * its `run_failed` frame is what the person reads (the summary, then the ledger line) and what a
 * script reads (`--json` / the `result` line), and a provider failure exits 5, not 1.
 *
 * The runtime is a fake (`ctx.overrides.gatewayRuntime`), as in `run.test.ts`: nothing reaches a model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { RunFailureVerdict } from "@trent/core/orchestrator/verdict.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import type { CliOverrides } from "../context.js";
import { runCli } from "../index.js";

const RUN = "orc_quota";
const OBJECTIVE = "Write the launch note";
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-run-verdict-"));
  process.env.TRENT_HOME = home;
  const manager = new ConfigManager({ profile: "default" });
  manager.updateConfig({ ...manager.loadConfig(), provider: "google", model: "gemini-3.7-flash" });
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function ev(kind: OrcEvent["kind"], extra: Record<string, unknown> = {}): OrcEvent {
  return { kind, runId: RUN, at: "2026-09-25T10:00:00.000Z", ...extra } as unknown as OrcEvent;
}

const SUMMARY = "1 of 2 steps failed: google HTTP 429 rate_limit (You exceeded your current quota) on content; consolidation skipped; retry after 3600s";
const QUOTA: RunFailureVerdict = {
  reason: "model_calls_failed",
  summary: SUMMARY,
  failedSteps: [{ seat: "content", step: "s2", title: "content part", errorClass: "rate_limit", message: "google request failed with HTTP 429 Too Many Requests: You exceeded your current quota", provider: "google", status: 429, retryAfterSeconds: 3600, attempts: 1 }],
  completedSteps: 1,
  totalSteps: 2,
  costCents: 7,
  consolidation: "skipped",
  retryAfterSeconds: 3600,
};

function stream(verdict: RunFailureVerdict | undefined, detail = verdict?.summary ?? "provider returned 429"): OrcEvent[] {
  return [
    ev("run_start", { run: { objective: OBJECTIVE, status: "planning" } }),
    ev("step_end", { step: { id: "s1", title: "growth part", agentRole: "growth", status: "completed", costCents: 7 } }),
    ev("step_end", { step: { id: "s2", title: "content part", agentRole: "content", status: "failed", costCents: 0 }, detail: "google request failed with HTTP 429" }),
    ev("run_failed", { run: { status: "failed", summary: `Run failed: ${detail}` }, detail, ...(verdict === undefined ? {} : { verdict }) }),
  ];
}

function fakeRuntime(events: readonly OrcEvent[]): CliOverrides {
  const runtime = {
    companyId: "cmp_local",
    durable: true,
    store: { createApproval: async () => ({}), getApproval: async () => null, listJobRuns: async () => [] },
    orchestrator: {},
    run: () =>
      (async function* () {
        yield* events;
      })(),
    cleanup: vi.fn(async () => undefined),
  } as unknown as HeadlessRuntime;
  return { gatewayRuntime: async () => runtime };
}

describe("[P2-11] trent run on a run whose model calls failed part-way", () => {
  it("--json carries the verdict's fields and exits 5, the provider-failure code", async () => {
    const result = await runCli(["run", OBJECTIVE, "--json"], { overrides: fakeRuntime(stream(QUOTA)) });
    expect(result.exitCode).toBe(EXIT.PROVIDER);
    const doc = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(doc).toMatchObject({
      status: "failed",
      error: SUMMARY,
      reason: "model_calls_failed",
      completed_steps: 1,
      total_steps: 2,
      consolidation: "skipped",
      retry_after_seconds: 3600,
      cost_cents: 7,
      run_id: RUN,
    });
    expect(doc.failed_steps).toEqual([{ seat: "content", step: "s2", error_class: "rate_limit", message: QUOTA.failedSteps[0]?.message, provider: "google", status: 429, retry_after_seconds: 3600 }]);
    expect(result.stdout).not.toContain("without a verdict");
  });

  it("text prints the summary and then the ledger line", async () => {
    const result = await runCli(["run", OBJECTIVE, "--no-color"], { overrides: fakeRuntime(stream(QUOTA)) });
    expect(result.exitCode).toBe(EXIT.PROVIDER);
    const lines = result.stdout.split("\n");
    const failed = lines.findIndex((line) => line.includes(`Run failed: ${SUMMARY}`));
    const ledger = lines.findIndex((line) => line.includes("$0.07") && line.includes(`run ${RUN}`));
    expect(failed).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(failed);
  });

  it("stream-json keeps the verdict on the run_failed line verbatim and repeats its fields on the result line", async () => {
    const result = await runCli(["run", OBJECTIVE, "--format", "stream-json"], { overrides: fakeRuntime(stream(QUOTA)) });
    const lines = result.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.find((line) => line.type === "run_failed")?.verdict).toEqual(QUOTA);
    expect(lines.at(-1)).toMatchObject({ type: "result", status: "failed", reason: "model_calls_failed", error: SUMMARY });
    expect(result.exitCode).toBe(EXIT.PROVIDER);
  });

  it("a failure that is not the provider's still exits 1, with or without a verdict", async () => {
    const plain = await runCli(["run", OBJECTIVE, "--json"], { overrides: fakeRuntime(stream(undefined)) });
    expect(plain.exitCode).toBe(EXIT.RUN_FAILED);
    expect(JSON.parse(plain.stdout)).not.toHaveProperty("reason");
    const stopped: RunFailureVerdict = { ...QUOTA, reason: "run_error", failedSteps: [], summary: "the run stopped on an error: trace sink exploded; 1 of 2 steps completed; consolidation skipped" };
    delete (stopped as { retryAfterSeconds?: number }).retryAfterSeconds;
    const errored = await runCli(["run", OBJECTIVE, "--json"], { overrides: fakeRuntime(stream(stopped)) });
    expect(errored.exitCode).toBe(EXIT.RUN_FAILED);
    expect(JSON.parse(errored.stdout)).toMatchObject({ reason: "run_error", error: stopped.summary });
  });

  it("--help lists the provider-failure exit code", async () => {
    const result = await runCli(["run", "--help"]);
    expect(result.stdout).toMatch(/5 (a )?provider/);
  });
});
