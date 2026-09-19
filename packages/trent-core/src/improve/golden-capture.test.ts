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

/**
 * Wall time spent loading the module graph (the orchestrator wrapper plus the nine `apps/web/lib`
 * modules `loadLibs()` pulls in), and wall time spent on the orchestration the timed hook drives.
 *
 * Measured on this file: the graph costs 0.9 s on an idle machine and 24.2 s under a saturated
 * fork pool, while the whole run — planner, two steps, ten provider attempts through the fallback
 * chain, consolidation, run_failed, golden write — costs 63 ms warm. No backoff is involved: the
 * injected failure is a plain `Error`, which `classifyProviderError` puts in `internal` with
 * `retryable: false`, so `DEFAULT_RETRY_POLICY` never sleeps.
 *
 * Both numbers scale with machine load together, so the ratio is the load-independent invariant:
 * loading must cost more than running, which is only true when the graph is loaded OUTSIDE the
 * hook that vitest puts a wall-clock budget on. Loading it inside the hook is what put this file
 * on a timeout cliff in the full parallel run.
 */
let ORCHESTRATION_MS = 0;

/**
 * The boot, at module scope — deliberately not in `beforeAll`.
 *
 * The order is the standalone contract's, unchanged: `imitateCompiledBinary` and
 * `applyStandaloneEnv` write the environment, `createOrchestrator` writes the model variables, and
 * only then is any `apps/web/lib` module evaluated — `ai-client.ts` freezes its registry and token
 * limits at evaluation time. `loadLibs()` is the run's own loader, called here so the run finds the
 * graph resident; `goldens.list()` warms `@/lib/orchestration-golden-capture`, which the capture
 * imports lazily on the first `run_failed`.
 */
const BOOT_STARTED_AT = Date.now();
imitateCompiledBinary();
const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
applyStandaloneEnv(IN_MEMORY_DATABASE);
const GOLDEN_DIR = mkdtempSync(path.join(tmpdir(), "trent-goldens-"));
const { createOrchestrator } = await import("../orchestrator/index.js");
const HOOK = createImproveHook({ store: new InMemoryImproveStore(), installedAgents: [], goldenDir: GOLDEN_DIR });
const ORCHESTRATOR = createOrchestrator({
  model: { provider: "google", model: "gemini-3.5-flash-lite" },
  createChatCompletion: async () => {
    throw new Error(`404 status code (no body) for ${SECRET}`);
  },
  improve: HOOK,
});
const { loadLibs } = await import("../orchestrator/libs.js");
await loadLibs();
await HOOK.goldens?.list();
const COMPANY_ID = await newCompany("ImproveGoldens");
const MODULE_BOOT_MS = Date.now() - BOOT_STARTED_AT;

describe("golden capture — run_failed becomes a quarantined fixture", () => {
  const dir = GOLDEN_DIR;
  let events: OrcEvent[] = [];
  let runId = "";

  beforeAll(async () => {
    const hookStartedAt = Date.now();
    const handle = ORCHESTRATOR.run({ companyId: COMPANY_ID, objective: OBJECTIVE });
    const collected = await collect(handle);
    events = collected.events;
    runId = collected.snapshot.id;
    ORCHESTRATION_MS = Date.now() - hookStartedAt;
  });

  afterAll(restoreEnv);

  it("the timed hook drives the run only: the module graph is already loaded when it starts", () => {
    expect(ORCHESTRATION_MS).toBeLessThan(MODULE_BOOT_MS);
  });

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
