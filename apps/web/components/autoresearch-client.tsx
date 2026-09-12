"use client";

import React, { useCallback, useMemo, useState } from "react";
import {
  FlaskConical,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Sparkles,
  Loader2,
} from "lucide-react";
import type { AutoresearchView } from "@/lib/self-improvement/autoresearch-read";
import type { IterationDecision, SelfImprovementIteration } from "@/lib/self-improvement/iteration-log";

type Props = {
  companyId: string;
  initial: AutoresearchView;
};

const DECISION_STYLE: Record<IterationDecision, { label: string; cls: string }> = {
  pending_approval: { label: "pending", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  promoted: { label: "promoted", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  rejected: { label: "rejected", cls: "bg-rose-500/15 text-rose-300 border-rose-500/30" },
  no_candidate: { label: "no candidate", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (Number.isNaN(mins)) return "";
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function DiffPreview({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-white/10 bg-black/40 p-3 text-xs leading-relaxed font-mono">
      {lines.map((line, i) => {
        let cls = "text-zinc-300";
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-emerald-300 bg-emerald-500/10";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-rose-300 bg-rose-500/10";
        else if (line.startsWith("@@")) cls = "text-sky-300";
        return (
          <div key={i} className={`whitespace-pre-wrap ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function PendingItem({
  item,
  companyId,
  onResolved,
}: {
  item: AutoresearchView["pending"][number];
  companyId: string;
  onResolved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const [error, setError] = useState<string | null>(null);

  const act = useCallback(
    async (verdict: "approve" | "reject") => {
      setBusy(verdict);
      setError(null);
      try {
        const res = await fetch(`/api/companies/${companyId}/autoresearch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId: item.approvalId, verdict }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        onResolved();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to submit");
      } finally {
        setBusy(null);
      }
    },
    [companyId, item.approvalId, onResolved],
  );

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
              {item.candidateKind ?? "skill"}
            </span>
            <span className="font-mono text-sm text-zinc-200">{item.taskType}</span>
          </div>
          <p className="mt-1.5 text-sm text-zinc-400">{item.reason}</p>
          <span className="mt-1 block text-xs text-zinc-500">{relTime(item.createdAt)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => act("approve")}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
          >
            {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Approve
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => act("reject")}
            className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/15 px-3 py-1.5 text-sm font-medium text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
          >
            {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            Reject
          </button>
        </div>
      </div>

      {item.previewContent ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {open ? "Hide diff preview" : "Show diff preview"}
          </button>
          {open ? <DiffPreview content={item.previewContent} /> : null}
        </div>
      ) : null}

      {error ? <p className="mt-2 text-xs text-rose-400">{error}</p> : null}
    </div>
  );
}

function IterationRow({ iter }: { iter: SelfImprovementIteration }) {
  const style = DECISION_STYLE[iter.decision] ?? DECISION_STYLE.no_candidate;
  return (
    <div className="flex items-start gap-3 border-b border-white/5 py-3 last:border-0">
      <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${style.cls}`}>{style.label}</span>
          <span className="font-mono text-sm text-zinc-200">{iter.taskType}</span>
          {typeof iter.score === "number" ? (
            <span className="text-xs text-zinc-400">score {iter.score.toFixed(2)}</span>
          ) : null}
          {typeof iter.delta === "number" ? (
            <span className={`text-xs ${iter.delta >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {iter.delta >= 0 ? "+" : ""}
              {iter.delta.toFixed(2)}
            </span>
          ) : null}
        </div>
        {iter.triggers.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {iter.triggers.map((t, i) => (
              <span key={i} className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-zinc-400">
                {t}
              </span>
            ))}
          </div>
        ) : null}
        {iter.blockedBy ? <p className="mt-1 text-xs text-rose-400/80">blocked by {iter.blockedBy}</p> : null}
      </div>
      <span className="shrink-0 text-xs text-zinc-500">{relTime(iter.createdAt)}</span>
    </div>
  );
}

export function AutoresearchClient({ companyId, initial }: Props) {
  const [view, setView] = useState<AutoresearchView>(initial);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/autoresearch`, { cache: "no-store" });
      if (res.ok) {
        setView((await res.json()) as AutoresearchView);
      }
    } finally {
      setRefreshing(false);
    }
  }, [companyId]);

  const pending = view.pending;
  const iterations = useMemo(() => view.iterations, [view.iterations]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-amber-300" />
          <h1 className="text-lg font-semibold text-zinc-100">Autoresearch</h1>
        </div>
        <p className="mt-1 text-sm text-zinc-400">
          Trent improving its own skills, gated by your approval. Candidate promotions are quarantined until you
          approve them here.
        </p>
      </header>

      <section className="mb-8">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-300" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Pending review</h2>
          {pending.length > 0 ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">{pending.length}</span>
          ) : null}
        </div>
        {pending.length === 0 ? (
          <p className="rounded-lg border border-white/5 bg-white/[0.02] px-4 py-6 text-sm text-zinc-500">
            Nothing awaiting your review. Promotions will appear here when Trent finds a candidate that passes the eval
            gate.
          </p>
        ) : (
          <div className="space-y-3">
            {pending.map((item) => (
              <PendingItem key={item.approvalId} item={item} companyId={companyId} onResolved={refresh} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Iteration history</h2>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Refresh
          </button>
        </div>
        {iterations.length === 0 ? (
          <p className="rounded-lg border border-white/5 bg-white/[0.02] px-4 py-6 text-sm text-zinc-500">
            No iterations recorded yet.
          </p>
        ) : (
          <div className="rounded-lg border border-white/5 bg-white/[0.02] px-4">
            {iterations.map((iter) => (
              <IterationRow key={iter.id} iter={iter} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
