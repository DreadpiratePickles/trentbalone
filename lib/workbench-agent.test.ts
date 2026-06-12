import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/workbench-providers";
import {
  runWorkbenchAgent,
  type AgentDeps,
  type WorkbenchAgentChunk,
  type ArtifactStreamToken,
} from "./workbench-agent";
import { store } from "./store";
import type { WorkbenchProviderAdapter, WorkbenchExecResult, WorkbenchTestResult } from "./workbench-provider";
import type { WorkbenchSession } from "./types";
import { setFastApplyImpl } from "./workbench-edit-apply";
import { passingInteractionDriver } from "./workbench-interaction-verify";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<WorkbenchProviderAdapter> = {}): WorkbenchProviderAdapter {
  return {
    name:            "mock_local",
    start:           vi.fn().mockResolvedValue(undefined),
    stop:            vi.fn().mockResolvedValue(undefined),
    exec:            vi.fn(async (): Promise<WorkbenchExecResult> => ({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 5 })),
    readFile:        vi.fn().mockResolvedValue(""),
    writeFile:       vi.fn().mockResolvedValue(undefined),
    listFiles:       vi.fn().mockResolvedValue([]),
    runTests:        vi.fn(async (): Promise<WorkbenchTestResult> => ({ passed: 3, failed: 0, skipped: 0, durationMs: 9, output: "3 passing", exitCode: 0 })),
    screenshot:      vi.fn().mockResolvedValue({ dataUri: "data:image/png;base64,dGVzdA==", width: 1280, height: 720, storageKey: "screenshots/test.png" }),
    getPreviewUrl:   vi.fn().mockResolvedValue("http://localhost:3000"),
    inspectPreview:  vi.fn(async (_session, url) => ({
      url,
      screenshot: { dataUri: "data:image/png;base64,dGVzdA==", width: 1280, height: 720, storageKey: "screenshots/test.png" },
      domText: "Rendered landing page workbench preview",
      visibleElements: 3,
      consoleErrors: [],
      pageErrors: [],
    })),
    captureArtifact: vi.fn(),
    ...overrides,
  };
}

/**
 * Produces a fake streamArtifact that yields an XML artifact equivalent to the
 * given actions list. Replaces the old `plan` mock.
 */
function makeStreamArtifact(actions: string[]): AgentDeps["streamArtifact"] {
  const xml =
    `<boltArtifact id="test" title="Test App">\n` +
    actions.join("\n") +
    `\n</boltArtifact>`;
  return async function* (): AsyncGenerator<ArtifactStreamToken> {
    yield { type: "token", content: xml };
    yield { type: "finish", reason: "stop" };
    yield { type: "usage", inputTokens: 100, outputTokens: 200 };
  };
}

/** Standard test artifact: file → shell → start */
const DEFAULT_STREAM = makeStreamArtifact([
  `<boltAction type="file" filePath="index.html"><h1>Hi</h1></boltAction>`,
  `<boltAction type="shell">npm install</boltAction>`,
  `<boltAction type="start">npm run dev</boltAction>`,
]);
const TEST_INTERACTION_DRIVER = passingInteractionDriver();

