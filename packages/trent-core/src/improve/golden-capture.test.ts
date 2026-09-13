/**
 * Item 4 — golden capture. A failed run becomes a quarantined regression fixture with secrets
 * redacted. The failure is a REAL offline run whose every seat call throws.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { OrcEvent } from "../orchestrator/types.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { createGoldenCapture, createImproveHook } from "./index.js";
import { collect, imitateCompiledBinary, newCompany, restoreEnv } from "./offline-harness.js";

const SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789";
const OBJECTIVE = `Rotate the billing webhook and re-verify with key ${SECRET} then email ops@example.com`;

describe("golden capture — run_failed becomes a quarantined fixture", () => {
  let dir = "";
  let events: OrcEvent[] = [];
  let runId = "";

  beforeAll(async () => {
    imitateCompiledBinary();
    const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
    applyStandaloneEnv(IN_MEMORY_DATABASE);
    dir = mkdtempSync(path.join(tmpdir(), "trent-goldens-"));
    const { createOrchestrator } = await import("../orchestrator/index.js");
    const hook = createImproveHook({ store: new InMemoryImproveStore(), installedAgents: [], goldenDir: dir });
    const orchestrator = createOrchestrator({
      model: { provider: "google", model: "gemini-3.5-flash-lite" },
      createChatCompletion: async () => {
        throw new Error(`404 status code (no body) for ${SECRET}`);
      },
      improve: hook,
    });
    const companyId = await newCompany("ImproveGoldens");
    const handle = orchestrator.run({ companyId, objective: OBJECTIVE });
    const collected = await collect(handle);
    events = collected.events;
    runId = collected.snapshot.id;
  }, 120_000);

  afterAll(restoreEnv);

  it("the run really failed", () => {
    expect(events.map((e) => e.kind)).toContain("run_failed");
  });

  it("wrote exactly one quarantined golden for the run, with the secret and the email redacted", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toEqual([`golden-${runId}.json`]);
    const raw = readFileSync(path.join(dir, files[0]!), "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("ops@example.com");
    const golden = JSON.parse(raw) as { status: string; runId: string; objective: string; reason: string };
    expect(golden.status).toBe("quarantined");
    expect(golden.runId).toBe(runId);
    expect(golden.objective).toContain("[KEY_REDACTED]");
    expect(golden.reason).toContain("run_failed");
  });
});

describe("golden capture — critic escalate/replan on a synthetic bus", () => {
  it("captures on step_critic with verdict escalate, and never twice for one run", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "trent-goldens-"));
    const seen: Array<{ runId: string; reason: string }> = [];
    const capture = createGoldenCapture({
      dir,
      capture: async (input) => {
        seen.push({ runId: input.runId, reason: input.reason });
        return { id: "g", runId: input.runId, status: "quarantined" };
      },
    });
    const critic = (verdict: string): OrcEvent => ({
      kind: "step_critic",
      runId: "run_c",
      at: "t",
      step: { id: "s", critique: { verdict, reason: "weak" } } as unknown as OrcEvent["step"],
    });
    capture.sink(critic("pass"));
    capture.sink(critic("escalate"));
    capture.sink(critic("replan"));
    capture.sink({ kind: "run_failed", runId: "run_c", at: "t", detail: "boom" });
    await capture.flush();
    expect(seen).toEqual([{ runId: "run_c", reason: "critic_escalate: weak" }]);
  });
});
