"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ConsoleMark, I, PulseDot } from "@/components/ui";
import { NAV_GROUPS, hrefFor, type NavGroupConfig, type NavItemConfig } from "@/components/nav-config";

export type ShellCompany = {
  id: string;
  name: string;
  status: string;
  lastCycleAt?: string;
  nextCycleAt?: string;
  pendingApprovals?: number;
  createdAt?: string;
};

type SidebarProps = {
  companies: ShellCompany[];
  company: ShellCompany | null;
  companyId?: string;
  isMobile?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
  activeCycleId?: string | null;
};

const COLLAPSED_KEY = "trent_nav_collapsed";

function companyHue(name: string): number {
  let hue = 0;
  for (let index = 0; index < name.length; index += 1) {
    hue = (hue * 31 + name.charCodeAt(index)) % 360;
  }
  return hue;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function readCollapsedState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return raw ? JSON.parse(raw) as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

export function Sidebar({
  companies,
  company,
  companyId,
  isMobile,
  isOpen,
  onClose,
  activeCycleId,
}: SidebarProps) {
  const [companyOpen, setCompanyOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const cid = companyId || company?.id || "";
  const pendingApprovals = company?.pendingApprovals ?? 0;

  useEffect(() => {
    setCollapsed(readCollapsedState());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch {}
  }, [collapsed, hydrated]);

  const navGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.map((item) => ({
          ...item,
          href: hrefFor(cid, item.slug),
          badge: item.approvalsBadge && pendingApprovals > 0 ? String(pendingApprovals) : undefined,
        })),
      })),
    [cid, pendingApprovals],
  );

  const handleCompanySelect = (selectedCompanyId: string) => {
    router.push(`/companies/${selectedCompanyId}`);
    setCompanyOpen(false);
    onClose?.();
  };

  const handlePortfolioClick = () => {
    router.push("/companies");
    setCompanyOpen(false);
    onClose?.();
  };

  return (
    <>
      {isMobile && isOpen && <div className="nav-mobile-scrim" onClick={onClose} />}
      <aside
        className="nav-sidebar"
        data-mobile={isMobile ? "true" : "false"}
        data-open={isOpen ? "true" : "false"}
      >
        <div className="nav-logo">
          <ConsoleMark size={20} />
          <span className="mono">trent</span>
          <span className="nav-version">v1.0</span>
        </div>

        {company && (
          <div className="nav-company">
            <button type="button" className="nav-company-button" onClick={() => setCompanyOpen((open) => !open)}>
              <span className="nav-company-mark" style={{ background: `oklch(0.65 0.16 ${companyHue(company.name)})` }}>
                {company.name[0]}
              </span>
              <span className="nav-company-copy">
                <span className="nav-company-name">{company.name}</span>
                <span className="nav-company-status" data-status={company.status}>
                  {company.status === "active" ? "operating" : "paused"}
                </span>
              </span>
              <I.chevR className="nav-chev" data-open={companyOpen ? "true" : "false"} />
            </button>

            {companyOpen && (
              <div className="nav-company-menu">
                {companies.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="nav-company-option"
                    data-active={candidate.id === company.id}
                    onClick={() => handleCompanySelect(candidate.id)}
                  >
                    <span className="nav-company-option-mark" style={{ background: `oklch(0.65 0.16 ${companyHue(candidate.name)})` }}>
                      {candidate.name[0]}
                    </span>
                    <span>{candidate.name}</span>
                    <span className="nav-company-dot" data-status={candidate.status} />
                  </button>
                ))}
                <div className="nav-divider" />
                <button type="button" className="nav-company-option" onClick={handlePortfolioClick}>
                  <I.list />
                  <span>portfolio</span>
                  <I.chevR style={{ marginLeft: "auto" }} />
                </button>
              </div>
            )}
          </div>
        )}

        <nav className="nav-groups" aria-label="Company navigation">
          {navGroups.map((group) => (
            <SidebarGroup
              key={group.id}
              group={group}
              collapsed={Boolean(collapsed[group.id])}
              pathname={pathname}
              approvalCount={group.id === "govern" ? pendingApprovals : 0}
              onToggle={() => setCollapsed((current) => ({ ...current, [group.id]: !current[group.id] }))}
              onNavigate={(href) => {
                router.push(href as Parameters<typeof router.push>[0]);
                onClose?.();
              }}
            />
          ))}
        </nav>

        <CycleFooter company={company} activeCycleId={activeCycleId} />
      </aside>
    </>
  );
}

type SidebarGroupProps = {
  group: Omit<NavGroupConfig, "items"> & { items: Array<NavItemConfig & { href: string; badge?: string }> };
  collapsed: boolean;
  pathname: string;
  approvalCount: number;
  onToggle: () => void;
  onNavigate: (href: string) => void;
};

function SidebarGroup({ group, collapsed, pathname, approvalCount, onToggle, onNavigate }: SidebarGroupProps) {
  return (
    <section className="nav-section">
      <button type="button" className="nav-section-toggle" data-collapsed={collapsed} onClick={onToggle}>
        <I.chevR className="nav-section-chev" />
        <span>{group.label}</span>
        {approvalCount > 0 && <span className="nav-section-badge">{approvalCount > 9 ? "9+" : approvalCount}</span>}
      </button>

      {!collapsed && (
        <div className="nav-section-items">
          {group.items.map((item) => {
            const exact = item.slug ? pathname === item.href || pathname.startsWith(`${item.href}/`) : pathname === item.href;
            const Icon = I[item.icon];
            return (
              <button
                key={item.slug || "console"}
                type="button"
                className="nav-item"
                data-active={exact}
                onClick={() => onNavigate(item.href)}
              >
                <span className="nav-active-rail" />
                <Icon className="nav-item-icon" />
                <span className="nav-item-label">{item.label}</span>
                {item.badge && <span className="nav-badge">{item.badge}</span>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CycleFooter({ company, activeCycleId }: { company: ShellCompany | null; activeCycleId?: string | null }) {
  let eyebrow = "no cycles yet";
  let body = "run a cycle to get started";
  let state: "running" | "paused" | "operating" | "idle" = "idle";

  if (activeCycleId) {
    state = "running";
    eyebrow = "running";
    body = "cycle in progress...";
  } else if (company?.status === "paused") {
    state = "paused";
    eyebrow = "paused";
    body = "cycles are paused";
  } else if (company?.lastCycleAt) {
    state = "operating";
    eyebrow = "operating";
    body = `last cycle ${timeAgo(company.lastCycleAt)}`;
  }

  return (
    <div className="nav-cycle">
      <div className="nav-cycle-card" data-state={state}>
        <div className="nav-cycle-kicker">
          {state !== "idle" && state !== "paused" && <PulseDot size={6} />}
          {state === "paused" && <span>○</span>}
          <span>{eyebrow}</span>
        </div>
        <div className="nav-cycle-body">{body}</div>
      </div>
    </div>
  );
}
