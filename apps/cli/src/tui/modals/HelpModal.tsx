import React from "react";
import { Box, Text, useInput } from "ink";

interface HelpModalProps {
  onClose: () => void;
}

export const HelpModal: React.FC<HelpModalProps> = ({ onClose }) => {
  useInput((_input, key) => {
    if (key.escape || key.return) {
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#8B5CF6"
      padding={1}
      width={64}
      backgroundColor="#1A1D27"
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="#8B5CF6">
          ⌨️ TUI KEYBOARD SHORTCUTS
        </Text>
        <Text color="#9CA3AF">[Esc to close]</Text>
      </Box>

      <Box marginY={0}>
        <Text bold color="#06B6D4">m          </Text>
        <Text color="white">Switch Model & Provider</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color="#06B6D4">f          </Text>
        <Text color="white">Open Fleet Specialist Manager</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color="#06B6D4">t          </Text>
        <Text color="white">Toggle Toolsets & Capabilities</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color="#06B6D4">d          </Text>
        <Text color="white">Run System Diagnostics (Doctor)</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color="#06B6D4">?          </Text>
        <Text color="white">Show this help overlay</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color="#06B6D4">Ctrl+C     </Text>
        <Text color="white">Interrupt active agent reasoning</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color="#06B6D4">Ctrl+B     </Text>
        <Text color="white">Toggle push-to-talk voice recording</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color="#06B6D4">Alt+Enter  </Text>
        <Text color="white">Insert multi-line newline in chat input</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color="#06B6D4">/          </Text>
        <Text color="white">Trigger slash command autocomplete</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color="#06B6D4">q          </Text>
        <Text color="white">Quit session</Text>
      </Box>
    </Box>
  );
};
