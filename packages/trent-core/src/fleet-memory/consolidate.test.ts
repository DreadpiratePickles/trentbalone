/**
 * T1.4 — sleep-time memory consolidation: one model turn over MEMORY.md + USER.md, proposed as a
 * `kind: "memory"` draft through the improve ledger, promoted and rolled back like any artifact.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryImproveStore } from "../improve/memory-store.js";
import { SweepMeter } from "../improve/meter.js";
import { rollback } from "../improve/lifecycle.js";
import type { GatewayCompletion } from "../model-gateway/types.js";
import { DEFAULT_MEMORY_BLOCKS, type MemoryBlock } from "../tools/memory/blocks.js";
import { ENTRY_SEPARATOR, MEMORY_CAPS, commitOperations, memoryPath } from "../tools/memory/store.js";
import { MEMORY_DRAFT_KIND, consolidateMemory, decodeMemoryDraft, promoteMemoryDraft } from "./consolidate.js";

const COMPANY = "co_consolidate";
const NOW = "2026-09-15T03:00:00.000Z";
const tmpDirs: string[] = [];

function profile(memory: string, user: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-consolidate-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "memories"), { recursive: true });
  fs.writeFileSync(memoryPath(dir, "memory"), memory, "utf8");
  fs.writeFileSync(memoryPath(dir, "user"), user, "utf8");
  return dir;
}

/** An extra writable block the founder added to `memory.blocks`, and a read-only one. */
const NOTES: MemoryBlock = { label: "notes", file: "NOTES.md", description: "open questions the fleet is carrying", limit: 400, read_only: false };
const PLAYBOOK: MemoryBlock = { label: "playbook", file: "PLAYBOOK.md", description: "how the founder runs the company", limit: 400, read_only: true };

function writeBlock(dir: string, block: MemoryBlock, text: string): void {
  fs.writeFileSync(memoryPath(dir, block), text, "utf8");
}

function readBlock(dir: string, block: MemoryBlock): string {
  return fs.readFileSync(memoryPath(dir, block), "utf8");
}

function readBytes(dir: string): { memory: string; user: string } {
  return {
    memory: fs.readFileSync(memoryPath(dir, "memory"), "utf8"),
    user: fs.readFileSync(memoryPath(dir, "user"), "utf8"),
  };
}

function fakeGateway(reply: string, costCents = 3) {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    async complete(req: { messages: Array<{ role: string; content: string }> }): Promise<GatewayCompletion> {
      calls.push({
        system: req.messages.find((m) => m.role === "system")?.content ?? "",
        user: req.messages.find((m) => m.role === "user")?.content ?? "",
      });
      return {
        text: reply,
        provider: "anthropic",
        model: "fake",
        modelTier: "sonnet",
        inputTokens: 10,
        outputTokens: 10,
        costCents,
        estimated: false,
        priced_as_default: false,
        finishReason: "stop",
      };
    },
  };
}

