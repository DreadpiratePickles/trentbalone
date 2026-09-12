import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionData } from "@trent/core";

export interface ChatProps {
  session: SessionData;
  onSendMessage: (text: string) => void;
  isActive?: boolean;
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
      borderColor="#2D3139"
      paddingX={1}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="#8B5CF6">
          💬 FLEET WORKSPACE [{session.agent}]
        </Text>
        <Text color="#9CA3AF">{session.messages.length} messages</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginBottom={1}>
        {displayMessages.length === 0 ? (
          <Box marginY={2} justifyContent="center">
            <Text dimColor color="#6B7280">
              Fleet session initialized. Type below and press [Enter] to dispatch.
            </Text>
          </Box>
        ) : (
          displayMessages.map((m) => {
            const isUser = m.role === "user";
            return (
              <Box key={m.id} flexDirection="column" marginY={0}>
                <Box>
                  <Text bold color={isUser ? "#06B6D4" : "#8B5CF6"}>
                    {isUser ? "You: " : `[${m.agent || "CEO"}]: `}
                  </Text>
                  <Text color={isUser ? "white" : "#E4E6EB"}>{m.content}</Text>
                </Box>
                {m.metadata?.cost !== undefined && (
                  <Box marginLeft={2}>
                    <Text dimColor color="#9CA3AF">
                      ⏱ {((m.metadata.durationMs || 0) / 1000).toFixed(1)}s · 💰 ${m.metadata.cost.toFixed(2)}
                    </Text>
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
        borderColor={isActive ? "#8B5CF6" : "#2D3139"}
        paddingX={1}
      >
        <Text color="#8B5CF6">❯ </Text>
        <Text color="white">{input}</Text>
        <Text color="#8B5CF6">█</Text>
      </Box>
    </Box>
  );
};
