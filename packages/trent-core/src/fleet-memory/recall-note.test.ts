/**
 * [W3] The `recall` note, from the seat's `brain_read` to a quarantined retrieval golden.
 *
 * The hook ranks chunks for a seat, the seat reads one of them by id, and the note that leaves the
 * hook names the query, what was ranked and what was read. Through the orchestrator's bridge the
 * note is a `step_note`; through the improve hook it is a golden a human can promote. A read of a
 * chunk recall never ranked, or a read by path of a whole file, emits nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createImproveHook } from "../improve/hook.js";
import { InMemoryImproveStore } from "../improve/memory-store.js";
import { listRetrievalGoldens, retrievalGoldensDir, reviewOf } from "../improve/golden-store.js";
import { bridgeContextNotices } from "../orchestrator/run-hooks.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { createBrain, type Brain, type BrainExec } from "./brain.js";
import { BRAIN_READ_ADAPTER_NAME } from "../tools/memory/brain-read.js";
import { ingestDocuments } from "./ingest/index.js";
import { createFleetMemoryHook, type FleetMemoryNotice, type FleetSeatInput } from "./orchestrator-hook.js";
import { canonicalChunkId, chunkIdOfBrainRead, encodeRecallNote, parseRecallNote } from "./recall-note.js";
import { InMemoryFleetSource } from "./source.js";

let profileDir: string;
let sourceDir: string;
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });
const clock = (): Date => new Date("2026-09-20T10:00:00.000Z");
const OBJECTIVE = "how many days notice does the office lease need before we can leave";

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-recall-note-")));
  sourceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-recall-note-src-")));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

async function brainWithLease(): Promise<Brain> {
  const brain = createBrain({ profileDir, exec: noGit, now: clock });
  brain.ensure();
  const file = path.join(sourceDir, "lease.md");
  fs.writeFileSync(
    file,
    [
      "# Office lease",
      "",
      "## Parties",
      "The landlord and the tenant agree the premises on the second floor are let for office use only.",
      "",
      "## Termination",
      "Either party may end this agreement with ninety days written notice delivered to the registered address.",
      "",
      "## Parking",
      "Two parking bays in the basement are included and may not be sublet to visitors.",
    ].join("\n"),
    "utf8",
  );
  await ingestDocuments({ brain, paths: [file], now: clock });
  return brain;
}

describe("[W3] the recall note encoding", () => {
  it("round-trips through the detail string and rejects anything else", () => {
    const detail = encodeRecallNote({ query: "notice period", ranked_ids: ["lease#2", "lease#1"], read_id: "lease#2" });
    expect(detail.startsWith("recall {")).toBe(true);
    expect(parseRecallNote(detail)).toEqual({ query: "notice period", ranked_ids: ["lease#2", "lease#1"], read_id: "lease#2" });
    expect(parseRecallNote("context pressure on run r1")).toBeUndefined();
    expect(parseRecallNote("recall {\"query\": 1}")).toBeUndefined();
    expect(parseRecallNote(undefined)).toBeUndefined();
  });

  it("names the chunk a brain_read asks for, in either spelling, and nothing for a file read", () => {
    expect(canonicalChunkId("docs/lease.md#7")).toBe("lease#7");
    expect(canonicalChunkId("lease#7")).toBe("lease#7");
    expect(canonicalChunkId("decisions/2026-09-10-churn.md#1")).toBe("decisions/2026-09-10-churn.md#1");
    expect(chunkIdOfBrainRead('brain_read {"id": "lease#2"}')).toBe("lease#2");
    expect(chunkIdOfBrainRead('brain_read {"path": "docs/lease.md#2"}')).toBe("lease#2");
    expect(chunkIdOfBrainRead('brain_read {"path": "decisions/2026-09-10-churn.md"}')).toBeUndefined();
  });
});

describe("[W3] the hook emits a recall note for a ranked chunk the seat reads", () => {
  async function seatReads(action: string): Promise<{ notices: FleetMemoryNotice[]; rankedIds: string[] }> {
    const brain = await brainWithLease();
    const hook = createFleetMemoryHook({ source: new InMemoryFleetSource(), profileDir, brain });
    const notices: FleetMemoryNotice[] = [];
    hook.setNoticeSink((notice) => notices.push(notice));
    const brainRead = hook.adapters.find((adapter) => adapter.name === BRAIN_READ_ADAPTER_NAME)!;
    hook.runStarted({ runId: "run_7", companyId: "co_1", objective: OBJECTIVE });
    const seat = hook.wrapSeatModel(async (input: FleetSeatInput) => {
      const read = await brainRead.execute(action, {});
      expect(read.status).toBe("completed");
      return input;
    });
    await seat({ companyId: "co_1", subtask: { id: "s1", seat: "operations", objective: OBJECTIVE } });
    const prelude = hook.preludeFor("run_7", "operations") ?? "";
    const rankedIds = [...prelude.matchAll(/^- \[(lease#\d+)/gm)].map((m) => m[1]!);
    return { notices, rankedIds };
  }

  it("carries the objective as the query, the ranked ids in order, and the id that was read", async () => {
    const { notices, rankedIds } = await seatReads('brain_read {"id": "lease#2"}');
    expect(rankedIds).toContain("lease#2");
    const recall = notices.filter((n): n is Extract<FleetMemoryNotice, { kind: "recall" }> => n.kind === "recall");
    expect(recall).toHaveLength(1);
    expect(recall[0]).toMatchObject({ runId: "run_7", seat: "operations", query: OBJECTIVE, readId: "lease#2", rankedIds });
    expect(parseRecallNote(recall[0]!.detail)).toEqual({ query: OBJECTIVE, ranked_ids: rankedIds, read_id: "lease#2" });
  });

  it("emits nothing for a whole-file read, because that says nothing about the ranker", async () => {
    const { notices } = await seatReads('brain_read {"path": "docs/lease.md"}');
    expect(notices.filter((n) => n.kind === "recall")).toEqual([]);
  });
});

describe("[W3] a brain_read after recall lands as a quarantined retrieval golden", () => {
  it("through the orchestrator bridge and the improve hook, with the right query and id", async () => {
    const brain = await brainWithLease();
    const fleet = createFleetMemoryHook({ source: new InMemoryFleetSource(), profileDir, brain });
    const improve = createImproveHook({ store: new InMemoryImproveStore(), installedAgents: [], goldenDir: path.join(profileDir, "goldens") });
    // The orchestrator's own bridge: every notice naming a live run becomes a `step_note` on its bus.
    const delivered: OrcEvent[] = [];
    bridgeContextNotices(fleet, () => (event) => {
      delivered.push(event);
      improve.sink(event);
    });
    const brainRead = fleet.adapters.find((adapter) => adapter.name === BRAIN_READ_ADAPTER_NAME)!;
    fleet.runStarted({ runId: "run_8", companyId: "co_1", objective: OBJECTIVE });
    const seat = fleet.wrapSeatModel(async (input: FleetSeatInput) => {
      await brainRead.execute('brain_read {"id": "lease#2"}', {});
      return input;
    });
    await seat({ companyId: "co_1", subtask: { id: "s1", seat: "operations", objective: OBJECTIVE } });
    fleet.runFinished("run_8");
    await improve.flush();

    expect(delivered.map((e) => e.kind)).toEqual(["step_note"]);
    const goldens = await listRetrievalGoldens(retrievalGoldensDir(profileDir));
    expect(goldens).toHaveLength(1);
    expect(goldens[0]).toMatchObject({ query: OBJECTIVE, expected_chunk_ids: ["lease#2"], source: "captured", runId: "run_8" });
    expect(reviewOf(goldens[0]!)).toBe("quarantined");
  });
});
