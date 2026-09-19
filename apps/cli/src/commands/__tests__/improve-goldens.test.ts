/**
 * [D1] `trent improve goldens` — the human gate on a seat's suite, and what changes downstream.
 *
 * Goldens are captured quarantined on real failures and are the ONLY way a suite grows (plan
 * decision 4). This suite asserts the gate: listing what was captured, promoting one, rejecting
 * one, and the two consequences — a seat whose suite is still empty is refused with its own name
 * and its golden counts instead of a bare `no_suite`, and `--live` will not spend a model call
 * reflecting for a seat below `improve.min_goldens`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { InMemoryImproveStore } from "@trent/core/improve/index.js";
import { runCli } from "../index.js";
import { setImproveStoreForTests } from "../improve.js";

let home: string;
let store: InMemoryImproveStore;

function goldenDir(): string {
  return path.join(home, "goldens");
}

function capture(index: number, runId = "run_1"): string {
  const id = `orcgolden_${index}`;
  fs.mkdirSync(goldenDir(), { recursive: true });
  fs.writeFileSync(
    path.join(goldenDir(), `golden-${runId}-${index}.json`),
    JSON.stringify(
      {
        id,
        companyId: "trent-local",
        runId,
        objective: `Ship the ${index}th release note and verify the totals`,
        reason: "run_failed: the engineer step never verified the build",
        status: "quarantined",
        trajectoryFailureTags: ["trajectory_terminal_event_emitted"],
        capturedAt: "2026-09-18T10:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
  return id;
}

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

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-d1-"));
  process.env.TRENT_HOME = home;
  store = new InMemoryImproveStore();
  setImproveStoreForTests(store);
});

afterEach(() => {
  setImproveStoreForTests(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

interface GoldenRow {
  id: string;
  review: string;
  seats: string[];
  failureTags: string[];
}

async function listGoldens(): Promise<GoldenRow[]> {
  const result = await runCli(["improve", "goldens", "list", "--json"]);
  expect(result.exitCode).toBe(EXIT.OK);
  return (JSON.parse(result.stdout) as { goldens: GoldenRow[] }).goldens;
}

describe("[D1] trent improve goldens", () => {
  it("lists captured goldens quarantined, with the seats their run touched", async () => {
    await seed();
    capture(1);
    const goldens = await listGoldens();
    expect(goldens).toHaveLength(1);
    expect(goldens[0]!.review).toBe("quarantined");
    expect(goldens[0]!.seats).toContain("engineer");
    expect(goldens[0]!.failureTags).toEqual(["trajectory_terminal_event_emitted"]);
  });

  it("show renders the fixture a golden becomes, graders included", async () => {
    await seed();
    const id = capture(1);
    const result = await runCli(["improve", "goldens", "show", id, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { golden: { id: string }; fixture: { id: string; prompt: string; graders: Array<{ type: string }> } };
    expect(data.golden.id).toBe(id);
    expect(data.fixture.prompt).toContain("release note");
    expect(data.fixture.graders.map((g) => g.type)).toContain("state_check");
    expect(data.fixture.graders.map((g) => g.type)).toContain("llm_rubric");
  });

  it("promote and reject are the human gate, and both are recorded on the file", async () => {
    await seed();
    const id = capture(1);

    const promoted = await runCli(["improve", "goldens", "promote", id, "--json"]);
    expect(promoted.exitCode).toBe(EXIT.OK);
    expect((await listGoldens())[0]!.review).toBe("promoted");

    const rejected = await runCli(["improve", "goldens", "reject", id, "--json"]);
    expect(rejected.exitCode).toBe(EXIT.OK);
    expect((await listGoldens())[0]!.review).toBe("rejected");
  });

  it("an unknown golden id is a usage error", async () => {
    const result = await runCli(["improve", "goldens", "promote", "orcgolden_nope", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
  });

  it("a dry run answers for any id, at exit 0, and says whether it exists", async () => {
    await seed();
    const id = capture(1);
    for (const command of ["show", "promote", "reject"]) {
      const missing = await runCli(["improve", "goldens", command, "sample", "--dry-run", "--json"]);
      expect(missing.exitCode, `${command} on an unknown id`).toBe(EXIT.OK);
      const data = JSON.parse(missing.stdout) as { dryRun: boolean; goldenId: string; exists: boolean; review: string | null };
      expect(data.dryRun).toBe(true);
      expect(data.goldenId).toBe("sample");
      expect(data.exists).toBe(false);
      expect(data.review).toBeNull();

      const known = JSON.parse((await runCli(["improve", "goldens", command, id, "--dry-run", "--json"])).stdout) as {
        exists: boolean;
        review: string | null;
      };
      expect(known.exists).toBe(true);
      expect(known.review).toBe("quarantined");
    }
    // The refusal is still there outside a dry run, and nothing was written by any of the above.
    expect((await runCli(["improve", "goldens", "show", "sample", "--json"])).exitCode).toBe(EXIT.USAGE);
    expect((await listGoldens())[0]!.review).toBe("quarantined");
  });

  it("--dry-run reports the decision without writing it", async () => {
    await seed();
    const id = capture(1);
    const result = await runCli(["improve", "goldens", "promote", id, "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect((await listGoldens())[0]!.review).toBe("quarantined");
  });
});

describe("[D1] a seat's suite comes from its promoted goldens", () => {
  it("a seat with none is refused by name, with both counts, instead of a bare no_suite", async () => {
    await seed();
    capture(1);
    capture(2);
    expect((await runCli(["improve", "sweep", "--json"])).exitCode).toBe(EXIT.OK);

    const status = JSON.parse((await runCli(["improve", "status", "--json"])).stdout) as {
      quarantine: Array<{ agentId: string; gate: { blockedBy: string | null } | null }>;
    };
    const engineer = status.quarantine.find((q) => q.agentId === "engineer");
    expect(engineer, "the engineer draft was gated").toBeTruthy();
    expect(engineer!.gate?.blockedBy).toContain("engineer");
    expect(engineer!.gate?.blockedBy).toContain("0 promoted");
    expect(engineer!.gate?.blockedBy).toContain("2 quarantined");
  });

  it("a promoted golden gives the seat a suite, so the gate stops answering no_suite", async () => {
    await seed();
    const id = capture(1);
    expect((await runCli(["improve", "goldens", "promote", id, "--json"])).exitCode).toBe(EXIT.OK);
    expect((await runCli(["improve", "sweep", "--json"])).exitCode).toBe(EXIT.OK);

    const status = JSON.parse((await runCli(["improve", "status", "--json"])).stdout) as {
      quarantine: Array<{ agentId: string; gate: { blockedBy: string | null } | null }>;
    };
    const engineer = status.quarantine.find((q) => q.agentId === "engineer");
    expect(engineer!.gate?.blockedBy).not.toContain("no_suite");
    // Without `--live` there is no gateway, which is the honest next refusal.
    expect(engineer!.gate?.blockedBy).toBe("no_gateway");
  });
});

describe("[D1] reflection is switchable, under the cap and over a floor", () => {
  it("an offline sweep reflects nothing and says so", async () => {
    await seed();
    const report = JSON.parse((await runCli(["improve", "sweep", "--json"])).stdout) as {
      reflected: boolean;
      budget: { limitCents: number | null };
    };
    expect(report.reflected).toBe(false);
    expect(report.budget.limitCents).toBe(DEFAULT_CONFIG.improve.sweep_cap_cents);
  });

  it("--live refuses below improve.min_goldens, naming the floor and the count, before any model call", async () => {
    await seed();
    capture(1);
    const result = await runCli(["improve", "sweep", "--live", "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stderr + result.stdout).toContain(String(DEFAULT_CONFIG.improve.min_goldens));
    expect(result.stderr + result.stdout).toContain("engineer");
  });

  it("over the floor the refusal is gone, and the dry run says what --live would reflect on", async () => {
    await seed();
    for (let i = 0; i < DEFAULT_CONFIG.improve.min_goldens; i += 1) {
      const id = capture(i + 1);
      expect((await runCli(["improve", "goldens", "promote", id, "--json"])).exitCode).toBe(EXIT.OK);
    }
    // --dry-run so the assertion never reaches a provider: the floor is checked either way.
    const result = await runCli(["improve", "sweep", "--live", "--agent", "engineer", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as {
      live: boolean;
      reflection: { minGoldens: number; blocked: string | null; eligible: string[] };
    };
    expect(data.live).toBe(true);
    expect(data.reflection.minGoldens).toBe(DEFAULT_CONFIG.improve.min_goldens);
    expect(data.reflection.blocked).toBeNull();
    expect(data.reflection.eligible).toContain("engineer");
  });
});
