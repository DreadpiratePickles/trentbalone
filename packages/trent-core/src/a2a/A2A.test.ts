/**
 * The PRE-SPECIFICATION A2A surface: the HMAC-signed agent card, and `POST /a2a/tasks` with
 * Trent's own payload.
 *
 * The specification transport — the Agent Card at the well-known URI and JSON-RPC at the server
 * root — is covered by `spec-transport.test.ts`. This file covers what is kept for ONE release
 * behind a deprecation header (`legacy.ts`): the payload reaches the same engine, the old response
 * shape comes back, a refusal becomes 503, an unknown id becomes 404, bad JSON becomes 400, and
 * every one of those responses carries the header that says where to go instead.
 *
 * The previous version of the third test asserted the server's own canned literal
 * (`status === "completed"`, `"... resolved successfully."`) with nothing behind it — the exact
 * anti-test AGENTS.md invariant 4 forbids. No live model is involved on any path here.
 */
import { describe, it, expect } from "vitest";
import type { AgentRunner, AgentRunInput } from "../agent-runner/index.js";
import { NO_RUNNER_REASON } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import {
  generateAgentCard,
  verifyAgentCardSignature,
  A2AServer,
  a2aObjective,
  A2A_DEPRECATION_HEADERS,
  type A2ALegacyTask,
  type AgentCard,
} from "./index.js";

const secret = "test-a2a-secret-key-12345";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_a2a", at: "2026-09-18T00:00:00.000Z", ...extra } as OrcEvent;
}

/** Records the objectives it was asked to run and replays a fixed event sequence. */
function fakeRunner(events: readonly OrcEvent[]): AgentRunner & { objectives: string[] } {
  const objectives: string[] = [];
  return {
    objectives,
    run(input: AgentRunInput) {
      objectives.push(input.objective);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

const payload = {
  taskId: "task-001",
  originAgent: "remote-partner-agent",
  targetAgent: "engineer",
  taskType: "architecture-review",
  parameters: { repo: "acme/backend" },
};

async function postTask(port: number, body: Record<string, unknown>): Promise<{ code: number; json: any; deprecated: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/a2a/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { code: res.status, json: (await res.json()) as any, deprecated: res.headers.get("deprecation") };
}

describe("A2A agent cards", () => {
  it("generates a valid Signed Agent Card with cryptographic signature", () => {
    const card = generateAgentCard(
      {
        id: "eng-ai-engineer",
        name: "AI Systems Engineer",
        description: "Specialist in fine-tuning, evals, and agent architectures.",
        category: "engineering",
        capabilities: ["prompt-eval", "architecture-review"],
        endpoint: "http://localhost:7895/a2a",
      },
      secret,
    );

    expect(card.id).toBe("eng-ai-engineer");
    expect(card.capabilities).toContain("prompt-eval");
    expect(card.signature).toBeDefined();
    expect(typeof card.signature).toBe("string");
    expect(card.signature!.length).toBe(64); // SHA-256 hex string
  });

  it("verifies valid agent card signatures and rejects tampered cards", () => {
    const card = generateAgentCard(
      {
        id: "ceo",
        name: "Trent CEO",
        description: "Chief Executive cofounder",
        category: "executive",
        capabilities: ["strategic-planning", "milestone-review"],
        endpoint: "http://localhost:7895/a2a",
      },
      secret,
    );

    expect(verifyAgentCardSignature(card, secret)).toBe(true);

    const tampered: AgentCard = { ...card, description: "Malicious modified description" };
    expect(verifyAgentCardSignature(tampered, secret)).toBe(false);
  });
});

describe("a2aObjective", () => {
  it("prefers the delegating agent's own words", () => {
    expect(a2aObjective({ ...payload, objective: "  audit the retry policy  " })).toBe("audit the retry policy");
  });

  it("composes the question from the payload when no objective was sent", () => {
    const objective = a2aObjective(payload);
    expect(objective).toContain("architecture-review");
    expect(objective).toContain("engineer");
    expect(objective).toContain("remote-partner-agent");
    expect(objective).toContain("acme/backend");
  });
});

describe("the deprecated A2A task endpoint", () => {
  it("serves a signed card and runs a delegated task on the injected runtime", async () => {
    const runner = fakeRunner([
      ev("run_start", { run: { objective: "x" } }),
      ev("step_end", { step: { id: "s1", output: "reviewed the dependency graph" } }),
      ev("consolidate_end", { run: { summary: "The service boundary between billing and ledger is the risk." } }),
      ev("run_done", { run: { status: "completed", summary: "The service boundary between billing and ledger is the risk." } }),
    ]);
    const server = new A2AServer({ port: 7895, secret, runner });
    await server.start();
    try {
      expect(server.isRunning()).toBe(true);

      const cardRes = await fetch("http://127.0.0.1:7895/a2a/card/engineer");
      const cardData = (await cardRes.json()) as any;
      expect(cardData.id).toBe("engineer");
      expect(cardData.signature).toBeDefined();

      const { code, json, deprecated } = await postTask(7895, payload);
      const task = json as A2ALegacyTask;
      expect(code).toBe(200);
      // Kept for one release, and every response says so.
      expect(deprecated).toBe(A2A_DEPRECATION_HEADERS.Deprecation);

      // The lifecycle actually happened, in order, and the terminal state is the runner's.
      expect(task.history.map((h) => h.state)).toEqual(["submitted", "working", "completed"]);
      expect(task.status.state).toBe("completed");
      expect(task.runId).toBe("run_a2a");

      // The output is the RUN's own summary, not a string this server composed.
      expect(task.artifacts).toHaveLength(1);
      expect(task.artifacts[0]?.parts[0]?.text).toBe(
        "The service boundary between billing and ledger is the risk.",
      );
      expect(JSON.stringify(task)).not.toContain("resolved successfully");

      // The objective handed to the runtime is built from the caller's own payload.
      expect(runner.objectives).toEqual([a2aObjective(payload)]);
      expect(runner.objectives[0]).toContain("architecture-review");
      expect(runner.objectives[0]).toContain("acme/backend");

      // GET returns the stored state, not a fresh fabrication.
      const getRes = await fetch("http://127.0.0.1:7895/a2a/tasks/task-001");
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toEqual(task);
    } finally {
      await server.stop();
    }
    expect(server.isRunning()).toBe(false);
  });

  it("with no runner attached it refuses honestly with 503 and never reports success", async () => {
    const server = new A2AServer({ port: 7894, secret });
    await server.start();
    try {
      const { code, json, deprecated } = await postTask(7894, payload);
      expect(code).toBe(503);
      expect(deprecated).toBe(A2A_DEPRECATION_HEADERS.Deprecation);
      expect(json.error).toBe(NO_RUNNER_REASON);
      expect(json.status).toBeUndefined();
      expect(JSON.stringify(json)).not.toContain("completed");

      // Nothing was stored, so there is no task to poll.
      const getRes = await fetch("http://127.0.0.1:7894/a2a/tasks/task-001");
      expect(getRes.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("rejects an unparseable task body without inventing a task", async () => {
    const runner = fakeRunner([ev("run_done", { run: { summary: "done" } })]);
    const server = new A2AServer({ port: 7893, secret, runner });
    await server.start();
    try {
      const res = await fetch("http://127.0.0.1:7893/a2a/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(runner.objectives).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});
