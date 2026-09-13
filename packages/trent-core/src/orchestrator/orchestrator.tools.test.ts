/**
 * The test that closes the requirement ("I want it to have access to all the tools Hermes has").
 *
 * With `toolsets: [file_ops, terminal]`, an offline run whose objective is "print the name field of
 * package.json" ends `completed` with a `step.toolCalls` entry from `file_ops` whose summary carries
 * the real name, and one from `terminal` whose stdout came from a container whose `docker inspect`
 * shows NetworkMode=none. Before this build the same run recorded
 * `Tool "read_file" is not allowed for this seat.`
 *
 * The planner, critic and seat model are scripted (no provider); everything else — the wrapper, the
 * seam, the seat loop, the adapters, the Docker sandbox — is real. The live counterpart on
 * gemini-3.5-flash-lite is `orchestrator.tools.live.test.ts`.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrchestrationRunSnapshot } from "./types.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

type ToolCall = { adapter: string; action: string; status: string; summary: string };
type StepWithTools = OrchestrationRunSnapshot["steps"][number] & { toolCalls?: ToolCall[] };
type SeatInput = {
  subtask: { id: string; seat: string; objective: string };
  toolLoopContext?: {
    step: number;
    availableTools: string[];
    toolInstructions?: string[];
    toolHistory: Array<{ adapter: string; action: string; result: ToolCall }>;
  };
};

function dockerCli(args: string[]): Promise<string> {
  return new Promise((resolve) => execFile("docker", args, { timeout: 60_000 }, (error, stdout) => resolve(error ? "" : stdout)));
}
const dockerAvailable = (await dockerCli(["version", "--format", "{{.Server.Version}}"])).trim().length > 0;

/** A one-step plan for the engineer, a passing critic, a plain consolidation. */
function scriptedPlanner(objective: string) {
  return async (_model: string, messages: Array<{ role: string; content: string }>) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (system.includes("quality supervisor")) return { content: JSON.stringify({ verdict: "pass", reason: "scripted" }), totalTokens: 4 };
    if (system.includes("chief orchestrator") || system.includes("orchestration planner") || user.includes("Objective:")) {
      return {
        content: JSON.stringify({
          objective,
          reasoning: "scripted plan: one engineer step that must read the file",
          steps: [{ id: "s1", title: "Read package.json and print its name field", rationale: "the objective", agentRole: "engineer",
            dependsOn: [], expectedOutput: "The name value from package.json", riskLevel: "low", needsApproval: false }],
          successCriteria: ["name reported"],
          blockers: [],
        }),
        totalTokens: 12,
      };
    }
    return { content: JSON.stringify({ summary: "scripted consolidation", findings: [], recommendations: [], workRequests: [] }), totalTokens: 4 };
  };
}

