import { useState } from "react";
import { SessionManager, type SessionData } from "@trent/core";

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

  const appendAgentMessage = (agent: string, text: string, cost = 0.04, durationMs = 350) => {
    const msg = sessionManager.appendMessage(session.id, {
      role: "assistant",
      agent,
      content: text,
      metadata: { cost, durationMs },
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
