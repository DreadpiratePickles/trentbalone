import { describe, expect, it } from "vitest";
import { nextFromCron, parseSchedule } from "@/lib/schedule-grammar";
import { nextRunFrom } from "@/lib/scheduler";

const localIso = (
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute = 0
) => new Date(year, monthIndex, day, hour, minute, 0, 0).toISOString();

describe("schedule grammar", () => {
  it("schedules weekly runs on the requested weekday instead of tomorrow", () => {
    const base = new Date(2026, 4, 27, 20, 0, 0, 0); // Wednesday, May 27 2026

    expect(parseSchedule("weekly", base).nextRunAt).toBe(localIso(2026, 5, 1, 9));
    expect(parseSchedule("every monday at 5pm", base).nextRunAt).toBe(
      localIso(2026, 5, 1, 17)
    );
    expect(parseSchedule("every friday at 5:30pm", base).nextRunAt).toBe(
      localIso(2026, 4, 29, 17, 30)
    );
  });

  it("keeps interval schedules inside the current day when possible", () => {
    const base = new Date(2026, 4, 27, 20, 17, 0, 0);

    expect(parseSchedule("every 2 hours", base).nextRunAt).toBe(localIso(2026, 4, 27, 22));
    expect(parseSchedule("every 30 minutes", base).nextRunAt).toBe(
      localIso(2026, 4, 27, 20, 30)
    );
  });

  it("supports daily, weekday, weekend, and monthly natural schedules", () => {
    const base = new Date(2026, 4, 27, 10, 0, 0, 0); // Wednesday

    expect(parseSchedule("every day at 8am", base).nextRunAt).toBe(localIso(2026, 4, 28, 8));
    expect(parseSchedule("every weekday at noon", base).nextRunAt).toBe(
      localIso(2026, 4, 27, 12)
    );
    expect(parseSchedule("every weekend at 9am", base).nextRunAt).toBe(
      localIso(2026, 4, 30, 9)
    );
    expect(parseSchedule("monthly", base).nextRunAt).toBe(localIso(2026, 5, 1, 9));
  });

  it("passes raw cron through the same next-run evaluator", () => {
    const base = new Date(2026, 4, 27, 20, 0, 0, 0);

    expect(nextFromCron("15 9 * * 1-5", base).toISOString()).toBe(
      localIso(2026, 4, 28, 9, 15)
    );
    expect(nextRunFrom(base.toISOString(), "0 9 * * 1")).toBe(localIso(2026, 5, 1, 9));
  });
});
