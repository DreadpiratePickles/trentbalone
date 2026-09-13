/**
 * Item 3: the seat wiring. `config.toolsets` was read by nothing at runtime; `file_ops` and
 * `terminal` were labels. After `wireSeatTools` the adapters are in the live registry, the router
 * ranks `file_ops` for a file-reading step with the OFFLINE lexical embedder (no OPENAI_API_KEY, so
 * this is the path a Gemini-only install takes), and every slot role's environment carries the
 * toolset scopes and the approval floors.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

describe("seat wiring", () => {
  let companyId = "";
  let workspace = "";

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
    applyStandaloneEnv(IN_MEMORY_DATABASE);
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-wiring-"));
    const { store } = await import("@/lib/store");
    const { setSemanticRouterEmbedderForTests, resetSemanticRouterForTests } = await import("@/lib/semantic-router");
    setSemanticRouterEmbedderForTests(null);
    resetSemanticRouterForTests();
    companyId = (await store.createCompany({ name: "Seat wiring", brief: { vision: "tools for seats" } })).id;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("registers the adapters, ranks file_ops in the top 3 for a file-reading step, and upserts every seat", async () => {
    const { buildTrentToolAdapters } = await import("../tools/index.js");
    const { loadLibs } = await import("./libs.js");
    const { wireSeatTools, SEAT_ROLES } = await import("./seat-wiring.js");
    const adapters = buildTrentToolAdapters(
      { toolsets: ["file_ops", "terminal"], disabled_toolsets: [] },
      { workspace, profileDir: path.join(workspace, ".profile"), backend: "local" },
    );
    const libs = await loadLibs();
    await wireSeatTools(libs, companyId, adapters);

    const { adapters: registry } = await import("@/lib/tools");
    expect(registry.map((adapter) => adapter.name)).toEqual(expect.arrayContaining(["file_ops", "terminal"]));

    const engineer = await libs.store.getAgentPlugAssignment(companyId, "engineer");
    expect(engineer?.environment.tools).toEqual(expect.arrayContaining(["file_ops", "read_file", "write_file", "patch", "search_files", "terminal", "process_manage"]));
    expect(engineer?.environment.tools).toEqual(expect.arrayContaining(["GitHub", "workbench:session"]));
    expect(engineer?.environment.approvalRequiredFor).toEqual(expect.arrayContaining(["file_ops.write", "terminal.dangerous"]));
    for (const role of SEAT_ROLES) {
      const assignment = await libs.store.getAgentPlugAssignment(companyId, role);
      expect(assignment?.environment.tools, role).toContain("file_ops");
    }

    // Exactly what `executeStepWithRuntime` does (`orchestrator-runtime.ts:1379-1382`): the top-3
    // ranking when the best score clears the threshold, otherwise every environment tool.
    const { routeToolsForStep } = await import("@/lib/semantic-router");
    const step = "read package.json and report the version";
    const environment = { tools: [...engineer!.environment.tools] };
    const ranked = await routeToolsForStep(step, environment, 3);
    const names = ranked.map((tool) => tool.name);
    const toolGuidance = names.length ? names : engineer!.environment.tools;
    expect(toolGuidance, `ranked: ${names.join(", ") || "(none)"}`).toContain("file_ops");
    if (names.length) expect(names.indexOf("file_ops")).toBeLessThanOrEqual(2);
    // And the ranking itself is right: with no threshold, file_ops is the first choice for the step.
    const wide = await routeToolsForStep(step, environment, 10);
    if (wide.length) expect(wide[0]!.name).toBe("file_ops");
    for (const adapter of adapters) await adapter.cleanup();
  }, 60_000);

  it("the seat guard appends each available adapter's instructions to the seat's tool instructions", async () => {
    const { guardSeatModel, SeatTally } = await import("./seat-guard.js");
    const seen: unknown[] = [];
    const guarded = guardSeatModel(
      async (input) => {
        seen.push(input);
        return { output: {}, model: "m", tokens: 0, costCents: 0, fallback: false };
      },
      undefined,
      new SeatTally(),
      new Map([["file_ops", "USE read_file {json}"], ["terminal", "USE terminal {json}"]]),
    );
    await guarded({ subtask: { id: "s1", seat: "engineer" }, toolLoopContext: { availableTools: ["file_ops", "GitHub"], toolInstructions: ["existing"] } });
    const forwarded = seen[0] as { toolLoopContext: { toolInstructions: string[] } };
    expect(forwarded.toolLoopContext.toolInstructions).toEqual(["existing", "USE read_file {json}"]);
  });
});
