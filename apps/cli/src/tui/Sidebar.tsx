import React from "react";
import { Box, Text } from "ink";
import type { FleetStatusReport } from "@trent/core";

export interface SidebarProps {
  fleet: FleetStatusReport;
  budgetSpent: number;
  budgetCap: number;
  toolsCount: number;
  skillsCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  fleet,
  budgetSpent,
  budgetCap,
  toolsCount,
  skillsCount,
}) => {
  const activeAgents = fleet.agents.filter((a) => a.active);
  const idleAgents = fleet.agents.filter((a) => a.installed && !a.active);

  return (
    <Box
      flexDirection="column"
      width={28}
      borderStyle="single"
      borderColor="#2D3139"
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text bold color="#8B5CF6">
          ⚡ FLEET STATUS
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {activeAgents.map((a) => (
          <Box key={a.id}>
            <Text color="#10B981">● </Text>
            <Text bold color="white">{a.name} </Text>
            <Text color="#9CA3AF">({a.id})</Text>
          </Box>
        ))}
        {idleAgents.map((a) => (
          <Box key={a.id}>
            <Text color="#F59E0B">● </Text>
            <Text color="#9CA3AF">{a.name} </Text>
            <Text dimColor color="#6B7280">[idle]</Text>
          </Box>
        ))}
        {activeAgents.length === 0 && idleAgents.length === 0 && (
          <Text dimColor color="#6B7280">No agents active</Text>
        )}
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor="#2D3139" paddingX={1} marginY={1}>
        <Text color="#9CA3AF">DAILY BUDGET</Text>
        <Text bold color="#10B981">
          ${budgetSpent.toFixed(2)} / ${budgetCap.toFixed(2)}
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color="#9CA3AF">Tools: <Text color="white">{toolsCount} active</Text></Text>
        <Text color="#9CA3AF">Skills: <Text color="white">{skillsCount} loaded</Text></Text>
        <Text color="#9CA3AF">Catalog: <Text color="#8B5CF6">164 specialists</Text></Text>
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor="#2D3139" paddingX={1}>
        <Text dimColor color="#6B7280">Self-Improvement:</Text>
        <Text color="#10B981">GEPA: +0.03 <Text color="#9CA3AF">· 2 distilled</Text></Text>
      </Box>
    </Box>
  );
};