async function collect(gen: AsyncGenerator<WorkbenchAgentChunk>): Promise<WorkbenchAgentChunk[]> {
  const out: WorkbenchAgentChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

async function createSession(agentMode: WorkbenchSession["agentMode"], companyId: string): Promise<WorkbenchSession> {
  return store.createWorkbenchSession({
    companyId,
    agentRole:  "engineer",
    agentMode,
    provider:   "mock_local",
    status:     "running",
    objective:  "Build a landing page",
    metadata: {
      networkPolicy:        "deny_all",
      allowedHosts:         [],
      maxRuntimeSeconds:    1800,
      maxCostCents:         250,
      approvalRequiredFor:  [],
      rollbackAvailable:    true,
    },
  });
}

// ── Build mode tests ──────────────────────────────────────────────────────────

describe("runWorkbenchAgent — build mode (XML artifact loop)", () => {
  let session:  WorkbenchSession;
  let provider: WorkbenchProviderAdapter;
  let deps:     Partial<AgentDeps>;

  beforeEach(async () => {
    const company = await store.createCompany({ name: `Workbench Agent ${Date.now()}`, brief: { vision: "test" } });
    session  = await createSession("build", company.id);
    provider = makeProvider();
    deps     = { provider, streamArtifact: DEFAULT_STREAM, interactionDriver: TEST_INTERACTION_DRIVER };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setFastApplyImpl(null);
  });

  it("drives the provider through write → run → preview", async () => {
    const chunks = await collect(runWorkbenchAgent({ session, userMessage: "build it", deps }));
    const types  = chunks.map((c) => c.type);

    expect(types).toContain("plan");
    expect(types).toContain("file");
    expect(types).toContain("command");
    expect(types).toContain("preview");
    expect(types).toContain("done");

    expect(provider.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id }), "index.html", "<h1>Hi</h1>",
    );
    expect(provider.exec).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id }), "npm install",
    );
    expect(provider.getPreviewUrl).toHaveBeenCalled();
  });

  it("uses provider-managed preview starts when available", async () => {
    const startPreview = vi.fn(async () => ({
      command: "npm run dev",
      url: "http://localhost:4100",
      port: 4100,
      result: { stdout: "preview ready", stderr: "", exitCode: 0, durationMs: 25 },
    }));
    provider = makeProvider({
      listFiles: vi.fn().mockResolvedValue([
        { name: "package.json", path: "package.json", isDir: false, sizeBytes: 2, modifiedAt: "2026-06-04T00:00:00.000Z" },
      ]),
      startPreview,
    });
    const streamArtifact = makeStreamArtifact([
      `<boltAction type="file" filePath="src/App.tsx">export default function App(){return <h1>Hi</h1>}</boltAction>`,
      `<boltAction type="start">npm run dev</boltAction>`,
    ]);

    const chunks = await collect(runWorkbenchAgent({
      session,
      userMessage: "build it",
      deps: { provider, streamArtifact, interactionDriver: TEST_INTERACTION_DRIVER },
    }));

    expect(startPreview).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), "npm run dev");
    expect(chunks).toContainEqual({ type: "preview", url: "http://localhost:4100" });
    const refreshed = await store.getWorkbenchSession(session.id);
    expect(refreshed?.previewUrl).toBe("http://localhost:4100");
  });

  it("persists user + assistant chat messages and a preview URL", async () => {
    await collect(runWorkbenchAgent({ session, userMessage: "build it", deps }));
    const messages = await store.listWorkbenchChatMessages(session.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1].content).toContain("What I did");

    const refreshed = await store.getWorkbenchSession(session.id);
    expect(refreshed?.previewUrl).toBe("http://localhost:3000");
    expect(refreshed?.status).toBe("completed");
  });

  it("passes a markdown-only analysis deliverable without preview repair cycles", async () => {
    const files = new Map<string, string>();
    provider = makeProvider({
      listFiles: vi.fn(async () => Array.from(files.entries()).map(([path, content]) => ({
        name: path.split("/").pop() ?? path,
        path,
        isDir: false,
        sizeBytes: content.length,
        modifiedAt: new Date().toISOString(),
      }))),
      readFile: vi.fn(async (_session, filePath) => files.get(filePath) ?? ""),
      writeFile: vi.fn(async (_session, filePath, content) => {
        files.set(filePath, content);
      }),
      getPreviewUrl: vi.fn().mockResolvedValue("http://localhost:3000"),
      inspectPreview: vi.fn(),
    });
    const prompt = "Inspect the uploaded technical architecture and product feature inventory. Create a file called trent-test-plan.md summarizing the top engineering risks, recommended test commands, and a short manual QA checklist. Do not deploy anything.";
    const streamArtifact = makeStreamArtifact([
      `<boltAction type="file" filePath="trent-test-plan.md"># Trent Test Plan\n\n## Risks\n- Auth and onboarding.\n\n## Commands\n- npm test\n\n## Manual QA\n- Verify onboarding.</boltAction>`,
    ]);

    const chunks = await collect(runWorkbenchAgent({
      session,
      userMessage: prompt,
      deps: { provider, streamArtifact, interactionDriver: TEST_INTERACTION_DRIVER },
    }));

    expect(provider.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id }),
      "trent-test-plan.md",
      expect.stringContaining("Trent Test Plan"),
    );
    expect(provider.getPreviewUrl).not.toHaveBeenCalled();
    expect(provider.inspectPreview).not.toHaveBeenCalled();
    expect(provider.exec).not.toHaveBeenCalled();
    expect(chunks).toContainEqual(expect.objectContaining({
      type: "status",
      phase: "scoping",
      detail: expect.stringContaining("Task scope: analysis"),
    }));
    expect(chunks.filter((chunk) => chunk.type === "verify")).toHaveLength(1);
    const verifyChunk = chunks.find((chunk) => chunk.type === "verify");
    expect(verifyChunk).toMatchObject({
      passed: true,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "files", status: "pass", detail: expect.stringContaining("trent-test-plan.md") }),
      ]),
    });

    const attempts = await store.listWorkbenchAttempts(session.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("completed");
    const refreshed = await store.getWorkbenchSession(session.id);
    expect(refreshed?.status).toBe("completed");
    const messages = await store.listWorkbenchChatMessages(session.id);
    expect(messages.at(-1)?.content).toContain("**Verification:** passed");
  });

  it("records workbench events for plan and file step", async () => {
    await collect(runWorkbenchAgent({ session, userMessage: "build it", deps }));
    const events = await store.listWorkbenchEvents(session.id);
    const titles = events.map((e) => e.title);
    expect(titles.some((t) => t.includes("Build plan ready"))).toBe(true);
    expect(titles.some((t) => t.includes("index.html"))).toBe(true);
  });

  it("persists written files as attributed artifacts", async () => {
    await collect(runWorkbenchAgent({ session, userMessage: "build it", deps }));

    const events = await store.listWorkbenchEvents(session.id);
    const fileEvent = events.find((event) => event.type === "file" && event.title === "Wrote index.html");
    const artifacts = await store.listWorkbenchArtifacts(session.id);
    const fileArtifact = artifacts.find((artifact) => artifact.kind === "file" && artifact.path === "index.html");

    expect(fileArtifact).toEqual(expect.objectContaining({
      createdByAgent: "engineer",
      sourceEventId: fileEvent?.id,
      mimeType: "text/html",
      sizeBytes: "<h1>Hi</h1>".length,
    }));
    expect(fileArtifact?.metadata).toMatchObject({ attemptNo: 1, bytes: "<h1>Hi</h1>".length });
  });

  it("includes durable artifact ids and attribution in the final assistant report", async () => {
    await collect(runWorkbenchAgent({ session, userMessage: "build it", deps }));

    const messages = await store.listWorkbenchChatMessages(session.id);
    const final = messages[messages.length - 1].content;
    const artifacts = await store.listWorkbenchArtifacts(session.id);
    const fileArtifact = artifacts.find((artifact) => artifact.kind === "file" && artifact.path === "index.html");
    const screenshot = artifacts.find((artifact) => artifact.kind === "screenshot");

    expect(fileArtifact).toBeTruthy();
    expect(screenshot).toBeTruthy();
    expect(final).toContain("**Artifacts:**");
    expect(final).toContain(`${fileArtifact?.id}`);
    expect(final).toContain("file");
    expect(final).toContain("index.html");
    expect(final).toContain("engineer");
    expect(final).toContain(`${screenshot?.id}`);
    expect(final).toContain("screenshot");
    expect(final).toContain("http://localhost:3000");
  });

  it("persists each build attempt and latest verification checkpoint", async () => {
    provider = makeProvider({
      snapshot: vi.fn(async () => ({
        id: "snapshot_1",
        fileTreeHash: "tree_hash_1",
        createdAt: "2026-06-04T00:00:00.000Z",
        metadata: { providerSessionId: "sandbox_1" },
      })),
    });

    await collect(runWorkbenchAgent({
      session,
      userMessage: "build it",
      deps: { provider, streamArtifact: DEFAULT_STREAM, interactionDriver: TEST_INTERACTION_DRIVER },
    }));

    const attempts = await store.listWorkbenchAttempts(session.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual(expect.objectContaining({
      attemptNo: 1,
      status: "completed",
      inputTokens: 100,
      outputTokens: 200,
      rawArtifact: expect.stringContaining("<boltArtifact"),
    }));

    const checkpoint = await store.getWorkbenchCheckpoint(session.id);
    expect(checkpoint).toEqual(expect.objectContaining({
      sessionId: session.id,
      provider: "mock_local",
      providerSessionId: "sandbox_1",
      previewUrl: "http://localhost:3000",
      activePort: 3000,
      fileTreeHash: "tree_hash_1",
    }));
    expect(checkpoint?.latestVerification).toMatchObject({ passed: true });
    expect(provider.snapshot).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }));
  });

  it("tags build trace events with their durable attempt number", async () => {
    await collect(runWorkbenchAgent({ session, userMessage: "build it", deps }));

    const events = await store.listWorkbenchEvents(session.id);
    expect(events.find((event) => event.title === "Build plan ready")).toEqual(expect.objectContaining({
      attemptNo: 1,
    }));
    expect(events.find((event) => event.title === "Verification passed")).toEqual(expect.objectContaining({
      attemptNo: 1,
    }));
  });

  it("persists the verification screenshot as an attributed artifact", async () => {
    await collect(runWorkbenchAgent({ session, userMessage: "build it", deps }));

    const artifacts = await store.listWorkbenchArtifacts(session.id);
    const screenshot = artifacts.find((artifact) => artifact.kind === "screenshot");
    expect(screenshot).toEqual(expect.objectContaining({
      storageKey: "screenshots/test.png",
      createdByAgent: "engineer",
      previewUrl: "http://localhost:3000",
    }));
    expect(screenshot?.metadata).toMatchObject({ attemptNo: 1, verificationPassed: true });

    const events = await store.listWorkbenchEvents(session.id);
    expect(events.find((event) => event.artifactId === screenshot?.id)).toEqual(expect.objectContaining({
      type: "screenshot",
      attemptNo: 1,
      agentRole: "engineer",
    }));

    const checkpoint = await store.getWorkbenchCheckpoint(session.id);
    expect(checkpoint?.latestVerification).toMatchObject({ screenshotArtifactId: screenshot?.id });
  });

  it("stops when the cost ceiling is reached", async () => {
    await store.updateWorkbenchSession(session.id, { costCents: 999 });
    const chunks = await collect(runWorkbenchAgent({ session, userMessage: "build it", deps }));
    expect(chunks.some((c) => c.type === "status" && c.phase === "budget_reached")).toBe(true);
    expect(provider.writeFile).not.toHaveBeenCalled();
  });

  it("emits an error chunk when the stream produces no artifact", async () => {
    async function* noArtifact(): AsyncGenerator<ArtifactStreamToken> {
      yield { type: "token",  content: "Just some text with no XML tags." };
      yield { type: "finish", reason: "stop" };
    }
    const chunks = await collect(
      runWorkbenchAgent({
        session,
        userMessage: "build it",
        deps: { provider, streamArtifact: noArtifact, interactionDriver: TEST_INTERACTION_DRIVER },
      }),
    );
    expect(chunks.some((c) => c.type === "error")).toBe(true);
    expect(chunks.some((c) => c.type === "done")).toBe(true);
  });

  it("handles continuation: merges two segments into one artifact", async () => {
    const part1 = `<boltArtifact id="app" title="App">\n<boltAction type="file" filePath="a.ts">const a = 1;</boltAction>`;
    const part2 = `\n<boltAction type="file" filePath="b.ts">const b = 2;</boltAction>\n</boltArtifact>`;
    let call = 0;
    async function* twoSegments(): AsyncGenerator<ArtifactStreamToken> {
      call++;
      if (call === 1) {
        yield { type: "token",  content: part1 };
        yield { type: "finish", reason: "length" }; // truncated
      } else {
        yield { type: "token",  content: part2 };
        yield { type: "finish", reason: "stop" };
      }
    }
    const chunks = await collect(
      runWorkbenchAgent({
        session,
        userMessage: "build it",
        deps: { provider, streamArtifact: twoSegments, interactionDriver: TEST_INTERACTION_DRIVER },
      }),
    );
    const fileChunks = chunks.filter((c) => c.type === "file");
    expect(fileChunks.length).toBe(2);
  });

  it("writes the starter template when workdir is empty", async () => {
    // listFiles returns [] (default mock), so starter template should be written
    await collect(runWorkbenchAgent({ session, userMessage: "build it", deps }));
    // The starter template write is done via safeWrite (provider.writeFile)
    // package.json is the first starter file
    const calls = (provider.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    const writtenPaths = calls.map((c: unknown[]) => c[1]);
    expect(writtenPaths).toContain("package.json");
    expect(writtenPaths).toContain("src/globals.css");
    expect(writtenPaths).toContain("src/components/ui/button.tsx");
  });

  it("repair edit touches only the broken file and leaves sibling byte-identical", async () => {
    const siblingContent = "export const sibling = 'untouched';\n";
    const brokenOriginal = "export const broken = true;\n";
    const files = new Map<string, string>([
      ["src/Sibling.tsx", siblingContent],
      ["src/Broken.tsx", brokenOriginal],
    ]);

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("preview unreachable");
    }));

    let streamCalls = 0;
    const streamArtifact: AgentDeps["streamArtifact"] = async function* ({ messages }) {
      streamCalls++;
      if (streamCalls === 1) {
        const xml =
          `<boltArtifact id="build" title="Build">\n` +
          `<boltAction type="file" filePath="src/Broken.tsx">export const broken = true;</boltAction>\n` +
          `<boltAction type="start">npm run dev</boltAction>\n` +
          `</boltArtifact>`;
        yield { type: "token", content: xml };
      } else {
        const userPrompt = messages.find((message) => message.role === "user")?.content ?? "";
        expect(userPrompt).toContain("minimal type=\"edit\"");
        const editBody = [
          "<<<<<<< SEARCH",
          "export const broken = true;",
          "=======",
          "export const broken = false;",
          ">>>>>>> REPLACE",
        ].join("\n");
        const xml =
          `<boltArtifact id="repair" title="Repair">\n` +
          `<boltAction type="edit" filePath="src/Broken.tsx">${editBody}</boltAction>\n` +
          `<boltAction type="start">npm run dev</boltAction>\n` +
          `</boltArtifact>`;
        yield { type: "token", content: xml };
      }
      yield { type: "finish", reason: "stop" };
      yield { type: "usage", inputTokens: 50, outputTokens: 50 };
    };

    let screenshotCalls = 0;
    provider = makeProvider({
      listFiles: vi.fn().mockResolvedValue([
        { name: "Sibling.tsx", path: "src/Sibling.tsx", isDir: false, sizeBytes: 30, modifiedAt: "2026-06-04T00:00:00.000Z" },
        { name: "Broken.tsx", path: "src/Broken.tsx", isDir: false, sizeBytes: 25, modifiedAt: "2026-06-04T00:00:00.000Z" },
      ]),
      readFile: vi.fn(async (_session, path: string) => files.get(path) ?? ""),
      writeFile: vi.fn(async (_session, path: string, content: string) => {
        files.set(path, content);
      }),
      screenshot: vi.fn(async () => {
        screenshotCalls++;
        if (screenshotCalls === 1) {
          const svg = Buffer.from("<svg>Preview placeholder (browser screenshot unavailable)</svg>").toString("base64");
          return { dataUri: `data:image/svg+xml;base64,${svg}`, width: 1280, height: 720, storageKey: "placeholder.svg" };
        }
        return { dataUri: "data:image/png;base64,dGVzdA==", width: 1280, height: 720, storageKey: "ok.png" };
      }),
    });

    await collect(runWorkbenchAgent({
      session,
      userMessage: "fix the bug",
      deps: { provider, streamArtifact, interactionDriver: TEST_INTERACTION_DRIVER },
    }));

    expect(streamCalls).toBe(2);
    expect(files.get("src/Sibling.tsx")).toBe(siblingContent);
    expect(files.get("src/Broken.tsx")).toBe("export const broken = false;");

    const writeCalls = (provider.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    const siblingWrites = writeCalls.filter((call: unknown[]) => call[1] === "src/Sibling.tsx");
    expect(siblingWrites).toHaveLength(0);
  });

  it("runs a repair artifact pass when verification fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("preview unreachable");
    }));
    let streamCalls = 0;
    const streamArtifact: AgentDeps["streamArtifact"] = async function* ({ messages }) {
      streamCalls++;
      const userPrompt = messages.find((message) => message.role === "user")?.content ?? "";
      const fileContent = streamCalls === 1 ? "<h1>Broken</h1>" : "<h1>Fixed</h1>";
      const xml =
        `<boltArtifact id="repair" title="Repair App">\n` +
        `<boltAction type="file" filePath="index.html">${fileContent}</boltAction>\n` +
        `<boltAction type="start">npm run dev</boltAction>\n` +
        `</boltArtifact>`;
      if (streamCalls === 2) expect(userPrompt).toContain("Previous verification failed");
      yield { type: "token", content: xml };
      yield { type: "finish", reason: "stop" };
      yield { type: "usage", inputTokens: 100, outputTokens: 100 };
    };
    let screenshotCalls = 0;
    provider = makeProvider({
      screenshot: vi.fn(async () => {
        screenshotCalls++;
        if (screenshotCalls === 1) {
          const svg = Buffer.from("<svg>Preview placeholder (browser screenshot unavailable)</svg>").toString("base64");
          return { dataUri: `data:image/svg+xml;base64,${svg}`, width: 1280, height: 720, storageKey: "placeholder.svg" };
        }
        return { dataUri: "data:image/png;base64,dGVzdA==", width: 1280, height: 720, storageKey: "ok.png" };
      }),
    });

    const chunks = await collect(runWorkbenchAgent({
      session,
      userMessage: "build it",
      deps: { provider, streamArtifact, interactionDriver: TEST_INTERACTION_DRIVER },
    }));

    expect(streamCalls).toBe(2);
    expect(chunks.some((c) => c.type === "status" && c.phase === "repair_cycle")).toBe(true);
    const refreshed = await store.getWorkbenchSession(session.id);
    expect(refreshed?.status).toBe("completed");
    expect(provider.writeFile).toHaveBeenCalledWith(expect.anything(), "index.html", "<h1>Fixed</h1>");
  });

  it("includes per-attempt shell failures in the final failed-check summary", async () => {
    provider = makeProvider({
      listFiles: vi.fn().mockResolvedValue([
        { name: "package.json", path: "package.json", isDir: false, sizeBytes: 2, modifiedAt: "2026-06-02T00:00:00.000Z" },
      ]),
      getPreviewUrl: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn(async (_session: WorkbenchSession, command: string): Promise<WorkbenchExecResult> => {
        if (command === "npm install") {
          return { stdout: "", stderr: "registry unavailable", exitCode: 1, durationMs: 5 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 5 };
      }),
    });

    await collect(runWorkbenchAgent({
      session,
      userMessage: "build it",
      deps: { provider, streamArtifact: DEFAULT_STREAM, interactionDriver: TEST_INTERACTION_DRIVER },
    }));

    const messages = await store.listWorkbenchChatMessages(session.id);
    const final = messages[messages.length - 1].content;
    expect(final).toContain("**Verification:** FAILED");
    expect(final).toContain("install: npm install exit 1");
    expect(final).toContain("registry unavailable");
    const refreshed = await store.getWorkbenchSession(session.id);
    expect(refreshed?.status).toBe("failed");
  });

  it("rolls back text workspace changes from failed build attempts instead of checkpointing them", async () => {
    const files = new Map<string, string>([
      ["package.json", "{}"],
      ["src/App.tsx", "export default function App(){return <h1>Original</h1>}"],
    ]);
    const streamArtifact = makeStreamArtifact([
      `<boltAction type="file" filePath="src/App.tsx">export default function App(){return <h1>Broken</h1>}</boltAction>`,
      `<boltAction type="file" filePath="src/New.tsx">export const bad = true;</boltAction>`,
      `<boltAction type="start">npm run dev</boltAction>`,
    ]);
    provider = makeProvider({
      listFiles: vi.fn(async () => Array.from(files.entries()).map(([path, content]) => ({
        name: path.split("/").pop() ?? path,
        path,
        isDir: false,
        sizeBytes: content.length,
        modifiedAt: "2026-06-12T00:00:00.000Z",
      }))),
      readFile: vi.fn(async (_session, path: string) => files.get(path) ?? ""),
      writeFile: vi.fn(async (_session, path: string, content: string) => {
        files.set(path, content);
      }),
      exec: vi.fn(async (_session: WorkbenchSession, command: string): Promise<WorkbenchExecResult> => {
        if (command.includes("src/New.tsx")) files.delete("src/New.tsx");
        return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 5 };
      }),
      runTests: vi.fn(async (): Promise<WorkbenchTestResult> => ({
        passed: 0,
        failed: 1,
        skipped: 0,
        durationMs: 5,
        output: "regression still failing",
        exitCode: 1,
      })),
    });

    await collect(runWorkbenchAgent({
      session,
      userMessage: "build it",
      deps: { provider, streamArtifact, interactionDriver: TEST_INTERACTION_DRIVER },
    }));

    expect(files.get("src/App.tsx")).toContain("Original");
    expect(files.has("src/New.tsx")).toBe(false);
    expect(await store.getWorkbenchCheckpoint(session.id)).toBeUndefined();
    const rollbackEvents = await store.listWorkbenchEvents(session.id);
    expect(rollbackEvents.some((event) => event.title === "Rolled back failed Workbench run")).toBe(true);
  });
});

