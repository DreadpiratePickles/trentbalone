"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CommandPalette } from "@/components/command-palette";
import { Sidebar, type ShellCompany } from "@/components/shell-sidebar";
import { TopBar, TrialBanner } from "@/components/shell-topbar";
import { ConsoleMark, I } from "@/components/ui";
import {
  buildRunCycleControl,
  emptyRunCycleControl,
  mergeOrchestratorRunIntoCycleControl,
  runCycleEventReducer,
  runCycleIsActive,
  type RunCycleControlState,
  type RunCycleEvent,
  type RunCycleOrchestratorSnapshot,
} from "@/lib/run-cycle-control";
import type { JobRun } from "@/lib/types";

type AppShellProps = {
  children: ReactNode;
  companyId?: string;
  /** Full-bleed stage for editor/workspace pages (workbench, trenchpad). */
  wide?: boolean;
};

export function AppShell({ children, companyId, wide }: AppShellProps) {
  const [companies, setCompanies] = useState<ShellCompany[]>([]);
  const [company, setCompany] = useState<ShellCompany | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [runCycleState, setRunCycle] = useState<RunCycleControlState>(() => emptyRunCycleControl());
  const router = useRouter();
  const activeCycleId = runCycleState.runId ?? runCycleState.jobId;

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
        const data = JSON.parse(event.data as string) as RunCycleEvent;
        setRunCycle((current) => runCycleEventReducer(current, data));
        if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
          reloadCompanies();
        }
      } catch {}
    };
    events.onerror = () => {
      setRunCycle((current) => runCycleEventReducer(current, {
        status: "lost_contact",
        summary: "Connection to live cycle events dropped. Reconnecting with polling.",
        at: new Date().toISOString(),
      }));
    };
    return () => events.close();
  }, [companyId, reloadCompanies]);

  const pollRunCycle = useCallback(async () => {
    if (!companyId) return;

    let next: RunCycleControlState | null = null;
    try {
      const jobsRes = await fetch(`/api/jobs?companyId=${encodeURIComponent(companyId)}`);
      if (jobsRes.ok) {
        const data = await jobsRes.json() as { runCycle?: RunCycleControlState | null };
        if (data.runCycle && data.runCycle.status !== "idle") next = data.runCycle;
      }

      const runId = next?.runId ?? runCycleState.runId;
      if (runId) {
        const runRes = await fetch(`/api/companies/${companyId}/orchestrate?runId=${encodeURIComponent(runId)}`);
        if (runRes.ok) {
          const data = await runRes.json() as { run?: RunCycleOrchestratorSnapshot };
          next = mergeOrchestratorRunIntoCycleControl(next ?? runCycleState, data.run);
        }
      }

      if (next) {
        setRunCycle(next);
        if (next.status === "completed" || next.status === "failed" || next.status === "cancelled") {
          reloadCompanies();
        }
      }
    } catch {
      setRunCycle((current) => runCycleEventReducer(current, {
        status: "lost_contact",
        summary: "Cycle polling could not reach the server.",
        at: new Date().toISOString(),
      }));
    }
  }, [companyId, reloadCompanies, runCycleState]);

  useEffect(() => {
    if (!runCycleIsActive(runCycleState)) return;
    if (runCycleState.status === "lost_contact" || runCycleState.runId) void pollRunCycle();
    const timer = window.setInterval(() => void pollRunCycle(), 5_000);
    return () => window.clearInterval(timer);
  }, [pollRunCycle, runCycleState]);

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
    if (!companyId || runCycleIsActive(runCycleState)) return;

    fetch(`/api/companies/${companyId}/cycles`, { method: "POST" })
      .then(async (response) => {
        const data = await response.json() as {
          runCycle?: RunCycleControlState;
          job?: JobRun;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(data.error || "Could not queue cycle.");
        }
        if (data.runCycle) setRunCycle(data.runCycle);
        else if (data.job) setRunCycle(buildRunCycleControl({ job: data.job }));
        router.refresh();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Could not queue cycle.";
        setRunCycle({
          ...emptyRunCycleControl(),
          status: "failed",
          label: "failed",
          error: message,
          lastEventAt: new Date().toISOString(),
        });
      });
  }, [companyId, router, runCycleState]);

  const cancelRunCycle = useCallback(async () => {
    if (!companyId || !runCycleIsActive(runCycleState)) return;
    try {
      if (runCycleState.runId) {
        await fetch(`/api/companies/${companyId}/orchestrate?runId=${encodeURIComponent(runCycleState.runId)}`, {
          method: "DELETE",
        });
      } else if (runCycleState.jobId) {
        await fetch(`/api/jobs/${encodeURIComponent(runCycleState.jobId)}/cancel`, { method: "POST" });
      }
      setRunCycle((current) => ({ ...current, status: "cancelled", label: "cancelled" }));
      router.refresh();
    } catch {
      setRunCycle((current) => ({
        ...current,
        status: "lost_contact",
        label: "cancel failed",
        error: "Could not cancel the active cycle. Refresh and check the Ops trace.",
      }));
    }
  }, [companyId, router, runCycleState]);

  const viewRunCycle = useCallback(() => {
    if (!companyId) return;
    if (runCycleState.runId) {
      router.push(`/companies/${companyId}/ops?runId=${encodeURIComponent(runCycleState.runId)}` as Parameters<typeof router.push>[0]);
      return;
    }
    router.push(`/companies/${companyId}/cycles` as Parameters<typeof router.push>[0]);
  }, [companyId, router, runCycleState.runId]);

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
          runCycle={runCycleState}
          activeStepLabel={runCycleState.label}
          onRunCycle={runCycle}
          onCancelCycle={cancelRunCycle}
          onViewCycle={viewRunCycle}
          onOpenPalette={() => setPaletteOpen(true)}
          onToggleKillSwitch={toggleKillSwitch}
        />
        <TrialBanner company={company} />
        <main className="app-main" data-wide={wide ? "true" : undefined}>{children}</main>
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
