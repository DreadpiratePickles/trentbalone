"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CommandPalette } from "@/components/command-palette";
import { Sidebar, type ShellCompany } from "@/components/shell-sidebar";
import { TopBar, TrialBanner } from "@/components/shell-topbar";
import { ConsoleMark, I } from "@/components/ui";

type AppShellProps = {
  children: ReactNode;
  companyId?: string;
};

export function AppShell({ children, companyId }: AppShellProps) {
  const [companies, setCompanies] = useState<ShellCompany[]>([]);
  const [company, setCompany] = useState<ShellCompany | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const [activeStepLabel, setActiveStepLabel] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!companyId) return;
    try {
      localStorage.setItem("trent_last_company", companyId);
    } catch {}
  }, [companyId]);

  const reloadCompanies = useCallback(() => {
    fetch("/api/companies")
      .then((response) => response.json())
      .then((data: { companies: ShellCompany[] }) => {
        const list = data.companies || [];
        setCompanies(list);
        if (companyId) {
          const found = list.find((candidate) => candidate.id === companyId);
          setCompany(found || list[0] || null);
        } else {
          setCompany(list[0] || null);
        }
      })
      .catch(() => {});
  }, [companyId]);

  useEffect(() => {
    reloadCompanies();
  }, [reloadCompanies]);

  useEffect(() => {
    if (!companyId) return;

    const events = new EventSource(`/api/jobs/events?companyId=${companyId}`);
    events.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as {
          status?: string;
          jobRunId?: string;
          step?: { phase?: string; role?: string; label?: string };
        };

        if (data.status === "running" || data.status === "started") {
          setActiveCycleId(data.jobRunId ?? "running");
          setActiveStepLabel(null);
        } else if (data.status === "step") {
          setActiveCycleId((current) => current ?? data.jobRunId ?? "running");
          if (data.step?.phase === "agent_start" && data.step.role) {
            setActiveStepLabel(`${data.step.role} agent`);
          } else if (data.step?.phase === "plan_start") {
            setActiveStepLabel("planning");
          } else if (data.step?.phase === "plan_end") {
            setActiveStepLabel("plan ready");
          }
        } else if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
          setActiveCycleId(null);
          setActiveStepLabel(null);
          reloadCompanies();
        }
      } catch {}
    };
    events.onerror = () => {
      window.setTimeout(() => setActiveCycleId(null), 5000);
    };
    return () => events.close();
  }, [companyId, reloadCompanies]);

  const toggleKillSwitch = useCallback(() => {
    if (!company || !companyId) return;

    fetch(`/api/companies/${companyId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: company.status === "paused" ? "active" : "paused" }),
    })
      .then(() => {
        router.refresh();
        reloadCompanies();
      })
      .catch(() => {});
  }, [company, companyId, router, reloadCompanies]);

  const runCycle = useCallback(() => {
    if (!companyId || activeCycleId) return;

    fetch(`/api/companies/${companyId}/cycles`, { method: "POST" })
      .then((response) => response.json())
      .then((data: { cycle?: { id: string } }) => {
        if (data.cycle?.id) setActiveCycleId(data.cycle.id);
        router.refresh();
      })
      .catch(() => {});
  }, [companyId, activeCycleId, router]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === ".") {
        event.preventDefault();
        toggleKillSwitch();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleKillSwitch]);

  return (
    <div className="app-v2 app-shell-grid" data-mobile={isMobile}>
      <Sidebar
        companies={companies}
        company={company}
        companyId={companyId}
        isMobile={isMobile}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeCycleId={activeCycleId}
      />
      <div className="app-shell-main">
        <TopBar
          company={company}
          companyId={companyId}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          activeCycleId={activeCycleId}
          activeStepLabel={activeStepLabel}
          onRunCycle={runCycle}
          onOpenPalette={() => setPaletteOpen(true)}
          onToggleKillSwitch={toggleKillSwitch}
        />
        <TrialBanner company={company} />
        <main className="app-main">{children}</main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        companyId={companyId || company?.id}
        companies={companies}
        companyStatus={company?.status}
        onRunCycle={runCycle}
        onToggleKillSwitch={toggleKillSwitch}
      />
    </div>
  );
}

export function PortfolioShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div className="app-v2 portfolio-shell">
      <header className="portfolio-topbar">
        <button type="button" className="portfolio-brand" onClick={() => router.push("/companies")}>
          <ConsoleMark size={22} />
          <span className="mono">trent</span>
        </button>

        <div style={{ flex: 1 }} />

        {!isMobile && (
          <div className="portfolio-search">
            <I.search />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="search companies..."
            />
          </div>
        )}

        {!isMobile && (
          <button type="button" onClick={() => router.push("/referral")} className="portfolio-referral">
            refer -&gt; $99
          </button>
        )}

        <div className="portfolio-user">op</div>
      </header>

      <main className="portfolio-main">{children}</main>
    </div>
  );
}
