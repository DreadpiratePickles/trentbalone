/**
 * [C16] Red first (council C16): the grader reads the END STATE of the fake servers. A world in which the
 * booking was never made fails the booking task; the same world after the booking was made passes it; and a
 * booking at the wrong instant fails, naming the key that differs. No runner and no model are involved: the
 * booking is made (or not) by calling the fake Square directly, as the business tool would.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BOOK_SQUARE_FACIAL } from "./fixtures/bookings.js";
import { gradeTask } from "./grade.js";
import { startBenchWorld, type BenchWorld } from "./world.js";

let world: BenchWorld;

beforeAll(async () => {
  world = await startBenchWorld();
});

afterAll(async () => {
  await world.stop();
});

beforeEach(() => {
  world.reset(BOOK_SQUARE_FACIAL.seed);
});

/** What `square_booking_create` sends (`tools/business/square.ts`), straight to the fake. */
async function bookInSquare(start: string): Promise<void> {
  const response = await fetch(`${world.endpoints.square}/v2/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotency_key: `k-${start}`,
      booking: { location_id: "L1", customer_id: "CUST_JANE", start_at: start, appointment_segments: [{ service_variation_id: "SV_FACIAL", service_variation_version: 3, team_member_id: "TM_ANA" }] },
    }),
  });
  expect(response.status).toBe(200);
}

describe("[C16] the bench grader reads the fake servers' end state", () => {
  it("fails the booking task when the fake Square holds no booking", async () => {
    const grade = await gradeTask(BOOK_SQUARE_FACIAL, world);
    expect(grade.passed).toBe(false);
    expect(grade.checks.find((check) => check.name === "bookings_created")).toMatchObject({ passed: false, detail: "expected 1, got 0" });
  });

  it("passes it once the booking exists at 10:00 New York time with Jane, the facial and Ana", async () => {
    await bookInSquare("2026-10-06T10:00:00-04:00");
    const grade = await gradeTask(BOOK_SQUARE_FACIAL, world);
    expect(grade.checks.filter((check) => !check.passed)).toEqual([]);
    expect(grade).toMatchObject({ passed: true, score: 1 });
  });

  it("fails a booking at the wrong instant, and says which key differs", async () => {
    await bookInSquare("2026-10-06T10:00:00Z");
    const grade = await gradeTask(BOOK_SQUARE_FACIAL, world);
    expect(grade.passed).toBe(false);
    expect(grade.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(["start"]);
  });
});
