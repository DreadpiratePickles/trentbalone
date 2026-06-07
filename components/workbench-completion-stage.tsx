"use client";

import { useEffect, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { I, Pill } from "@/components/ui";
import { summarizeWorkbenchCompletion } from "@/lib/workbench-test-mode";
import { workbenchPreviewFrameSrc } from "@/lib/workbench-preview-url";
import type { WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";

type CompletionStageProps = {
  session: WorkbenchSession;
  events: WorkbenchEvent[];
  artifacts: WorkbenchArtifact[];
  composer: string;
  streaming: boolean;
  onComposerChange: Dispatch<SetStateAction<string>>;
  onSend: () => void;
  onBackToBuild: () => void;
};

export function WorkbenchCompletionStage({
  session,
  events,
  artifacts,
  composer,
  streaming,
  onComposerChange,
  onSend,
  onBackToBuild,
}: CompletionStageProps) {
  const [narrow, setNarrow] = useState(false);
  const summary = summarizeWorkbenchCompletion(events, artifacts);
  const previewArtifact = artifacts.find((artifact) => artifact.kind === "preview");
  const primaryUrl = session.previewUrl;
  const frameUrl = workbenchPreviewFrameSrc(session);
  const recentEvents = events.slice(-8).reverse();

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 980);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div style={{ ...S.root, gridTemplateColumns: narrow ? "1fr" : "minmax(280px, 360px) minmax(0, 1fr)" }}>
      <aside style={{ ...S.rail, minHeight: narrow ? "auto" : 720 }}>
        <div style={S.railHeader}>
          <div style={S.kicker}>workbench complete</div>
          <h1 style={S.title}>Test what Trent made.</h1>
          <p style={S.lead}>{session.objective}</p>
        </div>

        <div style={S.traceBox}>
          <TraceLine active label={`${summary.completedEvents} completed events`} />
          <TraceLine active={summary.testEvents > 0} label={`${summary.testEvents} test events`} />
          <TraceLine active={summary.artifactCount > 0} label={`${summary.artifactCount} artifacts captured`} />
          <TraceLine active={!!primaryUrl || !!previewArtifact} label={primaryUrl ? "live preview available" : "artifact preview fallback"} />
        </div>

        <div style={S.artifactBox}>
          <div style={S.sectionLabel}>artifacts</div>
          {artifacts.length === 0 ? (
            <p style={S.empty}>No artifacts were captured for this session yet.</p>
          ) : (
            artifacts.slice(0, 6).map((artifact) => (
              <div key={artifact.id} style={S.artifactRow}>
                <span style={S.artifactKind}>{artifact.kind}</span>
                <span style={S.artifactTitle}>{artifact.title}</span>
              </div>
            ))
          )}
        </div>

        <div style={S.iterateBox}>
          <label htmlFor="workbench-continue" style={S.sectionLabel}>continue iterating</label>
          <textarea
            id="workbench-continue"
            value={composer}
            onChange={(event) => onComposerChange(event.target.value)}
            placeholder="Tell Trent what to fix, test, or improve next..."
            style={S.textarea}
            rows={4}
            disabled={streaming}
          />
          <button
            onClick={onSend}
            disabled={streaming || !composer.trim()}
            className="btn btn-pulse btn-mono"
            style={{ width: "100%", justifyContent: "center" }}
          >
            {streaming ? "sending" : "send iteration"}
          </button>
          <button onClick={onBackToBuild} className="btn btn-secondary btn-mono" style={{ width: "100%", justifyContent: "center" }}>
            back to build log
          </button>
        </div>
      </aside>

      <main style={S.stage}>
        <div style={S.toolbar}>
          <div style={S.windowDots}><span style={S.windowDot} /><span style={S.windowDot} /><span style={S.windowDot} /></div>
          <div style={S.path}>
            <I.globe />
            <span>{primaryUrl ?? `workbench/${session.id}`}</span>
          </div>
          <Pill tone="pulse">ready to test</Pill>
        </div>

        <section style={S.previewStage}>
          {frameUrl ? (
            <iframe src={frameUrl} style={S.frame} title="Workbench completed preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
          ) : (
            <div style={S.noPreview}>
              <div style={S.bigMark}><I.play /></div>
              <div style={S.kicker}>sandbox fallback</div>
              <h2 style={S.stageTitle}>No live preview URL yet.</h2>
              <p style={S.stageCopy}>
                Trent still captured the output trail. Review artifacts, terminal logs, and screenshots from the left rail, then ask for a fix or a preview step.
              </p>
            </div>
          )}
        </section>

        <div style={S.bottomBand}>
          <div>
            <div style={S.sectionLabel}>recent work</div>
            <div style={S.bandTitle}>{recentEvents[0]?.title ?? "Session completed"}</div>
          </div>
          <div style={S.eventStrip}>
            {recentEvents.slice(0, 4).map((event) => (
              <span key={event.id} style={S.eventPill}>{event.type}</span>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

function TraceLine({ active, label }: { active: boolean; label: string }) {
  return (
    <div style={S.traceLine}>
      <span style={{ ...S.traceDot, background: active ? "var(--pulse)" : "rgba(255,255,255,.14)" }} />
      <span style={{ color: active ? "var(--bone)" : "var(--haze)" }}>{label}</span>
    </div>
  );
}

const border = "1px solid rgba(255,255,255,.08)";

const S: Record<string, CSSProperties> = {
  root: { display: "grid", gap: 18, minHeight: "calc(100vh - 150px)" },
  rail: { display: "grid", gridTemplateRows: "auto auto 1fr auto", gap: 16, padding: 18, borderRight: border, background: "rgba(255,255,255,.025)", minHeight: 0 },
  railHeader: { borderBottom: "1px solid rgba(255,255,255,.07)", paddingBottom: 16 },
  kicker: { fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--pulse)" },
  title: { margin: "12px 0 10px", fontFamily: "var(--display)", fontSize: 38, lineHeight: .95, letterSpacing: 0, color: "var(--bone)" },
  lead: { margin: 0, color: "var(--mist)", lineHeight: 1.55, fontSize: 14 },
  traceBox: { padding: 14, border, borderRadius: 8, background: "rgba(10,10,15,.38)" },
  traceLine: { display: "flex", alignItems: "center", gap: 9, minHeight: 28, fontSize: 13 },
  traceDot: { width: 6, height: 6, borderRadius: 999, boxShadow: "0 0 18px rgba(110,231,183,.3)" },
  artifactBox: { minHeight: 0, overflow: "auto", padding: 14, border, borderRadius: 8, background: "rgba(255,255,255,.025)" },
  sectionLabel: { display: "block", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--haze)", textTransform: "uppercase", marginBottom: 10 },
  empty: { margin: 0, color: "var(--haze)", fontSize: 13, lineHeight: 1.45 },
  artifactRow: { display: "grid", gridTemplateColumns: "72px 1fr", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid rgba(255,255,255,.05)" },
  artifactKind: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase" },
  artifactTitle: { color: "var(--bone)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  iterateBox: { display: "grid", gap: 10 },
  textarea: { width: "100%", resize: "vertical", minHeight: 90, borderRadius: 8, border, background: "rgba(255,255,255,.035)", color: "var(--bone)", padding: 12, lineHeight: 1.45 },
  stage: { display: "grid", gridTemplateRows: "54px minmax(0, 1fr) auto", minWidth: 0, minHeight: 0, background: "linear-gradient(135deg, #0A0A0F 0%, #111116 60%, #090A0C 100%)" },
  toolbar: { display: "flex", alignItems: "center", gap: 12, padding: "0 14px", borderBottom: border, background: "rgba(255,255,255,.035)" },
  windowDots: { display: "flex", gap: 7 },
  windowDot: { width: 9, height: 9, borderRadius: 999, background: "rgba(255,255,255,.18)" },
  path: { minWidth: 0, flex: 1, height: 32, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  previewStage: { minHeight: 0, padding: 18, position: "relative" },
  frame: { width: "100%", height: "100%", minHeight: 520, border, borderRadius: 8, background: "#fff" },
  noPreview: { minHeight: 520, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-start", padding: "min(7vw, 72px)", border, borderRadius: 8, background: "radial-gradient(circle at 78% 20%, rgba(110,231,183,.14), transparent 30%), rgba(255,255,255,.025)" },
  bigMark: { width: 42, height: 42, display: "grid", placeItems: "center", background: "var(--pulse)", color: "var(--obsidian)", marginBottom: 36 },
  stageTitle: { maxWidth: 760, margin: "14px 0 18px", fontFamily: "var(--display)", fontSize: "clamp(48px, 7vw, 96px)", lineHeight: .9, letterSpacing: 0 },
  stageCopy: { maxWidth: 680, margin: 0, color: "var(--bone-2)", fontSize: 17, lineHeight: 1.7 },
  bottomBand: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, padding: 18, borderTop: border, background: "rgba(255,255,255,.025)" },
  bandTitle: { color: "var(--bone)", fontWeight: 650, lineHeight: 1.35 },
  eventStrip: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" },
  eventPill: { padding: "6px 8px", border, borderRadius: 7, color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase" },
};
