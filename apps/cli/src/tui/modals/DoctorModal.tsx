import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { P } from "../palette.js";
import type { CheckResult, DoctorReport } from "@trent/core";

interface DoctorModalProps {
  report: DoctorReport;
  onFix: () => void;
  onClose: () => void;
}

export const DoctorModal: React.FC<DoctorModalProps> = ({
  report,
  onFix,
  onClose,
}) => {
  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (input === "f") {
      onFix();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={P.accent}
      padding={1}
      width={72}
      backgroundColor={P.surface}
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={P.accent}>
          TRENT DOCTOR — SYSTEM DIAGNOSTICS
        </Text>
        <Text color={P.muted}>[Esc to close]</Text>
      </Box>

      {report.results.slice(0, 8).map((res) => {
        let icon = <Text color={P.accent}>✓ </Text>;
        if (res.status === "warn") icon = <Text color={P.needsApproval}>◆ </Text>;
        if (res.status === "error") icon = <Text color={P.danger}>✗ </Text>;

        return (
          <Box key={res.name} marginY={0}>
            {icon}
            <Text bold color="white">
              {res.category.padEnd(14, " ")}
            </Text>
            <Text color={P.muted} wrap="truncate">
              {res.message}
            </Text>
          </Box>
        );
      })}

      <Box marginTop={1} justifyContent="space-between" borderStyle="single" borderColor={P.border} paddingTop={0}>
        <Text color={report.errors > 0 ? P.danger : P.accent} bold>
          {report.passed}/{report.total} Passed · {report.warnings} Warnings · {report.errors} Errors
        </Text>
        <Text color={P.accent}>[f] Auto-Fix Issues</Text>
      </Box>
    </Box>
  );
};
