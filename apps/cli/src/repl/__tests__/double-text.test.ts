/**
 * T2.2 — what a second submission during a run does, by `repl.double_text_policy`.
 *
 * Before this, `handleKey` dropped every keystroke while busy, so a founder who typed a
 * follow-up during a run lost it in silence. Now: `enqueue` holds the text for the next turn,
 * `interrupt` stops the run and starts the new one, `reject` says so on the status line.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { TrentConfig } from "@trent/core/config/index.js";
import { BUSY_STATUS_LINE } from "../engine.js";
import { makeHarness, DEFAULT_EVENTS } from "./harness.js";

const withPolicy = (policy: "enqueue" | "interrupt" | "reject"): TrentConfig => ({
  ...DEFAULT_CONFIG,
  repl: { double_text_policy: policy },
});

describe("double texting in the REPL", () => {
  it("enqueue: the second submission runs as the next turn once the first completes", async () => {
    const h = makeHarness({ config: withPolicy("enqueue") });
    const first = h.engine.submit("plan the launch");
    await h.emitted(2);
    const second = h.engine.submit("now the budget");
    expect(h.engine.queued).toEqual(["now the budget"]);
    expect(h.out.some((line) => /queued/i.test(line))).toBe(true);
    await first;
    expect(h.streamCompleted).toBe(true); // the first run was never cut short
    await second;
    expect(h.engine.queued).toEqual([]);
    expect(h.engine.busy).toBe(false);
    expect(h.objectives).toEqual(["plan the launch", "now the budget"]);
  });

  it("interrupt: the second submission aborts the run and starts its own", async () => {
    const h = makeHarness({ config: withPolicy("interrupt") });
    const first = h.engine.submit("plan the launch");
    await h.emitted(2);
    const second = h.engine.submit("scrap that, do the budget");
    await first;
    expect(h.transcript().some((line) => line.includes("Interrupted"))).toBe(true);
    await second;
    expect(h.objectives).toEqual(["plan the launch", "scrap that, do the budget"]);
    expect(h.streamCompleted).toBe(true); // the second run completed
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("reject: the second submission is refused on the status line and the run continues", async () => {
    const h = makeHarness({ config: withPolicy("reject") });
    const first = h.engine.submit("plan the launch");
    await h.emitted(2);
    await h.engine.submit("and also this");
    expect(h.out).toContain(BUSY_STATUS_LINE);
    expect(h.engine.busy).toBe(true);
    await first;
    expect(h.streamCompleted).toBe(true);
    expect(h.objectives).toEqual(["plan the launch"]);
  });

  it("/stop during a run interrupts it under every policy and starts nothing", async () => {
    for (const policy of ["enqueue", "interrupt", "reject"] as const) {
      const h = makeHarness({ config: withPolicy(policy) });
      const first = h.engine.submit("plan the launch");
      await h.emitted(2);
      await h.engine.submit("/stop");
      await first;
      expect(h.streamCompleted).toBe(false);
      expect(h.transcript().some((line) => line.includes("Interrupted"))).toBe(true);
      expect(h.objectives).toEqual(["plan the launch"]);
      expect(h.engine.busy).toBe(false);
    }
  });

  it("typed input during a run reaches the draft and submits under enqueue instead of vanishing", async () => {
    const h = makeHarness({ config: withPolicy("enqueue"), events: DEFAULT_EVENTS });
    const first = h.engine.submit("plan the launch");
    await h.emitted(2);
    h.feed("follow up\r");
    expect(h.engine.queued).toEqual(["follow up"]);
    await first;
    for (let i = 0; i < 200 && h.engine.busy; i += 1) await new Promise((r) => setTimeout(r, 1));
    for (let i = 0; i < 200 && h.objectives.length < 2; i += 1) await new Promise((r) => setTimeout(r, 1));
    expect(h.objectives).toEqual(["plan the launch", "follow up"]);
  });
});
