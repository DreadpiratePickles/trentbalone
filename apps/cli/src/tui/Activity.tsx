import React from "react";
import { Box, Text } from "ink";
import { P } from "./palette.js";
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
      borderColor={P.border}
      paddingX={1}
    >
      {/* Approvals Section */}
      <Box flexDirection="column" marginBottom={1}>
        <Box marginBottom={0}>
          <Text bold color={approvals.length > 0 ? P.danger : P.muted}>
            APPROVAL QUEUE ({approvals.length})
          </Text>
        </Box>
        {approvals.length === 0 ? (
          <Text dimColor color={P.dim}>0 actions pending review</Text>
        ) : (
          approvals.slice(0, 3).map((req) => (
            <Box
              key={req.id}
              flexDirection="column"
              borderStyle="single"
              borderColor={P.danger}
              paddingX={1}
              marginY={0}
            >
              <Text bold color={P.needsApproval}>
                {req.action}
              </Text>
              <Text dimColor color={P.muted}>Agent: {req.agentId}</Text>
              <Box marginTop={0}>
                <Text color={P.accent}>[y] Approve </Text>
                <Text color={P.danger}>[n] Deny</Text>
              </Box>
            </Box>
          ))
        )}
      </Box>

      {/* Real-time Activity Feed */}
      <Box flexDirection="column" flexGrow={1}>
        <Box marginBottom={0}>
          <Text bold color={P.info}>
            AGENT ACTIVITY
          </Text>
        </Box>
        {activities.length === 0 ? (
          <Text dimColor color={P.dim}>Agents standing by.</Text>
        ) : (
          activities.slice(0, 6).map((act) => (
            <Box key={act.id} flexDirection="column" marginY={0}>
              <Box>
                <Text bold color={P.info}>[{act.agent}] </Text>
                <Text color={P.text}>{act.action.slice(0, 22)}</Text>
              </Box>
              <Text dimColor color={P.dim}>
                {act.timestamp.slice(11, 19)}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
};
