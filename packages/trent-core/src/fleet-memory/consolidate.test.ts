/**
 * T1.4 + [C4] — sleep-time memory consolidation as ITEMISED DELTAS: one model turn that returns
 * operations over the entries of each block, applied by code, proposed as a `kind: "memory"` draft
 * through the improve ledger, promoted and rolled back like any artifact.
 *
 * The turn never asks for a rewritten block. ACE measured that pattern taking a context from
 * 18,282 tokens at 66.7 percent to 122 tokens at 57.1 percent in one step; here omission cannot be
 * expressed, and a proposal that would take out more than the per-turn share is refused whole.
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
import { CONSOLIDATION_WRITE_GATE, ENTRY_SEPARATOR, MEMORY_CAPS, commitOperations, memoryPath } from "../tools/memory/store.js";
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

/** The reply shape: one op list per block label, blocks that need no change simply omitted. */
function opsReply(ops: Record<string, unknown[]>): string {
  return JSON.stringify({ ops });
}

const MEMORY_BEFORE = ["Ship on Fridays only after the smoke suite is green.", "Ship on Fridays after smoke is green.", "Invoices go out on the 1st."].join(
  ENTRY_SEPARATOR,
);
const USER_BEFORE = ["Prefers short replies.", "Prefers brief replies.", "Timezone is Europe/London."].join(ENTRY_SEPARATOR);
const MEMORY_AFTER = ["Ship on Fridays only after the smoke suite is green.", "Invoices go out on the 1st."].join(ENTRY_SEPARATOR);
const USER_AFTER = ["Prefers short replies.", "Timezone is Europe/London."].join(ENTRY_SEPARATOR);
const DROPPED = ["Ship on Fridays after smoke is green.", "Prefers brief replies."];
const GOOD_OPS = { memory: [{ op: "remove", entry_id: "e2" }], user: [{ op: "remove", entry_id: "e2" }] };
const GOOD_REPLY = opsReply(GOOD_OPS);
const NOTES_BEFORE = ["Does the EU launch wait for SOC 2?", "Is the EU launch blocked on SOC 2?", "Who signs the renewal?"].join(ENTRY_SEPARATOR);
const NOTES_AFTER = ["Does the EU launch wait for SOC 2?", "Who signs the renewal?"].join(ENTRY_SEPARATOR);
const PLAYBOOK_TEXT = ["Never ship on a Friday afternoon."].join(ENTRY_SEPARATOR);

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the consolidation turn asks for deltas, never a new block", () => {
  it("shows the model the addressed entries and the four operations, and never asks it to restate a block", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const gateway = fakeGateway(GOOD_REPLY);
    await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway, store: new InMemoryImproveStore(), now: NOW });

    expect(gateway.calls).toHaveLength(1);
    const { system, user } = gateway.calls[0]!;
    for (const op of ["append", "replace", "remove", "merge"]) expect(system).toContain(op);
    expect(system).not.toMatch(/rewrite/i);
    expect(system).not.toMatch(/full .{0,20}text/i);
    expect(system).not.toMatch(/return (it|each file|the file) unchanged/i);
    // Every entry is addressed, so an omission is not something the model can express.
    expect(user).toContain("[e1] Ship on Fridays only after the smoke suite is green.");
    expect(user).toContain("[e2] Ship on Fridays after smoke is green.");
    expect(user).toContain("[e3] Invoices go out on the 1st.");
    expect(user).toContain(String(MEMORY_CAPS.memory));
    expect(user).toContain(String(MEMORY_CAPS.user));
  });

  it("a valid op list produces exactly the expected text, and the draft carries the ops beside it", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const meter = new SweepMeter(undefined);
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(GOOD_REPLY), store, meter, now: NOW });

    expect(result.status).toBe("drafted");
    if (result.status !== "drafted") throw new Error(result.status);
    expect(result.before).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
    expect(result.after).toEqual({ memory: MEMORY_AFTER, user: USER_AFTER });
    // `dropped` is derived from the applied operations, never taken from the model's word for it.
    expect(result.dropped).toEqual(DROPPED);
    expect(result.ops).toEqual([
      { label: "memory", ops: [{ op: "remove", entry_id: "e2" }] },
      { label: "user", ops: [{ op: "remove", entry_id: "e2" }] },
    ]);

    const draft = await store.getDraft(result.draft.id);
    expect(draft?.kind).toBe(MEMORY_DRAFT_KIND);
    expect(draft?.status).toBe("quarantine");
    expect(decodeMemoryDraft(draft!.content)).toEqual({ profileDir: dir, memory: MEMORY_AFTER, user: USER_AFTER, dropped: DROPPED, ops: result.ops });

    const iteration = await store.getIteration(result.iterationId);
    expect(iteration?.candidateId).toBe(result.draft.id);
    expect(iteration?.decision).toBe("pending_approval");
    const staged = await store.listLedger(COMPANY, { artifactId: result.draft.id });
    expect(staged.map((row) => row.action)).toEqual(["stage"]);
    expect(decodeMemoryDraft(staged[0]!.before!)).toMatchObject({ memory: MEMORY_BEFORE, user: USER_BEFORE });
    expect(meter.phases.candidate).toEqual({ calls: 1, costCents: 3 });
    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
  });

  it("merge, replace and append land where the operations say, in one deterministic pass", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const reply = opsReply({
      memory: [
        { op: "merge", entry_ids: ["e1", "e2"], text: "Ship on Fridays once the smoke suite is green." },
        { op: "append", text: "The renewal is signed by the founder." },
      ],
      user: [{ op: "replace", entry_id: "e3", text: "Timezone is Europe/Dublin." }],
    });
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(reply), store: new InMemoryImproveStore(), now: NOW });
    if (result.status !== "drafted") throw new Error(result.status);
    expect(result.after.memory).toBe(
      ["Ship on Fridays once the smoke suite is green.", "Invoices go out on the 1st.", "The renewal is signed by the founder."].join(ENTRY_SEPARATOR),
    );
    expect(result.after.user).toBe(["Prefers short replies.", "Prefers brief replies.", "Timezone is Europe/Dublin."].join(ENTRY_SEPARATOR));
    expect(result.dropped).toEqual(["Ship on Fridays only after the smoke suite is green.", "Ship on Fridays after smoke is green."]);
  });
});

