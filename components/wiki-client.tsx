"use client";

import { useEffect, useMemo, useState } from "react";
import { WIKI_CLIENT_CAPABILITIES } from "@/components/wiki-client-capabilities";

export { WIKI_CLIENT_CAPABILITIES };

type WikiPage = {
  slug: string;
  title: string;
  summary: string;
  sourceKind: string;
  sourceLinks: Array<{ path: string; line: number; label: string }>;
  updatedAt: string;
};

type WikiAggregate = {
  tree: { nodes: Array<{ id: string; label: string; count: number }> };
  pages: WikiPage[];
  diagrams: Array<{ id: string; kind: "mermaid"; title: string; content: string }>;
  versions: { previousGeneratedAt?: string; diff: { added: string[]; changed: string[]; removed: string[] } };
  freshness: {
    ageSeconds: number;
    isStale: boolean;
    sourceCount: number;
    chunkCount: number;
    costTelemetry: { usageCents: number; budgetCents: number; remainingCents: number };
  };
};

export function WikiClient({ companyId }: { companyId: string }) {
  const [wiki, setWiki] = useState<WikiAggregate | null>(null);
  const [activeSlug, setActiveSlug] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [question, setQuestion] = useState("");
  const [searchAnswer, setSearchAnswer] = useState<{ answer: string; refusal?: string; citations: string[] } | null>(null);

  useEffect(() => {
    fetch(`/api/companies/${companyId}/wiki`)
      .then((res) => res.ok ? res.json() : Promise.reject(new Error("wiki load failed")))
      .then((body: { wiki: WikiAggregate }) => {
        setWiki(body.wiki);
        setActiveSlug(body.wiki.pages[0]?.slug ?? "");
      })
      .catch(() => setWiki({
        tree: { nodes: [] },
        pages: [],
        diagrams: [],
        versions: { diff: { added: [], changed: [], removed: [] } },
        freshness: { ageSeconds: 0, isStale: true, sourceCount: 0, chunkCount: 0, costTelemetry: { usageCents: 0, budgetCents: 0, remainingCents: 0 } },
      }));
  }, [companyId]);

  const pages = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = wiki?.pages ?? [];
    if (!q) return all;
    return all.filter((page) => `${page.title} ${page.summary} ${page.sourceKind}`.toLowerCase().includes(q));
  }, [wiki, filter]);

  const activePage = pages.find((page) => page.slug === activeSlug) ?? pages[0];
  const diffCount = (wiki?.versions.diff.added.length ?? 0) + (wiki?.versions.diff.changed.length ?? 0) + (wiki?.versions.diff.removed.length ?? 0);

  async function askWiki() {
    const query = question.trim();
    if (!query) return;
    const res = await fetch(`/api/companies/${companyId}/wiki/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return;
    const body = await res.json() as { answer: { answer: string; refusal?: string; citations: string[] } };
    setSearchAnswer(body.answer);
  }

  if (!wiki) return <div style={shellStyle}>Loading Trench Wiki...</div>;

  return (
    <div style={shellStyle}>
      <header style={headerStyle}>
        <div>
          <div style={eyebrowStyle}>Trench Wiki</div>
          <h1 style={headingStyle}>Company knowledge map</h1>
        </div>
        <div style={telemetryStyle}>
          <span>{wiki.freshness.sourceCount} sources</span>
          <span>{wiki.freshness.chunkCount} chunks</span>
          <span>{wiki.freshness.isStale ? "stale" : "fresh"}</span>
          <span>${(wiki.freshness.costTelemetry.remainingCents / 100).toFixed(2)} left</span>
        </div>
      </header>

      <main style={gridStyle}>
        <aside style={panelStyle}>
          <input
            aria-label="filter wiki pages"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="filter pages"
            style={inputStyle}
          />
          <div style={sectionTitleStyle}>tree</div>
          {wiki.tree.nodes.map((node) => (
            <div key={node.id} style={treeRowStyle}>
              <span>{node.label}</span>
              <span>{node.count}</span>
            </div>
          ))}
          <div style={sectionTitleStyle}>pages</div>
          {pages.map((page) => (
            <button
              key={page.slug}
              type="button"
              onClick={() => setActiveSlug(page.slug)}
              style={page.slug === activePage?.slug ? activeButtonStyle : buttonStyle}
            >
              <span>{page.title}</span>
              <small>{page.sourceKind}</small>
            </button>
          ))}
        </aside>

        <section style={panelStyle}>
          <div style={sectionTitleStyle}>ask</div>
          <div style={searchStyle}>
            <input
              aria-label="ask the wiki"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="ask with citations"
              style={inputStyle}
            />
            <button type="button" onClick={() => void askWiki()} style={askButtonStyle}>ask</button>
          </div>
          {searchAnswer ? (
            <div style={answerStyle}>
              <p>{searchAnswer.refusal || searchAnswer.answer}</p>
              <div style={linkGridStyle}>
                {searchAnswer.citations.map((citation) => <span key={citation} style={sourceLinkStyle}>{citation}</span>)}
              </div>
            </div>
          ) : null}
          {activePage ? (
            <article>
              <div style={eyebrowStyle}>{activePage.sourceKind}</div>
              <h2 style={subheadingStyle}>{activePage.title}</h2>
              <p style={summaryStyle}>{activePage.summary}</p>
              <div style={sectionTitleStyle}>source links</div>
              <div style={linkGridStyle}>
                {activePage.sourceLinks.map((link) => (
                  <a key={link.label} href={`#${activePage.slug}`} style={sourceLinkStyle}>
                    {link.label}
                  </a>
                ))}
              </div>
            </article>
          ) : (
            <div style={emptyStyle}>No wiki pages indexed yet.</div>
          )}
        </section>

        <aside style={panelStyle}>
          <div style={sectionTitleStyle}>architecture</div>
          <pre style={diagramStyle}>{wiki.diagrams[0]?.content ?? "graph TD\n  empty[No index]"}</pre>
          <div style={sectionTitleStyle}>version diff</div>
          <div style={metricStyle}>{diffCount} changed page{diffCount === 1 ? "" : "s"}</div>
          <DiffList label="added" values={wiki.versions.diff.added} />
          <DiffList label="changed" values={wiki.versions.diff.changed} />
          <DiffList label="removed" values={wiki.versions.diff.removed} />
          <div style={sectionTitleStyle}>grounded search</div>
          <div style={metaStyle}>Phase 18 will query this index and require citations.</div>
        </aside>
      </main>
    </div>
  );
}

