"use client";

import type { JobRun } from "@/lib/types";
import { I, Pill, Spinner } from "@/components/ui";

type Props = {
  job?: JobRun | null;
  notice?: string;
  error?: string;
  onRefresh: () => void;
  onOpenQueue: () => void;
};

export function CycleJobStatusCard({ job, notice, error, onRefresh, onOpenQueue }: Props) {
  if (!job && !notice && !error) return null;

  const tone = error || job?.status === "failed" ? "ember" : job?.status === "completed" ? "pulse" : "neutral";
  const title = error
    ? "Cycle failed"
    : job?.status === "completed"
    ? "Cycle completed"
    : job?.status === "cancelled"
    ? "Cycle cancelled"
    : "Cycle job queued";
  const summary = error ?? notice ?? job?.summary ?? "Waiting for a worker or manual processor.";

  return (
    <div
      style={{
        border: tone === "ember" ? "1px solid rgba(251,146,60,.28)" : "1px solid rgba(110,231,183,.18)",
        background: tone === "ember" ? "rgba(251,146,60,.06)" : "rgba(110,231,183,.04)",
        borderRadius: 14,
        padding: "14px 16px",
        marginBottom: 20,
        display: "flex",
        alignItems: "center",
        gap: 14,
      }}
    >
      <div style={{ color: tone === "ember" ? "var(--ember)" : "var(--pulse)", flexShrink: 0 }}>
        {job?.status === "running" ? <Spinner /> : job?.status === "completed" ? <I.check /> : <I.cycle />}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
          <strong style={{ color: "var(--bone)", fontSize: 14 }}>{title}</strong>
          {job && <Pill tone={tone === "ember" ? "ember" : "pulse"}>{job.status}</Pill>}
          {job?.type && <span className="mono" style={{ fontSize: 9, color: "var(--haze)" }}>{job.type}</span>}
        </div>
        <div style={{ color: "var(--mist)", fontSize: 12, lineHeight: 1.5 }}>
          {summary}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button className="btn btn-secondary btn-mono" style={{ height: 32, padding: "0 10px", fontSize: 10 }} onClick={onRefresh}>
          <I.refresh width={12} height={12} />
          refresh
        </button>
        <button className="btn btn-secondary btn-mono" style={{ height: 32, padding: "0 10px", fontSize: 10 }} onClick={onOpenQueue}>
          queue
        </button>
      </div>
    </div>
  );
}
