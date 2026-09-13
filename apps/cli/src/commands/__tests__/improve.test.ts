/**
 * Item 8 — `trent improve`: status, sweep, promote, reject, rollback, history, all through
 * `defineCommand` so `--json` and `--dry-run` come free.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@trent/core/errors/index.js";
import { InMemoryImproveStore } from "@trent/core/improve/index.js";
import { runCli } from "../index.js";
import { setImproveStoreForTests } from "../improve.js";

let home: string;
let store: InMemoryImproveStore;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-improve-"));
  process.env.TRENT_HOME = home;
  store = new InMemoryImproveStore();
  setImproveStoreForTests(store);
});

afterEach(() => {
  setImproveStoreForTests(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function seed(agentId = "engineer"): Promise<void> {
  for (const id of ["a", "b", "c"]) {
    await store.appendTrace({
      id: `${agentId}_${id}`,
      companyId: "trent-local",
      agentRole: "engineer",
      agentId,
      runId: "run_1",
      taskType: "ship-feature",
      stepTitle: "implement",
      status: "completed",
      toolCalls: ["GitHub", "memory:read"],
      toolCallCount: 2,
      critiqueVerdict: id === "b" ? "retry" : "pass",
      improvement: null,
      evalScore: 0.9,
      costCents: 1,
      latencyMs: 10,
      humanCorrected: false,
      skillApplied: false,
      createdAt: "2026-09-12T10:00:00.000Z",
    });
  }
}

describe("trent improve", () => {
  it("status --json reports traces per agent, quarantine drafts, last sweep and frontier best", async () => {
    await seed();
    const result = await runCli(["improve", "status", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as {
      companyId: string;
      tracesPerAgent: Record<string, number>;
      quarantine: unknown[];
      lastSweep: unknown;
      frontierBest: Record<string, unknown>;
      store: { durable: boolean };
    };
    expect(data.tracesPerAgent).toEqual({ engineer: 3 });
    expect(data.quarantine).toEqual([]);
    expect(data.lastSweep).toBeNull();
    expect(data.frontierBest).toEqual({});
    expect(typeof data.store.durable).toBe("boolean");
  });

  it("sweep produces a quarantined draft and status then shows it; sweep --agent narrows", async () => {
    await seed();
    const sweep = await runCli(["improve", "sweep", "--agent", "engineer", "--json"]);
    expect(sweep.exitCode).toBe(EXIT.OK);
    const report = JSON.parse(sweep.stdout) as { agents: Array<{ agentId: string; skillsDistilled: number }> };
    expect(report.agents.map((a) => a.agentId)).toEqual(["engineer"]);
    expect(report.agents[0]?.skillsDistilled).toBe(1);

    const status = JSON.parse((await runCli(["improve", "status", "--json"])).stdout) as {
      quarantine: Array<{ id: string; agentId: string; taskType: string }>;
      lastSweep: { at: string } | null;
    };
    expect(status.quarantine.length).toBe(1);
    expect(status.quarantine[0]?.agentId).toBe("engineer");
    expect(status.lastSweep).not.toBeNull();
  });

  it("--dry-run on sweep performs no writes", async () => {
    await seed();
    const result = await runCli(["improve", "sweep", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, command: "improve sweep" });
    expect(await store.listDrafts("trent-local")).toEqual([]);
  });

  it("promote / reject / rollback / history round-trip through the ledger", async () => {
    await seed();
    await runCli(["improve", "sweep", "--json"]);
    const [draft] = await store.listDrafts("trent-local", { status: "quarantine" });
    expect(draft).toBeTruthy();

    const promoted = await runCli(["improve", "promote", draft!.id, "--json"]);
    expect(promoted.exitCode).toBe(EXIT.OK);
    expect((await store.getDraft(draft!.id))?.status).toBe("live");

    const history = JSON.parse((await runCli(["improve", "history", "--json"])).stdout) as {
      iterations: Array<{ id: string; decision: string }>;
      ledger: Array<{ action: string; artifactId: string }>;
    };
    expect(history.ledger.map((l) => l.action)).toEqual(["promote"]);
    expect(history.iterations.length).toBe(1);

    const rolled = await runCli(["improve", "rollback", history.iterations[0]!.id, "--json"]);
    expect(rolled.exitCode).toBe(EXIT.OK);
    expect((await store.getDraft(draft!.id))?.status).toBe("rejected");

    const rejected = await runCli(["improve", "reject", draft!.id, "--json"]);
    expect(rejected.exitCode).toBe(EXIT.OK);
    expect((await store.getDraft(draft!.id))?.status).toBe("rejected");
  });

  it("promote of an unknown draft is a usage error", async () => {
    const result = await runCli(["improve", "promote", "draft_nope", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
  });
});
