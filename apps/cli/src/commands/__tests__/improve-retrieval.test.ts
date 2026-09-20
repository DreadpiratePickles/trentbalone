/**
 * [W3] `trent improve goldens add --retrieval` and `trent improve retrieval`: a founder names a
 * chunk, the human gate promotes it, and the command prints recall@8 with every hit and miss —
 * exit 0 at or over `retrieval.min_recall`, exit 1 under it. The brain is a fixture imported
 * through the real pipeline; the ranker is the shipped one with no embedder configured.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT } from "@trent/core/errors/index.js";
import { createBrain } from "@trent/core/fleet-memory/brain.js";
import { RETRIEVAL_FIXTURE_QUERIES, importRetrievalFixture } from "@trent/core/fleet-memory/retrieval-fixture.js";
import { InMemoryImproveStore, listRetrievalGoldens, retrievalGoldensDir } from "@trent/core/improve/index.js";
import { runCli } from "../index.js";
import { setImproveStoreForTests } from "../improve.js";

let home: string;
let sourceDir: string;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-w3-")));
  sourceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-w3-src-")));
  process.env.TRENT_HOME = home;
  setImproveStoreForTests(new InMemoryImproveStore());
});

afterEach(() => {
  setImproveStoreForTests(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

async function fixtureBrain(): Promise<void> {
  const brain = createBrain({ profileDir: home, versioning: "off" });
  brain.ensure();
  await importRetrievalFixture(brain, sourceDir);
}

async function addFounderGolden(query: string, expect_: string): Promise<string> {
  const result = await runCli(["improve", "goldens", "add", "--retrieval", "--query", query, "--expect", expect_, "--json"]);
  expect(result.exitCode, result.stdout).toBe(EXIT.OK);
  return (JSON.parse(result.stdout) as { golden: { id: string } }).golden.id;
}

interface RetrievalReport {
  measured: boolean;
  passed: boolean;
  recallAtK: number;
  k: number;
  minRecall: number;
  queries: number;
  hits: number;
  ranker: string;
  perQuery: Array<{ id: string; hit: boolean; rank: number | null }>;
  misses: Array<{ id: string; query: string }>;
}

describe("[W3] trent improve goldens add --retrieval", () => {
  it("adds a founder golden quarantined, lists it under retrieval, and the human gate promotes and rejects it", async () => {
    const id = await addFounderGolden("how many days notice to end the office lease", "lease#7");
    expect(id.startsWith("rgold_")).toBe(true);
    const stored = await listRetrievalGoldens(retrievalGoldensDir(home));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id, source: "founder", expected_chunk_ids: ["lease#7"], status: "quarantined" });

    const listed = await runCli(["improve", "goldens", "list", "--json"]);
    expect(listed.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(listed.stdout) as { goldens: unknown[]; retrieval: Array<{ id: string; review: string; source: string }> };
    expect(data.goldens).toEqual([]);
    expect(data.retrieval).toEqual([{ id, review: "quarantined", source: "founder", query: "how many days notice to end the office lease", expected: ["lease#7"], runId: null }]);

    const promoted = await runCli(["improve", "goldens", "promote", id, "--json"]);
    expect(promoted.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(promoted.stdout)).toMatchObject({ goldenId: id, kind: "retrieval", review: "promoted" });
    const rejected = await runCli(["improve", "goldens", "reject", id, "--json"]);
    expect(rejected.exitCode).toBe(EXIT.OK);
    expect((await listRetrievalGoldens(retrievalGoldensDir(home)))[0]!.status).toBe("rejected");
  });

  it("refuses a founder golden without a query or an expectation, and a dry run answers without writing", async () => {
    const noQuery = await runCli(["improve", "goldens", "add", "--retrieval", "--expect", "lease#7", "--json"]);
    expect(noQuery.exitCode).toBe(EXIT.USAGE);
    const noExpect = await runCli(["improve", "goldens", "add", "--retrieval", "--query", "notice period", "--json"]);
    expect(noExpect.exitCode).toBe(EXIT.USAGE);
    const notRetrieval = await runCli(["improve", "goldens", "add", "--query", "notice period", "--expect", "lease#7", "--json"]);
    expect(notRetrieval.exitCode).toBe(EXIT.USAGE);
    const dry = await runCli(["improve", "goldens", "add", "--retrieval", "--query", "notice period", "--expect", "lease#7", "--dry-run", "--json"]);
    expect(dry.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, query: "notice period", expected: ["lease#7"] });
    expect(await listRetrievalGoldens(retrievalGoldensDir(home))).toEqual([]);
  });
});

describe("[W3] trent improve retrieval", () => {
  it("prints recall@8 over the promoted goldens with per-query hits, at exit 0 over the floor", async () => {
    await fixtureBrain();
    for (const golden of RETRIEVAL_FIXTURE_QUERIES) {
      const id = await addFounderGolden(golden.query, golden.expected_chunk_ids[0]!);
      expect((await runCli(["improve", "goldens", "promote", id, "--json"])).exitCode).toBe(EXIT.OK);
    }
    const result = await runCli(["improve", "retrieval", "--json"]);
    expect(result.exitCode, result.stdout).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout) as RetrievalReport;
    expect(report).toMatchObject({ measured: true, passed: true, recallAtK: 1, k: 8, minRecall: 0.9, queries: 5, hits: 5, ranker: "lexical", misses: [] });
    expect(report.perQuery.every((q) => q.hit && q.rank === 1)).toBe(true);

    const human = await runCli(["improve", "retrieval"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain("recall@8");
    expect(human.stdout).toContain("1.000");
  });

  it("exits 1 under the floor and names the queries the ranker lost; quarantined goldens do not count", async () => {
    await fixtureBrain();
    for (const golden of RETRIEVAL_FIXTURE_QUERIES) {
      const id = await addFounderGolden(golden.query, golden.expected_chunk_ids[0]!);
      expect((await runCli(["improve", "goldens", "promote", id, "--json"])).exitCode).toBe(EXIT.OK);
    }
    const unanswerable = await addFounderGolden("book a flight to Lisbon next Tuesday", "lease#7");
    const stillFine = await runCli(["improve", "retrieval", "--json"]);
    expect((JSON.parse(stillFine.stdout) as RetrievalReport).queries).toBe(5);

    expect((await runCli(["improve", "goldens", "promote", unanswerable, "--json"])).exitCode).toBe(EXIT.OK);
    const result = await runCli(["improve", "retrieval", "--json"]);
    expect(result.exitCode).toBe(EXIT.RUN_FAILED);
    const report = JSON.parse(result.stdout) as RetrievalReport;
    expect(report.passed).toBe(false);
    expect(report.queries).toBe(6);
    expect(report.recallAtK).toBeCloseTo(5 / 6, 6);
    expect(report.misses.map((m) => m.id)).toEqual([unanswerable]);

    const human = await runCli(["improve", "retrieval"]);
    expect(human.exitCode).toBe(EXIT.RUN_FAILED);
    expect(human.stdout).toContain("book a flight to Lisbon");
  });

  it("with no promoted retrieval goldens it says so at exit 0 and measures nothing", async () => {
    const result = await runCli(["improve", "retrieval", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ measured: false, queries: 0, quarantined: 0 });
  });
});
