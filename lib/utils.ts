import type { AgentRole, TaskStatus } from "@/lib/types";

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 48);
}

export function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2
  }).format(cents / 100);
}

export function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

export function roleLabel(role: AgentRole) {
  const labels: Record<AgentRole, string> = {
    ceo: "CEO",
    engineer: "Engineer",
    growth: "Growth",
    content: "Design / Content",
    support: "Support / Ops",
    analyst: "Research / Analyst",
    finance: "Finance",
    escalation: "Critic / Escalation / Auditor",
    sales: "Sales"
  };
  return labels[role];
}

export function taskStatusLabel(status: TaskStatus) {
  return status.replace("_", " ");
}
