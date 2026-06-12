"use client";

import React, { useEffect, useState, useMemo, useCallback } from "react";
import {
  AGENT_SLOTS,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
  SLOT_CONTRACTS,
  SLOT_ENVIRONMENTS,
  type CatalogCategory,
} from "@/lib/agent-catalog";
import type { AgentAccessState, CatalogAgentWithAccess } from "@/lib/agent-marketplace";
import type { SeatToolContract } from "@/lib/seat-tool-contracts";
import type { AgentEnvironmentConfig, AgentRole } from "@/lib/types";
import { I } from "@/components/ui";

// ── Types ─────────────────────────────────────────────────────────────────────

type SlotAssignment = Record<string, string | null>;

type PlugPayload = {
  catalog: CatalogAgentWithAccess[];
  slots: SlotAssignment;
  environments: Partial<Record<AgentRole, AgentEnvironmentConfig>>;
  toolContracts: Partial<Record<AgentRole, SeatToolContract[]>>;
};

// ── Slot authority metadata ──────────────────────────────────────────────────

type AuthorityKind = "coordinate" | "execute" | "verify" | "guard" | "block";

const SLOT_AUTHORITY: Record<string, { kind: AuthorityKind; label: string; color: string }> = {
  ceo:        { kind: "coordinate", label: "Coordinator",  color: "#6EE7B7" },
  engineer:   { kind: "execute",    label: "Executor",     color: "#06B6D4" },
  growth:     { kind: "execute",    label: "Executor",     color: "#10B981" },
  content:    { kind: "execute",    label: "Executor",     color: "#6366F1" },
  support:    { kind: "execute",    label: "Executor",     color: "#F97316" },
  analyst:    { kind: "verify",     label: "Verifier",     color: "#A78BFA" },
  finance:    { kind: "guard",      label: "Guard",        color: "#84CC16" },
  browser:    { kind: "execute",    label: "Executor",     color: "#EC4899" },
  escalation: { kind: "block",      label: "Blocker",      color: "#EF4444" },
};

// ── Category rail config ──────────────────────────────────────────────────────

const ALL_CATEGORIES: (CatalogCategory | "all")[] = [
  "all",
  "engineering",
  "design",
  "marketing",
  "paid-media",
  "sales",
  "product",
  "project-management",
  "testing",
  "support",
  "finance",
  "spatial-computing",
  "academic",
  "specialized",
];

const CATEGORY_EMOJI: Record<CatalogCategory | "all", string> = {
  all: "✦",
  engineering: "💻",
  design: "🎨",
  marketing: "📢",
  "paid-media": "💰",
  sales: "💼",
  product: "📊",
  "project-management": "🎬",
  testing: "🧪",
  support: "🛟",
  finance: "📈",
  "spatial-computing": "🥽",
  academic: "🎓",
  specialized: "🎯",
};

function cents(n: number) {
  if (n === 0) return "free";
  return `$${(n / 100).toFixed(0)}`;
}

export function agentTrustSignals(agent: Pick<CatalogAgentWithAccess, "skills" | "capability">): string[] {
  const skillSignals = (agent.skills ?? []).slice(0, 3);
  const capability = agent.capability;
  const capabilitySignal = capability
    ? [`${capability.qualityLabel}${typeof capability.score === "number" ? ` ${capability.score}` : ""}`]
    : [];
  return [...capabilitySignal, ...skillSignals];
}

// ── Access badge ──────────────────────────────────────────────────────────────

function AccessBadge({ access, priceCents }: { access: AgentAccessState; priceCents: number }) {
  if (access === "included") {
    return (
      <span style={badgeStyle("rgba(110,231,183,.1)", "rgba(110,231,183,.25)", "var(--pulse)")}>
        free
      </span>
    );
  }
  if (access === "entitled") {
    return (
      <span style={badgeStyle("rgba(110,231,183,.07)", "rgba(110,231,183,.15)", "var(--pulse)")}>
        ✓ unlocked
      </span>
    );
  }
  return (
    <span style={badgeStyle("rgba(251,146,60,.07)", "rgba(251,146,60,.2)", "var(--ember)")}>
      🔒 {cents(priceCents)}
    </span>
  );
}