describe("runWorkbenchAgent — approval gates", () => {
  it("pauses before file writes when implementation plan approval is required", async () => {
    const company = await store.createCompany({ name: `Plan Approval ${Date.now()}`, brief: { vision: "test" } });
    const baseSession = await createSession("build", company.id);
    const session: WorkbenchSession = {
      ...baseSession,
      metadata: {
        ...baseSession.metadata,
        approvalRequiredFor: ["workbench_plan"],
      },
    };
    const provider = makeProvider();

    const chunks = await collect(runWorkbenchAgent({
      session,
      userMessage: "Build a landing page",
      deps: { provider, streamArtifact: DEFAULT_STREAM, interactionDriver: TEST_INTERACTION_DRIVER },
    }));

    expect(chunks.some((c) => c.type === "plan")).toBe(true);
    expect(chunks.some((c) => c.type === "status" && c.phase === "awaiting_approval")).toBe(true);
    expect(provider.writeFile).not.toHaveBeenCalled();
    expect(provider.exec).not.toHaveBeenCalled();
    const refreshed = await store.getWorkbenchSession(session.id);
    expect(refreshed?.status).toBe("paused");
    const approvals = await store.listApprovals(company.id);
    expect(approvals.some((approval) => approval.action === "workbench.plan" && approval.status === "pending")).toBe(true);
    const attempts = await store.listWorkbenchAttempts(session.id);
    expect(attempts[0]).toMatchObject({ status: "needs_approval" });
  });

  it("pauses the session when a shell action requires external-write approval", async () => {
    const company = await store.createCompany({ name: `Approval ${Date.now()}`, brief: { vision: "test" } });
    const session = await createSession("build", company.id);
    const pushStream = makeStreamArtifact([
      `<boltAction type="shell">git push origin main</boltAction>`,
    ]);
    const provider = makeProvider({
      exec: vi.fn(async () => ({
        stdout: "",
        stderr: "Approval required before executing this command.",
        exitCode: 1,
        durationMs: 1,
        blocked: true,
        blockedReason: "external_write_requires_approval",
      })),
    });

    const chunks = await collect(runWorkbenchAgent({
      session,
      userMessage: "Ship to main",
      deps: { provider, streamArtifact: pushStream, interactionDriver: TEST_INTERACTION_DRIVER },
    }));

    const refreshed = await store.getWorkbenchSession(session.id);
    expect(refreshed?.status).toBe("paused");
    expect(chunks.some((c) => c.type === "status" && c.phase === "awaiting_approval")).toBe(true);
    const approvals = await store.listApprovals(company.id);
    expect(approvals.some((a) => a.status === "pending" && a.action === "workbench.git_push")).toBe(true);
  });
});

