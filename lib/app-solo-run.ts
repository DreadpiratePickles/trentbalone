import { buildAppSoloObjective, type AppSoloAgent, type AppSoloApp } from "@/lib/app-solo";
import { buildWorkbenchCreateRequestBody } from "@/lib/workbench-session-request";
import type { WorkbenchProvider, WorkbenchSession } from "@/lib/types";
import type { WorkbenchAgentChunk } from "@/lib/workbench-agent";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type AppSoloRunResult = {
  session: WorkbenchSession;
  chunks: WorkbenchAgentChunk[];
};

export async function launchAppSoloRun(input: {
  companyId: string;
  agent: AppSoloAgent;
  app: AppSoloApp;
  objective: string;
  provider?: Extract<WorkbenchProvider, "daytona" | "e2b" | "mock_local">;
  fetcher?: FetchLike;
  onSessionCreated?: (session: WorkbenchSession) => void;
  onChunk?: (chunk: WorkbenchAgentChunk) => void;
}): Promise<AppSoloRunResult> {
  const fetcher = input.fetcher ?? fetch;
  const objective = buildAppSoloObjective(input.agent, input.app, input.objective);
  const created = await fetcher("/api/workbench", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildWorkbenchCreateRequestBody({
      companyId: input.companyId,
      agentRole: input.agent.role,
      agentMode: input.agent.mode,
      objective,
      provider: input.provider,
      metadata: {
        appSolo: {
          agentRole: input.agent.role,
          agentLabel: input.agent.label,
          appId: input.app.id,
          appName: input.app.name,
        },
      },
    })),
  });

  const createData = await readJson(created);
  if (!created.ok) throw new Error(responseError(createData, "Could not launch app-solo session."));

  const session = asSession(createData?.session);
  if (!session) throw new Error("Workbench did not return a session for app-solo.");
  input.onSessionCreated?.(session);

  const streamResponse = await fetcher(`/api/workbench/${session.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: [
        objective,
        "",
        "Run this app-solo objective now. Stream every file, command, preview URL, verification result, and final error detail.",
      ].join("\n"),
    }),
  });
  if (!streamResponse.ok) {
    const errorData = await readJson(streamResponse);
    throw new Error(responseError(errorData, "App-solo worker failed to start."));
  }

  const chunks = await consumeWorkbenchStream(streamResponse, input.onChunk);
  const streamedError = chunks.find((chunk): chunk is Extract<WorkbenchAgentChunk, { type: "error" }> => chunk.type === "error");
  if (streamedError) throw new Error(streamedError.message);

  const refreshed = await fetcher(`/api/workbench/${session.id}`);
  if (!refreshed.ok) return { session, chunks };
  const refreshData = await readJson(refreshed);
  return { session: asSession(refreshData?.session) ?? session, chunks };
}

async function consumeWorkbenchStream(
  response: Response,
  onChunk?: (chunk: WorkbenchAgentChunk) => void,
): Promise<WorkbenchAgentChunk[]> {
  if (!response.body) throw new Error("App-solo worker returned no event stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: WorkbenchAgentChunk[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const chunk = parseSseBlock(block);
      if (!chunk) continue;
      chunks.push(chunk);
      onChunk?.(chunk);
      if (chunk.type === "done") return chunks;
    }
  }

  const finalChunk = parseSseBlock(buffer);
  if (finalChunk) {
    chunks.push(finalChunk);
    onChunk?.(finalChunk);
  }
  return chunks;
}

function parseSseBlock(block: string): WorkbenchAgentChunk | null {
  const payload = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as WorkbenchAgentChunk;
  } catch {
    return { type: "error", message: `Malformed app-solo event: ${payload.slice(0, 200)}` };
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text };
  }
}

function responseError(data: Record<string, unknown> | null, fallback: string): string {
  return typeof data?.error === "string" && data.error.trim() ? data.error : fallback;
}

function asSession(value: unknown): WorkbenchSession | null {
  if (!value || typeof value !== "object") return null;
  const maybe = value as Partial<WorkbenchSession>;
  return typeof maybe.id === "string" ? maybe as WorkbenchSession : null;
}
