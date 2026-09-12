import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface ToolsModalProps {
  toolsets: string[];
  disabledToolsets: string[];
  onToggle: (tool: string) => void;
  onClose: () => void;
}

const ALL_TOOLSETS = [
  { id: "file_ops", label: "File Operations", desc: "Read, write, edit, and search workspace files" },
  { id: "terminal", label: "Sandboxed Terminal", desc: "Execute bash commands in Docker/Local PTY" },
  { id: "browser", label: "Headless Browser", desc: "Web scraping, DOM inspection, automation" },
  { id: "git", label: "Git VCS Operations", desc: "Branches, commits, diff inspection, PR creation" },
  { id: "search", label: "Web Search Gateway", desc: "Real-time web queries and citations" },
  { id: "mcp", label: "MCP Connectors", desc: "Model Context Protocol tool execution" },
  { id: "voice", label: "Whisper Voice Mode", desc: "Local push-to-talk speech transcription" },
  { id: "cron", label: "Scheduled Autonomy", desc: "Recurring background sweep triggers" },
];

export const ToolsModal: React.FC<ToolsModalProps> = ({
  toolsets,
  disabledToolsets,
  onToggle,
  onClose,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : ALL_TOOLSETS.length - 1));
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev < ALL_TOOLSETS.length - 1 ? prev + 1 : 0));
    }
    if (key.return || input === " ") {
      const selected = ALL_TOOLSETS[selectedIndex];
      onToggle(selected.id);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#06B6D4"
      padding={1}
      width={70}
      backgroundColor="#1A1D27"
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="#06B6D4">
          🔧 TOOLSET CAPABILITY POLICIES
        </Text>
        <Text color="#9CA3AF">[Esc to close]</Text>
      </Box>

      {ALL_TOOLSETS.map((t, idx) => {
        const isSelected = idx === selectedIndex;
        const isEnabled = toolsets.includes(t.id) && !disabledToolsets.includes(t.id);

        return (
          <Box key={t.id} marginY={0} justifyContent="space-between">
            <Box>
              <Text color={isSelected ? "#06B6D4" : "gray"}>
                {isSelected ? "❯ " : "  "}
              </Text>
              <Text color={isEnabled ? "#10B981" : "#EF4444"}>
                {isEnabled ? "[✓] " : "[ ] "}
              </Text>
              <Text bold color={isSelected ? "white" : "#E4E6EB"}>
                {t.label.padEnd(20, " ")}
              </Text>
              <Text color="#9CA3AF">{t.desc}</Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1} borderStyle="single" borderColor="#2D3139" paddingTop={0}>
        <Text dimColor color="#9CA3AF">
          Press [Space] or [Enter] to toggle capability on/off.
        </Text>
      </Box>
    </Box>
  );
};
