import React from "react";
import { Box, Text, useInput } from "ink";
import { P } from "../palette.js";

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
      borderColor={P.accent}
      padding={1}
      width={64}
      backgroundColor={P.surface}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={P.accent}>
          TUI KEYBOARD SHORTCUTS
        </Text>
        <Text color={P.muted}>[Esc to close]</Text>
      </Box>

      <Box marginY={0}>
        <Text bold color={P.info}>m          </Text>
        <Text color="white">Switch Model & Provider</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color={P.info}>f          </Text>
        <Text color="white">Open Fleet Specialist Manager</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color={P.info}>t          </Text>
        <Text color="white">Toggle Toolsets & Capabilities</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color={P.info}>d          </Text>
        <Text color="white">Run System Diagnostics (Doctor)</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color={P.info}>?          </Text>
        <Text color="white">Show this help overlay</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color={P.info}>Ctrl+C     </Text>
        <Text color="white">Interrupt active agent reasoning</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color={P.info}>Ctrl+B     </Text>
        <Text color="white">Toggle push-to-talk voice recording</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color={P.info}>Alt+Enter  </Text>
        <Text color="white">Insert multi-line newline in chat input</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color={P.info}>/          </Text>
        <Text color="white">Trigger slash command autocomplete</Text>
      </Box>
      <Box marginY={0}>
        <Text bold color={P.info}>q          </Text>
        <Text color="white">Quit session</Text>
      </Box>
    </Box>
  );
};