const MEMORY_BEFORE = ["Ship on Fridays only after the smoke suite is green.", "Ship on Fridays after smoke is green.", "Invoices go out on the 1st."].join(
  ENTRY_SEPARATOR,
);
const USER_BEFORE = ["Prefers short replies.", "Prefers brief replies.", "Timezone is Europe/London."].join(ENTRY_SEPARATOR);
const MEMORY_AFTER = ["Ship on Fridays only after the smoke suite is green.", "Invoices go out on the 1st."].join(ENTRY_SEPARATOR);
const USER_AFTER = ["Prefers short replies.", "Timezone is Europe/London."].join(ENTRY_SEPARATOR);
const DROPPED = ["Ship on Fridays after smoke is green.", "Prefers brief replies."];
const GOOD_REPLY = JSON.stringify({ memory: MEMORY_AFTER, user: USER_AFTER, dropped: DROPPED });
const NOTES_BEFORE = ["Does the EU launch wait for SOC 2?", "Is the EU launch blocked on SOC 2?", "Who signs the renewal?"].join(ENTRY_SEPARATOR);
const NOTES_AFTER = ["Does the EU launch wait for SOC 2?", "Who signs the renewal?"].join(ENTRY_SEPARATOR);
const PLAYBOOK_TEXT = ["Never ship on a Friday afternoon."].join(ENTRY_SEPARATOR);

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("consolidateMemory", () => {
  it("a shorter valid rewrite becomes a quarantined memory draft carrying before, after and the dropped list; files untouched", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const gateway = fakeGateway(GOOD_REPLY);
    const meter = new SweepMeter(undefined);

    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway, store, meter, now: NOW });
    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error(result.status);
    expect(result.before).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
    expect(result.after).toEqual({ memory: MEMORY_AFTER, user: USER_AFTER });
    expect(result.dropped).toEqual(DROPPED);

    const draft = await store.getDraft(result.draft.id);
    expect(draft?.kind).toBe(MEMORY_DRAFT_KIND);
    expect(draft?.status).toBe("quarantine");
    expect(decodeMemoryDraft(draft!.content)).toEqual({ profileDir: dir, memory: MEMORY_AFTER, user: USER_AFTER, dropped: DROPPED });

    const iteration = await store.getIteration(result.iterationId);
    expect(iteration?.candidateId).toBe(result.draft.id);
    expect(iteration?.candidateKind).toBe(MEMORY_DRAFT_KIND);
    expect(iteration?.decision).toBe("pending_approval");

    const staged = await store.listLedger(COMPANY, { artifactId: result.draft.id });
    expect(staged.map((row) => row.action)).toEqual(["stage"]);
    expect(decodeMemoryDraft(staged[0]!.before!)).toMatchObject({ memory: MEMORY_BEFORE, user: USER_BEFORE });

    // The model saw both blocks and both caps, and the call was metered once.
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.user).toContain("Invoices go out on the 1st.");
    expect(gateway.calls[0]!.user).toContain("Timezone is Europe/London.");
    expect(gateway.calls[0]!.system).toContain(String(MEMORY_CAPS.memory));
    expect(gateway.calls[0]!.system).toContain(String(MEMORY_CAPS.user));
    expect(meter.phases.candidate).toEqual({ calls: 1, costCents: 3 });

    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
  });

  it("promote writes both files through the memory commit path and records a ledger iteration; rollback restores the previous bytes exactly", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(GOOD_REPLY), store, now: NOW });
    if (result.status !== "drafted") throw new Error(result.status);

    const promoted = await promoteMemoryDraft({ store, draftId: result.draft.id, actor: "human", now: NOW });
    expect(promoted.status).toBe("live");
    expect(readBytes(dir)).toEqual({ memory: MEMORY_AFTER, user: USER_AFTER });
    expect(fs.statSync(memoryPath(dir, "memory")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(dir, "memories")).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"))).toEqual([]);

    const ledger = await store.listLedger(COMPANY, { iterationId: result.iterationId });
    expect(ledger.map((row) => row.action)).toEqual(["stage", "fix"]);
    expect(decodeMemoryDraft(ledger[1]!.before!)).toMatchObject({ memory: MEMORY_BEFORE, user: USER_BEFORE });
    expect(decodeMemoryDraft(ledger[1]!.after!)).toMatchObject({ memory: MEMORY_AFTER, user: USER_AFTER });

    const report = await rollback(store, result.iterationId, "human", NOW);
    expect(report.reverted).toEqual([result.draft.id]);
    expect(report.restored).toHaveLength(1);
    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
    expect((await store.getDraft(result.draft.id))?.status).toBe("rejected");
    const after = await store.listLedger(COMPANY, { iterationId: result.iterationId });
    expect(after.map((row) => row.action)).toEqual(["stage", "fix", "rollback"]);
  });

  it("rollback restores the promoted-over bytes exactly even after a seat edited the file since", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(GOOD_REPLY), store, now: NOW });
    if (result.status !== "drafted") throw new Error(result.status);
    await promoteMemoryDraft({ store, draftId: result.draft.id, actor: "human", now: NOW });
    // A seat drops one promoted entry and adds another through the memory tool before the founder rolls back.
    const edited = commitOperations(
      dir,
      "memory",
      [
        { action: "remove", old_text: "Invoices go out" },
        { action: "add", content: "Invoices go out on the 1st." },
        { action: "add", content: "Invoices go out on the 1st." },
      ],
      MEMORY_CAPS.memory,
    );
    expect(edited.ok).toBe(true);

    await rollback(store, result.iterationId, "human", NOW);
    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
    expect(fs.readdirSync(path.join(dir, "memories")).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"))).toEqual([]);
  });

  it("promotion by anything but a human is refused and the files stay put", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(GOOD_REPLY), store, now: NOW });
    if (result.status !== "drafted") throw new Error(result.status);
    await expect(promoteMemoryDraft({ store, draftId: result.draft.id, actor: "heartbeat", now: NOW })).rejects.toThrow(/human/);
    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
  });

  it("a block over its cap is rejected: no draft, files untouched", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const reply = JSON.stringify({ memory: "x".repeat(MEMORY_CAPS.memory + 1), user: USER_AFTER, dropped: [] });
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(reply), store, now: NOW });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error(result.status);
    expect(result.reason).toContain(String(MEMORY_CAPS.memory));
    expect(await store.listDrafts(COMPANY)).toEqual([]);
    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
  });

  it("a malformed answer is rejected and writes nothing", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    for (const reply of ["not json at all", JSON.stringify({ memory: MEMORY_AFTER }), JSON.stringify({ memory: 1, user: 2, dropped: "x" })]) {
      const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(reply), store, now: NOW });
      expect(result.status).toBe("rejected");
    }
    expect(await store.listDrafts(COMPANY)).toEqual([]);
    expect(await store.listLedger(COMPANY)).toEqual([]);
    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
  });

  it("a rewrite identical to the current files is unchanged: no draft, no ledger row", async () => {
    const dir = profile(MEMORY_AFTER, USER_AFTER);
    const store = new InMemoryImproveStore();
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(GOOD_REPLY), store, now: NOW });
    expect(result).toMatchObject({ status: "unchanged", costCents: 3 });
    expect(await store.listDrafts(COMPANY)).toEqual([]);
    expect(await store.listLedger(COMPANY)).toEqual([]);
  });

  it("every configured block is consolidated in the same turn: the extra block rides on the draft, promote writes its file, rollback restores it", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    writeBlock(dir, NOTES, NOTES_BEFORE);
    const store = new InMemoryImproveStore();
    const gateway = fakeGateway(JSON.stringify({ memory: MEMORY_AFTER, user: USER_AFTER, notes: NOTES_AFTER, dropped: [...DROPPED, "Does the EU launch wait for SOC 2?"] }));

    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway, store, blocks: [...DEFAULT_MEMORY_BLOCKS, NOTES], now: NOW });
    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error(result.status);

    // The model saw the extra block, its file name and its own cap.
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.system).toContain(String(NOTES.limit));
    expect(gateway.calls[0]!.user).toContain(NOTES.file);
    expect(gateway.calls[0]!.user).toContain("Does the EU launch wait for SOC 2?");

    expect(result.before.blocks).toEqual([{ label: "notes", file: "NOTES.md", limit: 400, text: NOTES_BEFORE }]);
    expect(result.after.blocks).toEqual([{ label: "notes", file: "NOTES.md", limit: 400, text: NOTES_AFTER }]);
    expect(decodeMemoryDraft(result.draft.content).blocks).toEqual([{ label: "notes", file: "NOTES.md", limit: 400, text: NOTES_AFTER }]);
    // Nothing on disk moved until a human promotes.
    expect(readBlock(dir, NOTES)).toBe(NOTES_BEFORE);

    await promoteMemoryDraft({ store, draftId: result.draft.id, actor: "human", now: NOW });
    expect(readBlock(dir, NOTES)).toBe(NOTES_AFTER);
    expect(fs.statSync(memoryPath(dir, NOTES)).mode & 0o777).toBe(0o600);

    await rollback(store, result.iterationId, "human", NOW);
    expect(readBlock(dir, NOTES)).toBe(NOTES_BEFORE);
    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
  });

  it("an extra block rewritten over its own limit is rejected: no draft, no file touched", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    writeBlock(dir, NOTES, NOTES_BEFORE);
    const store = new InMemoryImproveStore();
    const reply = JSON.stringify({ memory: MEMORY_AFTER, user: USER_AFTER, notes: "x".repeat(NOTES.limit + 1), dropped: [] });
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(reply), store, blocks: [...DEFAULT_MEMORY_BLOCKS, NOTES], now: NOW });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error(result.status);
    expect(result.reason).toContain(NOTES.file);
    expect(result.reason).toContain(String(NOTES.limit));
    expect(await store.listDrafts(COMPANY)).toEqual([]);
    expect(readBlock(dir, NOTES)).toBe(NOTES_BEFORE);
  });

  it("a read_only block is never shown to the model, never drafted and never rewritten", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    writeBlock(dir, PLAYBOOK, PLAYBOOK_TEXT);
    const store = new InMemoryImproveStore();
    const gateway = fakeGateway(JSON.stringify({ memory: MEMORY_AFTER, user: USER_AFTER, playbook: "rewritten by the model", dropped: DROPPED }));

    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway, store, blocks: [...DEFAULT_MEMORY_BLOCKS, PLAYBOOK], now: NOW });
    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error(result.status);
    expect(gateway.calls[0]!.user).not.toContain(PLAYBOOK.file);
    expect(gateway.calls[0]!.user).not.toContain(PLAYBOOK_TEXT);
    expect(result.after.blocks).toBeUndefined();
    expect(decodeMemoryDraft(result.draft.content).blocks).toBeUndefined();

    await promoteMemoryDraft({ store, draftId: result.draft.id, actor: "human", now: NOW });
    expect(readBlock(dir, PLAYBOOK)).toBe(PLAYBOOK_TEXT);
  });

  it("the shipped blocks alone change nothing: one turn over the two files, the same reply shape, the same draft payload", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const gateway = fakeGateway(GOOD_REPLY);
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway, store, blocks: DEFAULT_MEMORY_BLOCKS, now: NOW });
    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error(result.status);
    expect(gateway.calls).toHaveLength(1);
    expect(result.before).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
    expect(result.after).toEqual({ memory: MEMORY_AFTER, user: USER_AFTER });
    expect(decodeMemoryDraft(result.draft.content)).toEqual({ profileDir: dir, memory: MEMORY_AFTER, user: USER_AFTER, dropped: DROPPED });
  });

  it("an exhausted meter budget rejects before the call is made", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const gateway = fakeGateway(GOOD_REPLY);
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway, store, meter: new SweepMeter(0), now: NOW });
    expect(result.status).toBe("rejected");
    expect(gateway.calls).toHaveLength(0);
  });
});
