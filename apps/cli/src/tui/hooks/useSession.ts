import { useState } from "react";
import { SessionManager, type SessionData } from "@trent/core";

/** What the orchestrator actually reported for a step. Absent means unknown, never a default. */
export interface AgentMessageMetadata {
  costCents?: number;
  durationMs?: number;
}

export function useSession(sessionManager: SessionManager) {
  const [session, setSession] = useState<SessionData>(() => {
    return (
      sessionManager.getCurrentSession() ||
      sessionManager.startSession("ceo", "gpt-5.6-terra", "openai")
    );
  });

  const appendUserMessage = (text: string) => {
    const msg = sessionManager.appendMessage(session.id, {
      role: "user",
      content: text,
    });
    setSession({ ...sessionManager.getSession(session.id)! });
    return msg;
  };

  const appendAgentMessage = (agent: string, text: string, metadata: AgentMessageMetadata = {}) => {
    const { costCents, durationMs } = metadata;
    const msg = sessionManager.appendMessage(session.id, {
      role: "assistant",
      agent,
      content: text,
      metadata: {
        ...(Number.isInteger(costCents) ? { cost_cents: costCents } : {}),
        ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      },
    });
    setSession({ ...sessionManager.getSession(session.id)! });
    return msg;
  };

  return {
    session,
    appendUserMessage,
    appendAgentMessage,
  };
}
