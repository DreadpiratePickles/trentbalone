"use client";

import { useState, useEffect, ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { ConsoleMark, PulseDot, I, Eyebrow } from "@/components/ui";
import { RuntimeHealthChip } from "@/components/runtime-health";

// ── Types ──────────────────────────────────────────────────────────────

interface Company {
  id: string;
  name: string;
  status: string;
  lastCycleAt?: string;
  nextCycleAt?: string;
  pendingApprovals?: number;
  createdAt?: string;
}

interface AppShellProps {
  children: ReactNode;
  companyId?: string;
}

// ── AppShell ───────────────────────────────────────────────────────────

export function AppShell({ children, companyId }: AppShellProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const [activeStepLabel, setActiveStepLabel] = useState<string | null>(null);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 1024);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Persist last-visited company so portfolio page can redirect back
  useEffect(() => {
    if (companyId) {
      try { localStorage.setItem("trent_last_company", companyId); } catch {}
    }
  }, [companyId]);

  useEffect(() => {
    fetch("/api/companies")
      .then((r) => r.json())
      .then((data: { companies: Company[] }) => {
        const list = data.companies || [];
        setCompanies(list);
        if (companyId) {
          const found = list.find((c) => c.id === companyId);
          setCompany(found || list[0] || null);
        } else {
          setCompany(list[0] || null);
        }
      })
      .catch(() => {});
  }, [companyId]);

  // Live cycle streaming — SSE feed for the current company
  useEffect(() => {
    if (!companyId) return;
    const url = `/api/jobs/events?companyId=${companyId}`;
    const es = new EventSource(url);
    es.onmessage = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data as string) as {
          status?: string;
          jobRunId?: string;
          step?: { phase?: string; role?: string; label?: string };
        };
        if (ev.status === "running" || ev.status === "started") {
          setActiveCycleId(ev.jobRunId ?? "running");
          setActiveStepLabel(null);
        } else if (ev.status === "step") {
          setActiveCycleId((prev) => prev ?? (ev.jobRunId ?? "running"));
          if (ev.step?.phase === "agent_start" && ev.step.role) {
            setActiveStepLabel(`${ev.step.role} agent`);
          } else if (ev.step?.phase === "plan_start") {
            setActiveStepLabel("planning");
          } else if (ev.step?.phase === "plan_end") {
            setActiveStepLabel("plan ready");
          }
        } else if (
          ev.status === "completed" ||
          ev.status === "failed" ||
          ev.status === "cancelled"
        ) {
          setActiveCycleId(null);
          setActiveStepLabel(null);
          // Reload company data to reflect new lastCycleAt
          fetch("/api/companies")
            .then((r) => r.json())
            .then((data: { companies: Company[] }) => {
              const list = data.companies || [];
              setCompanies(list);
              const found = list.find((c) => c.id === companyId);
              if (found) setCompany(found);
            })
            .catch(() => {});
        }
      } catch {}
    };
    es.onerror = () => {
      // SSE will auto-reconnect; clear stale running flag after gap
      setTimeout(() => setActiveCycleId(null), 5000);
    };
    return () => es.close();
  }, [companyId]);

  return (
    <div
      style={{
        display: isMobile ? "block" : "grid",
        gridTemplateColumns: isMobile ? undefined : "240px 1fr",
        minHeight: "100vh",
        position: "relative",
        background: "var(--obsidian)",
      }}
    >
      <Sidebar
        companies={companies}
        company={company}
        companyId={companyId}
        isMobile={isMobile}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeCycleId={activeCycleId}
      />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <TopBar
          company={company}
          companyId={companyId}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          activeCycleId={activeCycleId}
          activeStepLabel={activeStepLabel}
          onCycleStarted={(id) => setActiveCycleId(id)}
        />
        <TrialBanner company={company} />
        <main
          style={{
            flex: 1,
            padding: isMobile ? "20px 16px 80px" : "32px 40px 80px",
            position: "relative",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────

function Sidebar({
  companies,
  company,
  companyId,
  isMobile,
  isOpen,
  onClose,
  activeCycleId,
}: {
  companies: Company[];
  company: Company | null;
  companyId?: string;
  isMobile?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
  activeCycleId?: string | null;
}) {
  const [coOpen, setCoOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const cid = companyId || company?.id || "";

  const workspaceItems = [
    { icon: I.bolt, label: "console", href: `/companies/${cid}` },
    { icon: I.sparkle, label: "command", href: `/companies/${cid}/command` },
    { icon: I.check, label: "goals", href: `/companies/${cid}/goals` },
    { icon: I.inbox, label: "queue", href: `/companies/${cid}/queue` },
    { icon: I.building, label: "workbench", href: `/companies/${cid}/workbench` },
    { icon: I.play, label: "app solo", href: `/companies/${cid}/app-solo` },
    { icon: I.cycle, label: "missions", href: `/companies/${cid}/missions` },
    {
      icon: I.diamond,
      label: "approvals",
      href: `/companies/${cid}/approvals`,
      badge: company?.pendingApprovals ? String(company.pendingApprovals) : undefined,
      ember: (company?.pendingApprovals || 0) > 0,
    },
    { icon: I.doc, label: "reports", href: `/companies/${cid}/reports` },
    { icon: I.diamond, label: "artifacts", href: `/companies/${cid}/artifacts` },
    { icon: I.brain, label: "memory", href: `/companies/${cid}/memory` },
    { icon: I.diamond, label: "vault graph", href: `/companies/${cid}/vault-graph` },
    { icon: I.doc, label: "wiki", href: `/companies/${cid}/wiki` },
    { icon: I.sparkle, label: "autoresearch", href: `/companies/${cid}/autoresearch` },
  ];

  const operateItems = [
    { icon: I.cycle, label: "cycles", href: `/companies/${cid}/cycles` },
    { icon: I.wallet, label: "budgets", href: `/companies/${cid}/budgets` },
    { icon: I.shield, label: "audit", href: `/companies/${cid}/audit` },
    { icon: I.plug, label: "integrations", href: `/companies/${cid}/integrations` },
  ];

  const setupItems = [
    { icon: I.plug, label: "agent plug", href: `/companies/${cid}/plug` },
    { icon: I.settings, label: "settings", href: `/companies/${cid}/settings` },
    { icon: I.list, label: "agents", href: `/companies/${cid}/agents` },
  ];

  const hue = (name: string) => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  };

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 2) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const handleCompanySelect = (cId: string) => {
    router.push(`/companies/${cId}`);
    setCoOpen(false);
    if (onClose) onClose();
  };

  const handlePortfolioClick = () => {
    router.push("/companies");
    setCoOpen(false);
    if (onClose) onClose();
  };

  return (
    <>
      {isMobile && isOpen && (
        <div
          onClick={onClose}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,.5)",
            backdropFilter: "blur(4px)",
            zIndex: 998,
          }}
        />
      )}
      <aside
        style={{
          borderRight: "1px solid rgba(255,255,255,.05)",
          background: "rgba(10,10,15,.95)",
          padding: "20px 14px",
          position: isMobile ? "fixed" : "sticky",
          top: 0,
          left: 0,
          height: "100vh",
          width: 240,
          overflowY: "auto",
          zIndex: isMobile ? 999 : 5,
          display: "flex",
          flexDirection: "column",
          transform: isMobile ? (isOpen ? "translateX(0)" : "translateX(-240px)") : "none",
          transition: "transform .3s ease",
        }}
      >
        {/* Logo */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "4px 8px 18px",
          }}
        >
          <ConsoleMark size={20} />
          <span
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: ".18em",
              textTransform: "uppercase",
              color: "var(--bone)",
            }}
          >
            trent
          </span>
          <span
            style={{
              marginLeft: "auto",
              fontSize: 10,
              fontFamily: "var(--mono)",
              letterSpacing: ".14em",
              color: "var(--haze)",
            }}
          >
            v1.0
          </span>
        </div>

        {/* Company switcher */}
        {company && (
          <>
            <button
              onClick={() => setCoOpen((o) => !o)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 10px",
                borderRadius: 10,
                background: "var(--steel)",
                border: "1px solid rgba(255,255,255,.05)",
                color: "var(--bone)",
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: `oklch(0.65 0.16 ${hue(company.name)})`,
                  color: "#0A0A0F",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {company.name[0]}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {company.name}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: ".14em",
                    color:
                      company.status === "active" ? "var(--pulse)" : "var(--haze)",
                    textTransform: "uppercase",
                    marginTop: 2,
                  }}
                >
                  {company.status === "active" ? "● operating" : "○ paused"}
                </div>
              </div>
              <I.chevR
                style={{
                  color: "var(--haze)",
                  transform: coOpen ? "rotate(90deg)" : "none",
                  transition: "transform .2s",
                }}
              />
            </button>

            {coOpen && (
              <div
                style={{
                  marginTop: 6,
                  padding: 6,
                  background: "var(--ink)",
                  border: "1px solid rgba(255,255,255,.08)",
                  borderRadius: 10,
                  animation: "enter-up .25s ease both",
                }}
              >
                {companies.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleCompanySelect(c.id)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background:
                        c.id === company.id
                          ? "rgba(110,231,183,.06)"
                          : "transparent",
                      border: 0,
                      color: "var(--bone)",
                      textAlign: "left",
                      fontSize: 13,
                      marginBottom: 2,
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        background: `oklch(0.65 0.16 ${hue(c.name)})`,
                        color: "#0A0A0F",
                        fontFamily: "var(--mono)",
                        fontSize: 10,
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {c.name[0]}
                    </span>
                    <span style={{ flex: 1 }}>{c.name}</span>
                    <span
                      className="mono"
                      style={{
                        fontSize: 9,
                        color:
                          c.status === "active" ? "var(--pulse)" : "var(--haze)",
                      }}
                    >
                      {c.status === "active" ? "●" : "○"}
                    </span>
                  </button>
                ))}
                <div style={{ height: 1, background: "rgba(255,255,255,.06)", margin: "6px 0" }} />
                <button
                  onClick={handlePortfolioClick}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: "transparent",
                    border: 0,
                    color: "var(--mist)",
                    textAlign: "left",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  <I.list style={{ color: "var(--haze)" }} />
                  <span style={{ flex: 1 }}>portfolio</span>
                  <I.chevR style={{ color: "var(--haze)" }} />
                </button>
              </div>
            )}
          </>
        )}

        {/* Nav groups */}
        <NavGroup label="workspace" items={workspaceItems} pathname={pathname} onItemClick={onClose} />
        <NavGroup label="operate" items={operateItems} pathname={pathname} onItemClick={onClose} />
        <NavGroup label="setup" items={setupItems} pathname={pathname} onItemClick={onClose} />

        {/* Cycle status footer */}
        <div style={{ marginTop: "auto", paddingTop: 24 }}>
          {activeCycleId ? (
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                background: "rgba(110,231,183,.06)",
                border: "1px solid rgba(110,231,183,.3)",
                animation: "pulse-soft 2s ease infinite",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 9,
                  letterSpacing: ".2em",
                  textTransform: "uppercase",
                  color: "var(--pulse)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <PulseDot size={6} /> running
              </div>
              <div style={{ fontSize: 12, color: "var(--bone-2)", lineHeight: 1.4 }}>
                cycle in progress…
              </div>
            </div>
          ) : company?.status === "paused" ? (
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                background: "rgba(251,146,60,.04)",
                border: "1px solid rgba(251,146,60,.18)",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 9,
                  letterSpacing: ".2em",
                  textTransform: "uppercase",
                  color: "var(--ember)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                ○ paused
              </div>
              <div style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.4 }}>
                cycles are paused
              </div>
            </div>
          ) : company?.lastCycleAt ? (
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                background: "rgba(110,231,183,.04)",
                border: "1px solid rgba(110,231,183,.18)",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 9,
                  letterSpacing: ".2em",
                  textTransform: "uppercase",
                  color: "var(--pulse)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <PulseDot size={6} /> operating
              </div>
              <div style={{ fontSize: 12, color: "var(--bone-2)", lineHeight: 1.4 }}>
                last cycle {timeAgo(company.lastCycleAt)}
              </div>
            </div>
          ) : (
            <div
              style={{
                padding: 12,
                borderRadius: 10,
                background: "var(--steel)",
                border: "1px solid rgba(255,255,255,.06)",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 9,
                  letterSpacing: ".2em",
                  textTransform: "uppercase",
                  color: "var(--haze)",
                  marginBottom: 6,
                }}
              >
                no cycles yet
              </div>
              <div style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.4 }}>
                run a cycle to get started
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

