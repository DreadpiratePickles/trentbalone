import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { P } from "./palette.js";
import type { SessionData, SessionMessageMetadata } from "@trent/core";
import { formatCents } from "../repl/budget.js";

export interface ChatProps {
  session: SessionData;
  onSendMessage: (text: string) => void;
  isActive?: boolean;
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

export const Chat: React.FC<ChatProps> = ({ session, onSendMessage, isActive = true }) => {
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
        {displayMessages.length === 0 ? (
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
