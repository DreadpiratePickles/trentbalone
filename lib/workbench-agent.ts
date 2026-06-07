/**
 * workbench-agent.ts — Autonomous Build Intelligence
 *
 * Architecture (inspired by bolt.diy):
 *   build   → scaffold starter → stream <boltArtifact> XML → parse → execute actions
 *             in order (file writes → shell commands → start) → verify + self-heal
 *   research / design → single streamed pass (unchanged)
 *
 * Key improvements over the previous one-shot JSON approach:
 *   - GPT-4o (not mini) for real reasoning quality
 *   - XML artifact format: file contents never JSON-encoded → no truncation
 *   - Continuation loop: resumes on finish_reason=length (MAX_SEGMENTS = 2)
 *   - Golden starter template: agent edits a real app, not a blank folder
 *   - Holistic context: file tree + key file contents injected every turn
 *   - Completeness contract + design instructions in system prompt
 *   - Real token-cost metering (not fake per-step ticks)
 *   - Loud failure (no silent NOTES.md fallback)
 *   - AgentDeps.streamArtifact is injectable for offline testing
 */

import { store } from "@/lib/store";
import type { WorkbenchChatMessage, WorkbenchSession } from "@/lib/types";
import { persistWorkbenchMemoryLog } from "@/lib/run-memory-log";
import { runBuildLoop, runStreamingMode } from "@/lib/workbench-build-loop";
import { recordEvent } from "@/lib/workbench-build-helpers";
import { resolveDeps } from "@/lib/workbench-llm-client";
import type { AgentDeps, WorkbenchAgentChunk } from "@/lib/workbench-agent-types";

export type {
  AgentDeps,
  AgentPlanStep,
  ArtifactStreamToken,
  StreamInput,
  WorkbenchAgentChunk,
} from "@/lib/workbench-agent-types";

export async function* runWorkbenchAgent(input: {
  session:      WorkbenchSession;
  userMessage:  string;
  history?:     WorkbenchChatMessage[];
  deps?:        Partial<AgentDeps>;
}): AsyncGenerator<WorkbenchAgentChunk> {
  const session = {
    ...input.session,
    agentMode:    input.session.agentMode ?? "build",
    messageCount: input.session.messageCount ?? 0,
  };
  const history = input.history ?? [];
  const deps    = resolveDeps(session, input.deps);

  await store.addWorkbenchChatMessage({
    companyId: session.companyId, sessionId: session.id,
    role: "user", content: input.userMessage, agentMode: session.agentMode,
  });
  await store.updateWorkbenchSession(session.id, { status: "running" });

  let assistantText = "";
  try {
    let buildPassed = true;
    if (session.agentMode === "build") {
      const result = yield* runBuildLoop(session, input.userMessage, history, deps);
      assistantText = result.summary;
      buildPassed   = result.passed;
      if (result.paused) {
        const msg = await store.addWorkbenchChatMessage({
          companyId: session.companyId, sessionId: session.id,
          role: "assistant", content: assistantText || "Paused for approval.", agentMode: session.agentMode,
        });
        yield { type: "done", messageId: msg.id };
        return;
      }
    } else {
      assistantText = yield* runStreamingMode(session, input.userMessage, history, deps);
    }
    const msg = await store.addWorkbenchChatMessage({
      companyId: session.companyId, sessionId: session.id,
      role: "assistant", content: assistantText || "(no output)", agentMode: session.agentMode,
    });
    await store.updateWorkbenchSession(session.id, { status: buildPassed ? "completed" : "failed" });
    await persistWorkbenchMemoryLog(session.id, { finalSummary: assistantText }).catch((error: unknown) => {
      console.error("Failed to persist Workbench memory log:", error);
    });
    yield { type: "done", messageId: msg.id };
  } catch (err) {
    const text = err instanceof Error ? err.message : "Workbench agent failed.";
    await store.updateWorkbenchSession(session.id, { status: "failed" });
    await recordEvent(session, "system", "failed", "Agent run failed", text);
    yield { type: "error", message: text };
    const msg = await store.addWorkbenchChatMessage({
      companyId: session.companyId, sessionId: session.id,
      role: "assistant", content: `⚠️ ${text}`, agentMode: session.agentMode,
    });
    await persistWorkbenchMemoryLog(session.id, { finalSummary: `Agent run failed: ${text}` }).catch((error: unknown) => {
      console.error("Failed to persist failed Workbench memory log:", error);
    });
    yield { type: "done", messageId: msg.id };
  }
}
