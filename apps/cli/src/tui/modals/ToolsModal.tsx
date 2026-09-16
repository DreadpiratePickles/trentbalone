import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { P } from "../palette.js";

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
      borderColor={P.info}
      padding={1}
      width={70}
      backgroundColor={P.surface}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={P.info}>
          TOOLSET CAPABILITY POLICIES
        </Text>
        <Text color={P.muted}>[Esc to close]</Text>
      </Box>

      {ALL_TOOLSETS.map((t, idx) => {
        const isSelected = idx === selectedIndex;
        const isEnabled = toolsets.includes(t.id) && !disabledToolsets.includes(t.id);

        return (
          <Box key={t.id} marginY={0} justifyContent="space-between">
            <Box>
              <Text color={isSelected ? P.info : P.dim}>
                {isSelected ? "❯ " : "  "}
              </Text>
              <Text color={isEnabled ? P.accent : P.danger}>
                {isEnabled ? "[✓] " : "[ ] "}
              </Text>
              <Text bold color={isSelected ? "white" : P.text}>
                {t.label.padEnd(20, " ")}
              </Text>
              <Text color={P.muted}>{t.desc}</Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1} borderStyle="single" borderColor={P.border} paddingTop={0}>
        <Text dimColor color={P.muted}>
          Press [Space] or [Enter] to toggle capability on/off.
        </Text>
      </Box>
    </Box>
  );
};
