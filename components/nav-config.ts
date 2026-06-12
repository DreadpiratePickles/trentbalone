export type NavIconName =
  | "bolt"
  | "sparkle"
  | "check"
  | "inbox"
  | "building"
  | "play"
  | "cycle"
  | "diamond"
  | "doc"
  | "brain"
  | "wallet"
  | "shield"
  | "plug"
  | "settings"
  | "list";

export type NavItemConfig = {
  label: string;
  slug: string;
  icon: NavIconName;
  keywords?: string[];
  approvalsBadge?: boolean;
};

export type NavGroupConfig = {
  id: "operate" | "build" | "knowledge" | "govern" | "setup";
  label: string;
  items: NavItemConfig[];
};

export const NAV_GROUPS: NavGroupConfig[] = [
  {
    id: "operate",
    label: "operate",
    items: [
      { label: "console", slug: "", icon: "bolt", keywords: ["home", "dashboard", "overview"] },
      { label: "command", slug: "command", icon: "sparkle", keywords: ["chat", "ceo", "orchestrate", "goal"] },
      { label: "goals", slug: "goals", icon: "check", keywords: ["objectives", "criteria"] },
      { label: "queue", slug: "queue", icon: "inbox", keywords: ["tasks", "backlog", "work"] },
      { label: "missions", slug: "missions", icon: "cycle", keywords: ["agent missions", "campaigns"] },
      { label: "cycles", slug: "cycles", icon: "cycle", keywords: ["runs", "history", "operating"] },
    ],
  },
  {
    id: "build",
    label: "build",
    items: [
      { label: "workbench", slug: "workbench", icon: "building", keywords: ["sandbox", "code", "sessions", "dev"] },
      { label: "mcp", slug: "mcp", icon: "plug", keywords: ["model context protocol", "tools", "servers"] },
      { label: "artifacts", slug: "artifacts", icon: "diamond", keywords: ["deliverables", "outputs", "exports"] },
      { label: "reports", slug: "reports", icon: "doc", keywords: ["weekly", "summary"] },
    ],
  },
  {
    id: "knowledge",
    label: "knowledge",
    items: [
      { label: "memory", slug: "memory", icon: "brain", keywords: ["vault", "context", "documents", "search"] },
      { label: "wiki", slug: "wiki", icon: "doc", keywords: ["docs", "knowledge base", "trench"] },
      { label: "vault graph", slug: "vault-graph", icon: "diamond", keywords: ["graph", "connections"] },
      { label: "autoresearch", slug: "autoresearch", icon: "sparkle", keywords: ["research", "deep dive"] },
    ],
  },
  {
    id: "govern",
    label: "govern",
    items: [
      { label: "approvals", slug: "approvals", icon: "shield", keywords: ["pending", "gates", "review"], approvalsBadge: true },
      { label: "budgets", slug: "budgets", icon: "wallet", keywords: ["spend", "cost", "ledger"] },
      { label: "audit", slug: "audit", icon: "list", keywords: ["log", "compliance", "trail"] },
      { label: "integrations", slug: "integrations", icon: "plug", keywords: ["connections", "mcp", "credentials"] },
    ],
  },
  {
    id: "setup",
    label: "setup",
    items: [
      { label: "agents", slug: "agents", icon: "list", keywords: ["seats", "team", "roles"] },
      { label: "agent plug", slug: "plug", icon: "plug", keywords: ["marketplace", "plugs", "specialists"] },
      { label: "settings", slug: "settings", icon: "settings", keywords: ["configuration", "preferences", "company"] },
    ],
  },
];

export function hrefFor(companyId: string, slug: string): string {
  return slug ? `/companies/${companyId}/${slug}` : `/companies/${companyId}`;
}

export type FlatNavItem = NavItemConfig & {
  groupId: NavGroupConfig["id"];
  groupLabel: string;
  href: string;
};

export function flattenNav(companyId: string): FlatNavItem[] {
  return NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      ...item,
      groupId: group.id,
      groupLabel: group.label,
      href: hrefFor(companyId, item.slug),
    })),
  );
}

export function fuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 1;
  if (c.includes(q)) return c.startsWith(q) ? 100 - c.length : 60 - c.indexOf(q);

  let qi = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci += 1) {
    if (c[ci] === q[qi]) qi += 1;
  }

  return qi === q.length ? 20 - (c.length - q.length) : -1;
}

export function matchesNavItem(query: string, item: NavItemConfig): number {
  return Math.max(
    fuzzyScore(query, item.label),
    ...(item.keywords ?? []).map((keyword) => fuzzyScore(query, keyword)),
  );
}