describe.skipIf(!dockerAvailable)(`closing test: a seat reads a file and runs a command in the sandbox${dockerAvailable ? "" : " [SKIPPED: no Docker daemon]"}`, () => {
  const seatInputs: SeatInput[] = [];
  let snapshot: OrchestrationRunSnapshot;
  let expectedName = "";
  let profileDir = "";
  let isolatedContainer: string | undefined;
  let inspected = "";
  let cleanup: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    expectedName = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string }).name;
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-closing-"));

    const { buildTrentToolAdapters } = await import("../tools/index.js");
    const tools = buildTrentToolAdapters(
      { toolsets: ["file_ops", "terminal"], disabled_toolsets: [] },
      { workspace: REPO_ROOT, profileDir, dockerImage: "alpine:3" },
    );
    cleanup = async () => {
      for (const tool of tools) await tool.cleanup();
    };

    const { createOrchestrator } = await import("./index.js");
    const objective = "print the name field of package.json";
    const orchestrator = createOrchestrator({
      tools,
      createCompletion: scriptedPlanner(objective) as unknown as (...args: never[]) => unknown,
      // The scripted seat: read the file with file_ops, confirm with terminal, then answer from the tool result.
      executeSeatModelFn: (async (input: SeatInput) => {
        seatInputs.push(input);
        const loop = input.toolLoopContext;
        const turn = loop?.step ?? 1;
        const reply = (output: unknown) => ({ output, model: "scripted-seat", tokens: 10, costCents: 0, fallback: false });
        if (turn === 1) return reply({ toolCall: { name: "file_ops", action: 'read_file {"path":"package.json"}' }, summary: null });
        if (turn === 2) return reply({ toolCall: { name: "terminal", action: 'terminal {"command":"grep -m1 \\"\\\\\\"name\\\\\\"\\" package.json"}' }, summary: null });
        const fromTool = loop?.toolHistory.find((t) => t.adapter === "file_ops")?.result.summary ?? "";
        const name = /"name":\s*"([^"]+)"/.exec(fromTool)?.[1] ?? "(not found in tool result)";
        return reply({ toolCall: null, summary: `The name field of package.json is ${name}.`, findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests: [] });
      }) as unknown as (...args: never[]) => unknown,
    });

    const companyId = await orchestrator.ensureCompany({ name: "Closing test", vision: "seats with real tools" });
    const handle = orchestrator.run({ companyId, objective });
    for await (const event of handle) {
      if (event.kind === "run_awaiting_approval" && event.step?.id) await orchestrator.approve(event.runId, event.step.id);
    }
    snapshot = await handle.result();
    // Inspect while the sandbox still exists; cleanup removes the containers.
    const terminal = tools.find((tool) => tool.name === "terminal") as unknown as { containerNames(): string[] } | undefined;
    isolatedContainer = terminal?.containerNames().find((name) => name.includes("isolated"));
    if (isolatedContainer) inspected = await dockerCli(["inspect", "--format", "{{.HostConfig.NetworkMode}}|{{json .HostConfig.CapDrop}}", isolatedContainer]);
  }, 300_000);

  afterAll(async () => {
    await cleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("ends completed", () => {
    expect(snapshot.status).toBe("completed");
  });

  it("the seat was offered file_ops and terminal, with their usage instructions in the prompt", () => {
    const first = seatInputs[0];
    expect(first?.toolLoopContext?.availableTools).toEqual(expect.arrayContaining(["file_ops", "terminal"]));
    expect(first?.toolLoopContext?.toolInstructions?.join("\n")).toContain('read_file {"path":"package.json"}');
    expect(first?.toolLoopContext?.toolInstructions?.join("\n")).toContain('terminal {"command"');
  });

  it("records a completed file_ops read_file call whose summary carries the real package name", () => {
    const calls = (snapshot.steps as StepWithTools[]).flatMap((step) => step.toolCalls ?? []);
    const read = calls.find((call) => call.adapter === "file_ops");
    expect(read, JSON.stringify(calls.map((c) => [c.adapter, c.status, c.summary.slice(0, 80)]))).toBeDefined();
    expect(read!.status).toBe("completed");
    expect(read!.action).toContain("read_file");
    expect(read!.summary).toContain(`"name": "${expectedName}"`);
    expect(read!.summary).toMatch(/^package\.json \(lines 1-/);
    expect(calls.some((call) => /not allowed for this seat/.test(call.summary))).toBe(false);
  });

  it("records a completed terminal call whose stdout came from a container with NetworkMode=none and CapDrop=[ALL]", () => {
    const calls = (snapshot.steps as StepWithTools[]).flatMap((step) => step.toolCalls ?? []);
    const shell = calls.find((call) => call.adapter === "terminal");
    expect(shell?.status).toBe("completed");
    expect(shell?.summary).toContain(expectedName);
    expect(isolatedContainer).toBeDefined();
    expect(inspected.trim()).toBe('none|["ALL"]');
  });

  it("the tool result reached the seat's final answer and the step output", () => {
    const step = snapshot.steps[0]!;
    expect(step.status).toBe("completed");
    expect(step.output ?? "").toContain(expectedName);
  });
});
