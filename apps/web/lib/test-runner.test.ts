import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { detectTestRunner } from "@/lib/test-runner";

let workdir: string;

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-tr-"));
});

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(workdir, name), content, "utf8");
}

// ── Go ────────────────────────────────────────────────────────────────────────

describe("detectTestRunner — Go", () => {
  it("detects go_test from go.mod", async () => {
    await write("go.mod", "module example.com/myapp\n\ngo 1.21\n");
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("go_test");
    expect(result.command).toBe("go test ./...");
  });
});

// ── Rust ──────────────────────────────────────────────────────────────────────

describe("detectTestRunner — Rust", () => {
  it("detects cargo_test from Cargo.toml", async () => {
    await write("Cargo.toml", "[package]\nname = \"myapp\"\n");
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("cargo_test");
    expect(result.command).toBe("cargo test");
  });
});

// ── Python ────────────────────────────────────────────────────────────────────

describe("detectTestRunner — Python", () => {
  it("detects pytest from pytest.ini", async () => {
    await write("pytest.ini", "[pytest]\ntestpaths = tests\n");
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("pytest");
    expect(result.command).toBe("pytest");
    expect(result.configFile).toBe("pytest.ini");
  });

  it("detects pytest from pyproject.toml with [tool.pytest", async () => {
    await write("pyproject.toml", "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n");
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("pytest");
    expect(result.configFile).toBe("pyproject.toml");
  });

  it("detects pytest from setup.cfg with [tool:pytest]", async () => {
    await write("setup.cfg", "[tool:pytest]\ntestpaths = tests\n");
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("pytest");
    expect(result.configFile).toBe("setup.cfg");
  });

  it("detects pytest from requirements.txt alone (no package.json)", async () => {
    await write("requirements.txt", "pytest>=7\nrequests\n");
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("pytest");
  });

  it("does not detect pytest from requirements.txt when package.json present", async () => {
    await write("requirements.txt", "pytest>=7\n");
    await write("package.json", JSON.stringify({ name: "my-app" }));
    const result = await detectTestRunner(workdir);
    // Should fall through to Node detection
    expect(result.kind).not.toBe("pytest");
  });
});

// ── Node / JavaScript ─────────────────────────────────────────────────────────

describe("detectTestRunner — Node", () => {
  it("detects vitest from vitest.config.ts", async () => {
    await write("package.json", JSON.stringify({ name: "my-app" }));
    await write("vitest.config.ts", "export default {}");
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("vitest");
    expect(result.command).toBe("vitest run");
    expect(result.configFile).toBe("vitest.config.ts");
  });

  it("detects vitest from devDependencies", async () => {
    await write("package.json", JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }));
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("vitest");
    expect(result.command).toBe("vitest run");
  });

  it("detects jest from jest.config.js", async () => {
    await write("package.json", JSON.stringify({ name: "my-app" }));
    await write("jest.config.js", "module.exports = {}");
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("jest");
    expect(result.command).toBe("jest");
    expect(result.configFile).toBe("jest.config.js");
  });

  it("detects jest from devDependencies", async () => {
    await write("package.json", JSON.stringify({ devDependencies: { jest: "^29.0.0" } }));
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("jest");
  });

  it("detects mocha from devDependencies", async () => {
    await write("package.json", JSON.stringify({ devDependencies: { mocha: "^10.0.0" } }));
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("mocha");
  });

  it("detects vitest from scripts.test", async () => {
    await write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("vitest");
  });

  it("detects jest from scripts.test", async () => {
    await write("package.json", JSON.stringify({ scripts: { test: "jest --coverage" } }));
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("jest");
  });

  it("returns unknown for package.json with placeholder test script", async () => {
    await write("package.json", JSON.stringify({
      scripts: { test: "echo \"Error: no test specified\" && exit 1" }
    }));
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("unknown");
  });

  it("prefers vitest config file over jest devDependency", async () => {
    await write("package.json", JSON.stringify({
      devDependencies: { jest: "^29.0.0", vitest: "^1.0.0" }
    }));
    await write("vitest.config.ts", "export default {}");
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("vitest");
  });
});

// ── Unknown ───────────────────────────────────────────────────────────────────

describe("detectTestRunner — unknown", () => {
  it("returns unknown for empty directory", async () => {
    const result = await detectTestRunner(workdir);
    expect(result.kind).toBe("unknown");
    expect(result.command).toBe("");
  });
});

export {};
