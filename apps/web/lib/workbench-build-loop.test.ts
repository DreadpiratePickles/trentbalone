import { describe, expect, it, vi } from "vitest";

const mockWikiEmbeddings = vi.hoisted(() => ({
  semanticSearch: vi.fn(async () => [] as Array<{
    noteId: string;
    title: string;
    path: string;
    chunkIdx: number;
    text: string;
    score: number;
  }>),
}));

vi.mock("@/lib/wiki-embeddings", () => mockWikiEmbeddings);

import {
  buildDeploymentPlanSummary,
  buildGroundedWorkbenchSourceContext,
  buildWorkbenchSourceContext,
  isWorkspaceUnscaffolded,
  STRICT_ARTIFACT_REPROMPT,
  streamArtifactWithRetry,
} from "@/lib/workbench-build-loop";
import type { ArtifactStreamToken, StreamInput, WorkbenchAgentChunk } from "@/lib/workbench-agent-types";
import { PREVIEW_PID_FILENAME } from "@/lib/workbench-preview-reaper";

describe("isWorkspaceUnscaffolded", () => {
  it("treats an empty workspace as unscaffolded", () => {
    expect(isWorkspaceUnscaffolded([])).toBe(true);
  });

  it("ignores the session README written by provider start()", () => {
    // Regression: mock_local/railway start() writes README.md into every new
    // session workdir, which used to make the workspace look non-empty and
    // silently skip starter-template seeding (no package.json/tsconfig.json/
    // index.html -> tsc help screen, vite 404).
    expect(isWorkspaceUnscaffolded([{ name: "README.md", isDir: false }])).toBe(true);
  });

  it("ignores the preview pid sidecar and .DS_Store", () => {
    expect(isWorkspaceUnscaffolded([
      { name: "README.md", isDir: false },
      { name: PREVIEW_PID_FILENAME, isDir: false },
      { name: ".DS_Store", isDir: false },
    ])).toBe(true);
  });

  it("keeps a scaffolded workspace untouched once project files exist", () => {
    expect(isWorkspaceUnscaffolded([
      { name: "README.md", isDir: false },
      { name: "package.json", isDir: false },
    ])).toBe(false);
    expect(isWorkspaceUnscaffolded([{ name: "src", isDir: true }])).toBe(false);
  });
});

describe("buildWorkbenchSourceContext", () => {
  it("injects required company docs into build-mode prompts", () => {
    const context = buildWorkbenchSourceContext(
      "Using the brand voice and marketing plan, create a minimal landing page prototype.",
      [
        {
          id: "doc_brand",
          title: "Brand Voice",
          type: "agent_note",
          content: "Brand voice: plainspoken operator-first copy, no generic startup boilerplate.",
        },
        {
          id: "doc_marketing",
          title: "Marketing Plan",
          type: "marketing_plan",
          content: "Marketing plan: target founder-operators with launch readiness and approval gates.",
        },
      ],
    );

    expect(context).toContain("SOURCE COVERAGE:");
    expect(context).toContain("brand voice (doc doc_brand)");
    expect(context).toContain("marketing plan (doc doc_marketing)");
    expect(context).toContain("[doc_brand] Brand Voice");
    expect(context).toContain("[doc_marketing] Marketing Plan");
    expect(context).toContain("Use these source documents for domain claims, landing-page copy, and layout decisions.");
  });

  it("injects repo deployment evidence for Railway planning prompts", () => {
    const context = buildWorkbenchSourceContext(
      "Prepare a Railway deployment plan for this app. Do not deploy. List every required environment variable and a rollback plan.",
      [],
    );

    expect(context).toContain("REPO DEPLOYMENT EVIDENCE");
    expect(context).toContain("DATABASE_URL");
    expect(context).toContain("REDIS_URL");
    expect(context).toContain("AUTH_SECRET");
    expect(context).toContain("SECRET_ENCRYPTION_KEY");
    expect(context).toContain("NEXT_PUBLIC_APP_URL");
    expect(context).toMatch(/web.*worker|worker.*web/i);
    expect(context).not.toContain("JWT_SECRET");
    expect(context).not.toContain("generic API_KEY");
  });

  it("injects semantic wiki chunks into grounded Workbench prompts", async () => {
    mockWikiEmbeddings.semanticSearch.mockResolvedValueOnce([
      {
        noteId: "note_roadmap",
        title: "Roadmap Wiki",
        path: "wiki/roadmap.md",
        chunkIdx: 0,
        text: "Roadmap: import GitHub repos before adding paid social automation.",
        score: 0.9,
      },
    ]);

    const context = await buildGroundedWorkbenchSourceContext(
      "co_1",
      "Using the roadmap, build the next Workbench priority screen.",
      [],
    );

    expect(context).toContain("SOURCE COVERAGE:");
    expect(context).toContain("roadmap (doc wiki:note_roadmap#0)");
    expect(context).toContain("[wiki:note_roadmap#0] Roadmap Wiki");
    expect(context).toContain("GitHub repos");
  });

  it("builds a deterministic visible deployment summary for Railway planning prompts", () => {
    const summary = buildDeploymentPlanSummary(
      "Prepare a Railway deployment plan for this app. Do not deploy. List every required environment variable and a rollback plan.",
    );

    expect(summary).toContain("Repo Deployment Evidence");
    expect(summary).toContain("DATABASE_URL");
    expect(summary).toContain("REDIS_URL");
    expect(summary).toContain("AUTH_SECRET");
    expect(summary).toContain("SECRET_ENCRYPTION_KEY");
    expect(summary).toContain("NEXT_PUBLIC_APP_URL");
    expect(summary).toMatch(/web.*worker|worker.*web/i);
    expect(summary).toMatch(/rollback/i);
    expect(summary).toMatch(/no deploy/i);
    expect(summary).not.toContain("JWT_SECRET");
    expect(summary).not.toContain("generic API_KEY");
  });
});

