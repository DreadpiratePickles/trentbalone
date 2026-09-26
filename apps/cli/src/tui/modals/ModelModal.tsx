import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Provider } from "@trent/core/config/schema.js";
import { DEFAULT_MODELS } from "@trent/core/setup/detect.js";
import { P } from "../palette.js";

interface ModelModalProps {
  currentProvider: string;
  currentModel: string;
  onSelect: (provider: string, model: string) => void;
  onClose: () => void;
}

/**
 * What this modal may offer is not a free choice: every entry must be a provider `ProviderSchema`
 * accepts AND one the gateway can route, and its model must match what the setup wizard would
 * write (`setup/detect.ts` DEFAULT_MODELS) so the two surfaces cannot disagree. The audit found
 * this list offering three providers that reached no model at all. `__tests__/model-modal.test.ts`
 * fails if an entry drifts.
 */
export const MODEL_MODAL_PROVIDERS: ReadonlyArray<{ provider: Provider; model: string; name: string }> = [
  { provider: "openai", model: DEFAULT_MODELS.openai, name: "OpenAI (GPT-5.6-terra)" },
  { provider: "anthropic", model: DEFAULT_MODELS.anthropic, name: "Anthropic (Claude Sonnet 4.6)" },
  { provider: "google", model: DEFAULT_MODELS.google, name: "Google Gemini (2.5 Pro)" },
  { provider: "mistral", model: DEFAULT_MODELS.mistral, name: "Mistral (Large)" },
  { provider: "openrouter", model: DEFAULT_MODELS.openrouter, name: "OpenRouter (auto)" },
  { provider: "deepseek", model: DEFAULT_MODELS.deepseek, name: "DeepSeek (Chat)" },
  { provider: "groq", model: DEFAULT_MODELS.groq, name: "Groq LPU (Llama 3.3 70B)" },
  { provider: "ollama", model: DEFAULT_MODELS.ollama, name: "Ollama, local (Qwen3.5 9B)" },
  { provider: "lmstudio", model: DEFAULT_MODELS.lmstudio, name: "LM Studio, local" },
];

const PROVIDERS = MODEL_MODAL_PROVIDERS;

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
      borderColor={P.accent}
      padding={1}
      width={60}
      backgroundColor={P.surface}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={P.accent}>
          SWITCH MODEL & PROVIDER
        </Text>
        <Text color={P.muted}>[Esc to close]</Text>
      </Box>

      {PROVIDERS.map((p, idx) => {
        const isSelected = idx === selectedIndex;
        const isCurrent = p.provider === currentProvider && p.model === currentModel;
        return (
          <Box key={p.provider} marginY={0}>
            <Text color={isSelected ? P.info : P.dim}>
              {isSelected ? "❯ " : "  "}
            </Text>
            <Text color={isSelected ? P.info : "white"} bold={isSelected}>
              {p.name}
            </Text>
            {isCurrent && <Text color={P.accent}> (active)</Text>}
          </Box>
        );
      })}

      <Box marginTop={1} borderStyle="single" borderColor={P.border} paddingTop={0}>
        <Text dimColor color={P.muted}>
          Use ↑/↓ arrows to navigate, [Enter] to select.
        </Text>
      </Box>
    </Box>
  );
};