// ── NavGroup ───────────────────────────────────────────────────────────

interface NavItem {
  icon: (p: React.SVGProps<SVGSVGElement>) => React.ReactElement;
  label: string;
  href: string;
  badge?: string;
  ember?: boolean;
}

function NavGroup({
  label,
  items,
  pathname,
  onItemClick,
}: {
  label: string;
  items: NavItem[];
  pathname: string;
  onItemClick?: () => void;
}) {
  const router = useRouter();
  return (
    <div style={{ marginTop: 24 }}>
      <div
        className="mono"
        style={{
          fontSize: 9,
          letterSpacing: ".2em",
          textTransform: "uppercase",
          color: "var(--haze)",
          padding: "0 8px 8px",
        }}
      >
        {label}
      </div>
      {items.map((it) => {
        const exact = pathname === it.href;
        return (
          <button
            key={it.label}
            onClick={() => {
              router.push(it.href as Parameters<typeof router.push>[0]);
              if (onItemClick) onItemClick();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "8px 10px",
              borderRadius: 8,
              background: exact ? "rgba(110,231,183,.06)" : "transparent",
              border: 0,
              fontSize: 13,
              color: exact ? "var(--bone)" : "#CFCAC0",
              boxShadow: exact ? "inset 0 0 0 1px rgba(110,231,183,.18)" : "none",
              marginBottom: 2,
              textAlign: "left",
              transition: "background .15s, color .15s",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              if (!exact)
                (e.currentTarget as HTMLButtonElement).style.background =
                  "rgba(255,255,255,.03)";
            }}
            onMouseLeave={(e) => {
              if (!exact)
                (e.currentTarget as HTMLButtonElement).style.background =
                  "transparent";
            }}
          >
            <it.icon
              style={{ color: exact ? "var(--pulse)" : "var(--haze)", flexShrink: 0 }}
            />
            <span style={{ flex: 1 }}>{it.label}</span>
            {it.badge && it.badge !== "0" && (
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: it.ember ? "var(--ember)" : "var(--haze)",
                  background: it.ember ? "rgba(251,146,60,.08)" : "var(--steel)",
                  padding: "2px 6px",
                  borderRadius: 4,
                }}
              >
                {it.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── TopBar ─────────────────────────────────────────────────────────────

function TopBar({
  company,
  companyId,
  isMobile,
  onMenuClick,
  activeCycleId,
  activeStepLabel,
  onCycleStarted,
}: {
  company: Company | null;
  companyId?: string;
  isMobile?: boolean;
  onMenuClick?: () => void;
  activeCycleId?: string | null;
  activeStepLabel?: string | null;
  onCycleStarted?: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [runningCycle, setRunningCycle] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifCount, setNotifCount] = useState(0);
  const [notifs, setNotifs] = useState<Array<{ id: string; kind: string; title: string; detail: string; href: string }>>([]);
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();

  // Clear local running state once SSE confirms cycle done
  useEffect(() => {
    if (!activeCycleId) setRunningCycle(false);
  }, [activeCycleId]);

  // Keyboard shortcut: cmd+shift+. → toggle kill switch
  useEffect(() => {
    if (!company || !companyId) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === ".") {
        e.preventDefault();
        fetch(`/api/companies/${companyId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: company.status === "paused" ? "active" : "paused" }),
        }).then(() => router.refresh()).catch(() => {});
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [company, companyId, router]);

  // Load notifications from pending approvals + recent artifacts + failed cycles
  useEffect(() => {
    if (!companyId) return;
    async function loadNotifs() {
      const res = await fetch(`/api/companies/${companyId}/notifications`);
      if (!res.ok) return;
      const data = await res.json() as { notifications: typeof notifs; unread: number };
      setNotifs(data.notifications ?? []);
      setNotifCount(data.unread ?? 0);
    }
    void loadNotifs();
    const timer = setInterval(loadNotifs, 30_000);
    return () => clearInterval(timer);
  }, [companyId]);

  // Close notification dropdown on outside click
  useEffect(() => {
    if (!notifOpen) return;
    function handleOutside(e: MouseEvent) {
      const el = document.getElementById("notif-dropdown");
      if (el && !el.contains(e.target as Node)) setNotifOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [notifOpen]);

  const segments = pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  const pageName =
    lastSegment && lastSegment !== companyId ? lastSegment : "console";

  const userInitials = (() => {
    const name = session?.user?.name || session?.user?.email || "op";
    const parts = name.split(/[\s@]/);
    return parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toLowerCase()
      : name.slice(0, 2).toLowerCase();
  })();

  const handleRunCycle = async () => {
    if (!companyId || runningCycle || activeCycleId) return;
    setRunningCycle(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/cycles`, { method: "POST" });
      const data = await res.json() as { cycle?: { id: string } };
      if (data.cycle?.id && onCycleStarted) onCycleStarted(data.cycle.id);
      router.refresh();
    } catch {
    } finally {
      // Keep running state until SSE confirms completion or 30s timeout
      setTimeout(() => setRunningCycle(false), 30000);
    }
  };

  const handleSearch = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && query.trim() && companyId) {
      router.push(`/companies/${companyId}/memory?q=${encodeURIComponent(query.trim())}`);
      setQuery("");
    }
  };

  const greeting = (() => {
    const h = new Date().getHours();
    const name = session?.user?.name?.split(" ")[0] || session?.user?.email?.split("@")[0] || "";
    if (h < 12) return `good morning${name ? `, ${name}` : ""} — trent's been working.`;
    if (h < 17) return `good afternoon${name ? `, ${name}` : ""} — trent's got you covered.`;
    return `good evening${name ? `, ${name}` : ""} — trent's still running.`;
  })();

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: isMobile ? "12px 16px" : "14px 40px",
        borderBottom: "1px solid rgba(255,255,255,.06)",
        background: "rgba(10,10,15,.8)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        position: "sticky",
        top: 0,
        zIndex: 8,
      }}
    >
      {isMobile && (
        <button
          onClick={onMenuClick}
          style={{
            background: "transparent",
            border: 0,
            color: "var(--bone)",
            cursor: "pointer",
            padding: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
      )}

      {/* Breadcrumb / greeting */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        {!isMobile && pageName === "console" && session?.user ? (
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--haze)", letterSpacing: ".08em" }}
          >
            {greeting}
          </span>
        ) : (
          <>
            {!isMobile && (
              <span
                style={{ color: "var(--haze)", cursor: "pointer" }}
                onClick={() => router.push("/companies")}
              >
                portfolio
              </span>
            )}
            {!isMobile && company && <I.chevR style={{ color: "var(--haze)" }} />}
            {company && (
              <span
                style={{ color: "var(--mist)", cursor: "pointer" }}
                onClick={() => router.push(`/companies/${company.id}`)}
              >
                {company.name}
              </span>
            )}
            {pageName !== "console" && (
              <>
                <I.chevR style={{ color: "var(--haze)" }} />
                <span style={{ color: "var(--bone)", fontWeight: 500 }}>{pageName}</span>
              </>
            )}
          </>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {/* Search */}
      {!isMobile && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--steel)",
            border: "1px solid rgba(255,255,255,.06)",
            borderRadius: 8,
            padding: "6px 12px",
            width: 300,
            transition: "border-color .2s",
          }}
        >
          <I.search style={{ color: "var(--haze)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearch}
            placeholder="search memory, agents, cycles…"
            style={{
              background: "transparent",
              border: 0,
              outline: 0,
              flex: 1,
              color: "var(--bone)",
              fontSize: 13,
            }}
          />
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--haze)",
              padding: "2px 6px",
              background: "var(--slate)",
              borderRadius: 4,
            }}
          >
            ⌘K
          </span>
        </div>
      )}

      {/* Run cycle / live indicator */}
      {activeCycleId || runningCycle ? (
        <div
          className="mono"
          style={{
            height: 34,
            padding: isMobile ? "0 10px" : "0 14px",
            background: "rgba(110,231,183,.06)",
            color: "var(--pulse)",
            border: "1px solid rgba(110,231,183,.3)",
            borderRadius: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            fontWeight: 500,
            animation: "pulse-soft 1.6s ease infinite",
          }}
        >
          <PulseDot size={6} />
          {!isMobile && (activeStepLabel ? activeStepLabel : "running")}
        </div>
      ) : (
        <button
          onClick={handleRunCycle}
          className="btn btn-mono"
          style={{
            height: 34,
            padding: isMobile ? "0 10px" : "0 14px",
            background: "rgba(110,231,183,.08)",
            color: "var(--pulse)",
            border: "1px solid rgba(110,231,183,.2)",
            borderRadius: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          <I.play width={13} height={13} />
          {!isMobile && "run cycle"}
        </button>
      )}

      {/* Kill switch — pause/resume all agents */}
      {company && companyId && (
        <button
          title={company.status === "paused" ? "Resume all agents (⌘⇧.)" : "Pause all agents — kill switch (⌘⇧.)"}
          onClick={async () => {
            await fetch(`/api/companies/${companyId}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: company.status === "paused" ? "active" : "paused" }),
            });
            router.refresh();
          }}
          className="btn btn-mono"
          style={{
            height: 34,
            width: 34,
            padding: 0,
            background: company.status === "paused" ? "rgba(251,146,60,.08)" : "var(--steel)",
            color: company.status === "paused" ? "var(--ember)" : "var(--haze)",
            border: company.status === "paused"
              ? "1px solid rgba(251,146,60,.3)"
              : "1px solid rgba(255,255,255,.06)",
            borderRadius: 8,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {company.status === "paused" ? (
            <I.play width={13} height={13} />
          ) : (
            <I.pause width={13} height={13} />
          )}
        </button>
      )}

      {!isMobile && <RuntimeHealthChip />}

      {/* Notification Bell */}
      {companyId && (
        <div id="notif-dropdown" style={{ position: "relative" }}>
          <button
            onClick={() => setNotifOpen((v) => !v)}
            title="Notifications"
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              background: notifOpen ? "rgba(110,231,183,.08)" : "var(--steel)",
              border: notifOpen ? "1px solid rgba(110,231,183,.2)" : "1px solid rgba(255,255,255,.06)",
              color: notifOpen ? "var(--pulse)" : "var(--haze)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              flexShrink: 0,
              transition: "all .15s",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {notifCount > 0 && (
              <span style={{
                position: "absolute",
                top: -3,
                right: -3,
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: "var(--ember)",
                border: "2px solid var(--night)",
                fontSize: 7,
                fontFamily: "var(--mono)",
                fontWeight: 700,
                color: "#0A0A0F",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}>
                {notifCount > 9 ? "9+" : notifCount}
              </span>
            )}
          </button>

          {/* Notification dropdown */}
          {notifOpen && (
            <div style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              width: 320,
              background: "var(--night)",
              border: "1px solid rgba(255,255,255,.1)",
              borderRadius: 14,
              boxShadow: "0 16px 48px rgba(0,0,0,.4)",
              zIndex: 100,
              overflow: "hidden",
              animation: "enter-up .2s var(--ease-out-expo) both",
            }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)" }}>notifications</span>
                {notifCount > 0 && <span className="mono" style={{ fontSize: 9, color: "var(--ember)" }}>{notifCount} unread</span>}
              </div>
              <div style={{ maxHeight: 380, overflowY: "auto" }}>
                {notifs.length === 0 ? (
                  <div style={{ padding: "20px 16px", fontSize: 12, color: "var(--haze)", textAlign: "center" }}>
                    All clear — nothing needs your attention.
                  </div>
                ) : (
                  notifs.map((n) => (
                    <a
                      key={n.id}
                      href={n.href}
                      onClick={() => setNotifOpen(false)}
                      style={{
                        display: "block",
                        padding: "12px 16px",
                        borderBottom: "1px solid rgba(255,255,255,.04)",
                        textDecoration: "none",
                        transition: "background .1s",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,.03)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                        <span style={{ fontSize: 12 }}>
                          {n.kind === "approval" ? "◆" : n.kind === "artifact" ? "◈" : n.kind === "cycle_fail" ? "✕" : "·"}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: n.kind === "approval" ? "var(--ember)" : "var(--bone)" }}>
                          {n.title}
                        </span>
                      </div>
                      <div className="mono" style={{ fontSize: 9, color: "var(--haze)", letterSpacing: ".08em", paddingLeft: 20 }}>
                        {n.detail}
                      </div>
                    </a>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* User */}
      <div
        title={session?.user?.email ?? ""}
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "var(--steel)",
          border: "1px solid rgba(255,255,255,.08)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--bone)",
          cursor: "pointer",
        }}
        onClick={() => router.push("/auth/signin")}
      >
        {userInitials}
      </div>
    </header>
  );
}

// ── Slim nav-only shell (for /companies list) ──────────────────────────

// ── Trial Banner ───────────────────────────────────────────────────────

const TRIAL_DAYS = 14;

function TrialBanner({ company }: { company: Company | null }) {
  const [dismissed, setDismissed] = useState(false);

  if (!company?.createdAt || dismissed) return null;

  const daysElapsed = Math.floor(
    (Date.now() - new Date(company.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );
  const daysLeft = TRIAL_DAYS - daysElapsed;

  // After trial ends — show upgrade nudge
  if (daysLeft <= 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 40px",
          background: "rgba(251,146,60,.05)",
          borderBottom: "1px solid rgba(251,146,60,.18)",
        }}
      >
        <span style={{ color: "var(--ember)", fontSize: 12 }}>◆</span>
        <span
          className="mono"
          style={{ fontSize: 10, color: "var(--ember)", letterSpacing: ".14em" }}
        >
          free trial ended
        </span>
        <span style={{ fontSize: 12, color: "var(--mist)", marginLeft: 4 }}>
          — upgrade to keep Trent running. Operator $99 / Studio $299.
        </span>
        <a
          href="/pricing"
          style={{
            marginLeft: "auto",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--ember)",
            textDecoration: "none",
            border: "1px solid rgba(251,146,60,.4)",
            borderRadius: 6,
            padding: "3px 10px",
          }}
        >
          upgrade →
        </a>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 40px",
        background: "rgba(110,231,183,.05)",
        borderBottom: "1px solid rgba(110,231,183,.12)",
      }}
    >
      <PulseDot size={5} />
      <span
        className="mono"
        style={{ fontSize: 10, color: "var(--pulse)", letterSpacing: ".14em" }}
      >
        {daysLeft === 1 ? "last day" : `${daysLeft} days left`} in your free trial
      </span>
      <span style={{ fontSize: 12, color: "var(--mist)", marginLeft: 4 }}>
        {daysLeft <= 3
          ? "— 14-day guarantee: 1 PR drafted, 1 post written, 1 letter delivered."
          : "— everything is live, no credit card needed yet."}
      </span>
      <button
        onClick={() => setDismissed(true)}
        style={{
          marginLeft: "auto",
          background: "transparent",
          border: 0,
          color: "var(--haze)",
          cursor: "pointer",
          fontSize: 16,
          lineHeight: 1,
          padding: "0 4px",
        }}
      >
        ×
      </button>
    </div>
  );
}

// ── Portfolio Shell ────────────────────────────────────────────────────

export function PortfolioShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 1024);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "var(--obsidian)" }}>
      {/* Top bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: isMobile ? "12px 16px" : "14px 40px",
          borderBottom: "1px solid rgba(255,255,255,.06)",
          background: "rgba(10,10,15,.9)",
          backdropFilter: "blur(14px)",
          position: "sticky",
          top: 0,
          zIndex: 8,
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}
          onClick={() => router.push("/companies")}
        >
          <ConsoleMark size={22} />
          <span
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: ".18em",
              textTransform: "uppercase",
              color: "var(--bone)",
            }}
          >
            trent
          </span>
        </div>

        <div style={{ flex: 1 }} />

        {!isMobile && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "var(--steel)",
              border: "1px solid rgba(255,255,255,.06)",
              borderRadius: 8,
              padding: "6px 12px",
              width: 280,
            }}
          >
            <I.search style={{ color: "var(--haze)" }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search companies…"
              style={{
                background: "transparent",
                border: 0,
                outline: 0,
                flex: 1,
                color: "var(--bone)",
                fontSize: 13,
              }}
            />
          </div>
        )}

        {!isMobile && (
          <button
            onClick={() => router.push("/referral")}
            className="btn btn-mono"
            style={{
              height: 32,
              padding: "0 12px",
              background: "rgba(110,231,183,.06)",
              border: "1px solid rgba(110,231,183,.18)",
              color: "var(--pulse)",
              borderRadius: 8,
              fontSize: 10,
              fontFamily: "var(--mono)",
              letterSpacing: ".14em",
              textTransform: "uppercase",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            refer → $99
          </button>
        )}

        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "var(--steel)",
            border: "1px solid rgba(255,255,255,.08)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--bone)",
          }}
        >
          op
        </div>
      </header>

      <main style={{ padding: isMobile ? "24px 16px 80px" : "40px 40px 80px" }}>{children}</main>
    </div>
  );
}