describe("the per-turn removal cap", () => {
  const TEN = Array.from({ length: 10 }, (_, i) => `fact number ${i + 1}`).join(ENTRY_SEPARATOR);

  it("a proposal that would delete most of a block is rejected whole, ledgered, and writes nothing", async () => {
    const dir = profile(TEN, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const reply = opsReply({ memory: [1, 2, 3, 4, 5, 6].map((n) => ({ op: "remove", entry_id: `e${n}` })) });
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(reply), store, now: NOW });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error(result.status);
    expect(result.reason).toContain("6");
    expect(result.reason).toContain("3");
    expect(await store.listDrafts(COMPANY)).toEqual([]);
    expect(readBytes(dir).memory).toBe(TEN);

    // Refusing silently would hide the model's worst behaviour from the founder.
    const ledger = await store.listLedger(COMPANY);
    expect(ledger.map((row) => row.action)).toEqual(["reject"]);
    expect(decodeMemoryDraft(ledger[0]!.before!)).toMatchObject({ memory: TEN });
    expect(decodeMemoryDraft(ledger[0]!.after!).ops).toEqual([{ label: "memory", ops: (JSON.parse(reply) as { ops: { memory: unknown[] } }).ops.memory }]);
  });

  it("three entries losing their one duplicate is allowed; the cap never rounds down to zero", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const result = await consolidateMemory({
      profileDir: dir,
      companyId: COMPANY,
      gateway: fakeGateway(opsReply({ memory: [{ op: "remove", entry_id: "e2" }] })),
      store: new InMemoryImproveStore(),
      now: NOW,
    });
    expect(result.status).toBe("drafted");
  });

  it("a configured ratio is what the turn enforces, and the model is told the allowance", async () => {
    const dir = profile(TEN, USER_BEFORE);
    const gateway = fakeGateway(opsReply({ memory: [1, 2, 3, 4, 5].map((n) => ({ op: "remove", entry_id: `e${n}` })) }));
    const result = await consolidateMemory({
      profileDir: dir,
      companyId: COMPANY,
      gateway,
      store: new InMemoryImproveStore(),
      maxRemovalRatio: 0.5,
      now: NOW,
    });
    expect(result.status).toBe("drafted");
    expect(gateway.calls[0]!.user).toContain("5");
  });
});

describe("an op list the boundary refuses", () => {
  it("rejects an unknown operation, an id the block does not have, and a reply that is not the shape", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    for (const reply of [
      opsReply({ memory: [{ op: "rewrite_block", text: "everything" }] }),
      opsReply({ memory: [{ op: "remove", entry_id: "e99" }] }),
      opsReply({ vault: [{ op: "remove", entry_id: "e1" }] }),
      "not json at all",
      JSON.stringify({ memory: "the whole block" }),
      JSON.stringify({ ops: [{ op: "remove", entry_id: "e1" }] }),
    ]) {
      const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(reply), store, now: NOW });
      expect(result.status, reply).toBe("rejected");
    }
    expect(await store.listDrafts(COMPANY)).toEqual([]);
    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
  });

  it("an op list that would push a block past its limit reports the block as it stands, with the usage", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const reply = opsReply({ memory: [{ op: "append", text: "z".repeat(MEMORY_CAPS.memory) }] });
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(reply), store, now: NOW });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error(result.status);
    expect(result.block).toBe("memory");
    expect(result.entries).toEqual(MEMORY_BEFORE.split(ENTRY_SEPARATOR));
    expect(result.used).toBe(MEMORY_BEFORE.length);
    expect(result.limit).toBe(MEMORY_CAPS.memory);
    expect(result.reason).toContain(String(MEMORY_CAPS.memory));
    expect(await store.listDrafts(COMPANY)).toEqual([]);
    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
  });

  it("no operation at all is unchanged: no draft, no ledger row", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(opsReply({})), store, now: NOW });
    expect(result).toMatchObject({ status: "unchanged", costCents: 3 });
    expect(await store.listDrafts(COMPANY)).toEqual([]);
    expect(await store.listLedger(COMPANY)).toEqual([]);
  });

  it("an exhausted meter budget rejects before the call is made", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const gateway = fakeGateway(GOOD_REPLY);
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway, store: new InMemoryImproveStore(), meter: new SweepMeter(0), now: NOW });
    expect(result.status).toBe("rejected");
    expect(gateway.calls).toHaveLength(0);
  });
});

