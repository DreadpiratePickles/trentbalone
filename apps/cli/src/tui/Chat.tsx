import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { P } from "./palette.js";
import type { SessionData, SessionMessageMetadata } from "@trent/core";
import { formatCents } from "../repl/budget.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js"; // [C13]

export interface ChatProps {
  session: SessionData;
  onSendMessage: (text: string) => void;
  isActive?: boolean;
  /** [C13] The answer the model is writing now (`streamedAnswer`), drawn after the messages until it lands as one. */
  streaming?: string; // [C13]
}

/**
 * [C13] The live text a pane keeps over a run's frames: a `step_delta` appends its text, and any other frame ends
 * it, because the model call it belonged to is over; the answer itself lands as a message (`events.ts`, `run_done`).
 */
export function streamedAnswer(current: string, event: OrcEvent): string {
  return event.kind === "step_delta" ? current + (event.detail ?? "") : "";
}

/**
 * Only what the orchestrator reported. A message with no cost shows no cost; a message
 * with no duration shows no duration. Nothing is estimated for display.
 */
function describeMetadata(metadata: SessionMessageMetadata): string {
  const parts: string[] = [];
  const duration = metadata.duration_ms ?? metadata.durationMs;
  if (duration !== undefined) parts.push(`${Math.round(duration / 1000)}s`);
  if (metadata.cost_cents !== undefined) parts.push(formatCents(metadata.cost_cents));
  return parts.join(" | ");
}

export const Chat: React.FC<ChatProps> = ({ session, onSendMessage, isActive = true, streaming = "" }) => { // [C13] streaming
  const [input, setInput] = useState("");

  useInput(
    (char, key) => {
      if (!isActive) return;

      if (key.return) {
        if (input.trim()) {
          onSendMessage(input.trim());
          setInput("");
        }
      } else if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
      } else if (!key.ctrl && !key.meta && char) {
        setInput((prev) => prev + char);
      }
    },
    { isActive }
  );

  const displayMessages = session.messages.slice(-6);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="single"
      borderColor={P.border}
      paddingX={1}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={P.accent}>
          FLEET WORKSPACE [{session.agent}]
        </Text>
        <Text color={P.muted}>{session.messages.length} messages</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginBottom={1}>
        {displayMessages.length === 0 && streaming === "" ? ( // [C13] not while an answer streams
          <Box marginY={2} justifyContent="center">
            <Text dimColor color={P.dim}>
              Fleet session initialized. Type below and press [Enter] to dispatch.
            </Text>
          </Box>
        ) : (
          displayMessages.map((m) => {
            const isUser = m.role === "user";
            const meta = m.metadata ? describeMetadata(m.metadata) : "";
            return (
              <Box key={m.id} flexDirection="column" marginY={0}>
                <Box>
                  <Text bold color={isUser ? P.info : P.accent}>
                    {isUser ? "You: " : `[${m.agent || "CEO"}]: `}
                  </Text>
                  <Text color={isUser ? "white" : P.text}>{m.content}</Text>
                </Box>
                {meta !== "" && (
                  <Box marginLeft={2}>
                    <Text dimColor color={P.muted}>{meta}</Text>
                  </Box>
                )}
              </Box>
            );
          })
        )}
        {streaming !== "" && ( // [C13] the answer as it is written
          <Box>
            <Text bold color={P.accent}>{`[${session.agent}]: `}</Text>
            <Text color={P.text}>{streaming}</Text>
          </Box>
        )}
      </Box>

      {/* Input Line */}
      <Box
        borderStyle="single"
        borderColor={isActive ? P.accent : P.border}
        paddingX={1}
      >
        <Text color={P.accent}>❯ </Text>
        <Text color="white">{input}</Text>
        <Text color={P.accent}>█</Text>
      </Box>
    </Box>
  );
};
