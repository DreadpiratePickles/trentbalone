/**
 * Test runner auto-detection.
 *
 * Inspects a project directory and returns the appropriate test runner
 * and command to use without requiring the user to configure it.
 */

import * as fs from "fs/promises";
import * as path from "path";

export type TestRunnerKind =
  | "jest"
  | "vitest"
  | "mocha"
  | "pytest"
  | "go_test"
  | "cargo_test"
  | "unknown";

export type DetectedTestRunner = {
  kind: TestRunnerKind;
  /** Ready-to-run command, e.g. "vitest run" or "go test ./...". Empty string when unknown. */
  command: string;
  /** Config file that triggered detection, if any. */
  configFile?: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fileContains(filePath: string, substring: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.includes(substring);
  } catch {
    return false;
  }
}

// ── Per-language detection ────────────────────────────────────────────────────

async function detectGo(workdir: string): Promise<DetectedTestRunner | null> {
  if (await fileExists(path.join(workdir, "go.mod"))) {
    return { kind: "go_test", command: "go test ./..." };
  }
  return null;
}

async function detectRust(workdir: string): Promise<DetectedTestRunner | null> {
  if (await fileExists(path.join(workdir, "Cargo.toml"))) {
    return { kind: "cargo_test", command: "cargo test" };
  }
  return null;
}

async function detectPython(workdir: string): Promise<DetectedTestRunner | null> {
  if (await fileExists(path.join(workdir, "pytest.ini"))) {
    return { kind: "pytest", command: "pytest", configFile: "pytest.ini" };
  }
  const pyproject = path.join(workdir, "pyproject.toml");
  if (await fileContains(pyproject, "[tool.pytest")) {
    return { kind: "pytest", command: "pytest", configFile: "pyproject.toml" };
  }
  const setupCfg = path.join(workdir, "setup.cfg");
  if (await fileContains(setupCfg, "[tool:pytest]")) {
    return { kind: "pytest", command: "pytest", configFile: "setup.cfg" };
  }
  // requirements.txt without package.json → assume Python project
  if (
    await fileExists(path.join(workdir, "requirements.txt")) &&
    !(await fileExists(path.join(workdir, "package.json")))
  ) {
    return { kind: "pytest", command: "pytest" };
  }
  return null;
}

type PackageJson = {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

async function detectNode(workdir: string): Promise<DetectedTestRunner | null> {
  const pkgPath = path.join(workdir, "package.json");
  if (!(await fileExists(pkgPath))) return null;

  const pkg = await readJsonFile(pkgPath) as PackageJson;

  // Config-file detection first (most specific signal)
  for (const cfg of ["vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs"]) {
    if (await fileExists(path.join(workdir, cfg))) {
      return { kind: "vitest", command: "vitest run", configFile: cfg };
    }
  }
  for (const cfg of ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs"]) {
    if (await fileExists(path.join(workdir, cfg))) {
      return { kind: "jest", command: "jest", configFile: cfg };
    }
  }

  // devDependencies / dependencies
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  if (deps["vitest"]) return { kind: "vitest", command: "vitest run" };
  if (deps["jest"] || deps["@jest/core"]) return { kind: "jest", command: "jest" };
  if (deps["mocha"]) return { kind: "mocha", command: "mocha" };

  // Fall back to scripts.test content
  const testScript = pkg.scripts?.["test"] ?? "";
  if (testScript.includes("vitest")) return { kind: "vitest", command: "vitest run" };
  if (testScript.includes("jest")) return { kind: "jest", command: "jest" };
  if (testScript.includes("mocha")) return { kind: "mocha", command: "mocha" };
  if (testScript.includes("pytest")) return { kind: "pytest", command: "pytest" };
  if (testScript && testScript !== "echo \"Error: no test specified\" && exit 1") {
    return { kind: "unknown", command: "npm test" };
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Inspect a project directory and return the detected test runner.
 * Returns `{ kind: "unknown", command: "" }` when no runner can be identified.
 */
export async function detectTestRunner(workdir: string): Promise<DetectedTestRunner> {
  const unknown: DetectedTestRunner = { kind: "unknown", command: "" };

  return (
    (await detectGo(workdir)) ??
    (await detectRust(workdir)) ??
    (await detectPython(workdir)) ??
    (await detectNode(workdir)) ??
    unknown
  );
}
