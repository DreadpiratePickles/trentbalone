/**
 * 3.6 — the dropdown.
 *
 * The old implementation used readline Tab completion over the WHOLE line, which is
 * why it only ever worked when the line was empty. This one filters on the token under
 * the cursor, wherever that token sits.
 */

import { describe, it, expect } from "vitest";
import { createTheme } from "../../ui/index.js";
import { tokenUnderCursor, autocomplete, applyCompletion, renderDropdown } from "../autocomplete.js";

const NAMES = ["approvals", "budget", "help", "mcp", "traces", "wiki", "workbench"];
const plain = createTheme("none");

describe("token under the cursor", () => {
  it("finds the token the cursor sits inside, not the whole line", () => {
    expect(tokenUnderCursor("run this /wor", 13)).toEqual({ token: "/wor", start: 9, end: 13 });
    expect(tokenUnderCursor("/wik and then more", 4)).toEqual({ token: "/wik", start: 0, end: 4 });
    expect(tokenUnderCursor("plain words", 5)).toEqual({ token: "plain", start: 0, end: 5 });
  });

  it("returns an empty token between words", () => {
    expect(tokenUnderCursor("a  b", 2).token).toBe("");
  });
});

describe("dropdown behaviour", () => {
  it("opens only on a slash token and filters as the token grows", () => {
    expect(autocomplete("hello", 5, NAMES).open).toBe(false);
    expect(autocomplete("/", 1, NAMES).matches).toEqual(NAMES);
    expect(autocomplete("/w", 2, NAMES).matches).toEqual(["wiki", "workbench"]);
    expect(autocomplete("/wor", 4, NAMES).matches).toEqual(["workbench"]);
    expect(autocomplete("/zzz", 4, NAMES).matches).toEqual([]);
  });

  it("opens mid-line, which the old whole-line completer could not do", () => {
    const result = autocomplete("please run /appr now", 15, NAMES);
    expect(result.open).toBe(true);
    expect(result.matches).toEqual(["approvals"]);
  });

  it("replaces only the token under the cursor when a choice is applied", () => {
    expect(applyCompletion("please run /appr now", 16, "approvals")).toEqual({
      line: "please run /approvals now",
      cursor: 21,
    });
  });

  it("renders the selected row with the mint left rail and no emoji", () => {
    const rows = renderDropdown(["wiki", "workbench"], 1, plain, 40);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("▎");
    expect(rows[0]).not.toContain("▎");
    expect(rows.join("\n")).not.toMatch(/\p{Extended_Pictographic}/u);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(40);
  });
});
