"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { I } from "@/components/ui";
import { flattenNav, fuzzyScore, matchesNavItem, type FlatNavItem, type NavIconName } from "@/components/nav-config";

type PaletteCompany = {
  id: string;
  name: string;
  status: string;
};

type PaletteEntry = {
  key: string;
  group: "navigate" | "companies" | "actions";
  label: string;
  hint?: string;
  icon: NavIconName;
  score: number;
  run: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  companyId?: string;
  companies: PaletteCompany[];
  companyStatus?: string;
  onRunCycle?: () => void;
  onToggleKillSwitch?: () => void;
};

const GROUP_LABELS: Record<PaletteEntry["group"], string> = {
  navigate: "navigate",
  companies: "switch company",
  actions: "actions",
};

export function CommandPalette({
  open,
  onClose,
  companyId,
  companies,
  companyStatus,
  onRunCycle,
  onToggleKillSwitch,
}: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  const entries = useMemo<PaletteEntry[]>(() => {
    if (!open) return [];

    const go = (href: string) => () => {
      router.push(href as Parameters<typeof router.push>[0]);
      onClose();
    };

    const navEntries: PaletteEntry[] = companyId
      ? flattenNav(companyId).map((item: FlatNavItem) => ({
          key: `nav:${item.href}`,
          group: "navigate" as const,
          label: item.label,
          hint: item.groupLabel,
          icon: item.icon,
          score: matchesNavItem(query, item),
          run: go(item.href),
        }))
      : [];

    const companyEntries: PaletteEntry[] = companies
      .filter((company) => company.id !== companyId)
      .map((company) => ({
        key: `company:${company.id}`,
        group: "companies" as const,
        label: company.name,
        hint: company.status === "active" ? "operating" : "paused",
        icon: "building" as const,
        score: query ? fuzzyScore(query, company.name) : 0.5,
        run: go(`/companies/${company.id}`),
      }));

    const actionEntries: PaletteEntry[] = [];

    if (companyId && onRunCycle) {
      actionEntries.push({
        key: "action:run-cycle",
        group: "actions",
        label: "run cycle",
        hint: "start an operating cycle",
        icon: "play",
        score: Math.max(fuzzyScore(query, "run cycle"), fuzzyScore(query, "start")),
        run: () => {
          onRunCycle();
          onClose();
        },
      });
    }

    if (companyId && onToggleKillSwitch) {
      const paused = companyStatus === "paused";
      actionEntries.push({
        key: "action:kill-switch",
        group: "actions",
        label: paused ? "resume all agents" : "pause all agents",
        hint: "kill switch - Cmd Shift .",
        icon: paused ? "play" : "shield",
        score: Math.max(fuzzyScore(query, paused ? "resume all agents" : "pause all agents"), fuzzyScore(query, "kill switch")),
        run: () => {
          onToggleKillSwitch();
          onClose();
        },
      });
    }

    actionEntries.push({
      key: "action:portfolio",
      group: "actions",
      label: "portfolio",
      hint: "all companies",
      icon: "list",
      score: Math.max(fuzzyScore(query, "portfolio"), fuzzyScore(query, "companies")),
      run: go("/companies"),
    });

    return [...navEntries, ...companyEntries, ...actionEntries]
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [open, query, companyId, companies, companyStatus, onRunCycle, onToggleKillSwitch, router, onClose]);

  const grouped = useMemo(() => {
    const order: PaletteEntry["group"][] = ["navigate", "actions", "companies"];
    return order
      .map((group) => ({ group, items: entries.filter((entry) => entry.group === group) }))
      .filter((group) => group.items.length > 0);
  }, [entries]);

  const flatOrder = useMemo(() => grouped.flatMap((group) => group.items), [grouped]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;

    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((current) => Math.min(current + 1, flatOrder.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((current) => Math.max(current - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        flatOrder[selected]?.run();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, flatOrder, selected, onClose]);

  useEffect(() => {
    const item = listRef.current?.querySelector(`[data-index="${selected}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;

  let runningIndex = -1;

  return (
    <>
      <div className="cmdk-overlay" onClick={onClose} />
      <div className="cmdk-panel" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input-row">
          <I.search style={{ color: "var(--haze)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            className="cmdk-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="go to page, switch company, run action..."
            spellCheck={false}
          />
          <span className="cmdk-kbd">esc</span>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {flatOrder.length === 0 ? (
            <div className="cmdk-empty">no matches for "{query}"</div>
          ) : (
            grouped.map((group) => (
              <div key={group.group}>
                <div className="cmdk-group-label">{GROUP_LABELS[group.group]}</div>
                {group.items.map((entry) => {
                  runningIndex += 1;
                  const index = runningIndex;
                  const Icon = I[entry.icon];
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      className="cmdk-item"
                      data-index={index}
                      data-selected={index === selected}
                      onMouseEnter={() => setSelected(index)}
                      onClick={entry.run}
                    >
                      <Icon className="cmdk-ico" />
                      <span>{entry.label}</span>
                      {entry.hint && <span className="cmdk-hint">{entry.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="cmdk-foot">
          <span>up/down navigate</span>
          <span>enter select</span>
          <span style={{ marginLeft: "auto" }}>Cmd K to toggle</span>
        </div>
      </div>
    </>
  );
}
