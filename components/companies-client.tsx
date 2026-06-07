"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Company } from "@/lib/types";
import { PageHeader, Pill, Reveal, Eyebrow, I } from "@/components/ui";

// ── CompaniesClient ────────────────────────────────────────────────────

export function CompaniesClient() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const router = useRouter();

  async function load() {
    const res = await fetch("/api/companies", { cache: "no-store" });
    const data = await res.json();
    const list: Company[] = data.companies ?? [];
    setCompanies(list);
    setLoading(false);

    // Redirect to last-visited company if stored and still valid
    try {
      const lastId = localStorage.getItem("trent_last_company");
      if (lastId && list.some((c) => c.id === lastId)) {
        router.push(`/companies/${lastId}`);
        return;
      }
    } catch {}
  }

  useEffect(() => { void load(); }, []);

  async function createCompany(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = {
      name: String(fd.get("name") || ""),
      website: String(fd.get("website") || ""),
      publicVisibility: fd.get("publicVisibility") === "on",
      cycleFrequency: "daily",
      budgetCents: Number(fd.get("budget") || 100) * 100,
      brief: {
        vision: String(fd.get("vision") || ""),
        icp: String(fd.get("icp") || ""),
        offer: String(fd.get("offer") || ""),
        goals: String(fd.get("goals") || ""),
      },
    };
    const res = await fetch("/api/companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.company) {
      // Kick off the first cycle in the background, then navigate
      fetch(`/api/companies/${data.company.id}/cycles`, { method: "POST" }).catch(() => {});
      router.push(`/companies/${data.company.id}`);
    }
  }

  const operating = companies.filter((c) => c.status === "active").length;

  return (
    <div>
      <PageHeader
        eyebrow="portfolio"
        title="Your companies."
        lead="One operator. Many companies. Trent runs each loop independently and surfaces only what needs you."
        meta={
          <>
            <span>{companies.length} companies</span>
            <span>·</span>
            <span style={{ color: "var(--pulse)" }}>{operating} operating</span>
          </>
        }
        actions={
          <>
            <button className="btn btn-secondary btn-mono">filter</button>
            <button
              onClick={() => setCreating(true)}
              className="btn btn-primary btn-mono"
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <I.plus width={13} height={13} />
              new company
            </button>
          </>
        }
      />

      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="skel"
              style={{ height: 280, borderRadius: "var(--r-lg)" }}
            />
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {companies.map((c, i) => (
            <Reveal key={c.id} delay={i * 80}>
              <CompanyCard company={c} onClick={() => router.push(`/companies/${c.id}`)} />
            </Reveal>
          ))}

          {/* New company card */}
          <Reveal delay={companies.length * 80}>
            <button
              onClick={() => setCreating(true)}
              style={{
                background: "transparent",
                border: "1px dashed rgba(255,255,255,.12)",
                borderRadius: "var(--r-lg)",
                padding: 28,
                color: "var(--mist)",
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 12,
                minHeight: 260,
                width: "100%",
                transition: "border-color .25s, color .25s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(110,231,183,.4)";
                (e.currentTarget as HTMLButtonElement).style.color = "var(--bone)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(255,255,255,.12)";
                (e.currentTarget as HTMLButtonElement).style.color = "var(--mist)";
              }}
            >
              <I.plus width={20} height={20} />
              <div>
                <div style={{ fontSize: 20, fontWeight: 600, color: "inherit" }}>New company</div>
                <p style={{ fontSize: 13, color: "var(--haze)", marginTop: 6, lineHeight: 1.5, maxWidth: "36ch" }}>
                  Drop a vision and an ICP. Trent&apos;s first cycle runs tonight.
                </p>
              </div>
            </button>
          </Reveal>
        </div>
      )}

      {creating && <CreateCompanyOverlay onClose={() => setCreating(false)} onCreate={createCompany} />}
    </div>
  );
}

// ── Company card ───────────────────────────────────────────────────────

