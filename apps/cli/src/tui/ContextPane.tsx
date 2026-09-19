import React from "react";
import { Box, Text } from "ink";
import { P } from "./palette.js";
import { contextReportLines, type ContextReport } from "../repl/context-report.js";

/**
 * What the wrapper injected into the last seat call, on screen.
 *
 * The figures are the fleet-memory hook's own measurement of the assembly it performed
 * (`fleet-memory/tiers.ts`), reached through `hook.contextFor(runId, seat)` — the same numbers
 * `/context` prints in the classic REPL, from the same function, so the two surfaces cannot
 * disagree. Nothing here counts characters or estimates tokens on its own.
 */
export function contextPaneLines(report: ContextReport): string[] {
  return contextReportLines(report);
}

export interface ContextPaneProps {
  report: ContextReport;
}

export const ContextPane: React.FC<ContextPaneProps> = ({ report }) => {
  const lines = contextPaneLines(report);
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={P.border} paddingX={1}>
      <Text bold color={P.muted}>
        CONTEXT
      </Text>
      {lines.map((line) => (
        <Text key={line} color={P.dim}>
          {line}
        </Text>
      ))}
    </Box>
  );
};
