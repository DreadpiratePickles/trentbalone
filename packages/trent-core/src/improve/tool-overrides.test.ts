/**
 * [D5] item 3 — a promoted `tool` draft overrides the shipped description at registration, and a
 * rollback puts the shipped one back. End to end: a store, a promotion, a build, a rollback.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTrentTools } from "../tools/index.js";
import type { ToolBuildConfig } from "../tools/index.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { contentHash, newId } from "./ledger.js";
import { promoteDraft, rollback } from "./lifecycle.js";
import { encodeToolDraft, TOOL_DRAFT_AGENT } from "./tool-drafts.js";
import {
  TOOL_OVERRIDES_FILE,
  applyToolDescriptions,
  overrideInstructions,
  readToolOverrides,
  removeToolOverride,
  writeToolOverride,
} from "./tool-overrides.js";

const COMPANY = "co_tool_overrides";
const NOW = "2026-09-18T12:00:00.000Z";
const REWRITE = "Search past sessions. `query` is required; `limit` is an integer from 1 to 50.";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tool-overrides-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * `session_search` is registered on every build and renders its instructions through
 * `renderToolInstructions`, which is the block shape an override rewrites.
 */
const config: ToolBuildConfig = { toolsets: [], disabled_toolsets: [] };
const TOOL = "session_search";

function build(profileDir: string): ReturnType<typeof buildTrentTools> {
  return buildTrentTools(config, { workspace: dir, profileDir, backend: "local" });
}

describe("the override file", () => {
  it("is owner-only and round-trips", () => {
    writeToolOverride(dir, { tool: TOOL, description: REWRITE, draftId: "tool_1", promotedAt: NOW });
    const file = path.join(dir, TOOL_OVERRIDES_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readToolOverrides(dir)).toEqual([{ tool: TOOL, description: REWRITE, draftId: "tool_1", promotedAt: NOW }]);

    writeToolOverride(dir, { tool: TOOL, description: "Search past sessions.", draftId: "tool_2", promotedAt: NOW });
    expect(readToolOverrides(dir)).toHaveLength(1);
    expect(readToolOverrides(dir)[0]?.draftId).toBe("tool_2");

    removeToolOverride(dir, TOOL);
    expect(readToolOverrides(dir)).toEqual([]);
  });

  it("a missing or corrupt file is no overrides, never a crash", () => {
    expect(readToolOverrides(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, TOOL_OVERRIDES_FILE), "{ not json", { mode: 0o600 });
    expect(readToolOverrides(dir)).toEqual([]);
  });
});

describe("overrideInstructions", () => {
  it("replaces the description line only, and leaves the schema under it alone", () => {
    const instructions = [`${TOOL}: The old wording.`, `  action = "${TOOL} {...}" with JSON keys:`, "    query (string, required): The search."].join("\n");
    const rewritten = overrideInstructions(instructions, TOOL, REWRITE)!;
    expect(rewritten.split("\n")[0]).toBe(`${TOOL}: ${REWRITE}`);
    expect(rewritten).toContain("query (string, required): The search.");
    expect(rewritten).not.toContain("The old wording.");
  });

  it("a multi-line proposal becomes one line, and a tool the instructions do not name matches nothing", () => {
    const instructions = `${TOOL}: The old wording.`;
    expect(overrideInstructions(instructions, TOOL, "one\ntwo")).toBe(`${TOOL}: one two`);
    expect(overrideInstructions(instructions, "write_file", REWRITE)).toBeUndefined();
  });
});

describe("applyToolDescriptions", () => {
  it("rewrites the description on the adapter that owns the tool and leaves its handler untouched", () => {
    const adapters = build(dir).adapters;
    const target = adapters.find((a) => a.instructions.startsWith(`${TOOL}: `))!;
    const { adapters: described, applied } = applyToolDescriptions([target], [
      { tool: TOOL, description: REWRITE, draftId: "tool_7", promotedAt: NOW },
    ]);
    expect(applied).toEqual([{ tool: TOOL, adapter: target.name, draftId: "tool_7" }]);
    expect(described[0]?.instructions).toContain(`${TOOL}: ${REWRITE}`);
    expect(described[0]?.descriptionOverrides?.map((o) => o.draftId)).toEqual(["tool_7"]);
    expect(described[0]?.execute).toBe(target.execute);
    expect(described[0]?.scopes).toEqual(target.scopes);
  });

  it("an override for a tool nothing registers is reported, not applied", () => {
    const adapters = build(dir).adapters;
    const { applied } = applyToolDescriptions(adapters, [{ tool: "no_such_tool", description: REWRITE, draftId: "tool_8", promotedAt: NOW }]);
    expect(applied).toEqual([]);
  });
});

