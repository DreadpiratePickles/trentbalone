"use client";

/**
 * Goal Cockpit (§2 Slice 5) — the founder's surface for the Goal Loop.
 *
 *  - Command composer → CEO intake → criteria checklist (HUMAN GATE #1).
 *  - Rounds timeline + per-round criteria deltas.
 *  - Criteria checklist with evidence links (artifact ids).
 *  - Next-round control: Run round / Stop (HUMAN GATE #2).
 */

import { useCallback, useEffect, useState } from "react";

type Criterion = { id: string; text: string; status: "unmet" | "met" | "blocked"; evidenceArtifactIds: string[] };
type Round = { n: number; runId: string; plannedTaskCount: number; costCents: number; summary: string; artifactIds: string[]; criteriaDelta: { criterionId: string; from: string; to: string }[]; at: string };
type ProgressEntry = { at: string; kind: string; text: string; refs: string[] };
type Goal = {
  id: string;
  objective: string;
  status: string;
  successCriteria: Criterion[];
  constraints: { budgetCentsCap: number; approvalsPolicy: string };
  rounds: Round[];
  progressLog: ProgressEntry[];
  costCents: number;
  createdAt: string;
};

const STATUS_COLOR: Record<string, string> = {
  intake: "var(--mist)",
  active: "var(--pulse)",
  round_running: "var(--ember)",
  awaiting_review: "var(--ember)",
  completed: "var(--pulse-deep)",
  stopped: "var(--haze)",
};

