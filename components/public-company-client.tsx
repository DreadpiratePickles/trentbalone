"use client";

import { useEffect, useState } from "react";
import type { CompanyMetrics, Cycle, Report, Task } from "@/lib/types";
import { money, taskStatusLabel } from "@/lib/utils";
import { Pill, ConsoleMark } from "@/components/ui";

type PublicPayload = {
  company: {
    name: string;
    slug: string;
    vision: string;
    goals: string;
    metrics: CompanyMetrics;
    publicShipped: string;
    publicLearning: string;
    publicFocus: string;
  };
  latestCycle: Cycle | null;
  reports: Report[];
  tasks: Task[];
};

export function PublicCompanyClient({ slug }: { slug: string }) {
  const [data, setData] = useState<PublicPayload | null>(null);

  useEffect(() => {
    fetch(`/api/public/${slug}`, { cache: "no-store" })
      .then((res) => res.json())
      .then(setData);
  }, [slug]);

  if (!data?.company) {
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          background: "var(--obsidian)",
        }}
      >
        <span className="mono" style={{ fontSize: 13, color: "var(--haze)" }}>
          Public company not found.
        </span>
      </div>
    );
  }

  const { company } = data;

  return (
    <main style={{ minHeight: "100vh", background: "var(--obsidian)" }}>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "48px 32px 80px" }}>
        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <ConsoleMark size={18} />
            <span
              className="mono"
              style={{ fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)" }}
            >
              trent · public dashboard
            </span>
            <Pill tone="pulse" style={{ marginLeft: "auto" }}>live</Pill>
          </div>
          <h1
            style={{
              fontFamily: "var(--display)",
              fontWeight: 700,
              fontSize: 40,
              letterSpacing: "-.025em",
              color: "var(--bone)",
              margin: "0 0 12px",
            }}
          >
            {company.name}
          </h1>
          <p style={{ fontSize: 15, color: "var(--mist)", lineHeight: 1.65, maxWidth: "60ch" }}>
            {company.vision}
          </p>
        </div>

        {/* Metrics */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 14,
            marginBottom: 32,
          }}
        >
          {[
            { k: "users", v: String(company.metrics.users) },
            { k: "signups", v: String(company.metrics.signups) },
            { k: "revenue", v: money(company.metrics.revenueCents) },
          ].map((s) => (
            <div
              key={s.k}
              style={{
                background: "var(--ink)",
                border: "1px solid rgba(255,255,255,.07)",
                borderRadius: "var(--r-md)",
                padding: 20,
              }}
            >
              <div
                className="mono"
                style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 10 }}
              >
                {s.k}
              </div>
              <div
                style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 28, letterSpacing: "-.02em", color: "var(--bone)" }}
              >
                {s.v}
              </div>
            </div>
          ))}
        </div>

        {/* Narrative sections — what shipped / learning / focus */}
        {(company.publicShipped || company.publicLearning || company.publicFocus) && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 14,
              marginBottom: 32,
            }}
          >
            {[
              { key: "what shipped", value: company.publicShipped },
              { key: "what we're learning", value: company.publicLearning },
              { key: "current focus", value: company.publicFocus },
            ].map(({ key, value }) =>
              value ? (
                <div
                  key={key}
                  style={{
                    background: "var(--ink)",
                    border: "1px solid rgba(255,255,255,.07)",
                    borderRadius: "var(--r-md)",
                    padding: 20,
                  }}
                >
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      letterSpacing: ".2em",
                      textTransform: "uppercase",
                      color: "var(--mist)",
                      marginBottom: 10,
                    }}
                  >
                    {key}
                  </div>
                  <p style={{ fontSize: 13, color: "var(--bone-2)", lineHeight: 1.65, margin: 0 }}>
                    {value}
                  </p>
                </div>
              ) : null
            )}
          </div>
        )}

        {/* Latest cycle */}
        <div
          style={{
            background: "var(--ink)",
            border: "1px solid rgba(255,255,255,.07)",
            borderRadius: "var(--r-md)",
            padding: 24,
            marginBottom: 32,
          }}
        >
          <div
            className="mono"
            style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--mist)", marginBottom: 12 }}
          >
            latest operating cycle
          </div>
          <p style={{ fontSize: 14, color: "var(--bone-2)", lineHeight: 1.65 }}>
            {data.latestCycle?.summary ?? "No public cycle report yet."}
          </p>
        </div>

        {/* Tasks + Reports */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <div
            style={{
              background: "var(--ink)",
              border: "1px solid rgba(255,255,255,.07)",
              borderRadius: "var(--r-md)",
              padding: 20,
            }}
          >
            <div
              className="mono"
              style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--mist)", marginBottom: 16 }}
            >
              recent tasks
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {data.tasks.map((task) => (
                <div
                  key={task.id}
                  style={{
                    padding: "10px 14px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,.05)",
                    background: "rgba(255,255,255,.01)",
                  }}
                >
                  <Pill>{taskStatusLabel(task.status)}</Pill>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--bone)", marginTop: 8 }}>
                    {task.title}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              background: "var(--ink)",
              border: "1px solid rgba(255,255,255,.07)",
              borderRadius: "var(--r-md)",
              padding: 20,
            }}
          >
            <div
              className="mono"
              style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--mist)", marginBottom: 16 }}
            >
              reports
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {data.reports.map((report) => (
                <div
                  key={report.id}
                  style={{
                    padding: "10px 14px",
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,.05)",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--bone)", marginBottom: 6 }}>
                    {report.title}
                  </div>
                  <p style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.5, margin: 0 }}>
                    {report.findings.slice(0, 1).join("")}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