describe("runWorkbenchAgent — model roles", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("records WORKBENCH_EXECUTOR_MODEL on build attempts", async () => {
    vi.stubEnv("WORKBENCH_EXECUTOR_MODEL", "custom-executor-ab");
    vi.resetModules();
    const { runWorkbenchAgent: runAgent } = await import("./workbench-agent");

    const company = await store.createCompany({ name: `Executor Model ${Date.now()}`, brief: { vision: "test" } });
    const session = await createSession("build", company.id);
    const provider = makeProvider();

    await collect(runAgent({
      session,
      userMessage: "build it",
      deps: { provider, streamArtifact: DEFAULT_STREAM, interactionDriver: TEST_INTERACTION_DRIVER },
    }));

    const attempts = await store.listWorkbenchAttempts(session.id);
    expect(attempts[0]?.model).toBe("custom-executor-ab");
  });
});

describe("runWorkbenchAgent — research mode (streamed)", () => {
  it("streams content tokens and persists the assistant message", async () => {
    const company = await store.createCompany({ name: `Research ${Date.now()}`, brief: { vision: "test" } });
    const session = await createSession("research", company.id);
    async function* fakeStream() { yield "Find"; yield "ings."; }
    const chunks = await collect(
      runWorkbenchAgent({
        session,
        userMessage: "research X",
        deps: { provider: makeProvider(), stream: () => fakeStream() },
      }),
    );
    const content = chunks
      .filter((c) => c.type === "content")
      .map((c) => (c as { content: string }).content)
      .join("");
    expect(content).toBe("Findings.");
    const messages = await store.listWorkbenchChatMessages(session.id);
    expect(messages[messages.length - 1].content).toContain("Findings.");
  });
});