describe("promotion and rollback stay byte-exact", () => {
  it("promote writes every file through the memory commit path; rollback restores the previous bytes", async () => {
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
    expect(readBytes(dir)).toEqual({ memory: MEMORY_BEFORE, user: USER_BEFORE });
    expect((await store.getDraft(result.draft.id))?.status).toBe("rejected");
  });

  it("rollback restores the promoted-over bytes exactly even after a seat appended since", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    const store = new InMemoryImproveStore();
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway(GOOD_REPLY), store, now: NOW });
    if (result.status !== "drafted") throw new Error(result.status);
    await promoteMemoryDraft({ store, draftId: result.draft.id, actor: "human", now: NOW });
    // A seat appends a byte-identical duplicate before the founder rolls back: the branch that
    // `old_text` cannot address at all, and the one that used to skip the lock.
    const edited = commitOperations(dir, "memory", [{ action: "add", content: "Invoices go out on the 1st." }], MEMORY_CAPS.memory, CONSOLIDATION_WRITE_GATE);
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
});

describe("which blocks join the turn", () => {
  it("every configured writable block rides on the same draft, and its own limit is the one enforced", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    writeBlock(dir, NOTES, NOTES_BEFORE);
    const store = new InMemoryImproveStore();
    const gateway = fakeGateway(opsReply({ ...GOOD_OPS, notes: [{ op: "remove", entry_id: "e2" }] }));

    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway, store, blocks: [...DEFAULT_MEMORY_BLOCKS, NOTES], now: NOW });
    if (result.status !== "drafted") throw new Error(result.status);
    expect(gateway.calls[0]!.user).toContain(NOTES.file);
    expect(gateway.calls[0]!.user).toContain(String(NOTES.limit));
    expect(result.after.blocks).toEqual([{ label: "notes", file: "NOTES.md", limit: 400, text: NOTES_AFTER }]);
    expect(readBlock(dir, NOTES)).toBe(NOTES_BEFORE);

    await promoteMemoryDraft({ store, draftId: result.draft.id, actor: "human", now: NOW });
    expect(readBlock(dir, NOTES)).toBe(NOTES_AFTER);
    await rollback(store, result.iterationId, "human", NOW);
    expect(readBlock(dir, NOTES)).toBe(NOTES_BEFORE);
  });

  it("a read_only block is not in the turn and cannot be written, unless consolidation_may_edit lists it", async () => {
    const dir = profile(MEMORY_BEFORE, USER_BEFORE);
    writeBlock(dir, PLAYBOOK, PLAYBOOK_TEXT);
    const store = new InMemoryImproveStore();
    const blocks = [...DEFAULT_MEMORY_BLOCKS, PLAYBOOK];
    const gateway = fakeGateway(opsReply({ ...GOOD_OPS, playbook: [{ op: "remove", entry_id: "e1" }] }));

    const unlisted = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway, store, blocks, now: NOW });
    expect(unlisted.status).toBe("rejected");
    expect(gateway.calls[0]!.user).not.toContain(PLAYBOOK.file);
    expect(readBlock(dir, PLAYBOOK)).toBe(PLAYBOOK_TEXT);

    const listed = await consolidateMemory({
      profileDir: dir,
      companyId: COMPANY,
      gateway: fakeGateway(opsReply({ ...GOOD_OPS, playbook: [{ op: "replace", entry_id: "e1", text: "Never ship on a Friday." }] })),
      store,
      blocks,
      mayEdit: [PLAYBOOK.label],
      now: NOW,
    });
    if (listed.status !== "drafted") throw new Error(listed.status);
    expect(listed.after.blocks).toEqual([{ label: "playbook", file: "PLAYBOOK.md", limit: 400, text: "Never ship on a Friday." }]);
    await promoteMemoryDraft({ store, draftId: listed.draft.id, actor: "human", now: NOW });
    expect(readBlock(dir, PLAYBOOK)).toBe("Never ship on a Friday.");
  });
});