describe("streamArtifactWithRetry", () => {
  const ARTIFACT = `<boltArtifact id="crm" title="CRM"><boltAction type="file" filePath="index.html">hi</boltAction></boltArtifact>`;

  function baseMessages(): StreamInput["messages"] {
    return [
      { role: "system", content: "sys" },
      { role: "user", content: "build a CRM" },
    ];
  }

  // Mock provider: each call returns the next scripted response as one token,
  // then a usage record and a non-truncated finish (matches the executor stream).
  function makeStream(responses: string[]) {
    const calls: StreamInput[] = [];
    async function* stream(input: StreamInput): AsyncGenerator<ArtifactStreamToken> {
      const idx = calls.length;
      calls.push({ messages: input.messages.map((m) => ({ ...m })) });
      yield { type: "token", content: responses[Math.min(idx, responses.length - 1)] };
      yield { type: "usage", inputTokens: 100, outputTokens: 200 };
      yield { type: "finish", reason: "stop" };
    }
    return { stream, calls };
  }

  async function drain(gen: AsyncGenerator<WorkbenchAgentChunk, Awaited<ReturnType<typeof streamArtifactWithRetry>> extends AsyncGenerator<infer _C, infer R> ? R : never>) {
    const chunks: WorkbenchAgentChunk[] = [];
    let next = await gen.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await gen.next();
    }
    return { chunks, result: next.value };
  }

  it("returns the artifact on the first try without reprompting", async () => {
    const { stream, calls } = makeStream([ARTIFACT]);
    const { chunks, result } = await drain(streamArtifactWithRetry(stream, baseMessages()));

    expect(result.reprompted).toBe(false);
    expect(result.artifact?.actions).toHaveLength(1);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(200);
    expect(calls).toHaveLength(1);
    expect(chunks.some((c) => c.type === "status" && c.phase === "reprompting")).toBe(false);
  });

  it("re-prompts strictly and recovers when the first response is prose", async () => {
    const prose = "Sure! I'll build a CRM. First we set up the project, then add pages.";
    const { stream, calls } = makeStream([prose, ARTIFACT]);
    const { chunks, result } = await drain(streamArtifactWithRetry(stream, baseMessages()));

    expect(result.reprompted).toBe(true);
    expect(result.artifact?.actions).toHaveLength(1);
    // both segments' tokens are accounted for (real spend happened)
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(400);
    expect(calls).toHaveLength(2);

    const retry = calls[1].messages;
    expect(retry.some((m) => m.role === "assistant" && m.content === prose)).toBe(true);
    expect(retry.some((m) => m.role === "user" && m.content === STRICT_ARTIFACT_REPROMPT)).toBe(true);
    expect(chunks.some((c) => c.type === "status" && c.phase === "reprompting")).toBe(true);
    // prose (no <bolt) is still surfaced to the user as content
    expect(chunks.some((c) => c.type === "content" && c.content === prose)).toBe(true);
  });

  it("re-prompts once when the artifact has no actions", async () => {
    const empty = `<boltArtifact id="x" title="x"></boltArtifact>`;
    const { stream, calls } = makeStream([empty, ARTIFACT]);
    const { result } = await drain(streamArtifactWithRetry(stream, baseMessages()));

    expect(result.reprompted).toBe(true);
    expect(result.artifact?.actions).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("gives up after exactly one reprompt (caller decides to throw)", async () => {
    const { stream, calls } = makeStream(["only prose", "still no artifact here"]);
    const { result } = await drain(streamArtifactWithRetry(stream, baseMessages()));

    expect(result.reprompted).toBe(true);
    expect(result.artifact).toBeNull();
    expect(calls).toHaveLength(2);
  });
});
