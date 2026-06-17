"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { I, PulseDot } from "@/components/ui";
import { RuntimeHealthChip } from "@/components/runtime-health";
import type { ShellCompany } from "@/components/shell-sidebar";
import { runCycleIsActive, type RunCycleControlState } from "@/lib/run-cycle-control";

type TopBarProps = {
  company: ShellCompany | null;
  companyId?: string;
  isMobile?: boolean;
  onMenuClick?: () => void;
  activeCycleId?: string | null;
  activeStepLabel?: string | null;
  runCycle?: RunCycleControlState;
  onRunCycle?: () => void;
  onCancelCycle?: () => void;
  onViewCycle?: () => void;
  onOpenPalette?: () => void;
  onToggleKillSwitch?: () => void;
};

type Notification = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  href: string;
};

export function TopBar({
  company,
  companyId,
  isMobile,
  onMenuClick,
  activeCycleId,
  activeStepLabel,
  runCycle,
  onRunCycle,
  onCancelCycle,
  onViewCycle,
  onOpenPalette,
  onToggleKillSwitch,
}: TopBarProps) {
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifCount, setNotifCount] = useState(0);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();

  useEffect(() => {
    if (!companyId) return;

    async function loadNotifs() {
      const res = await fetch(`/api/companies/${companyId}/notifications`);
      if (!res.ok) return;
      const data = await res.json() as { notifications: Notification[]; unread: number };
      setNotifs(data.notifications ?? []);
      setNotifCount(data.unread ?? 0);
    }

    void loadNotifs();
    const timer = window.setInterval(loadNotifs, 30_000);
    return () => window.clearInterval(timer);
  }, [companyId]);

  useEffect(() => {
    if (!notifOpen) return;

    function handleOutside(event: MouseEvent) {
      const el = document.getElementById("notif-dropdown");
      if (el && !el.contains(event.target as Node)) setNotifOpen(false);
    }

    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [notifOpen]);

  const segments = pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  const pageName = lastSegment && lastSegment !== companyId ? lastSegment : "console";

  const userInitials = (() => {
    const name = session?.user?.name || session?.user?.email || "op";
    const parts = name.split(/[\s@]/);
    return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toLowerCase() : name.slice(0, 2).toLowerCase();
  })();

  const greeting = (() => {
    const hour = new Date().getHours();
    const name = session?.user?.name?.split(" ")[0] || session?.user?.email?.split("@")[0] || "";
    if (hour < 12) return `good morning${name ? `, ${name}` : ""} - trent's been working.`;
    if (hour < 17) return `good afternoon${name ? `, ${name}` : ""} - trent's got you covered.`;
    return `good evening${name ? `, ${name}` : ""} - trent's still running.`;
  })();

  const handleRunCycle = () => {
    if (!companyId || (runCycle && runCycleIsActive(runCycle))) return;
    onRunCycle?.();
  };
  const cycleStatus = runCycle?.status ?? (activeCycleId ? "running" : "idle");
  const cycleActive = runCycle ? runCycleIsActive(runCycle) : Boolean(activeCycleId);
  const showCycleControl = cycleStatus !== "idle";
  const cycleLabel = runCycle?.label || activeStepLabel || cycleStatus;
  const cycleTone =
    cycleStatus === "failed" || cycleStatus === "lost_contact"
      ? "danger"
      : cycleStatus === "awaiting_approval"
        ? "approval"
        : cycleStatus === "cancelled"
          ? "muted"
          : "live";

  return (
    <header className="tbar">
      {isMobile && (
        <button type="button" onClick={onMenuClick} className="tbar-icon-button" aria-label="Open navigation">
          <I.list />
        </button>
      )}

      <div className="tbar-crumb">
        {!isMobile && pageName === "console" && session?.user ? (
          <span className="mono tbar-greeting">{greeting}</span>
        ) : (
          <>
            {!isMobile && (
              <button type="button" className="tbar-crumb-button" onClick={() => router.push("/companies")}>
                portfolio
              </button>
            )}
            {!isMobile && company && <I.chevR className="tbar-crumb-chev" />}
            {company && (
              <button type="button" className="tbar-crumb-button strong" onClick={() => router.push(`/companies/${company.id}`)}>
                {company.name}
              </button>
            )}
            {pageName !== "console" && (
              <>
                <I.chevR className="tbar-crumb-chev" />
                <span className="tbar-page-name">{pageName}</span>
              </>
            )}
          </>
        )}
      </div>

      <div className="tbar-spacer" />

      {!isMobile && (
        <button type="button" className="tbar-search-trigger" onClick={onOpenPalette}>
          <I.search />
          <span>jump, switch, run...</span>
          <kbd>Cmd K</kbd>
        </button>
      )}

      {showCycleControl ? (
        <div className="tbar-cycle-control" data-state={cycleStatus} data-tone={cycleTone}>
          <PulseDot size={6} />
          {!isMobile && <span>{cycleLabel}</span>}
          {runCycle?.approvalId && !isMobile && <span className="tbar-cycle-approval">{runCycle.approvalId}</span>}
          {onViewCycle && (
            <button type="button" className="tbar-cycle-action" onClick={onViewCycle} title="View run evidence">
              View
            </button>
          )}
          {cycleActive && onCancelCycle && (
            <button type="button" className="tbar-cycle-action danger" onClick={onCancelCycle} title="Cancel this run">
              Cancel
            </button>
          )}
          {!cycleActive && (
            <button type="button" className="tbar-cycle-action" onClick={handleRunCycle} title="Run another cycle">
              Retry
            </button>
          )}
        </div>
      ) : (
        <button type="button" onClick={handleRunCycle} className="tbar-run-button">
          <I.play width={13} height={13} />
          {!isMobile && "run cycle"}
        </button>
      )}

      {company && companyId && (
        <button
          type="button"
          title={company.status === "paused" ? "Resume all agents (Cmd Shift .)" : "Pause all agents - kill switch (Cmd Shift .)"}
          onClick={onToggleKillSwitch}
          className="tbar-icon-button kill"
          data-paused={company.status === "paused"}
        >
          {company.status === "paused" ? <I.play width={13} height={13} /> : <I.pause width={13} height={13} />}
        </button>
      )}

      {!isMobile && <RuntimeHealthChip />}

      {companyId && (
        <div id="notif-dropdown" className="tbar-notifs">
          <button
            type="button"
            onClick={() => setNotifOpen((open) => !open)}
            title="Notifications"
            className="tbar-icon-button"
            data-active={notifOpen}
          >
            <BellIcon />
            {notifCount > 0 && <span className="tbar-notif-count">{notifCount > 9 ? "9+" : notifCount}</span>}
          </button>

          {notifOpen && (
            <div className="tbar-notif-menu">
              <div className="tbar-notif-head">
                <span className="mono">notifications</span>
                {notifCount > 0 && <span className="mono unread">{notifCount} unread</span>}
              </div>
              <div className="tbar-notif-list">
                {notifs.length === 0 ? (
                  <div className="tbar-notif-empty">All clear. Nothing needs your attention.</div>
                ) : (
                  notifs.map((notification) => (
                    <a key={notification.id} href={notification.href} className="tbar-notif-item" onClick={() => setNotifOpen(false)}>
                      <span className="tbar-notif-kind">{iconForNotification(notification.kind)}</span>
                      <span className="tbar-notif-copy">
                        <span className="tbar-notif-title" data-kind={notification.kind}>{notification.title}</span>
                        <span className="mono tbar-notif-detail">{notification.detail}</span>
                      </span>
                    </a>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        title={session?.user?.email ?? ""}
        className="tbar-user"
        onClick={() => router.push("/auth/signin")}
      >
        {userInitials}
      </button>
    </header>
  );
}

const TRIAL_DAYS = 14;

export function TrialBanner({ company }: { company: ShellCompany | null }) {
  const [dismissed, setDismissed] = useState(false);

  if (!company?.createdAt || dismissed) return null;

  const daysElapsed = Math.floor((Date.now() - new Date(company.createdAt).getTime()) / (1000 * 60 * 60 * 24));
  const daysLeft = TRIAL_DAYS - daysElapsed;

  if (daysLeft <= 0) {
    return (
      <div className="trial-banner" data-state="ended">
        <span className="trial-dot">◆</span>
        <span className="mono trial-kicker">free trial ended</span>
        <span className="trial-copy">upgrade to keep Trent running. Operator $99 / Studio $299.</span>
        <a href="/pricing" className="trial-link">upgrade -&gt;</a>
      </div>
    );
  }

  return (
    <div className="trial-banner">
      <PulseDot size={5} />
      <span className="mono trial-kicker">{daysLeft === 1 ? "last day" : `${daysLeft} days left`} in your free trial</span>
      <span className="trial-copy">
        {daysLeft <= 3
          ? "14-day guarantee: 1 PR drafted, 1 post written, 1 letter delivered."
          : "everything is live, no credit card needed yet."}
      </span>
      <button type="button" onClick={() => setDismissed(true)} className="trial-dismiss" aria-label="Dismiss trial banner">
        x
      </button>
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function iconForNotification(kind: string): string {
  if (kind === "approval") return "◆";
  if (kind === "artifact") return "◈";
  if (kind === "cycle_fail") return "x";
  return "-";
}
