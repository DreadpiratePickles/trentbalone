import React from "react";
import { Box, Text } from "ink";
import { P } from "./palette.js";
import type { FleetStatusReport } from "@trent/core";
import { formatCents } from "../repl/budget.js";

export interface SidebarProps {
  fleet: FleetStatusReport;
  /** Integer cents. Formatted here, at the edge, and nowhere earlier. */
  budgetSpentCents: number;
  budgetCapCents: number;
  budgetWarning?: boolean;
  toolsCount: number;
  skillsCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  fleet,
  budgetSpentCents,
  budgetCapCents,
  budgetWarning = false,
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
      borderColor={P.border}
      paddingX={1}
    >
      <Box marginBottom={1}>
        <Text bold color={P.accent}>
          FLEET STATUS
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {activeAgents.map((a) => (
          <Box key={a.id}>
            <Text color={P.accent}>● </Text>
            <Text bold color="white">{a.name} </Text>
            <Text color={P.muted}>({a.id})</Text>
          </Box>
        ))}
        {idleAgents.map((a) => (
          <Box key={a.id}>
            <Text color={P.dim}>· </Text>
            <Text color={P.muted}>{a.name} </Text>
            <Text dimColor color={P.dim}>[idle]</Text>
          </Box>
        ))}
        {activeAgents.length === 0 && idleAgents.length === 0 && (
          <Text dimColor color={P.dim}>No agents active</Text>
        )}
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor={P.border} paddingX={1} marginY={1}>
        <Text color={P.muted}>DAILY BUDGET</Text>
        <Text bold color={budgetWarning ? P.needsApproval : P.accent}>
          {formatCents(budgetSpentCents)} / {formatCents(budgetCapCents)}
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text color={P.muted}>Tools: <Text color="white">{toolsCount} active</Text></Text>
        <Text color={P.muted}>Skills: <Text color="white">{skillsCount} loaded</Text></Text>
        <Text color={P.muted}>Catalog: <Text color={P.accent}>{fleet.totalCatalog} specialists</Text></Text>
      </Box>
    </Box>
  );
};
