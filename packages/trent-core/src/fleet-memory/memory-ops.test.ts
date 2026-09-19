/**
 * [C4] Memory changes are itemised deltas. RED for: the op schema at the boundary, the
 * deterministic apply, the removal cap, and the limit refusal carrying the block as it stands.
 */
import { describe, expect, it } from "vitest";

import { ENTRY_SEPARATOR } from "../tools/memory/store.js";
import { DEFAULT_MAX_REMOVAL_RATIO, addressEntries, applyMemoryOps, entryIdAt, parseMemoryOps, removalAllowance } from "./memory-ops.js";

const ENTRIES = [
  "Ship on Fridays only after the smoke suite is green.",
  "Ship on Fridays after smoke is green.",
  "Invoices go out on the 1st.",
];

describe("the op schema at the boundary", () => {
  it("accepts the four operations and keeps their fields", () => {
    const parsed = parseMemoryOps([
      { op: "append", text: "New fact." },
      { op: "replace", entry_id: "e3", text: "Invoices go out on the 2nd." },
      { op: "remove", entry_id: "e2" },
      { op: "merge", entry_ids: ["e1", "e2"], text: "Merged." },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.ops).toHaveLength(4);
    expect(parsed.ops[1]).toEqual({ op: "replace", entry_id: "e3", text: "Invoices go out on the 2nd." });
  });

  it("rejects an unknown operation, naming it and the four that exist", () => {
    const parsed = parseMemoryOps([{ op: "rewrite_block", text: "everything" }]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected a rejection");
    expect(parsed.reason).toContain("rewrite_block");
    for (const name of ["append", "replace", "remove", "merge"]) expect(parsed.reason).toContain(name);
  });

  it("rejects a malformed operation and anything that is not a list", () => {
    expect(parseMemoryOps([{ op: "replace", text: "no id" }]).ok).toBe(false);
    expect(parseMemoryOps([{ op: "merge", entry_ids: "e1", text: "x" }]).ok).toBe(false);
    expect(parseMemoryOps("append everything").ok).toBe(false);
    expect(parseMemoryOps([42]).ok).toBe(false);
  });
});

describe("applying an op list", () => {
  it("addresses entries by a stable id and renders them for the model", () => {
    expect(entryIdAt(0)).toBe("e1");
    expect(addressEntries(ENTRIES)).toBe(`[e1] ${ENTRIES[0]}\n[e2] ${ENTRIES[1]}\n[e3] ${ENTRIES[2]}`);
    expect(addressEntries([])).toBe("");
  });

  it("merges two entries into one, keeps the order, and reports both originals as dropped", () => {
    const result = applyMemoryOps(ENTRIES, [{ op: "merge", entry_ids: ["e1", "e2"], text: "Ship on Fridays once smoke is green." }], 2200);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.entries).toEqual(["Ship on Fridays once smoke is green.", "Invoices go out on the 1st."]);
    expect(result.rendered).toBe(result.entries.join(ENTRY_SEPARATOR));
    expect(result.dropped).toEqual([ENTRIES[0], ENTRIES[1]]);
    expect(result.remaining).toBe(2200 - result.rendered.length);
  });

  it("replaces in place, removes by id and appends at the end, in one deterministic pass", () => {
    const result = applyMemoryOps(
      ENTRIES,
      [
        { op: "append", text: "The renewal is signed by the founder." },
        { op: "replace", entry_id: "e3", text: "Invoices go out on the 2nd." },
        { op: "remove", entry_id: "e2" },
      ],
      2200,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.entries).toEqual([ENTRIES[0], "Invoices go out on the 2nd.", "The renewal is signed by the founder."]);
    expect(result.dropped).toEqual([ENTRIES[1]]);
  });

  it("rejects an op that addresses an entry the block does not have, naming the ids it does", () => {
    const result = applyMemoryOps(ENTRIES, [{ op: "remove", entry_id: "e9" }], 2200);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.reason).toContain("e9");
    expect(result.reason).toContain("e1");
  });

  it("rejects two operations addressing the same entry, a one-id merge and empty text", () => {
    const twice = applyMemoryOps(ENTRIES, [{ op: "remove", entry_id: "e1" }, { op: "replace", entry_id: "e1", text: "x" }], 2200);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.reason).toContain("e1");
    expect(applyMemoryOps(ENTRIES, [{ op: "merge", entry_ids: ["e1"], text: "x" }], 2200).ok).toBe(false);
    expect(applyMemoryOps(ENTRIES, [{ op: "append", text: "   " }], 2200).ok).toBe(false);
    expect(applyMemoryOps(ENTRIES, [{ op: "append", text: `a${ENTRY_SEPARATOR}b` }], 2200).ok).toBe(false);
  });
});

describe("the per-turn removal cap", () => {
  it("allows at most 30 percent of the entries to go, and never fewer than one", () => {
    expect(DEFAULT_MAX_REMOVAL_RATIO).toBe(0.3);
    expect(removalAllowance(10)).toBe(3);
    expect(removalAllowance(3)).toBe(1);
    expect(removalAllowance(0)).toBe(1);
    expect(removalAllowance(10, 0.5)).toBe(5);
  });

  it("rejects a proposal that would delete most of the block, as a whole", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `fact number ${i + 1}`);
    const result = applyMemoryOps(ten, ten.slice(0, 6).map((_, i) => ({ op: "remove" as const, entry_id: entryIdAt(i) })), 2200);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.reason).toContain("6");
    expect(result.reason).toContain("3");
    expect(result.entries).toEqual(ten);
  });

  it("counts a merge by the entries it folds away, so three duplicates into one is two gone", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `fact number ${i + 1}`);
    const ok = applyMemoryOps(ten, [{ op: "merge", entry_ids: ["e1", "e2", "e3"], text: "one fact" }], 2200);
    expect(ok.ok).toBe(true);
    const over = applyMemoryOps(ten, [{ op: "merge", entry_ids: ["e1", "e2", "e3", "e4", "e5"], text: "one fact" }], 2200);
    expect(over.ok).toBe(false);
  });
});

describe("a result past the block limit", () => {
  it("refuses with the current entries, the characters in use and the limit it was judged against", () => {
    const result = applyMemoryOps(ENTRIES, [{ op: "append", text: "z".repeat(200) }], 100);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(result.entries).toEqual(ENTRIES);
    expect(result.used).toBe(ENTRIES.join(ENTRY_SEPARATOR).length);
    expect(result.limit).toBe(100);
    expect(result.reason).toContain("100");
  });
});
