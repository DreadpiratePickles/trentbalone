import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
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
      borderColor="#10B981"
      padding={1}
      width={72}
      backgroundColor="#1A1D27"
    >
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color="#10B981">
          ⚕ TRENT DOCTOR — SYSTEM DIAGNOSTICS
        </Text>
        <Text color="#9CA3AF">[Esc to close]</Text>
      </Box>

      {report.results.slice(0, 8).map((res) => {
        let icon = <Text color="#10B981">✓ </Text>;
        if (res.status === "warn") icon = <Text color="#F59E0B">⚠ </Text>;
        if (res.status === "error") icon = <Text color="#EF4444">✗ </Text>;

        return (
          <Box key={res.name} marginY={0}>
            {icon}
            <Text bold color="white">
              {res.category.padEnd(14, " ")}
            </Text>
            <Text color="#9CA3AF" wrap="truncate">
              {res.message}
            </Text>
          </Box>
        );
      })}

      <Box marginTop={1} justifyContent="space-between" borderStyle="single" borderColor="#2D3139" paddingTop={0}>
        <Text color={report.errors > 0 ? "#EF4444" : "#10B981"} bold>
          {report.passed}/{report.total} Passed · {report.warnings} Warnings · {report.errors} Errors
        </Text>
        <Text color="#8B5CF6">[f] Auto-Fix Issues</Text>
      </Box>
    </Box>
  );
};