function badgeStyle(bg: string, border: string, color: string): React.CSSProperties {
  return {
    padding: "2px 7px",
    borderRadius: 5,
    background: bg,
    border: `1px solid ${border}`,
    color,
    fontSize: 9,
    fontFamily: "var(--mono)",
    letterSpacing: ".12em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };
}

function AuthorityBadge({ role }: { role: string }) {
  const auth = SLOT_AUTHORITY[role];
  if (!auth) return null;
  return (
    <span
      style={{
        padding: "1px 6px",
        borderRadius: 4,
        background: `${auth.color}14`,
        border: `1px solid ${auth.color}30`,
        color: auth.color,
        fontSize: 8,
        fontFamily: "var(--mono)",
        letterSpacing: ".14em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {auth.label}
    </span>
  );
}

// ── Main client ───────────────────────────────────────────────────────────────

export function AgentPlugClient({ companyId }: { companyId: string }) {
  const [payload, setPayload] = useState<PlugPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<CatalogCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [drawerAgent, setDrawerAgent] = useState<CatalogAgentWithAccess | null>(null);
  const [drawerRole, setDrawerRole] = useState<string | null>(null);
  const [view, setView] = useState<"catalog" | "slots">("slots");
  const [unlockModal, setUnlockModal] = useState<CatalogAgentWithAccess | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [showCouncil, setShowCouncil] = useState(false);

  const loadPayload = useCallback(async () => {
    try {
      const res = await fetch(`/api/agent-plug?companyId=${companyId}`);
      const data = await res.json();
      setPayload({
        catalog: data.catalog ?? [],
        slots: data.slots ?? {},
        environments: data.environments ?? {},
        toolContracts: data.toolContracts ?? {},
      });
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { loadPayload(); }, [loadPayload]);

  const catalog = payload?.catalog ?? [];
  const slots = payload?.slots ?? {};
  const environments = payload?.environments ?? {};
  const toolContracts = payload?.toolContracts ?? {};

  const filtered = useMemo(() => {
    let list = catalog;
    if (activeCategory !== "all") list = list.filter((a) => a.category === activeCategory);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.specialties.toLowerCase().includes(q) ||
          a.whenToUse.toLowerCase().includes(q)
      );
    }
    return list;
  }, [catalog, activeCategory, search]);

  async function assign(role: string, catalogAgentId: string | null, agent?: CatalogAgentWithAccess) {
    setSaving(role);
    try {
      const res = await fetch("/api/agent-plug", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, role, catalogAgentId }),
      });
      if (res.status === 402 && agent) {
        setUnlockModal(agent);
        return;
      }
      if (res.ok) {
        setPayload((prev) =>
          prev ? { ...prev, slots: { ...prev.slots, [role]: catalogAgentId } } : prev
        );
        setDrawerAgent(null);
        setDrawerRole(null);
      }
    } finally {
      setSaving(null);
    }
  }

  async function mockUnlock(agent: CatalogAgentWithAccess, productId: string, thenAssignRole?: string) {
    setUnlocking(true);
    try {
      const res = await fetch("/api/agent-marketplace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, productId, action: "mock_purchase" }),
      });
      if (res.ok) {
        const data = await res.json();
        setPayload((prev) =>
          prev ? { ...prev, catalog: data.catalog ?? prev.catalog } : prev
        );
        setUnlockModal(null);
        if (thenAssignRole) await assign(thenAssignRole, agent.id);
      }
    } finally {
      setUnlocking(false);
    }
  }

  function slotAgent(role: string): CatalogAgentWithAccess | null {
    const id = slots[role];
    return id ? (catalog.find((a) => a.id === id) ?? null) : null;
  }

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 320 }}>
        <div className="spinner" style={{ width: 22, height: 22, borderWidth: 2 }} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <div className="mono" style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--pulse)", marginBottom: 8 }}>
            agent plug
          </div>
          <h1 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 26, letterSpacing: "-.02em", color: "var(--bone)", margin: "0 0 8px" }}>
            Staff Your AI Company
          </h1>
          <p style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.6, maxWidth: "60ch", margin: 0 }}>
            9 executive seats. 164 specialist profiles from The Agency. Swap who sits in each seat without changing its authority — the office defines the rules, the profile defines the person.
          </p>
        </div>

        {/* Stats */}
        <div style={{ display: "flex", gap: 20, flexShrink: 0 }}>
          {[
            { label: "profiles", value: catalog.length, color: "var(--bone)" },
            { label: "free", value: catalog.filter((a) => a.access === "included").length, color: "var(--pulse)" },
            { label: "seats filled", value: Object.values(slots).filter(Boolean).length, color: "var(--ember)" },
          ].map((s) => (
            <div key={s.label} style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 24, color: s.color }}>
                {s.value}
              </div>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)", marginTop: 2 }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Operating Council toggle ─────────────────────────────────────── */}
      <button
        onClick={() => setShowCouncil((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 24,
          padding: "8px 14px",
          borderRadius: 8,
          background: showCouncil ? "rgba(110,231,183,.07)" : "var(--ink)",
          border: showCouncil ? "1px solid rgba(110,231,183,.2)" : "1px solid rgba(255,255,255,.07)",
          color: showCouncil ? "var(--pulse)" : "var(--mist)",
          fontSize: 11,
          fontFamily: "var(--mono)",
          letterSpacing: ".12em",
          textTransform: "uppercase",
          cursor: "pointer",
          transition: "all .2s",
        }}
      >
        <I.sparkle style={{ width: 13, height: 13 }} />
        operating council
        <I.chevR style={{ width: 12, height: 12, transform: showCouncil ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
      </button>

      {showCouncil && (
        <OperatingCouncil slots={slots} slotAgent={slotAgent} />
      )}

      {/* ── View tabs ────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {(["slots", "catalog"] as const).map((v) => (
          <button
            key={v}
            onClick={() => {
              setView(v);
              if (v === "catalog") setDrawerRole(null);
            }}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              border: view === v ? "1px solid rgba(110,231,183,.35)" : "1px solid rgba(255,255,255,.07)",
              background: view === v ? "rgba(110,231,183,.08)" : "var(--ink)",
              color: view === v ? "var(--pulse)" : "var(--mist)",
              fontFamily: "var(--mono)",
              fontSize: 11,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              cursor: "pointer",
              transition: "all .18s",
            }}
          >
            {v === "slots" ? `◈ my seats (9)` : `✦ agent catalog (${catalog.length})`}
          </button>
        ))}
      </div>

      {view === "slots" ? (
        <SlotsView
          slots={slots}
          environments={environments}
          toolContracts={toolContracts}
          saving={saving}
          slotAgent={slotAgent}
          onOpenDrawer={(role) => {
            setDrawerRole(role);
            setView("catalog");
          }}
          onClear={(role) => assign(role, null)}
        />
      ) : (
        <CatalogView
          filtered={filtered}
          activeCategory={activeCategory}
          search={search}
          drawerRole={drawerRole}
          slots={slots}
          saving={saving}
          totalCount={catalog.length}
          catalog={catalog}
          onCategoryChange={setActiveCategory}
          onSearchChange={setSearch}
          onSelectAgent={(agent) => {
            if (drawerRole) assign(drawerRole, agent.id, agent);
            else setDrawerAgent(agent);
          }}
          onPreviewAgent={setDrawerAgent}
        />
      )}

      {drawerAgent && (
        <AgentDrawer
          agent={drawerAgent}
          slots={slots}
          saving={saving}
          onAssign={(role) => assign(role, drawerAgent.id, drawerAgent)}
          onUnlock={() => setUnlockModal(drawerAgent)}
          onClose={() => setDrawerAgent(null)}
        />
      )}

      {unlockModal && (
        <UnlockModal
          agent={unlockModal}
          unlocking={unlocking}
          pendingRole={drawerRole}
          onMockPurchase={(productId, thenAssignRole) => mockUnlock(unlockModal, productId, thenAssignRole ?? undefined)}
          onClose={() => setUnlockModal(null)}
        />
      )}
    </div>
  );
}

// ── Operating Council ─────────────────────────────────────────────────────────

function OperatingCouncil({
  slots,
  slotAgent,
}: {
  slots: SlotAssignment;
  slotAgent: (role: string) => CatalogAgentWithAccess | null;
}) {
  const layers = [
    {
      label: "Human Founder",
      sublabel: "Final authority on all gated actions — approves, rejects, overrides",
      kind: "human" as const,
      slots: [] as typeof AGENT_SLOTS,
    },
    {
      label: "Coordination",
      sublabel: "Sets priorities and sequences work across all seats",
      kind: "coordinate" as const,
      slots: AGENT_SLOTS.filter((s) => SLOT_AUTHORITY[s.role]?.kind === "coordinate"),
    },
    {
      label: "Execution",
      sublabel: "Domain specialists that build, grow, create, support, and research",
      kind: "execute" as const,
      slots: AGENT_SLOTS.filter((s) => SLOT_AUTHORITY[s.role]?.kind === "execute"),
    },
    {
      label: "Checks",
      sublabel: "Verify data, guard spend, and block risky or irreversible actions",
      kind: "check" as const,
      slots: AGENT_SLOTS.filter((s) => ["verify", "guard", "block"].includes(SLOT_AUTHORITY[s.role]?.kind)),
    },
  ];

  return (
    <div
      style={{
        background: "var(--ink)",
        border: "1px solid rgba(255,255,255,.07)",
        borderRadius: "var(--r-md)",
        padding: 24,
        marginBottom: 28,
        animation: "enter-up .2s var(--ease-out-expo) both",
      }}
    >
      <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 20 }}>
        operating hierarchy · plugged profiles do not change seat authority
      </div>

      {layers.map((layer, li) => (
        <div key={layer.label}>
          {/* Connector line */}
          {li > 0 && (
            <div style={{ display: "flex", justifyContent: "center", margin: "8px 0" }}>
              <div style={{ width: 1, height: 20, background: "rgba(255,255,255,.08)" }} />
            </div>
          )}

          <div
            style={{
              padding: "12px 16px",
              borderRadius: 10,
              border: layer.kind === "human"
                ? "1px solid rgba(110,231,183,.25)"
                : "1px solid rgba(255,255,255,.06)",
              background: layer.kind === "human"
                ? "rgba(110,231,183,.05)"
                : "rgba(255,255,255,.02)",
              marginBottom: 4,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: layer.kind === "human" ? "var(--pulse)" : "var(--bone)", marginBottom: 3 }}>
                  {layer.label}
                </div>
                <div style={{ fontSize: 11, color: "var(--haze)" }}>{layer.sublabel}</div>
              </div>

              {/* Seat chips */}
              {layer.slots.length > 0 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {layer.slots.map((slot) => {
                    const agent = slotAgent(slot.role);
                    const auth = SLOT_AUTHORITY[slot.role];
                    return (
                      <div
                        key={slot.role}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "5px 10px",
                          borderRadius: 7,
                          background: slots[slot.role] ? `${auth?.color}10` : "rgba(255,255,255,.03)",
                          border: `1px solid ${slots[slot.role] ? `${auth?.color}30` : "rgba(255,255,255,.07)"}`,
                        }}
                      >
                        <div style={{ fontSize: 13 }}>{agent?.emoji ?? "·"}</div>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--bone)", lineHeight: 1.2 }}>
                            {agent?.name ?? slot.defaultName}
                          </div>
                          <div className="mono" style={{ fontSize: 8, letterSpacing: ".12em", color: auth?.color ?? "var(--haze)", textTransform: "uppercase" }}>
                            {slot.label}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {layer.kind === "human" && (
                <div
                  style={{
                    padding: "5px 12px",
                    borderRadius: 7,
                    background: "rgba(110,231,183,.08)",
                    border: "1px solid rgba(110,231,183,.2)",
                    color: "var(--pulse)",
                    fontSize: 11,
                    fontFamily: "var(--mono)",
                    letterSpacing: ".1em",
                  }}
                >
                  you
                </div>
              )}
            </div>
          </div>
        </div>
      ))}

      <div
        style={{
          marginTop: 14,
          padding: "9px 14px",
          borderRadius: 8,
          background: "rgba(239,68,68,.04)",
          border: "1px solid rgba(239,68,68,.12)",
          fontSize: 11,
          color: "var(--mist)",
          lineHeight: 1.55,
        }}
      >
        <span style={{ color: "var(--danger)" }}>◈ authority is seat-level, not profile-level.</span>{" "}
        Swapping an SEO Specialist into the Growth seat keeps Growth permissions and approval gates. The specialist changes <em>what</em> it does well, not <em>what</em> it's allowed to do.
      </div>
    </div>
  );
}