describe("buildTrentTools", () => {
  it("reads the profile's overrides at registration and names the improvement that made each one", () => {
    const shipped = build(dir);
    const before = shipped.adapters.find((a) => a.instructions.startsWith(`${TOOL}: `))!.instructions;
    expect(shipped.descriptionOverrides).toEqual([]);

    writeToolOverride(dir, { tool: TOOL, description: REWRITE, draftId: "tool_9", promotedAt: NOW });
    const improved = build(dir);
    expect(improved.descriptionOverrides).toEqual([{ tool: TOOL, adapter: TOOL, draftId: "tool_9" }]);
    const after = improved.adapters.find((a) => a.instructions.startsWith(`${TOOL}: `))!.instructions;
    expect(after).toContain(`${TOOL}: ${REWRITE}`);
    expect(after).not.toBe(before);
    // Only the description moved: every other tool's block is byte-identical.
    expect(after.split("\n").slice(1).join("\n")).toBe(before.split("\n").slice(1).join("\n"));
  });

  it("an injected override list replaces the file, so a caller can build without reading the profile", () => {
    const built = buildTrentTools(config, {
      workspace: dir,
      profileDir: dir,
      backend: "local",
      toolOverrides: [{ tool: TOOL, description: REWRITE, draftId: "tool_10", promotedAt: NOW }],
    });
    expect((built.descriptionOverrides ?? []).map((o) => o.draftId)).toEqual(["tool_10"]);
  });
});

describe("promotion and rollback", () => {
  async function stageToolDraft(store: InMemoryImproveStore): Promise<string> {
    const content = encodeToolDraft({
      tool: TOOL,
      adapter: TOOL,
      currentDescription: "The old wording.",
      proposedDescription: REWRITE,
      evidence: {
        calls: 24,
        failures: 6,
        failureRate: 0.25,
        invalidArguments: 6,
        invalidArgumentRate: 0.25,
        retries: 6,
        retryRate: 0.25,
        meanArgsBytes: 20,
        examples: [],
      },
    });
    const id = newId("tool");
    await store.createDraft({
      id,
      companyId: COMPANY,
      agentId: TOOL_DRAFT_AGENT,
      taskType: TOOL,
      kind: "tool",
      status: "quarantine",
      content,
      contentHash: contentHash(content),
      triggers: ["tool_health"],
      createdAt: NOW,
      promotedAt: null,
      lastUsedAt: null,
      retiredAt: null,
    });
    await store.appendIteration({
      id: newId("iter"),
      companyId: COMPANY,
      agentId: TOOL_DRAFT_AGENT,
      taskType: TOOL,
      candidateId: id,
      candidateKind: "tool",
      score: null,
      delta: null,
      decision: "quarantined",
      triggers: ["tool_health"],
      blockedBy: "human_review",
      inputHash: null,
      verdicts: null,
      createdAt: NOW,
    });
    return id;
  }

  it("a human promotion writes the override and the next build serves it; rollback restores the shipped description", async () => {
    const store = new InMemoryImproveStore();
    const draftId = await stageToolDraft(store);
    const shipped = build(dir).adapters.find((a) => a.instructions.startsWith(`${TOOL}: `))!.instructions;

    await promoteDraft(store, draftId, { actor: "human", now: NOW, toolOverrides: { profileDir: dir } });
    expect(readToolOverrides(dir).map((o) => o.draftId)).toEqual([draftId]);
    expect(build(dir).adapters.find((a) => a.instructions.startsWith(`${TOOL}: `))!.instructions).toContain(`${TOOL}: ${REWRITE}`);

    const iterationId = (await store.listIterations(COMPANY, { agentId: TOOL_DRAFT_AGENT }))[0]!.id;
    const report = await rollback(store, iterationId, "human", NOW, { profileDir: dir });
    expect(report.reverted).toContain(draftId);
    expect(readToolOverrides(dir)).toEqual([]);
    expect(build(dir).adapters.find((a) => a.instructions.startsWith(`${TOOL}: `))!.instructions).toBe(shipped);
  });

  it("promoting a tool draft with nowhere to write it is refused rather than half-done", async () => {
    const store = new InMemoryImproveStore();
    const draftId = await stageToolDraft(store);
    await expect(promoteDraft(store, draftId, { actor: "human", now: NOW })).rejects.toThrow(/tool-overrides/);
    expect((await store.getDraft(draftId))?.status).toBe("quarantine");
  });
});
