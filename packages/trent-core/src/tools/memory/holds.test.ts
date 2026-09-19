/** [C5] A memory write made from untrusted context is parked on the durable approval path. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileGatewayStore } from "../../gateway/store/GatewayStore.js";
import { createMemoryAdapter } from "./index.js";
import { approveHeldMemoryWrite, denyHeldMemoryWrite, heldWriteAction, holdMemoryWrite, listHeldMemoryWrites } from "./holds.js";
import { memoryPath } from "./store.js";
import { DEFAULT_MEMORY_BLOCKS } from "./blocks.js";

let profileDir = "";

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-holds-"));
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const ACTION = 'memory {"action":"add","content":"the vendor page lists net-30 terms"}';

describe("holdMemoryWrite", () => {
  it("parks a pending approval row naming the untrusted sources and nothing reaches the block", () => {
    const held = holdMemoryWrite({ profileDir, adapter: "memory", action: ACTION, sources: ["web_extract"], seat: "finance", runId: "run-1", stepId: "step-a" });
    expect(held.id).toMatch(/^appr_/);
    expect(held.line).toContain(held.id);

    const rows = listHeldMemoryWrites(profileDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.agentId).toBe("finance");
    expect(rows[0]!.details.sources).toEqual(["web_extract"]);
    expect(rows[0]!.details.provenance).toBe("untrusted");
    expect(rows[0]!.runId).toBe("run-1");

    const snapshot = new FileGatewayStore(path.join(profileDir, "gateway.json")).snapshot();
    expect(Object.keys(snapshot.approvals)).toEqual([held.id]);
    expect(fs.existsSync(memoryPath(profileDir, DEFAULT_MEMORY_BLOCKS[0]!))).toBe(false);
  });

  it("annotates the replayed action so the entry says what it was derived from", () => {
    const annotated = heldWriteAction(ACTION, ["web_extract", "browser_get_text"]);
    expect(annotated).toContain("[provenance: untrusted via web_extract, browser_get_text]");
    expect(JSON.parse(annotated.slice(annotated.indexOf("{"))).content).toContain("net-30 terms");
  });
});

describe("approveHeldMemoryWrite", () => {
  it("writes the held entry with its provenance recorded, and the row cannot be approved twice", async () => {
    const memory = createMemoryAdapter({ profileDir });
    const held = holdMemoryWrite({ profileDir, adapter: "memory", action: ACTION, sources: ["web_extract"], seat: "finance" });

    const approved = await approveHeldMemoryWrite({ profileDir, id: held.id, memory });
    expect(approved.ok).toBe(true);
    expect(approved.ok && approved.provenance).toBe("untrusted");
    expect(approved.ok && approved.record.status).toBe("completed");

    const block = fs.readFileSync(memoryPath(profileDir, DEFAULT_MEMORY_BLOCKS[0]!), "utf8");
    expect(block).toContain("net-30 terms");
    expect(block).toContain("[provenance: untrusted via web_extract]");

    expect(listHeldMemoryWrites(profileDir)).toHaveLength(0);
    const again = await approveHeldMemoryWrite({ profileDir, id: held.id, memory });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toBe("not_pending");
  });

  it("denies a held write without touching the block, and reports an unknown id", async () => {
    const memory = createMemoryAdapter({ profileDir });
    const held = holdMemoryWrite({ profileDir, adapter: "memory", action: ACTION, sources: ["web_search"] });
    expect(denyHeldMemoryWrite({ profileDir, id: held.id }).ok).toBe(true);
    expect(fs.existsSync(memoryPath(profileDir, DEFAULT_MEMORY_BLOCKS[0]!))).toBe(false);
    const missing = await approveHeldMemoryWrite({ profileDir, id: "appr_nothing", memory });
    expect(missing.ok === false && missing.reason).toBe("unknown");
  });
});