export function GoalCockpit({ companyId }: { companyId: string }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [runningRound, setRunningRound] = useState(false);
  const [error, setError] = useState("");

  const selected = goals.find((g) => g.id === selectedId) ?? null;

  const load = useCallback(async () => {
    const res = await fetch(`/api/companies/${companyId}/goals`);
    if (!res.ok) return;
    const data = await res.json();
    setGoals(data.goals ?? []);
    setSelectedId((prev) => prev ?? data.goals?.[0]?.id ?? null);
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  const createGoal = useCallback(async () => {
    if (!command.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/companies/${companyId}/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.detail || data.error || "intake failed"); return; }
      setCommand("");
      await load();
      setSelectedId(data.goal.id);
    } finally { setBusy(false); }
  }, [command, companyId, load]);

  const patchGoal = useCallback(async (goalId: string, body: Record<string, unknown>) => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/companies/${companyId}/goals/${goalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error || "update failed"); return; }
      await load();
    } finally { setBusy(false); }
  }, [companyId, load]);

  const runRound = useCallback(async (goalId: string) => {
    setRunningRound(true); setError("");
    try {
      const res = await fetch(`/api/companies/${companyId}/goals/${goalId}/rounds`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setError(data.detail || data.error || "round failed"); return; }
      await load();
    } finally { setRunningRound(false); }
  }, [companyId, load]);

  return (
    <div data-testid="goal-cockpit" style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 24, minHeight: "70vh" }}>
      {/* Left rail: goal list + new goal */}
      <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 26, color: "var(--bone)" }}>Goals</div>
        <div style={panel}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--mist)", marginBottom: 8 }}>New goal</div>
          <textarea
            data-testid="goal-command-input"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="Tell Trent what to achieve — e.g. 'Launch a waitlist landing page and get 50 signups'"
            rows={3}
            style={textarea}
          />
          <button data-testid="goal-create-btn" onClick={createGoal} disabled={busy || !command.trim()} style={primaryBtn(busy || !command.trim())}>
            {busy ? "Thinking…" : "Define goal →"}
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {goals.map((g) => (
            <button
              key={g.id}
              data-testid={`goal-list-item-${g.id}`}
              onClick={() => setSelectedId(g.id)}
              style={{
                ...listItem,
                borderColor: g.id === selectedId ? "var(--pulse)" : "var(--slate)",
                background: g.id === selectedId ? "rgba(110,231,183,.06)" : "var(--ink)",
              }}
            >
              <div style={{ fontSize: 13, color: "var(--bone)", marginBottom: 4 }}>{g.objective.slice(0, 70)}</div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                <span style={{ color: STATUS_COLOR[g.status] ?? "var(--mist)" }}>{g.status.replace(/_/g, " ")}</span>
                <span style={{ color: "var(--haze)" }}>{g.successCriteria.filter((c) => c.status === "met").length}/{g.successCriteria.length} met</span>
              </div>
            </button>
          ))}
          {goals.length === 0 && <div style={{ color: "var(--haze)", fontSize: 13 }}>No goals yet.</div>}
        </div>
      </aside>

      {/* Right: selected goal detail */}
      <section style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {error && <div data-testid="goal-error" style={{ ...panel, borderColor: "var(--danger)", color: "var(--danger)" }}>{error}</div>}
        {!selected && <div style={{ color: "var(--haze)" }}>Select or create a goal to begin.</div>}
        {selected && (
          <>
            <div style={panel}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                <div style={{ fontFamily: "var(--serif)", fontSize: 24, color: "var(--bone)", lineHeight: 1.2 }} data-testid="goal-objective">{selected.objective}</div>
                <span data-testid="goal-status" style={statusPill(STATUS_COLOR[selected.status] ?? "var(--mist)")}>{selected.status.replace(/_/g, " ")}</span>
              </div>
              <div style={{ marginTop: 12, fontSize: 12, color: "var(--mist)", display: "flex", gap: 18 }}>
                <span>Budget cap: ${(selected.constraints.budgetCentsCap / 100).toFixed(2)}</span>
                <span>Spent: ${(selected.costCents / 100).toFixed(2)}</span>
                <span>Rounds: {selected.rounds.length}</span>
              </div>

              {/* HUMAN GATE #1 / #2 controls */}
              <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
                {selected.status === "intake" && (
                  <button data-testid="goal-approve-criteria-btn" onClick={() => patchGoal(selected.id, { action: "approve_criteria" })} disabled={busy} style={primaryBtn(busy)}>
                    Approve criteria & activate →
                  </button>
                )}
                {(selected.status === "active" || selected.status === "awaiting_review") && (
                  <button data-testid="goal-run-round-btn" onClick={() => runRound(selected.id)} disabled={runningRound} style={primaryBtn(runningRound)}>
                    {runningRound ? `Running round ${selected.rounds.length + 1}…` : `Run round ${selected.rounds.length + 1} →`}
                  </button>
                )}
                {selected.status !== "completed" && selected.status !== "stopped" && (
                  <button data-testid="goal-stop-btn" onClick={() => patchGoal(selected.id, { action: "stop" })} disabled={busy} style={ghostBtn}>Stop</button>
                )}
                {selected.status === "completed" && <span style={{ color: "var(--pulse-deep)", alignSelf: "center" }}>✓ All criteria met</span>}
              </div>
            </div>

            {/* Criteria checklist with evidence */}
            <div style={panel}>
              <div style={sectionTitle}>Success criteria</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {selected.successCriteria.map((c) => (
                  <div key={c.id} data-testid={`criterion-${c.id}`} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <span data-testid={`criterion-status-${c.id}`} style={criterionMark(c.status)}>
                      {c.status === "met" ? "✓" : c.status === "blocked" ? "!" : "○"}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ color: c.status === "met" ? "var(--bone)" : "var(--mist)", fontSize: 14 }}>{c.text}</div>
                      {c.evidenceArtifactIds.length > 0 && (
                        <div style={{ marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {c.evidenceArtifactIds.map((aid) => (
                            <a key={aid} href={`/companies/${companyId}/artifacts`} data-testid={`evidence-${aid}`} style={evidenceChip}>evidence: {aid.slice(0, 12)}</a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Rounds timeline */}
            <div style={panel}>
              <div style={sectionTitle}>Rounds</div>
              {selected.rounds.length === 0 && <div style={{ color: "var(--haze)", fontSize: 13 }}>No rounds run yet.</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {selected.rounds.slice().reverse().map((r) => (
                  <div key={r.n} data-testid={`round-${r.n}`} style={{ borderLeft: "2px solid var(--slate)", paddingLeft: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: "var(--pulse)" }}>Round {r.n}</span>
                      <span style={{ color: "var(--haze)" }}>{r.plannedTaskCount} tasks · ${(r.costCents / 100).toFixed(2)} · {r.artifactIds.length} artifacts</span>
                    </div>
                    <div style={{ marginTop: 6, color: "var(--bone)", fontSize: 13, whiteSpace: "pre-wrap" }}>{r.summary}</div>
                    {r.criteriaDelta.length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 12, color: "var(--pulse-deep)" }}>
                        {r.criteriaDelta.map((d, i) => <span key={i}>· {d.from}→{d.to} </span>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Progress log */}
            <div style={panel}>
              <div style={sectionTitle}>Progress log</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {selected.progressLog.slice().reverse().slice(0, 12).map((p, i) => (
                  <div key={i} style={{ fontSize: 12, color: "var(--mist)" }}>
                    <span style={{ color: "var(--haze)" }}>[{p.kind}]</span> {p.text}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────
const panel: React.CSSProperties = { background: "var(--ink)", border: "1px solid var(--slate)", borderRadius: "var(--r-md)", padding: 20 };
const textarea: React.CSSProperties = { width: "100%", background: "var(--obsidian)", border: "1px solid var(--slate)", borderRadius: "var(--r-sm)", color: "var(--bone)", padding: 10, fontFamily: "var(--display)", fontSize: 13, resize: "vertical", boxSizing: "border-box" };
const listItem: React.CSSProperties = { textAlign: "left", border: "1px solid var(--slate)", borderRadius: "var(--r-sm)", padding: 12, cursor: "pointer" };
const sectionTitle: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--mist)", marginBottom: 14 };
const evidenceChip: React.CSSProperties = { fontSize: 11, color: "var(--pulse)", textDecoration: "none", border: "1px solid var(--pulse-deep)", borderRadius: 999, padding: "2px 8px", fontFamily: "var(--mono)" };
function primaryBtn(disabled: boolean): React.CSSProperties {
  return { marginTop: 10, background: disabled ? "var(--slate)" : "var(--pulse)", color: disabled ? "var(--haze)" : "var(--obsidian)", border: "none", borderRadius: "var(--r-sm)", padding: "9px 16px", fontWeight: 600, fontSize: 13, cursor: disabled ? "default" : "pointer" };
}
const ghostBtn: React.CSSProperties = { marginTop: 10, background: "transparent", color: "var(--mist)", border: "1px solid var(--slate)", borderRadius: "var(--r-sm)", padding: "9px 16px", fontSize: 13, cursor: "pointer" };
function statusPill(color: string): React.CSSProperties {
  return { fontSize: 11, color, border: `1px solid ${color}`, borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: ".06em" };
}
function criterionMark(status: string): React.CSSProperties {
  const color = status === "met" ? "var(--pulse-deep)" : status === "blocked" ? "var(--ember)" : "var(--haze)";
  return { width: 20, height: 20, borderRadius: "50%", border: `1px solid ${color}`, color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 };
}
