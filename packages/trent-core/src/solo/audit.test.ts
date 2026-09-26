/**
 * [S2] Council B4: a solo run writes the audit rows a fleet run writes. The fleet's rows are the
 * app's `auditTransition` (`apps/web/lib/orchestrator-runtime.ts`): `orchestration.<transition>`,
 * object type `orchestration`, the run id, actor `agent` (`system` for a failure), through the app
 * store's `addAudit`. The sink writes the same rows through the same call; the writer is injected
 * here so no app module loads.
 */
import { describe, expect, it } from "vitest";
import type { OrcEvent } from "../orchestrator/types.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, memorySession, scriptedGateway, sequentialIds, toolCall, type ScriptStep } from "./fakes.test-helpers.js";
import { createSoloAuditSink, type SoloAuditRow } from "./audit.js";
import { createSoloRouter } from "./router.js";
import { createSoloRunner } from "./runner.js";

const POST = 'social_post {"platform": "bluesky", "text": "New oak tables are in."}';

function setup(script: ScriptStep[]) {
  const rows: SoloAuditRow[] = [];
  const audit = createSoloAuditSink({ companyId: "cmp_audit", write: async (row) => void rows.push(row) });
  const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: (action) => action.startsWith("social_post") });
  const router = createSoloRouter({
    holds: "park",
    sinks: [audit],
    onDecision: audit.decision,
    create: () => createSoloRunner({ gateway: scriptedGateway(script), tools: { adapters: [social] }, session: memorySession(), memory: fakeMemory().memory, meter: fakeMeter(), now: FIXED_NOW, newId: sequentialIds() }),
  });
  return { rows, audit, router };
}

const shape = (rows: readonly SoloAuditRow[]) => rows.map((row) => [row.actor, row.action, row.objectType, row.objectId]);

describe("[S2] solo runs write the fleet's audit rows (B4)", () => {
  it("run start, the step, the gate, the human's decision and the end, in order", async () => {
    const { rows, audit, router } = setup([toolCall(POST), "Posted."]);
    const parked = await collect(router.run({ objective: "Announce the tables", session: "s1" }));
    const runId = parked[0]!.runId;
    await router.approve(runId, `${runId}-trent`);
    await collect(router.resume(runId));
    await audit.flush();

    expect(shape(rows)).toEqual([
      ["agent", "orchestration.run_start", "orchestration", runId],
      ["agent", "orchestration.step_start", "orchestration", runId],
      ["agent", "orchestration.step_start", "orchestration", runId],
      ["agent", "orchestration.step_approved", "orchestration", runId],
      ["agent", "orchestration.run_done", "orchestration", runId],
    ]);
    expect(rows.every((row) => row.companyId === "cmp_audit")).toBe(true);
    expect(rows[0]?.summary).toBe("Started: Announce the tables");
    expect(rows[1]?.summary).toBe("trent: Announce the tables");
    expect(rows[2]?.summary).toBe(`Awaiting tool approval: social ${POST}`);
    expect(rows[3]?.summary).toBe(`Approved solo step ${runId}-trent`);
    expect(rows[4]?.summary).toBe("Completed: Posted.");
  });

  it("a rejection is its own row, and a failure is the system's (the fleet's actor rule)", async () => {
    const { rows, audit, router } = setup([toolCall(POST), new Error("provider returned 500")]);
    const parked = await collect(router.run({ objective: "Announce", session: "s1" }));
    const runId = parked[0]!.runId;
    await router.reject(runId, `${runId}-trent`);
    await collect(router.resume(runId));
    await audit.flush();
    expect(shape(rows).map(([actor, action]) => `${actor} ${action}`)).toEqual([
      "agent orchestration.run_start",
      "agent orchestration.step_start",
      "agent orchestration.step_start",
      "agent orchestration.step_rejected",
      "system orchestration.run_failed",
    ]);
  });

  it("a write that fails is reported once and never fails the run", async () => {
    const reasons: string[] = [];
    const sink = createSoloAuditSink({ companyId: "cmp_audit", write: async () => { throw new Error("the app store is down"); }, onError: (reason) => void reasons.push(reason) });
    sink.sink({ kind: "run_start", runId: "solo_1", at: "2026-09-26T09:00:00.000Z", run: { objective: "x" } } as OrcEvent);
    sink.sink({ kind: "run_done", runId: "solo_1", at: "2026-09-26T09:00:01.000Z", run: { summary: "y" } } as OrcEvent);
    await sink.flush();
    expect(reasons).toEqual(["the solo audit row could not be written: the app store is down"]);
  });
});
