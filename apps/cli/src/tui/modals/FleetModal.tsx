import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface FleetModalProps {
  activeAgents: string[];
  installedAgents: string[];
  totalCatalogCount: number;
  onDeploy: (agentId: string) => void;
  onClose: () => void;
}

const FEATURED_AGENTS = [
  { id: "ceo", name: "CEO Agent", role: "Chief Executive & Strategy", color: "#8B5CF6" },
  { id: "engineer", name: "Lead Engineer", role: "Full-Stack System Architect", color: "#06B6D4" },
  { id: "growth", name: "Growth Hacker", role: "Traction & Acquisition", color: "#10B981" },
  { id: "content", name: "Content Engine", role: "Copy & Publishing", color: "#F59E0B" },
  { id: "support", name: "Support Lead", role: "Customer Operations", color: "#3B82F6" },
  { id: "analyst", name: "Data Analyst", role: "Quantitative Insights", color: "#EC4899" },
  { id: "finance", name: "Finance Controller", role: "Burn & Budget Caps", color: "#EF4444" },
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
      borderColor="#8B5CF6"
      padding={1}
      width={68}
      backgroundColor="#1A1D27"
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="#8B5CF6">
          👥 FLEET MANAGEMENT ({totalCatalogCount} Specialists)
        </Text>
        <Text color="#9CA3AF">[Esc to close]</Text>
      </Box>

      {FEATURED_AGENTS.map((agent, idx) => {
        const isSelected = idx === selectedIndex;
        const isActive = activeAgents.includes(agent.id);
        const isInstalled = installedAgents.includes(agent.id);

        return (
          <Box key={agent.id} marginY={0} justifyContent="space-between">
            <Box>
              <Text color={isSelected ? "#06B6D4" : "gray"}>
                {isSelected ? "❯ " : "  "}
              </Text>
              <Text color={agent.color} bold>
                {agent.name.padEnd(18, " ")}
              </Text>
              <Text color="#9CA3AF">{agent.role}</Text>
            </Box>
            <Box>
              {isActive ? (
                <Text color="#10B981">● active</Text>
              ) : isInstalled ? (
                <Text color="#F59E0B">● idle</Text>
              ) : (
                <Text color="#6B7280">○ available</Text>
              )}
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1} borderStyle="single" borderColor="#2D3139" paddingTop={0}>
        <Text dimColor color="#9CA3AF">
          Press [Enter] to deploy agent to active duty.
        </Text>
      </Box>
    </Box>
  );
};
