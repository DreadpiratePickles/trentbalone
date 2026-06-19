import { describe, expect, it } from "vitest";
import { hogqlStringLiteral } from "./hogql";

describe("hogqlStringLiteral", () => {
  it("wraps values as single-quoted HogQL literals", () => {
    expect(hogqlStringLiteral("experiment_1")).toBe("'experiment_1'");
  });

  it("escapes apostrophes and backslashes before interpolation into HogQL", () => {
    expect(hogqlStringLiteral("x' OR 1=1 -- \\")).toBe("'x'' OR 1=1 -- \\\\'");
  });
});
