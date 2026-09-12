import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Anti-pattern #2 (AGENTS.md invariant 3): `@trent/core` must be a WRAPPER over
 * the existing application, not a rewrite of it. The floor is 8 distinct real
 * files under `apps/web/lib/`.
 *
 * This walks every source file under packages/trent-core/src, extracts each
 * module specifier, resolves the ones that point into apps/web, and counts the
 * distinct lib files that actually exist on disk. The count is computed, never
 * hard-coded — only the >= 8 floor is asserted.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC_DIR, "../../..");
const WEB_LIB_DIR = join(REPO_ROOT, "apps/web/lib");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const IMPORT_SPECIFIER = /(?:import|export)\s[^'"()]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

/** Resolve a specifier to an existing file under apps/web/lib, or null. */
function resolveWebLibFile(specifier: string, fromFile: string): string | null {
  let candidateBase: string | null = null;
  if (specifier.startsWith("@/")) {
    candidateBase = join(REPO_ROOT, "apps/web", specifier.slice(2));
  } else if (specifier.startsWith(".") && fromFile.includes("apps/web")) {
    candidateBase = resolve(dirname(fromFile), specifier);
  } else if (specifier.startsWith(".") && specifier.includes("apps/web/")) {
    candidateBase = resolve(dirname(fromFile), specifier);
  }
  if (candidateBase === null) return null;

  const stripped = candidateBase.replace(/\.(m|c)?js$/, "");
  for (const suffix of ["", ".ts", ".tsx", ".json", "/index.ts", "/index.tsx"]) {
    const attempt = stripped + suffix;
    try {
      if (statSync(attempt).isFile() && attempt.startsWith(WEB_LIB_DIR + "/")) return attempt;
    } catch {
      /* not this one */
    }
  }
  return null;
}

function directlyWrappedLibFiles(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      const resolved = resolveWebLibFile(specifier, file);
      if (resolved) found.add(relative(REPO_ROOT, resolved));
    }
  }
  return [...found].sort();
}

describe("anti-pattern #2 — @trent/core wraps the real application", () => {
  it("references at least 8 distinct files under apps/web/lib/", () => {
    const wrapped = directlyWrappedLibFiles();
    // eslint-disable-next-line no-console
    console.log(
      `@trent/core references ${wrapped.length} distinct apps/web/lib files:\n` +
        wrapped.map((f) => `  - ${f}`).join("\n"),
    );
    expect(wrapped.length).toBeGreaterThanOrEqual(8);
  });

  it("wraps rather than re-implements: every referenced lib file exists on disk", () => {
    for (const file of directlyWrappedLibFiles()) {
      expect(statSync(join(REPO_ROOT, file)).isFile()).toBe(true);
    }
  });

  it("keeps every hand-written wrapper source file under the 500-line ceiling", () => {
    // Generated client code (e.g. the Prisma store client) is exempt — the
    // 500-line rule in AGENTS.md governs code a human maintains.
    const oversized = sourceFiles(SRC_DIR)
      .map((f) => [relative(REPO_ROOT, f), readFileSync(f, "utf8").split("\n").length] as const)
      .filter(([file]) => !file.includes("/generated/"))
      .filter(([, lines]) => lines > 500);
    expect(oversized).toEqual([]);
  });
});
