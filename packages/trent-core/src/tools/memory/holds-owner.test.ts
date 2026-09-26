/**
 * [CF] C15.1: approving a HELD solo rewrite applies it.
 *
 * In solo the conversation's own agent is its memory's owner and may replace and remove (C15); after a web read
 * its write is held as an approval row naming seat `trent` (`solo/memory-gate.ts`). Approving replays the row's
 * action through the UNWRAPPED adapter (`approveHeldMemoryWrite`), and did so outside any run, so the adapter
 * judged the replay a fleet seat's (`writerOfCall`: no conversation bound) and refused the replace while the row
 * stayed approved (docs/sessions/2026-09-26-c15-memory-and-prompt.md, "Verified"). A solo row now replays as the
 * owner, under a run id of its own; a fleet row replays exactly as before.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindSessionTaint, createSessionTaint, currentSessionTaint, unbindSessionTaint } from "../../governance/provenance.js";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import { approveHeldMemoryWrite, holdMemoryWrite } from "./holds.js";
import { CONSOLIDATION_WRITE_GATE, commitOperations, createMemoryAdapter, readEntries } from "./index.js";

const REPLACE = 'memory {"action":"replace","old_text":"Leeds","content":"Lives in York."}';
const ADD = 'memory {"action":"add","content":"The vendor lists net-30 terms."}';
const MARKER = "[provenance: untrusted via web_extract]";
const LIVE_RUN = "solo_live_run";

let profileDir = "";
beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cf-holds-"));
  const seeded = commitOperations(profileDir, "memory", [{ action: "add", content: "Prefers short replies." }, { action: "add", content: "Lives in Leeds." }], {}, CONSOLIDATION_WRITE_GATE);
  expect(seeded.ok).toBe(true);
});
afterEach(() => {
  unbindSessionTaint(LIVE_RUN);
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe("[CF] approving a held solo replace", () => {
  it("writes York over Leeds, tagged with its provenance", async () => {
    const held = holdMemoryWrite({ profileDir, adapter: "memory", action: REPLACE, sources: ["web_extract"], seat: "trent", runId: LIVE_RUN, stepId: `${LIVE_RUN}-trent` });

    const approved = await approveHeldMemoryWrite({ profileDir, id: held.id, memory: createMemoryAdapter({ profileDir }) });

    expect(approved).toMatchObject({ ok: true, record: { status: "completed", provenance: "untrusted" } });
    expect(readEntries(profileDir, "memory")).toEqual(["Prefers short replies.", `Lives in York. ${MARKER}`]);
  });

  it("never touches the row's live run: its taint binding is the same object before and after, and nothing stays bound", async () => {
    const live = createSessionTaint();
    bindSessionTaint(LIVE_RUN, live);
    const held = holdMemoryWrite({ profileDir, adapter: "memory", action: REPLACE, sources: ["web_extract"], seat: "trent", runId: LIVE_RUN });

    let seenDuringReplay: unknown = "not called";
    const memory = createMemoryAdapter({ profileDir });
    const spy = { execute: async (action: string, payload: Record<string, unknown>) => ((seenDuringReplay = currentSessionTaint()), memory.execute(action, payload)) };
    await approveHeldMemoryWrite({ profileDir, id: held.id, memory: spy });

    expect(seenDuringReplay).toBeDefined();
    expect(seenDuringReplay).not.toBe(live);
    expect(await runWithToolCallContext({ runId: LIVE_RUN, stepId: "s" }, async () => currentSessionTaint())).toBe(live);
    expect(await runWithToolCallContext({ runId: `approval_${held.id}`, stepId: "s" }, async () => currentSessionTaint())).toBeUndefined();
  });
});

describe("[CF] a held fleet write replays as it always has", () => {
  it("a fleet seat's held add is written, outside any conversation", async () => {
    const held = holdMemoryWrite({ profileDir, adapter: "memory", action: ADD, sources: ["web_extract"], seat: "finance", runId: "run_fleet" });
    let seenDuringReplay: unknown = "not called";
    const memory = createMemoryAdapter({ profileDir });
    const spy = { execute: async (action: string, payload: Record<string, unknown>) => ((seenDuringReplay = currentSessionTaint()), memory.execute(action, payload)) };

    const approved = await approveHeldMemoryWrite({ profileDir, id: held.id, memory: spy });

    expect(approved).toMatchObject({ ok: true, record: { status: "completed" } });
    expect(seenDuringReplay).toBeUndefined();
    expect(readEntries(profileDir, "memory")).toEqual(["Prefers short replies.", "Lives in Leeds.", `The vendor lists net-30 terms. ${MARKER}`]);
  });

  it("a fleet seat's held replace is still refused by the seat rule (C4), and the block is unchanged", async () => {
    const held = holdMemoryWrite({ profileDir, adapter: "memory", action: REPLACE, sources: ["web_extract"], seat: "finance" });
    const approved = await approveHeldMemoryWrite({ profileDir, id: held.id, memory: createMemoryAdapter({ profileDir }) });
    expect(approved).toMatchObject({ ok: true, record: { status: "blocked" } });
    expect(readEntries(profileDir, "memory")).toEqual(["Prefers short replies.", "Lives in Leeds."]);
  });
});