// ── Catalog View ──────────────────────────────────────────────────────────────

function CatalogView({
  filtered,
  activeCategory,
  search,
  drawerRole,
  slots,
  saving,
  totalCount,
  catalog,
  onCategoryChange,
  onSearchChange,
  onSelectAgent,
  onPreviewAgent,
}: {
  filtered: CatalogAgentWithAccess[];
  activeCategory: CatalogCategory | "all";
  search: string;
  drawerRole: string | null;
  slots: SlotAssignment;
  saving: string | null;
  totalCount: number;
  catalog: CatalogAgentWithAccess[];
  onCategoryChange: (c: CatalogCategory | "all") => void;
  onSearchChange: (s: string) => void;
  onSelectAgent: (a: CatalogAgentWithAccess) => void;
  onPreviewAgent: (a: CatalogAgentWithAccess) => void;
}) {
  const slotInfo = drawerRole ? AGENT_SLOTS.find((s) => s.role === drawerRole) : null;

  // Count per category (from full catalog, not filtered)
  const catCount = useMemo(() => {
    const m: Record<string, number> = { all: catalog.length };
    for (const a of catalog) m[a.category] = (m[a.category] ?? 0) + 1;
    return m;
  }, [catalog]);

  return (
    <>
      {/* Assigning-for banner */}
      {drawerRole && slotInfo && (
        <div
          style={{
            padding: "10px 16px",
            marginBottom: 16,
            borderRadius: 10,
            background: "rgba(110,231,183,.06)",
            border: "1px solid rgba(110,231,183,.18)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ color: "var(--pulse)" }}>◈</span>
          <span style={{ fontSize: 13, color: "var(--bone)" }}>
            Selecting profile for{" "}
            <strong style={{ color: "var(--pulse)" }}>{slotInfo.label}</strong> seat
            {" "}—{" "}
            <span style={{ color: "var(--mist)", fontSize: 12 }}>
              {SLOT_CONTRACTS[slotInfo.role as AgentRole]?.mission}
            </span>
          </span>
        </div>
      )}

      {/* Category rail — horizontal scroll */}
      <div
        style={{
          overflowX: "auto",
          display: "flex",
          gap: 6,
          marginBottom: 16,
          paddingBottom: 4,
          scrollbarWidth: "none",
        }}
      >
        {ALL_CATEGORIES.map((cat) => {
          const active = activeCategory === cat;
          const color = cat === "all" ? "var(--mist)" : CATEGORY_COLORS[cat as CatalogCategory];
          const count = catCount[cat] ?? 0;
          return (
            <button
              key={cat}
              onClick={() => onCategoryChange(cat)}
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "5px 11px",
                borderRadius: 20,
                border: active ? `1px solid ${color}55` : "1px solid rgba(255,255,255,.07)",
                background: active ? `${color}14` : "transparent",
                color: active ? color : "var(--haze)",
                fontSize: 11,
                fontFamily: "var(--mono)",
                letterSpacing: ".08em",
                cursor: "pointer",
                transition: "all .15s",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ fontSize: 13 }}>{CATEGORY_EMOJI[cat]}</span>
              <span style={{ textTransform: "capitalize" }}>
                {cat === "all" ? "all" : CATEGORY_LABELS[cat as CatalogCategory]}
              </span>
              <span style={{ fontSize: 9, opacity: 0.55 }}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div style={{ position: "relative", marginBottom: 16 }}>
        <span
          style={{
            position: "absolute",
            left: 14,
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--haze)",
            pointerEvents: "none",
            display: "flex",
          }}
        >
          <I.search style={{ width: 14, height: 14 }} />
        </span>
        <input
          className="input"
          placeholder="Search profiles, specialties, or use cases…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          style={{ width: "100%", paddingLeft: 38, boxSizing: "border-box" }}
        />
      </div>

      {/* Table */}
      <div
        style={{
          background: "var(--ink)",
          border: "1px solid rgba(255,255,255,.07)",
          borderRadius: "var(--r-md)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(180px, 2fr) minmax(180px, 2.5fr) minmax(180px, 2.5fr) 140px",
            padding: "9px 18px",
            borderBottom: "1px solid rgba(255,255,255,.05)",
            background: "rgba(0,0,0,.18)",
          }}
        >
          {["Agent", "Specialties", "When to Use", ""].map((h) => (
            <div key={h} className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)" }}>
              {h}
            </div>
          ))}
        </div>

        {/* Rows */}
        {filtered.length === 0 ? (
          <div style={{ padding: "48px 20px", textAlign: "center", color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 13 }}>
            No profiles match.
          </div>
        ) : (
          filtered.map((agent, i) => {
            const catColor = CATEGORY_COLORS[agent.category];
            const isAssigned = Object.values(slots).includes(agent.id);
            const isThisSlot = drawerRole ? slots[drawerRole] === agent.id : false;
            const isLocked = agent.access === "locked";

            return (
              <div
                key={agent.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(180px, 2fr) minmax(180px, 2.5fr) minmax(180px, 2.5fr) 140px",
                  padding: "12px 18px",
                  borderBottom: i < filtered.length - 1 ? "1px solid rgba(255,255,255,.04)" : "none",
                  alignItems: "center",
                  background: isThisSlot ? "rgba(110,231,183,.04)" : "transparent",
                  transition: "background .15s",
                }}
                onMouseEnter={(e) => {
                  if (!isThisSlot) (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,.02)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = isThisSlot ? "rgba(110,231,183,.04)" : "transparent";
                }}
              >
                {/* Name */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 9,
                      background: isLocked ? "rgba(255,255,255,.03)" : `${catColor}16`,
                      border: isLocked ? "1px solid rgba(255,255,255,.06)" : `1px solid ${catColor}28`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 15,
                      flexShrink: 0,
                      filter: isLocked ? "grayscale(0.5)" : "none",
                    }}
                  >
                    {agent.emoji}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        color: isLocked ? "var(--mist)" : "var(--bone)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        marginBottom: 3,
                      }}
                    >
                      {agent.name}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                      <span
                        className="mono"
                        style={{ fontSize: 8, letterSpacing: ".12em", textTransform: "uppercase", color: catColor }}
                      >
                        {CATEGORY_LABELS[agent.category]}
                      </span>
                      <AccessBadge access={agent.access} priceCents={agent.priceCents} />
                      {agentTrustSignals(agent).slice(0, 2).map((signal) => (
                        <span key={signal} style={badgeStyle("rgba(255,255,255,.03)", "rgba(255,255,255,.08)", "var(--haze)")}>
                          {signal}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Specialties */}
                <div style={{ fontSize: 11, color: "var(--mist)", lineHeight: 1.5, paddingRight: 14 }}>
                  {agent.specialties}
                </div>

                {/* When to use */}
                <div style={{ fontSize: 11, color: "var(--mist)", lineHeight: 1.5, paddingRight: 14 }}>
                  {agent.whenToUse}
                </div>

                {/* Action */}
                <div style={{ display: "flex", gap: 5, justifyContent: "flex-end", alignItems: "center" }}>
                  {drawerRole ? (
                    <button
                      onClick={() => onSelectAgent(agent)}
                      style={{
                        padding: "5px 11px",
                        borderRadius: 7,
                        background: isLocked
                          ? "rgba(251,146,60,.07)"
                          : isThisSlot
                          ? "rgba(110,231,183,.14)"
                          : "rgba(110,231,183,.07)",
                        border: `1px solid ${isLocked ? "rgba(251,146,60,.22)" : isThisSlot ? "rgba(110,231,183,.4)" : "rgba(110,231,183,.18)"}`,
                        color: isLocked ? "var(--ember)" : "var(--pulse)",
                        fontSize: 10,
                        fontFamily: "var(--mono)",
                        letterSpacing: ".1em",
                        cursor: "pointer",
                      }}
                    >
                      {isLocked ? "🔒 unlock" : isThisSlot ? "✓ active" : "assign"}
                    </button>
                  ) : (
                    <>
                      {isAssigned && (
                        <span style={badgeStyle("rgba(110,231,183,.06)", "rgba(110,231,183,.15)", "var(--pulse)")}>
                          in use
                        </span>
                      )}
                      <button
                        onClick={() => onPreviewAgent(agent)}
                        style={{
                          padding: "5px 11px",
                          borderRadius: 7,
                          background: "var(--steel)",
                          border: "1px solid rgba(255,255,255,.07)",
                          color: "var(--mist)",
                          fontSize: 10,
                          fontFamily: "var(--mono)",
                          letterSpacing: ".1em",
                          cursor: "pointer",
                        }}
                      >
                        view
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="mono" style={{ fontSize: 9, color: "var(--haze)", textAlign: "center", marginTop: 12, letterSpacing: ".12em" }}>
        {filtered.length} of {totalCount} profiles · agency-agents by msitarzewski · game-development excluded
      </div>
    </>
  );
}

// ── Slots View ────────────────────────────────────────────────────────────────

function SlotsView({
  slots,
  environments,
  toolContracts,
  saving,
  slotAgent,
  onOpenDrawer,
  onClear,
}: {
  slots: SlotAssignment;
  environments: Partial<Record<AgentRole, AgentEnvironmentConfig>>;
  toolContracts: Partial<Record<AgentRole, SeatToolContract[]>>;
  saving: string | null;
  slotAgent: (role: string) => CatalogAgentWithAccess | null;
  onOpenDrawer: (role: string) => void;
  onClear: (role: string) => void;
}) {
  const [expandedSlot, setExpandedSlot] = useState<string | null>(null);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
      {AGENT_SLOTS.map((slot) => {
        const agent = slotAgent(slot.role);
        const isSaving = saving === slot.role;
        const isExpanded = expandedSlot === slot.role;
        const auth = SLOT_AUTHORITY[slot.role];
        const catColor = agent ? CATEGORY_COLORS[agent.category] : auth?.color ?? "var(--haze)";
        const env = environments[slot.role as AgentRole] ?? SLOT_ENVIRONMENTS[slot.role as AgentRole];
        const contracts = toolContracts[slot.role as AgentRole] ?? [];
        const contract = SLOT_CONTRACTS[slot.role as AgentRole];

        return (
          <div
            key={slot.role}
            style={{
              background: "var(--ink)",
              border: `1px solid ${agent ? `${catColor}28` : "rgba(255,255,255,.06)"}`,
              borderRadius: "var(--r-md)",
              overflow: "hidden",
              transition: "border-color .2s",
            }}
          >
            {/* Seat authority accent */}
            <div
              style={{
                height: 2,
                background: `linear-gradient(90deg, ${auth?.color ?? "transparent"}60, transparent)`,
              }}
            />

            <div style={{ padding: 18 }}>
              {/* Seat header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: auth?.color ?? "var(--haze)" }}>
                    {slot.label}
                  </div>
                  <AuthorityBadge role={slot.role} />
                </div>
                {agent && <AccessBadge access={agent.access} priceCents={agent.priceCents} />}
              </div>

              {/* Profile or empty */}
              {agent ? (
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 12 }}>
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 10,
                      background: `${catColor}16`,
                      border: `1px solid ${catColor}30`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 17,
                      flexShrink: 0,
                    }}
                  >
                    {agent.emoji}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--bone)", marginBottom: 3, lineHeight: 1.3 }}>
                      {agent.name}
                    </div>
                    <div className="mono" style={{ fontSize: 8, letterSpacing: ".12em", textTransform: "uppercase", color: catColor }}>
                      {CATEGORY_LABELS[agent.category]}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, opacity: 0.45 }}>
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 10,
                      background: "rgba(255,255,255,.03)",
                      border: "1px dashed rgba(255,255,255,.1)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--haze)",
                      fontSize: 16,
                    }}
                  >
                    +
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--haze)", fontWeight: 500, marginBottom: 2 }}>
                      {slot.defaultName}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--haze)" }}>Default profile</div>
                  </div>
                </div>
              )}

              {/* Seat mission */}
              <div style={{ fontSize: 11, color: "var(--haze)", lineHeight: 1.55, marginBottom: 12 }}>
                {contract?.mission}
              </div>

              {/* Routing intent — shown when a profile is plugged */}
              {agent && (
                <div
                  style={{
                    padding: "8px 10px",
                    borderRadius: 7,
                    background: `${catColor}08`,
                    border: `1px solid ${catColor}20`,
                    marginBottom: 12,
                  }}
                >
                  <div className="mono" style={{ fontSize: 8, letterSpacing: ".16em", textTransform: "uppercase", color: catColor, marginBottom: 4 }}>
                    routes to this seat
                  </div>
                  <div style={{ fontSize: 11, color: "var(--mist)", lineHeight: 1.45 }}>
                    {agent.specialties}
                  </div>
                </div>
              )}

              {/* Expandable env detail */}
              {env && (
                <>
                  <button
                    onClick={() => setExpandedSlot(isExpanded ? null : slot.role)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      width: "100%",
                      padding: "5px 8px",
                      borderRadius: 6,
                      background: "rgba(255,255,255,.02)",
                      border: "1px solid rgba(255,255,255,.05)",
                      color: "var(--haze)",
                      fontSize: 9,
                      fontFamily: "var(--mono)",
                      letterSpacing: ".14em",
                      textTransform: "uppercase",
                      cursor: "pointer",
                      marginBottom: isExpanded ? 8 : 12,
                    }}
                  >
                    seat environment
                    <I.chevR style={{ width: 11, height: 11, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
                  </button>

                  {isExpanded && (
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 7,
                        background: "rgba(0,0,0,.2)",
                        border: "1px solid rgba(255,255,255,.05)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                        marginBottom: 12,
                        animation: "enter-up .15s ease both",
                      }}
                    >
                      <EnvLine label="Tools" value={(env.tools ?? SLOT_ENVIRONMENTS[slot.role as AgentRole]?.tools ?? []).join(", ") || "none"} />
                      <SeatToolBadges contracts={contracts} />
                      <EnvLine label="Approval gates" value={(env.approvalRequiredFor ?? SLOT_ENVIRONMENTS[slot.role as AgentRole]?.approvalRequiredFor ?? []).join(", ") || "none"} />
                      <EnvLine label="Budget / run" value={`${env.budgetCentsPerRun ?? SLOT_ENVIRONMENTS[slot.role as AgentRole]?.budgetCentsPerRun ?? 0}¢`} />
                      <EnvLine label="Max runtime" value={`${env.maxRuntimeSeconds ?? SLOT_ENVIRONMENTS[slot.role as AgentRole]?.maxRuntimeSeconds ?? 0}s`} />
                      <EnvLine label="Outputs" value={(env.outputContract ?? SLOT_ENVIRONMENTS[slot.role as AgentRole]?.outputContract ?? []).join(", ")} />
                    </div>
                  )}
                </>
              )}

              {/* Actions */}
              <div style={{ display: "flex", gap: 7 }}>
                <button
                  onClick={() => onOpenDrawer(slot.role)}
                  disabled={isSaving}
                  style={{
                    flex: 1,
                    padding: "7px 10px",
                    borderRadius: 7,
                    background: "rgba(110,231,183,.06)",
                    border: "1px solid rgba(110,231,183,.18)",
                    color: isSaving ? "var(--haze)" : "var(--pulse)",
                    fontSize: 10,
                    fontFamily: "var(--mono)",
                    letterSpacing: ".1em",
                    textTransform: "uppercase",
                    cursor: isSaving ? "not-allowed" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 5,
                  }}
                >
                  {isSaving ? (
                    <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />
                  ) : (
                    <>
                      <I.plug style={{ width: 11, height: 11 }} />
                      {agent ? "swap" : "plug in"}
                    </>
                  )}
                </button>
                {agent && !isSaving && (
                  <button
                    onClick={() => onClear(slot.role)}
                    style={{
                      padding: "7px 9px",
                      borderRadius: 7,
                      background: "transparent",
                      border: "1px solid rgba(255,255,255,.06)",
                      color: "var(--haze)",
                      cursor: "pointer",
                    }}
                    title="Remove profile"
                  >
                    <I.x style={{ width: 11, height: 11 }} />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SeatToolBadges({ contracts }: { contracts: SeatToolContract[] }) {
  if (!contracts.length) {
    return <EnvLine label="Tool readiness" value="no contract data" />;
  }
  const visible = contracts.slice(0, 8);
  return (
    <div>
      <div className="mono" style={{ fontSize: 7, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 4 }}>
        Tool readiness
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {visible.map((contract) => (
          <span
            key={`${contract.seat}:${contract.tool}`}
            className="mono"
            data-testid="seat-tool-readiness"
            style={{
              fontSize: 8,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: readinessColor(contract.readiness),
              border: `1px solid ${readinessBorder(contract.readiness)}`,
              borderRadius: 6,
              padding: "3px 5px",
              background: "rgba(255,255,255,.025)",
            }}
          >
            {contract.tool}: {contract.readiness}
          </span>
        ))}
        {contracts.length > visible.length && (
          <span className="mono" style={{ fontSize: 8, color: "var(--haze)", padding: "3px 0" }}>
            +{contracts.length - visible.length}
          </span>
        )}
      </div>
    </div>
  );
}

function readinessColor(readiness: SeatToolContract["readiness"]) {
  if (readiness === "connected" || readiness === "internal") return "var(--pulse)";
  if (readiness === "mocked") return "var(--mist)";
  if (readiness === "needs_credentials") return "var(--ember)";
  return "var(--haze)";
}

function readinessBorder(readiness: SeatToolContract["readiness"]) {
  if (readiness === "connected" || readiness === "internal") return "rgba(110,231,183,.22)";
  if (readiness === "mocked") return "rgba(148,163,184,.2)";
  if (readiness === "needs_credentials") return "rgba(251,146,60,.22)";
  return "rgba(255,255,255,.08)";
}

function EnvLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 7, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 1 }}>
        {label}
      </div>
      <div style={{ fontSize: 10, color: "var(--mist)", lineHeight: 1.4, wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

// ── Agent Drawer ──────────────────────────────────────────────────────────────

function AgentDrawer({
  agent,
  slots,
  saving,
  onAssign,
  onUnlock,
  onClose,
}: {
  agent: CatalogAgentWithAccess;
  slots: SlotAssignment;
  saving: string | null;
  onAssign: (role: string) => void;
  onUnlock: () => void;
  onClose: () => void;
}) {
  const catColor = CATEGORY_COLORS[agent.category];
  const currentSlot = AGENT_SLOTS.find((s) => slots[s.role] === agent.id);
  const isLocked = agent.access === "locked";

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 40 }} />
      <div
        style={{
          position: "fixed",
          right: 0,
          top: 0,
          bottom: 0,
          width: 440,
          background: "var(--ink)",
          borderLeft: `1px solid ${catColor}22`,
          zIndex: 41,
          overflowY: "auto",
          animation: "enter-up .25s var(--ease-out-expo) both",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Accent */}
        <div style={{ height: 2, background: `linear-gradient(90deg, ${catColor}, transparent)` }} />

        {/* Header */}
        <div style={{ padding: "22px 24px 18px", borderBottom: "1px solid rgba(255,255,255,.05)", background: `${catColor}05` }}>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 13,
                background: isLocked ? "rgba(255,255,255,.04)" : `${catColor}16`,
                border: isLocked ? "1px solid rgba(255,255,255,.08)" : `1px solid ${catColor}30`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 22,
                flexShrink: 0,
                filter: isLocked ? "grayscale(0.4)" : "none",
              }}
            >
              {agent.emoji}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5, flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: catColor }}>
                  {CATEGORY_LABELS[agent.category]}
                </span>
                <AccessBadge access={agent.access} priceCents={agent.priceCents} />
                {currentSlot && (
                  <span style={badgeStyle("rgba(110,231,183,.08)", "rgba(110,231,183,.2)", "var(--pulse)")}>
                    ✓ {currentSlot.label}
                  </span>
                )}
              </div>
              <h2 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 19, color: isLocked ? "var(--mist)" : "var(--bone)", margin: 0, letterSpacing: "-.015em", lineHeight: 1.2 }}>
                {agent.name}
              </h2>
            </div>
            <button
              onClick={onClose}
              style={{ width: 28, height: 28, borderRadius: 7, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.08)", color: "var(--haze)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            >
              <I.x style={{ width: 12, height: 12 }} />
            </button>
          </div>
        </div>

        {/* Locked CTA */}
        {isLocked && (
          <div style={{ margin: "18px 24px 0", padding: "14px", borderRadius: 10, background: "rgba(251,146,60,.06)", border: "1px solid rgba(251,146,60,.18)" }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--bone)", marginBottom: 5 }}>Premium profile</div>
            <div style={{ fontSize: 11, color: "var(--mist)", lineHeight: 1.6, marginBottom: 12 }}>
              Unlock <strong style={{ color: "var(--bone)" }}>{agent.name}</strong> for <strong style={{ color: "var(--ember)" }}>{cents(agent.priceCents)}</strong>, or get the whole {CATEGORY_LABELS[agent.category]} division as a pack.
            </div>
            <button
              onClick={onUnlock}
              style={{ width: "100%", padding: "8px", borderRadius: 7, background: "rgba(251,146,60,.1)", border: "1px solid rgba(251,146,60,.3)", color: "var(--ember)", fontSize: 11, fontFamily: "var(--mono)", letterSpacing: ".1em", textTransform: "uppercase", cursor: "pointer" }}
            >
              🔓 unlock {agent.name}
            </button>
          </div>
        )}

        {/* Body */}
        <div style={{ padding: "20px 24px", flex: 1 }}>
          <DrawerSection label="Specialties" color={catColor}>
            <p style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.7, margin: 0 }}>{agent.specialties}</p>
          </DrawerSection>

          <DrawerSection label="When to Use" color={catColor}>
            <p style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.7, margin: 0 }}>{agent.whenToUse}</p>
          </DrawerSection>

          <DrawerSection label="Trust Signals" color={catColor}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {agentTrustSignals(agent).map((signal) => (
                <span key={signal} style={badgeStyle("rgba(255,255,255,.03)", "rgba(255,255,255,.08)", "var(--haze)")}>
                  {signal}
                </span>
              ))}
            </div>
          </DrawerSection>

          {/* Routing intent per slot */}
          {!isLocked && (
            <DrawerSection label="Routing Intent — what routes here per seat" color={catColor}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {AGENT_SLOTS.map((slot) => {
                  const auth = SLOT_AUTHORITY[slot.role];
                  const isAssigned = slots[slot.role] === agent.id;
                  return (
                    <div
                      key={slot.role}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 7,
                        background: isAssigned ? `${catColor}08` : "rgba(255,255,255,.02)",
                        border: `1px solid ${isAssigned ? `${catColor}25` : "rgba(255,255,255,.05)"}`,
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                          <span style={{ fontSize: 10, fontWeight: 500, color: "var(--bone)" }}>{slot.label}</span>
                          <span className="mono" style={{ fontSize: 7, letterSpacing: ".12em", textTransform: "uppercase", color: auth?.color ?? "var(--haze)" }}>
                            {auth?.label}
                          </span>
                        </div>
                        <div style={{ fontSize: 10, color: "var(--haze)", lineHeight: 1.4 }}>
                          {routingIntent(slot.role as AgentRole, agent)}
                        </div>
                      </div>
                      <button
                        onClick={() => onAssign(slot.role)}
                        disabled={(saving === slot.role) || isAssigned}
                        style={{
                          padding: "4px 9px",
                          borderRadius: 5,
                          background: isAssigned ? `${catColor}10` : "rgba(255,255,255,.04)",
                          border: `1px solid ${isAssigned ? `${catColor}30` : "rgba(255,255,255,.08)"}`,
                          color: isAssigned ? catColor : "var(--haze)",
                          fontSize: 9,
                          fontFamily: "var(--mono)",
                          letterSpacing: ".1em",
                          cursor: isAssigned ? "default" : "pointer",
                          flexShrink: 0,
                        }}
                      >
                        {saving === slot.role ? "…" : isAssigned ? "✓" : "assign"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </DrawerSection>
          )}

          <DrawerSection label="Source" color={catColor}>
            <a
              href={`https://github.com/msitarzewski/agency-agents/blob/main/${agent.file}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: catColor, fontFamily: "var(--mono)", letterSpacing: ".06em", textDecoration: "none" }}
            >
              <I.github style={{ width: 12, height: 12 }} />
              {agent.file}
              <I.external style={{ width: 10, height: 10, opacity: 0.6 }} />
            </a>
          </DrawerSection>
        </div>
      </div>
    </>
  );
}

// Derive a short routing intent string based on slot + profile
function routingIntent(role: AgentRole, agent: CatalogAgentWithAccess): string {
  const env = SLOT_ENVIRONMENTS[role];
  const mission = SLOT_CONTRACTS[role]?.mission ?? "";
  // Show the first 2 tools the seat has, then tie to profile specialty
  const tools = (env?.tools ?? []).slice(0, 2).join(", ");
  return `${mission.split(",")[0]}. Uses: ${tools || "—"}. Profile brings: ${agent.specialties.split(",")[0]}.`;
}

// ── Unlock Modal ──────────────────────────────────────────────────────────────

function UnlockModal({
  agent,
  unlocking,
  pendingRole,
  onMockPurchase,
  onClose,
}: {
  agent: CatalogAgentWithAccess;
  unlocking: boolean;
  pendingRole: string | null;
  onMockPurchase: (productId: string, thenAssignRole?: string | null) => void;
  onClose: () => void;
}) {
  const catColor = CATEGORY_COLORS[agent.category];

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", zIndex: 50 }} />
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 400,
          background: "var(--ink)",
          border: `1px solid ${catColor}28`,
          borderRadius: "var(--r-lg)",
          zIndex: 51,
          overflow: "hidden",
          animation: "enter-up .22s var(--ease-out-expo) both",
        }}
      >
        <div style={{ height: 2, background: `linear-gradient(90deg, ${catColor}, transparent)` }} />
        <div style={{ padding: "24px 24px 20px" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 18 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: `${catColor}14`,
                border: `1px solid ${catColor}28`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 20,
              }}
            >
              {agent.emoji}
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--bone)", letterSpacing: "-.01em" }}>{agent.name}</div>
              <div className="mono" style={{ fontSize: 8, letterSpacing: ".18em", textTransform: "uppercase", color: catColor, marginTop: 2 }}>
                {CATEGORY_LABELS[agent.category]}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.65, marginBottom: 20 }}>
            This is a premium specialist. Unlock it to plug into any seat.
            <br />
            <span style={{ fontSize: 11, color: "var(--haze)" }}>Stripe billing coming — preview unlocks are free during preview.</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
            <UnlockOption
              title={`Unlock ${agent.name}`}
              price={cents(agent.priceCents)}
              description="This profile, any seat"
              loading={unlocking}
              onBuy={() => onMockPurchase(agent.productId, pendingRole)}
              accent={catColor}
            />
            <UnlockOption
              title={`${CATEGORY_LABELS[agent.category]} Division Pack`}
              price="from $12/mo"
              description={`All ${CATEGORY_LABELS[agent.category]} specialists`}
              loading={unlocking}
              onBuy={() => onMockPurchase(agent.packProductId, null)}
              accent={catColor}
              dim
            />
          </div>

          <button
            onClick={onClose}
            style={{ width: "100%", padding: "8px", borderRadius: 7, background: "transparent", border: "1px solid rgba(255,255,255,.07)", color: "var(--haze)", fontSize: 11, fontFamily: "var(--mono)", letterSpacing: ".1em", cursor: "pointer" }}
          >
            cancel
          </button>
        </div>
      </div>
    </>
  );
}

function UnlockOption({ title, price, description, loading, onBuy, accent, dim }: {
  title: string;
  price: string;
  description: string;
  loading: boolean;
  onBuy: () => void;
  accent: string;
  dim?: boolean;
}) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 9,
        background: dim ? "rgba(255,255,255,.02)" : `${accent}07`,
        border: `1px solid ${dim ? "rgba(255,255,255,.07)" : `${accent}22`}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--bone)", marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 10, color: "var(--mist)" }}>{description}</div>
      </div>
      <button
        onClick={onBuy}
        disabled={loading}
        style={{
          padding: "6px 12px",
          borderRadius: 7,
          background: dim ? "rgba(255,255,255,.05)" : `${accent}16`,
          border: `1px solid ${dim ? "rgba(255,255,255,.1)" : `${accent}32`}`,
          color: dim ? "var(--mist)" : accent,
          fontSize: 11,
          fontFamily: "var(--mono)",
          letterSpacing: ".08em",
          cursor: loading ? "not-allowed" : "pointer",
          whiteSpace: "nowrap",
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        {loading ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : price}
      </button>
    </div>
  );
}

function DrawerSection({ label, color, children }: { label: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div className="mono" style={{ fontSize: 8, letterSpacing: ".2em", textTransform: "uppercase", color, marginBottom: 8, opacity: 0.75 }}>
        {label}
      </div>
      {children}
    </div>
  );
}
