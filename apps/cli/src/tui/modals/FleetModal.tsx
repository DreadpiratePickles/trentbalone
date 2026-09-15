import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { P, categoryColor } from "../palette.js";
import type { AgentCategory } from "../../ui/theme.js";

interface FleetModalProps {
  activeAgents: string[];
  installedAgents: string[];
  totalCatalogCount: number;
  onDeploy: (agentId: string) => void;
  onClose: () => void;
}

/** Identity colour comes from the seat's category, never a per-seat literal. */
const FEATURED_AGENTS: Array<{ id: string; name: string; role: string; category: AgentCategory }> = [
  { id: "ceo", name: "CEO Agent", role: "Chief Executive & Strategy", category: "product" },
  { id: "engineer", name: "Lead Engineer", role: "Full-Stack System Architect", category: "engineering" },
  { id: "growth", name: "Growth Hacker", role: "Traction & Acquisition", category: "marketing" },
  { id: "content", name: "Content Engine", role: "Copy & Publishing", category: "design" },
  { id: "support", name: "Support Lead", role: "Customer Operations", category: "support" },
  { id: "analyst", name: "Data Analyst", role: "Quantitative Insights", category: "finance" },
  { id: "finance", name: "Finance Controller", role: "Burn & Budget Caps", category: "finance" },
];

export const FleetModal: React.FC<FleetModalProps> = ({
  activeAgents,
  installedAgents,
  totalCatalogCount,
  onDeploy,
  onClose,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : FEATURED_AGENTS.length - 1));
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (prev < FEATURED_AGENTS.length - 1 ? prev + 1 : 0));
    }
    if (key.return) {
      const selected = FEATURED_AGENTS[selectedIndex];
      onDeploy(selected.id);
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={P.accent}
      padding={1}
      width={68}
      backgroundColor={P.surface}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={P.accent}>
          FLEET MANAGEMENT ({totalCatalogCount} Specialists)
        </Text>
        <Text color={P.muted}>[Esc to close]</Text>
      </Box>

      {FEATURED_AGENTS.map((agent, idx) => {
        const isSelected = idx === selectedIndex;
        const isActive = activeAgents.includes(agent.id);
        const isInstalled = installedAgents.includes(agent.id);

        return (
          <Box key={agent.id} marginY={0} justifyContent="space-between">
            <Box>
              <Text color={isSelected ? P.info : P.dim}>
                {isSelected ? "❯ " : "  "}
              </Text>
              <Text color={categoryColor(agent.category)} bold>
                {agent.name.padEnd(18, " ")}
              </Text>
              <Text color={P.muted}>{agent.role}</Text>
            </Box>
            <Box>
              {isActive ? (
                <Text color={P.accent}>● active</Text>
              ) : isInstalled ? (
                <Text color={P.dim}>· idle</Text>
              ) : (
                <Text color={P.dim}>○ available</Text>
              )}
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1} borderStyle="single" borderColor={P.border} paddingTop={0}>
        <Text dimColor color={P.muted}>
          Press [Enter] to deploy agent to active duty.
        </Text>
      </Box>
    </Box>
  );
};
