/**
 * [S2] Cron on the solo runner. `--solo` on `trent cron run|start` builds the in-process runtime solo,
 * and a PINNED job, which runs in a child `trent run --model` (P2-1), carries the override to that
 * child, so both kinds of job run on the runner the launch asked for. A cron job has no human to
 * decide a held call, so on solo the call is refused and the job finishes on the model's answer
 * (council B8) instead of parking a run nobody will ever answer. The model is a scripted gateway.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCronRuns } from "@trent/core/cron/index.js";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import type { OrcEvent, Orchestrator } from "@trent/core/orchestrator/index.js";
import { fakeAdapter, scriptedGateway, toolCall } from "@trent/core/solo/fakes.test-helpers.js";
import type { CronJob } from "@trent/core/tools/cron/index.js";
import { MemoryStore } from "../../repl/__tests__/harness.js";
import type { ReplStore } from "../../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntime, type HeadlessRuntimeDeps } from "../../runtime/headless.js";
import { runCli } from "../index.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const POST = 'social_post {"platform": "bluesky", "text": "Daily digest is out."}';
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-cron-solo-"));
  process.env.TRENT_HOME = home;
  const manager = new ConfigManager({ profile: "default" });
  const config = manager.loadConfig();
  manager.updateConfig({ ...config, provider: "google", model: "gemini-test", terminal: { ...config.terminal, backend: "local" } });
});
afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const add = async (...extra: string[]): Promise<CronJob> => {
  const result = await runCli(["cron", "add", "--schedule", "@daily", "--prompt", "post the daily digest", ...extra, "--json"]);
  expect(result.exitCode).toBe(EXIT.OK);
  return (JSON.parse(result.stdout) as { added: CronJob }).added;
};

describe("[S2] cron on the solo runner", () => {
  it("--solo reaches the in-process runtime of an unpinned job AND the runtime a pinned job's child is built on", async () => {
    const built: HeadlessRuntimeDeps[] = [];
    const done = (runId: string): OrcEvent[] => [
      { kind: "run_start", runId, at: "2026-09-26T09:00:00.000Z", run: { objective: "x" } } as OrcEvent,
      { kind: "run_done", runId, at: "2026-09-26T09:00:01.000Z", run: { status: "completed", summary: "digest done" } } as OrcEvent,
    ];
    const gatewayRuntime = async (deps: HeadlessRuntimeDeps): Promise<HeadlessRuntime> => {
      built.push(deps);
      return { run: () => (async function* () { yield* done("run_x"); })(), cleanup: async () => undefined } as unknown as HeadlessRuntime;
    };
    const plain = await add();
    const pinned = await add("--model", "gemini-3.6-flash");
    expect((await runCli(["cron", "run", plain.id, "--solo", "--json"], { overrides: { gatewayRuntime } })).exitCode).toBe(EXIT.OK);
    expect((await runCli(["cron", "run", pinned.id, "--solo", "--json"], { overrides: { gatewayRuntime } })).exitCode).toBe(EXIT.OK);
    expect(built.map((deps) => [deps.model ?? null, deps.mode ?? null])).toEqual([
      [null, "solo"],
      ["gemini-3.6-flash", "solo"],
    ]);
    // Without the flag nothing is overridden: agent.mode decides, in-process and in the child.
    await runCli(["cron", "run", pinned.id, "--json"], { overrides: { gatewayRuntime } });
    expect(built.at(-1)?.mode).toBeUndefined();
  });

  it("B8: a solo cron job refuses a held call and finishes on the model's answer; nothing is posted or filed", async () => {
    const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: (action) => action.startsWith("social_post") });
    const gateway = scriptedGateway([toolCall(POST), "The digest is ready; posting it needs a person to approve."]);
    const createOrchestrator = (): Orchestrator => ({ ensureCompany: async () => "cmp_cron_solo", run: () => { throw new Error("the fleet must not run"); }, snapshot: async () => undefined, approve: async () => true, reject: async () => true }) as unknown as Orchestrator;
    const gatewayRuntime = (deps: HeadlessRuntimeDeps) =>
      createHeadlessRuntime({
        ...deps,
        workspace: REPO_ROOT,
        createOrchestrator,
        buildAdapters: () => [social],
        startEgress: async () => ({ port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined }),
        probeDocker: async () => ({ daemon: false, imagePresent: false }),
        openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
        solo: { gateway, audit: async () => undefined },
      });
    const job = await add();
    const result = await runCli(["cron", "run", job.id, "--solo", "--json"], { overrides: { gatewayRuntime } });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(readCronRuns(home, job.id).at(-1)).toMatchObject({ status: "completed", summary: "The digest is ready; posting it needs a person to approve." });
    expect(social.dryRuns).toEqual([]);
    expect(social.calls).toEqual([]);
  });
});
