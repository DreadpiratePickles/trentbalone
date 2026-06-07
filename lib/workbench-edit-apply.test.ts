import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyEditBlocks,
  fastApply,
  parseEditBlocks,
  setFastApplyImpl,
  type EditBlock,
} from "@/lib/workbench-edit-apply";

describe("parseEditBlocks", () => {
  it("parses a single search/replace block", () => {
    const body = [
      "<<<<<<< SEARCH",
      "const a = 1;",
      "=======",
      "const a = 2;",
      ">>>>>>> REPLACE",
    ].join("\n");
    expect(parseEditBlocks(body)).toEqual<EditBlock[]>([
      { search: "const a = 1;", replace: "const a = 2;" },
    ]);
  });

  it("parses multiple blocks in order", () => {
    const body = [
      "<<<<<<< SEARCH",
      "foo",
      "=======",
      "bar",
      ">>>>>>> REPLACE",
      "<<<<<<< SEARCH",
      "baz",
      "=======",
      "qux",
      ">>>>>>> REPLACE",
    ].join("\n");
    expect(parseEditBlocks(body)).toEqual([
      { search: "foo", replace: "bar" },
      { search: "baz", replace: "qux" },
    ]);
  });
});

describe("applyEditBlocks", () => {
  it("(a) applies an exact search/replace block", () => {
    const original = "line1\nconst a = 1;\nline3\n";
    const blocks: EditBlock[] = [{ search: "const a = 1;", replace: "const a = 2;" }];
    const result = applyEditBlocks(original, blocks);
    expect(result).toEqual({ ok: true, content: "line1\nconst a = 2;\nline3\n" });
  });

  it("(b) applies a block when whitespace has drifted", () => {
    const original = "function add(a: number, b: number) {\n  return a - b;\n}\n";
    const blocks: EditBlock[] = [
      {
        search: "function add(a: number, b: number) {\n  return a - b;\n}",
        replace: "function add(a: number, b: number) {\n  return a + b;\n}",
      },
    ];
    const drifted = "function add(a: number, b: number) {\n    return a - b;  \n}\n";
    const result = applyEditBlocks(drifted, blocks);
    expect(result).toEqual({
      ok: true,
      content: "function add(a: number, b: number) {\n  return a + b;\n}\n",
    });
  });

  it("(c) returns {ok:false, miss} for an unmatchable block", () => {
    const original = "export const value = 1;\n";
    const blocks: EditBlock[] = [{ search: "this text does not exist", replace: "nope" }];
    const result = applyEditBlocks(original, blocks);
    expect(result).toEqual({ ok: false, miss: "this text does not exist" });
  });

  it("(c) triggers mocked fastApply fallback after a miss", async () => {
    const original = "export const broken = true;\n";
    const lazyEdit = [
      "<<<<<<< SEARCH",
      "missing anchor",
      "=======",
      "export const broken = false;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const blocks = parseEditBlocks(lazyEdit);
    const deterministic = applyEditBlocks(original, blocks);
    expect(deterministic.ok).toBe(false);

    const mockApply = vi.fn(async () => "export const broken = false;\n");
    setFastApplyImpl(mockApply);
    const merged = await fastApply(original, lazyEdit);
    expect(mockApply).toHaveBeenCalledWith(original, lazyEdit);
    expect(merged).toBe("export const broken = false;\n");
  });
});

afterEach(() => {
  setFastApplyImpl(null);
});
