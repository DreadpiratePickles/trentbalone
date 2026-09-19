/**
 * [W3.1 item 2] `trent approvals`.
 *
 * C5 parks a memory write made from untrusted context as a durable approval row and exports
 * `approveHeldMemoryWrite` to release it — and no surface called either one, so a held write was a
 * row in `gateway.json` that nothing could list and nobody could decide. This is the scriptable
 * door: `list` shows the run approvals and the held writes together, `approve` replays the seat's
 * own action with the provenance recorded, `reject` discards it and leaves the decided row behind.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT } from "@trent/core/errors/index.js";
import { FileGatewayStore } from "@trent/core/gateway/index.js";
import { holdMemoryWrite } from "@trent/core/tools/index.js";
import { runCli } from "../index.js";

const ACTION = 'memory {"action":"add","content":"the vendor page lists net-30 terms"}';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-approvals-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function json<T>(argv: readonly string[]): Promise<T> {
  const result = await runCli([...argv, "--json"]);
  expect(result.exitCode, result.stderr || result.stdout).toBe(EXIT.OK);
  return JSON.parse(result.stdout) as T;
}

/** The one thing every case needs: a parked untrusted write in this profile. */
function hold(sources: readonly string[] = ["web_extract"]): string {
  return holdMemoryWrite({ profileDir: home, adapter: "memory", action: ACTION, sources, seat: "finance", runId: "run-1", stepId: "step-a" }).id;
}

function blockText(): string {
  const file = path.join(home, "memories", "MEMORY.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

interface HeldJson {
  id: string;
  kind: string;
  tool: string;
  seat: string;
  tools: string[];
  runId: string | null;
}
interface ListJson {
  pending: { id: string; action: string; agentId: string }[];
  held: HeldJson[];
}

describe("trent approvals", () => {
  it("list names every held write's kind, seat and the untrusted tools it came from", async () => {
    const id = hold(["web_extract", "browser_get_text"]);

    const listed = await json<ListJson>(["approvals", "list"]);

    expect(listed.held.map((row) => row.id)).toEqual([id]);
    expect(listed.held[0]).toMatchObject({ kind: "memory", tool: "memory", seat: "finance", runId: "run-1" });
    expect(listed.held[0]?.tools).toEqual(["web_extract", "browser_get_text"]);
    // A held write is not counted among the ordinary run approvals; it has its own decision path.
    expect(listed.pending.map((row) => row.id)).not.toContain(id);

    const human = await runCli(["approvals", "list"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain(id);
    expect(human.stdout).toContain("web_extract");
  });

  it("approve lands the write with the provenance recorded in the entry itself", async () => {
    const id = hold();
    expect(blockText()).toBe("");

    const approved = await json<{ id: string; status: string; provenance: string }>(["approvals", "approve", id]);

    expect(approved).toMatchObject({ id, status: "approved", provenance: "untrusted" });
    expect(blockText()).toContain("net-30 terms");
    expect(blockText()).toContain("[provenance: untrusted via web_extract]");
    expect((await json<ListJson>(["approvals", "list"])).held).toEqual([]);

    // The row is decided, so the same id cannot be replayed into the block a second time.
    const again = await runCli(["approvals", "approve", id, "--json"]);
    expect(again.exitCode).not.toBe(EXIT.OK);
  });

  it("reject discards the write and leaves the decided row behind as the record of the refusal", async () => {
    const id = hold();

    const rejected = await json<{ id: string; status: string }>(["approvals", "reject", id]);

    expect(rejected).toMatchObject({ id, status: "denied" });
    expect(blockText()).toBe("");
    expect((await json<ListJson>(["approvals", "list"])).held).toEqual([]);

    const row = new FileGatewayStore(path.join(home, "gateway.json")).snapshot().approvals[id];
    expect(row?.status).toBe("denied");
    expect(row?.decidedAt).toBeTruthy();
    expect(row?.decidedBy).toBeTruthy();
  });

  it("--dry-run reports what would be decided and writes nothing, the way every id command does", async () => {
    const id = hold();

    const dry = await json<{ dryRun: boolean; command: string; id: string }>(["approvals", "approve", id, "--dry-run"]);
    expect(dry).toMatchObject({ dryRun: true, command: "approvals approve", id });

    expect(blockText()).toBe("");
    expect((await json<ListJson>(["approvals", "list"])).held.map((row) => row.id)).toEqual([id]);
  });

  it("refuses an id no held write and no approval row answers to", async () => {
    const missing = await runCli(["approvals", "approve", "appr_nothing", "--json"]);
    expect(missing.exitCode).not.toBe(EXIT.OK);
    expect(missing.stdout + missing.stderr).toContain("appr_nothing");
  });
});
