/**
 * [W3] the `retrieval` block: the recall floor the improve loop reads, with the documented default.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "./defaults.js";
import { TrentConfigSchema } from "./schema.js";

describe("[W3] retrieval config block", () => {
  it("defaults min_recall to 0.9 in the schema and in the shipped defaults", () => {
    expect(TrentConfigSchema.parse({}).retrieval.min_recall).toBe(0.9);
    expect(DEFAULT_CONFIG.retrieval.min_recall).toBe(0.9);
  });

  it("keeps a configured floor and refuses one outside [0, 1]", () => {
    expect(TrentConfigSchema.parse({ retrieval: { min_recall: 0.75 } }).retrieval.min_recall).toBe(0.75);
    expect(TrentConfigSchema.safeParse({ retrieval: { min_recall: 1.1 } }).success).toBe(false);
  });
});
