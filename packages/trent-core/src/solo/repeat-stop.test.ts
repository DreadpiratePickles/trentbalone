/**
 * [CF] C11 open item 3: a successful call repeated with the same arguments and the same result stops the run with
 * a verdict naming the loop, before the tool-call cap. C11 live run 2 repeated one `read_file` 26 times up to the
 * cap of 25, because the misuse stop counts failed, refused and held calls only. Pure: records in, verdict out.
 */
import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "../tools/types.js";
import { SOLO_SUCCESS_REPEATS, repeatedSuccessOf } from "./repeat-stop.js";
import { DEFAULT_SOLO_MAX_TOOL_CALLS, SOLO_MISUSE_REPEATS } from "./types.js";

const READ = { adapter: { name: "file_ops" }, action: 'read_file {"path": "notes/brief.txt"}' };
const OTHER = { adapter: { name: "file_ops" }, action: 'read_file {"path": "README.md"}' };
const done = (summary: string, status: ToolCallRecord["status"] = "completed"): ToolCallRecord => ({ adapter: "file_ops", action: READ.action, status, summary });

/** Each verdict of `n` identical successes on one run, in order. */
function repeat(run: object, n: number, call = READ, summary = "brief: ship on Friday"): Array<string | undefined> {
  return Array.from({ length: n }, () => repeatedSuccessOf(run, call, done(summary)));
}

describe("[CF] the stop for a successful call repeated with the same result", () => {
  it(`stops on the ${String(SOLO_SUCCESS_REPEATS)}th identical success, naming the loop, the call and the result; not before`, () => {
    const verdicts = repeat({}, SOLO_SUCCESS_REPEATS);
    expect(verdicts.slice(0, -1)).toEqual(Array(SOLO_SUCCESS_REPEATS - 1).fill(undefined));
    const stop = verdicts.at(-1) ?? "";
    expect(stop).toMatch(/loop/);
    expect(stop).toContain(`${String(SOLO_SUCCESS_REPEATS)} times`);
    expect(stop).toContain('file_ops read_file {"path": "notes/brief.txt"}');
    expect(stop).toContain("brief: ship on Friday");
  });

  it("stops well before the solo loop's default tool-call cap, and after the misuse stop's count", () => {
    expect(SOLO_SUCCESS_REPEATS).toBeLessThan(DEFAULT_SOLO_MAX_TOOL_CALLS);
    expect(SOLO_SUCCESS_REPEATS).toBeGreaterThan(SOLO_MISUSE_REPEATS);
  });

  it("a changed result starts the count again: the call told the model something new", () => {
    const run = {};
    expect(repeat(run, SOLO_SUCCESS_REPEATS - 1)).toEqual(Array(SOLO_SUCCESS_REPEATS - 1).fill(undefined));
    expect(repeat(run, SOLO_SUCCESS_REPEATS - 1, READ, "brief: ship on Monday")).toEqual(Array(SOLO_SUCCESS_REPEATS - 1).fill(undefined));
    expect(repeatedSuccessOf(run, READ, done("brief: ship on Monday"))).toMatch(/loop/);
  });

  it("counts the same call across other calls in between (A, B, A, B ...), and each call on its own", () => {
    const run = {};
    const verdicts: Array<string | undefined> = [];
    for (let i = 0; i < SOLO_SUCCESS_REPEATS; i += 1) {
      verdicts.push(repeatedSuccessOf(run, READ, done("brief")));
      if (i < SOLO_SUCCESS_REPEATS - 1) verdicts.push(repeatedSuccessOf(run, OTHER, { ...done("readme"), action: OTHER.action }));
    }
    expect(verdicts.filter((verdict) => verdict !== undefined)).toHaveLength(1);
    expect(verdicts.at(-1)).toContain("notes/brief.txt");
  });

  it("folds whitespace in the arguments, as the misuse stop keys a call", () => {
    const run = {};
    const spaced = { adapter: READ.adapter, action: 'read_file   {"path":  "notes/brief.txt"}' };
    const compact = { adapter: READ.adapter, action: 'read_file {"path": "notes/brief.txt"}' };
    const verdicts = Array.from({ length: SOLO_SUCCESS_REPEATS }, (_, i) => repeatedSuccessOf(run, i % 2 === 0 ? spaced : compact, done("brief")));
    expect(verdicts.at(-1)).toMatch(/loop/);
  });

  it("leaves failed, refused, held and mocked results to the misuse stop and the gate", () => {
    const run = {};
    for (const status of ["failed", "blocked", "needs_approval", "mocked"] as const) {
      for (let i = 0; i < SOLO_SUCCESS_REPEATS + 1; i += 1) expect(repeatedSuccessOf(run, READ, done("same", status)), status).toBeUndefined();
    }
  });

  it("keeps each run's count on its own", () => {
    const first = {};
    const second = {};
    repeat(first, SOLO_SUCCESS_REPEATS - 1);
    expect(repeat(second, SOLO_SUCCESS_REPEATS - 1)).toEqual(Array(SOLO_SUCCESS_REPEATS - 1).fill(undefined));
    expect(repeatedSuccessOf(first, READ, done("brief: ship on Friday"))).toMatch(/loop/);
  });
});