function hue(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function CompanyCard({ company: c, onClick }: { company: Company; onClick: () => void }) {
  const budget = c.budgetCents || 10000;
  const spent = 0; // would come from usage data
  const pct = Math.round((spent / budget) * 100);

  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: "1px solid rgba(255,255,255,.07)",
        borderRadius: "var(--r-lg)",
        padding: 28,
        background: "var(--ink)",
        cursor: "pointer",
        transition: "transform .35s ease, border-color .35s ease",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "translateY(-4px)";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(110,231,183,.4)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "translateY(0)";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(255,255,255,.07)";
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: `oklch(0.65 0.18 ${hue(c.name)})`,
            color: "#0A0A0F",
            fontFamily: "var(--mono)",
            fontSize: 16,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {c.name[0]}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: "var(--bone)",
              letterSpacing: "-.01em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {c.name}
          </div>
          <div
            className="mono"
            style={{ fontSize: 11, color: "var(--haze)", marginTop: 4 }}
          >
            {c.website || "no website set"}
          </div>
        </div>
        <Pill tone={c.status === "active" ? "pulse" : "neutral"}>
          {c.status === "active" ? "● operating" : "○ paused"}
        </Pill>
      </div>

      {/* Vision */}
      <p
        style={{
          fontSize: 14,
          color: "#B8B2A4",
          lineHeight: 1.55,
          margin: "0 0 24px",
          maxWidth: "52ch",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {c.brief?.vision || "No vision set."}
      </p>

      {/* Stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 16,
          paddingTop: 18,
          borderTop: "1px solid rgba(255,255,255,.05)",
        }}
      >
        <StatLine k="frequency" v={c.cycleFrequency} />
        <StatLine k="budget" v={`$${(c.budgetCents / 100).toFixed(0)}`} />
        <StatLine k="autonomy" v={c.autonomyLevel.replace("_", " ")} />
      </div>

      {/* Budget meter */}
      <div style={{ marginTop: 14 }}>
        <div
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: ".14em",
            color: "var(--haze)",
            marginBottom: 6,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>budget</span>
          <span>${(spent / 100).toFixed(0)} / ${(budget / 100).toFixed(0)}</span>
        </div>
        <div style={{ height: 3, background: "var(--steel)", borderRadius: 2, overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: pct + "%",
              background: pct > 80 ? "var(--ember)" : "var(--pulse)",
              transition: "width .6s",
            }}
          />
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          marginTop: 16,
          display: "flex",
          alignItems: "center",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--haze)",
            letterSpacing: ".14em",
            textTransform: "uppercase",
          }}
        >
          last cycle {c.lastCycleAt ? new Date(c.lastCycleAt).toLocaleDateString() : "never"}
        </span>
        <I.chevR style={{ marginLeft: "auto", color: "var(--haze)" }} />
      </div>
    </button>
  );
}

function StatLine({ k, v, tone = "bone" }: { k: string; v: string; tone?: string }) {
  const colors: Record<string, string> = {
    pulse: "var(--pulse)",
    ember: "var(--ember)",
    haze: "var(--haze)",
    bone: "var(--bone)",
  };
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          color: "var(--haze)",
          marginBottom: 4,
        }}
      >
        {k}
      </div>
      <div
        style={{
          fontFamily: "var(--display)",
          fontWeight: 600,
          fontSize: 15,
          color: colors[tone] || colors.bone,
        }}
      >
        {v}
      </div>
    </div>
  );
}

// ── Create company overlay ─────────────────────────────────────────────

function CreateCompanyOverlay({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(10,10,15,.7)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "100%",
          background: "var(--ink)",
          border: "1px solid rgba(255,255,255,.1)",
          borderRadius: "var(--r-lg)",
          padding: 32,
          animation: "enter-up .35s var(--ease-out-expo) both",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <Eyebrow>new company</Eyebrow>
          <button
            onClick={onClose}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: 0,
              color: "var(--haze)",
              cursor: "pointer",
              display: "inline-flex",
            }}
          >
            <I.x />
          </button>
        </div>

        <h2
          style={{
            fontFamily: "var(--display)",
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: "-.02em",
            margin: "0 0 8px",
            color: "var(--bone)",
          }}
        >
          What should Trent build?
        </h2>
        <p style={{ fontSize: 14, color: "#B8B2A4", lineHeight: 1.6, margin: "0 0 28px" }}>
          A name, a sentence about the vision, and Trent does the rest.
        </p>

        <form onSubmit={onCreate} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Field label="company name">
            <input className="input" name="name" placeholder="Helio Notes" required />
          </Field>
          <Field label="website">
            <input className="input" name="website" placeholder="https://example.com" />
          </Field>
          <Field label="vision">
            <textarea
              className="input"
              name="vision"
              rows={3}
              placeholder="A calm journaling app for writers and operators."
              style={{ resize: "none" }}
            />
          </Field>
          <Field label="ideal customer">
            <input className="input" name="icp" placeholder="Solo writers, indie hackers, ops leads" />
          </Field>
          <Field label="offer">
            <input className="input" name="offer" placeholder="What does it sell?" />
          </Field>
          <Field label="monthly budget ($)">
            <input className="input" name="budget" type="number" min="0" defaultValue="100" />
          </Field>

          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <button type="button" onClick={onClose} className="btn btn-secondary">
              cancel
            </button>
            <button
              type="submit"
              className="btn btn-pulse"
              style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              create &amp; run first cycle
              <I.arrowRight width={14} height={14} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: ".18em",
          textTransform: "uppercase",
          color: "var(--mist)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
