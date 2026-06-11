"use client";

import React, { type CSSProperties } from "react";
import type { AppSoloRunSummary } from "@/lib/app-solo";
import { buildAppSoloProductReview } from "@/lib/app-solo-product-review";

export function AppSoloRunSummaryPanel({ summary }: { summary: AppSoloRunSummary }) {
  const productReview = buildAppSoloProductReview({
    evidenceSummary: {
      status: verificationStatus(summary),
      passCount: summary.verification?.passCount ?? 0,
      failCount: summary.verification?.failCount ?? 0,
      skipCount: summary.verification?.skipCount ?? 0,
      failedChecks: summary.verification?.failedChecks ?? [],
      fileCount: summary.fileCount,
      screenshotCount: summary.previewUrl ? 1 : 0,
      artifactCount: summary.fileCount,
      commandCount: summary.commandCount,
      failedCommandCount: 0,
      previewCaptured: Boolean(summary.previewUrl),
      previewUrl: summary.previewUrl,
    },
  });

  return (
    <div style={styles.runSummaryPanel} aria-label="App Solo run summary">
      <div style={styles.contractTitle}>run summary</div>
      <div style={styles.summaryGrid}>
        <span style={styles.summaryMetric}>{summary.status}</span>
        <span style={styles.summaryMetric}>{formatCount(summary.fileCount, "file")}</span>
        <span style={styles.summaryMetric}>{formatCount(summary.commandCount, "command")}</span>
        <span style={styles.summaryMetric}>{summary.previewUrl ? "preview captured" : "no preview"}</span>
      </div>
      {summary.verification && (
        <div style={styles.summaryLine}>
          {summary.verification.passCount} pass / {summary.verification.failCount} failed / {summary.verification.skipCount} skipped
        </div>
      )}
      {summary.verification?.failedChecks.length ? (
        <div style={styles.summaryLine}>failed: {summary.verification.failedChecks.join(", ")}</div>
      ) : null}
      {summary.files?.length ? (
        <div style={styles.summaryLine}>artifacts: {formatFiles(summary.files)}</div>
      ) : null}
      {summary.commands?.length ? (
        <div style={styles.summaryLine}>commands: {formatCommands(summary.commands)}</div>
      ) : null}
      <div style={styles.readinessPanel}>
        <div style={styles.contractTitle}>product readiness</div>
        <div style={styles.summaryGrid}>
          <span style={styles.summaryMetric}>{productReview.status}</span>
          <span style={styles.summaryMetric}>verification {productReview.reviewSignals.verification}</span>
          <span style={styles.summaryMetric}>preview {productReview.reviewSignals.preview}</span>
          <span style={styles.summaryMetric}>artifacts {productReview.reviewSignals.artifacts}</span>
        </div>
        {productReview.guidance.length > 0 ? (
          <div style={styles.summaryLine}>guidance: {formatGuidance(productReview.guidance)}</div>
        ) : null}
      </div>
      {summary.error ? <div style={styles.errorText}>{summary.error}</div> : null}
    </div>
  );
}

function verificationStatus(summary: AppSoloRunSummary) {
  if (!summary.verification) return "missing";
  return summary.verification.passed && summary.verification.failCount === 0 ? "passing" : "failing";
}

function formatGuidance(guidance: Array<Record<string, unknown>>): string {
  return guidance.map((item) => {
    const type = typeof item.type === "string" ? item.type : "guidance";
    const checks = Array.isArray(item.checks) ? ` ${item.checks.join(", ")}` : "";
    const count = typeof item.count === "number" ? ` ${item.count}` : "";
    return `${type}${checks}${count}`;
  }).join(", ");
}

function formatFiles(files: NonNullable<AppSoloRunSummary["files"]>): string {
  return files.map((file) => file.path).join(", ");
}

function formatCommands(commands: NonNullable<AppSoloRunSummary["commands"]>): string {
  return commands.map((command) => `${command.command} exit ${command.exitCode}`).join(", ");
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

const styles: Record<string, CSSProperties> = {
  runSummaryPanel: { display: "grid", gap: 7, marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,.06)" },
  readinessPanel: { display: "grid", gap: 7, marginTop: 2, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,.05)" },
  contractTitle: { fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--pulse)" },
  summaryGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 },
  summaryMetric: { minHeight: 24, display: "flex", alignItems: "center", padding: "0 7px", background: "rgba(255,255,255,.035)", color: "var(--bone)", fontFamily: "var(--mono)", fontSize: 10, textTransform: "uppercase", overflowWrap: "anywhere" },
  summaryLine: { color: "var(--mist)", fontSize: 12, lineHeight: 1.4, overflowWrap: "anywhere" },
  errorText: { marginTop: 10, color: "#FCA5A5", fontSize: 12, lineHeight: 1.45 },
};
