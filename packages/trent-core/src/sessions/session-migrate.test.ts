import { describe, it, expect } from "vitest";
import {
  dollarsToCents,
  centsToDollars,
  migrateSessionRecord,
  SESSION_SCHEMA_VERSION,
} from "./schema.js";

describe("session cost migration", () => {
  it("converts realistic float dollars to integer cents with no precision loss", () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [0.01, 1],
      [0.07, 7],
      [0.29, 29],
      [0.12, 12],
      [1.1, 110],
      [2.675, 268],
      [12.34, 1234],
      [99.99, 9999],
      [1234.56, 123456],
    ];
    for (const [dollars, cents] of cases) {
      expect(dollarsToCents(dollars)).toBe(cents);
    }
  });

  it("round-trips cents back to dollars", () => {
    expect(centsToDollars(1234)).toBeCloseTo(12.34, 10);
    expect(centsToDollars(0)).toBe(0);
  });

  it("rejects non-finite and negative costs rather than storing garbage", () => {
    expect(dollarsToCents(Number.NaN)).toBe(0);
    expect(dollarsToCents(Number.POSITIVE_INFINITY)).toBe(0);
    expect(dollarsToCents(-1)).toBe(0);
  });

  it("migrates a realistic pre-versioning session file", () => {
    const legacy = {
      id: "sess_1730000000000_ab12cd34",
      title: "Refactor the billing module",
      created_at: "2025-10-27T09:14:02.001Z",
      updated_at: "2025-10-27T09:41:55.912Z",
      agent: "engineer",
      model: "claude-sonnet-5",
      provider: "anthropic",
      status: "completed",
      total_cost: 3.4700000000000006,
      total_duration_ms: 91_240,
      messages: [
        {
          id: "msg_1",
          role: "user",
          content: "Move billing to integer cents",
          timestamp: "2025-10-27T09:14:02.001Z",
        },
        {
          id: "msg_2",
          role: "assistant",
          agent: "engineer",
          content: "Done.",
          timestamp: "2025-10-27T09:41:55.912Z",
          metadata: {
            cost: 3.47,
            duration_ms: 91_240,
            model: "claude-sonnet-5",
            tokens: { prompt: 9000, completion: 1200, total: 10_200 },
          },
        },
      ],
    };

    const migrated = migrateSessionRecord(legacy);

    expect(migrated.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(migrated.total_cost_cents).toBe(347);
    expect(migrated.total_cost).toBeCloseTo(3.47, 10);
    expect(migrated.messages[1]?.metadata?.cost_cents).toBe(347);
    expect(migrated.messages).toHaveLength(2);
    expect(migrated.title).toBe("Refactor the billing module");
    expect(migrated.total_duration_ms).toBe(91_240);
  });

  it("is idempotent: migrating an already-current record changes nothing", () => {
    const once = migrateSessionRecord({
      id: "sess_x",
      title: "t",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      agent: "ceo",
      model: "m",
      provider: "p",
      status: "active",
      total_cost: 0.5,
      total_duration_ms: 0,
      messages: [],
    });
    const twice = migrateSessionRecord(once);
    expect(twice).toEqual(once);
    expect(twice.total_cost_cents).toBe(50);
  });

  it("throws on a record that is not a session object", () => {
    expect(() => migrateSessionRecord(null)).toThrow();
    expect(() => migrateSessionRecord({ nope: true })).toThrow();
  });
});