function DiffList({ label, values }: { label: string; values: string[] }) {
  return (
    <div style={diffListStyle}>
      <strong>{label}</strong>
      <span>{values.length ? values.join(", ") : "none"}</span>
    </div>
  );
}

const shellStyle = { minHeight: "100vh", background: "#080a0f", color: "#e7edf6", padding: 20 };
const headerStyle = { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 16, flexWrap: "wrap" as const };
const headingStyle = { margin: 0, fontSize: 22, lineHeight: 1.2 };
const subheadingStyle = { margin: "4px 0 10px", fontSize: 20, lineHeight: 1.25 };
const gridStyle = { display: "grid", gridTemplateColumns: "280px minmax(340px, 1fr) 340px", gap: 12 };
const panelStyle = { border: "1px solid #223048", background: "#0e131d", padding: 12, minHeight: 440 };
const inputStyle = { width: "100%", boxSizing: "border-box" as const, background: "#070a10", color: "#e7edf6", border: "1px solid #2b3a55", padding: 8 };
const eyebrowStyle = { color: "#8bd7ff", textTransform: "uppercase" as const, fontSize: 11, letterSpacing: 0, marginBottom: 6 };
const sectionTitleStyle = { color: "#92a3b8", textTransform: "uppercase" as const, fontSize: 11, letterSpacing: 0, margin: "14px 0 8px" };
const telemetryStyle = { display: "flex", gap: 10, flexWrap: "wrap" as const, color: "#b8c5d8", fontSize: 13 };
const treeRowStyle = { display: "flex", justifyContent: "space-between", gap: 8, borderBottom: "1px solid #1d2738", padding: "8px 0", color: "#c5d2e4", fontSize: 13 };
const buttonStyle = { width: "100%", display: "grid", gap: 3, textAlign: "left" as const, border: "1px solid #1d2738", background: "#0a0f18", color: "#e7edf6", padding: 9, marginBottom: 6, cursor: "pointer" };
const activeButtonStyle = { ...buttonStyle, border: "1px solid #60a5fa", background: "#101a2a" };
const summaryStyle = { color: "#cbd7e7", lineHeight: 1.6 };
const linkGridStyle = { display: "flex", flexWrap: "wrap" as const, gap: 8 };
const sourceLinkStyle = { color: "#8bd7ff", border: "1px solid #23405f", padding: "5px 7px", textDecoration: "none", fontSize: 12 };
const searchStyle = { display: "grid", gridTemplateColumns: "1fr 72px", gap: 8, marginBottom: 10 };
const askButtonStyle = { border: "1px solid #3b82f6", background: "#10213a", color: "#e7edf6", cursor: "pointer" };
const answerStyle = { border: "1px solid #1d2738", background: "#090d15", padding: 10, marginBottom: 12, color: "#cbd7e7" };
const diagramStyle = { whiteSpace: "pre-wrap" as const, overflowX: "auto" as const, background: "#070a10", border: "1px solid #1d2738", padding: 10, color: "#d8e4f4", fontSize: 12 };
const metricStyle = { color: "#e7edf6", fontSize: 14, marginBottom: 8 };
const diffListStyle = { display: "grid", gridTemplateColumns: "80px 1fr", gap: 8, color: "#bac8da", fontSize: 12, padding: "5px 0" };
const metaStyle = { color: "#92a3b8", fontSize: 12, lineHeight: 1.5 };
const emptyStyle = { color: "#92a3b8", padding: 16 };
