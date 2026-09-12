import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface ModelModalProps {
  currentProvider: string;
  currentModel: string;
  onSelect: (provider: string, model: string) => void;
  onClose: () => void;
}

const PROVIDERS = [
  { provider: "openai", model: "gpt-5.6-terra", name: "OpenAI (GPT-5.6-terra)" },
  { provider: "anthropic", model: "claude-3-7-sonnet", name: "Anthropic (Claude 3.7 Sonnet)" },
  { provider: "google", model: "gemini-2.5-pro", name: "Google Gemini (2.5 Pro)" },
  { provider: "deepseek", model: "deepseek-reasoner", name: "DeepSeek (R1 Reasoner)" },
  { provider: "groq", model: "llama-3.3-70b", name: "Groq LPU (Llama 3.3 70B)" },
  { provider: "ollama", model: "llama3:latest", name: "Ollama Local (llama3)" },
];

export const ModelModal: React.FC<ModelModalProps> = ({
  currentProvider,
  currentModel,
  onSelect,
  onClose,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : PROVIDERS.length - 1));
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev < PROVIDERS.length - 1 ? prev + 1 : 0));
    }
    if (key.return) {
      const selected = PROVIDERS[selectedIndex];
      onSelect(selected.provider, selected.model);
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#8B5CF6"
      padding={1}
      width={60}
      backgroundColor="#1A1D27"
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="#8B5CF6">
          🤖 SWITCH MODEL & PROVIDER
        </Text>
        <Text color="#9CA3AF">[Esc to close]</Text>
      </Box>

      {PROVIDERS.map((p, idx) => {
        const isSelected = idx === selectedIndex;
        const isCurrent = p.provider === currentProvider && p.model === currentModel;
        return (
          <Box key={p.provider} marginY={0}>
            <Text color={isSelected ? "#06B6D4" : "gray"}>
              {isSelected ? "❯ " : "  "}
            </Text>
            <Text color={isSelected ? "#06B6D4" : "white"} bold={isSelected}>
              {p.name}
            </Text>
            {isCurrent && <Text color="#10B981"> (active)</Text>}
          </Box>
        );
      })}

      <Box marginTop={1} borderStyle="single" borderColor="#2D3139" paddingTop={0}>
        <Text dimColor color="#9CA3AF">
          Use ↑/↓ arrows to navigate, [Enter] to select.
        </Text>
      </Box>
    </Box>
  );
};
