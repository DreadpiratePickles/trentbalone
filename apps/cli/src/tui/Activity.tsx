import React from "react";
import { Box, Text } from "ink";
import type { ApprovalRequest } from "@trent/core";
import type { TuiActivityItem } from "./types.js";

export interface ActivityProps {
  activities: TuiActivityItem[];
  approvals: ApprovalRequest[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}

export const Activity: React.FC<ActivityProps> = ({
  activities,
  approvals,
  onApprove,
  onDeny,
}) => {
  return (
    <Box
      flexDirection="column"
      width={32}
      borderStyle="single"
      borderColor="#2D3139"
      paddingX={1}
    >
      {/* Approvals Section */}
      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={0}>
          <Text bold color={approvals.length > 0 ? "#EF4444" : "#9CA3AF"}>
            ⚠ APPROVAL QUEUE ({approvals.length})
          </Text>
        </Box>
        {approvals.length === 0 ? (
          <Text dimColor color="#6B7280">0 actions pending review</Text>
        ) : (
          approvals.slice(0, 3).map((req) => (
            <Box
              key={req.id}
              flexDirection="column"
              borderStyle="single"
              borderColor="#EF4444"
              paddingX={1}
              marginY={0}
            >
              <Text bold color="#F59E0B">
                {req.action}
              </Text>
              <Text dimColor color="#9CA3AF">Agent: {req.agentId}</Text>
              <Box marginTop={0}>
                <Text color="#10B981">[y] Approve </Text>
                <Text color="#EF4444">[n] Deny</Text>
              </Box>
            </Box>
          ))
        )}
      </Box>

      {/* Real-time Activity Feed */}
      <Box flexDirection="column" flexGrow={1}>
        <Box marginBottom={0}>
          <Text bold color="#06B6D4">
            ⚡ AGENT ACTIVITY
          </Text>
        </Box>
        {activities.length === 0 ? (
          <Text dimColor color="#6B7280">Agents standing by.</Text>
        ) : (
          activities.slice(0, 6).map((act) => (
            <Box key={act.id} flexDirection="column" marginY={0}>
              <Box>
                <Text bold color="#06B6D4">[{act.agent}] </Text>
                <Text color="#E4E6EB">{act.action.slice(0, 22)}</Text>
              </Box>
              <Text dimColor color="#6B7280">
                {act.timestamp.slice(11, 19)}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
};
