/**
 * [D5] item 4 — `trent improve tools`: what each tool's calls say, and which descriptions the
 * seats are reading from an improvement rather than from the code.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@trent/core/errors/index.js";
import { InMemoryImproveStore, encodeToolCall, readToolOverrides, writeToolOverride } from "@trent/core/improve/index.js";
import { runCli } from "../index.js";
import { setImproveStoreForTests } from "../improve.js";

let home: string;
let store: InMemoryImproveStore;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-d5-"));
  process.env.TRENT_HOME = home;
  store = new InMemoryImproveStore();
  setImproveStoreForTests(store);
});

afterEach(() => {
  setImproveStoreForTests(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function seed(badCalls = 6, total = 24): Promise<void> {
  const calls = Array.from({ length: total }, (_, i) =>
    encodeToolCall(
      i < badCalls
        ? { tool: "web_search", adapter: "web", status: "failed", error: 'invalid arguments: "limit" must be an integer', args: { limit: "five" } }
        : { tool: "web_search", adapter: "web", status: "completed", args: { query: `q${i}` } },
    ),
  );
  await store.appendTrace({
    id: "trace_1",
    companyId: "trent-local",
    agentRole: "engineer",
    agentId: "engineer",
    runId: "run_1",
    taskType: "ship-feature",
    stepTitle: "implement",
    status: "completed",
    toolCalls: calls,
    toolCallCount: calls.length,
    critiqueVerdict: "pass",
    improvement: null,
    evalScore: 0.9,
    costCents: 1,
    latencyMs: 10,
    humanCorrected: false,
    skillApplied: false,
    createdAt: "2026-09-18T10:00:00.000Z",
  });
}

interface ToolRow {
  tool: string;
  calls: number;
  failureRate: number;
  invalidArgumentRate: number;
  retryRate: number;
  meanArgsBytes: number;
  overThreshold: boolean;
  override: { draftId: string } | null;
}

describe("[D5] trent improve tools", () => {
  it("--json reports the four rates per tool and which of them is over the threshold", async () => {
    await seed();
    const result = await runCli(["improve", "tools", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { tools: ToolRow[]; thresholds: { threshold: number; minCalls: number } };
    expect(data.thresholds).toEqual({ threshold: 0.2, minCalls: 20 });
    const web = data.tools.find((t) => t.tool === "web_search")!;
    expect(web.calls).toBe(24);
    expect(web.invalidArgumentRate).toBe(0.25);
    expect(web.failureRate).toBe(0.25);
    expect(web.overThreshold).toBe(true);
    expect(web.override).toBeNull();
  });

  it("names the improvement a live description came from", async () => {
    await seed();
    writeToolOverride(home, {
      tool: "web_search",
      description: "Search the live web. `limit` is an integer from 1 to 100.",
      draftId: "tool_42",
      promotedAt: "2026-09-18T11:00:00.000Z",
    });
    const result = await runCli(["improve", "tools", "--json"]);
    const data = JSON.parse(result.stdout) as { tools: ToolRow[]; overrides: Array<{ tool: string; draftId: string }> };
    expect(data.overrides).toEqual([{ tool: "web_search", draftId: "tool_42", promotedAt: "2026-09-18T11:00:00.000Z", description: "Search the live web. `limit` is an integer from 1 to 100." }]);
    expect(data.tools.find((t) => t.tool === "web_search")?.override?.draftId).toBe("tool_42");

    const human = await runCli(["improve", "tools", "--no-color"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain("description from improvement tool_42");
  });

  it("--tool narrows to one tool, and a profile with no traces lists nothing rather than failing", async () => {
    await seed();
    const one = await runCli(["improve", "tools", "--tool", "web_search", "--json"]);
    expect((JSON.parse(one.stdout) as { tools: ToolRow[] }).tools.map((t) => t.tool)).toEqual(["web_search"]);

    const none = await runCli(["improve", "tools", "--tool", "no_such_tool", "--json"]);
    expect((JSON.parse(none.stdout) as { tools: ToolRow[] }).tools).toEqual([]);
    expect(none.exitCode).toBe(EXIT.OK);
  });

  it("lists a quarantined description draft against its tool", async () => {
    await seed();
    await runCli(["improve", "sweep", "--json"]);
    const result = await runCli(["improve", "tools", "--json"]);
    const data = JSON.parse(result.stdout) as { tools: Array<ToolRow & { drafts: Array<{ id: string; status: string }> }> };
    const web = data.tools.find((t) => t.tool === "web_search")!;
    expect(web.drafts).toHaveLength(1);
    expect(web.drafts[0]?.status).toBe("quarantine");
  });

  it("promote writes the override the seats read, and rollback takes it back off", async () => {
    await seed();
    await runCli(["improve", "sweep", "--json"]);
    const draftId = (await store.listDrafts("trent-local", { kind: "tool", status: "quarantine" }))[0]!.id;

    const promoted = await runCli(["improve", "promote", draftId, "--json"]);
    expect(promoted.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(promoted.stdout)).toMatchObject({ kind: "tool", status: "live" });
    expect(readToolOverrides(home).map((o) => o.draftId)).toEqual([draftId]);

    const iterationId = (await store.listIterations("trent-local", { agentId: "__tools__" }))[0]!.id;
    const rolledBack = await runCli(["improve", "rollback", iterationId, "--json"]);
    expect(rolledBack.exitCode).toBe(EXIT.OK);
    expect(readToolOverrides(home)).toEqual([]);
  });
});
