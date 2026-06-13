import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAV_GROUPS, flattenNav, fuzzyScore, hrefFor, matchesNavItem } from "@/components/nav-config";

describe("NAV_GROUPS", () => {
  it("groups the app navigation into five operator sections", () => {
    expect(NAV_GROUPS.map((group) => group.id)).toEqual(["operate", "build", "knowledge", "govern", "setup"]);
    expect(NAV_GROUPS.flatMap((group) => group.items).map((item) => item.label)).toEqual([
      "console",
      "command",
      "goals",
      "queue",
      "missions",
      "cycles",
      "workbench",
      "trenchpad",
      "mcp",
      "artifacts",
      "reports",
      "memory",
      "wiki",
      "vault graph",
      "autoresearch",
      "approvals",
      "budgets",
      "audit",
      "integrations",
      "agents",
      "agent plug",
      "settings",
    ]);
    expect(NAV_GROUPS.flatMap((group) => group.items).map((item) => item.slug)).not.toContain("app-solo");
  });

  it("keeps approvals badge metadata on the govern group", () => {
    const govern = NAV_GROUPS.find((group) => group.id === "govern");

    expect(govern?.items.find((item) => item.slug === "approvals")).toMatchObject({
      label: "approvals",
      approvalsBadge: true,
    });
  });
});

describe("nav ⇄ filesystem reconciliation", () => {
  const INTENTIONALLY_UNLINKED: Record<string, string> = {
    "app-solo": "redirect stub to /workbench?mode=agents (legacy URL kept alive)",
  };

  const companyPagesDir = fileURLToPath(new URL("../app/companies/[id]", import.meta.url));
  const pageDirs = readdirSync(companyPagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(companyPagesDir, name, "page.tsx")));
  const navSlugs = new Set(NAV_GROUPS.flatMap((group) => group.items).map((item) => item.slug));

  it("every company page directory is reachable from the nav or explicitly allowlisted", () => {
    const orphans = pageDirs.filter((dir) => !navSlugs.has(dir) && !(dir in INTENTIONALLY_UNLINKED));
    expect(
      orphans,
      `Pages exist under app/companies/[id]/ that no nav item points to: ${orphans.join(", ")}. Add a nav item in components/nav-config.ts or allowlist with a reason.`,
    ).toEqual([]);
  });

  it("every nav slug resolves to a real page", () => {
    const deadLinks = [...navSlugs].filter((slug) => {
      const target = slug === ""
        ? path.join(companyPagesDir, "page.tsx")
        : path.join(companyPagesDir, slug, "page.tsx");
      return !existsSync(target);
    });
    expect(deadLinks, `Nav items point at slugs with no page.tsx: ${deadLinks.join(", ")}`).toEqual([]);
  });

  it("allowlist entries stay honest", () => {
    for (const dir of Object.keys(INTENTIONALLY_UNLINKED)) {
      expect(pageDirs, `Allowlisted page "${dir}" no longer exists; remove it from INTENTIONALLY_UNLINKED`).toContain(dir);
      expect(navSlugs.has(dir), `"${dir}" is allowlisted as unlinked but now has a nav item; remove the allowlist entry`).toBe(false);
    }
  });
});

describe("navigation helpers", () => {
  it("builds console and subpage hrefs for a company", () => {
    expect(hrefFor("co_123", "")).toBe("/companies/co_123");
    expect(hrefFor("co_123", "queue")).toBe("/companies/co_123/queue");
  });

  it("flattens grouped nav with href and group labels", () => {
    expect(flattenNav("co_123").find((item) => item.slug === "workbench")).toMatchObject({
      label: "workbench",
      groupId: "build",
      groupLabel: "build",
      href: "/companies/co_123/workbench",
    });
  });

  it("supports substring and subsequence fuzzy matching", () => {
    expect(fuzzyScore("work", "workbench")).toBeGreaterThan(fuzzyScore("wb", "workbench"));
    expect(fuzzyScore("wb", "workbench")).toBeGreaterThan(0);
    expect(fuzzyScore("zz", "workbench")).toBe(-1);
  });

  it("matches item labels and keywords for the command palette", () => {
    const command = flattenNav("co_123").find((item) => item.slug === "command");

    expect(command).toBeDefined();
    expect(matchesNavItem("ceo", command!)).toBeGreaterThan(0);
  });
});
