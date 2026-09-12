import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(DESKTOP, "src-tauri/src");
const rust = readdirSync(SRC)
  .filter((f) => f.endsWith(".rs"))
  .map((f) => [f, readFileSync(join(SRC, f), "utf8")] as const);
const main = rust.find(([f]) => f === "main.rs")![1];

/**
 * Assertions below are about CODE, not prose. This file's own doc comments quote
 * the very anti-patterns being banned (`get_window(..).unwrap()`, the port 3000,
 * the old "Pending Approvals (0)" literal) so that the reason each rule exists
 * stays next to the rule. Strip comment-only lines before matching.
 */
const code = (source: string) =>
  source
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("the from-scratch SPA is gone", () => {
  it.each([
    "src",
    "index.html",
    "vite.config.ts",
    "tailwind.config.js",
    "postcss.config.js",
    "dist",
  ])("apps/desktop/%s no longer exists", (p) => {
    expect(existsSync(join(DESKTOP, p))).toBe(false);
  });

  it("no React view files survive anywhere in the app", () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps.react).toBeUndefined();
    expect(deps["react-dom"]).toBeUndefined();
    expect(deps.vite).toBeUndefined();
  });
});

describe("Rust shell", () => {
  /**
   * The regression this locks down: `main.rs` called
   * `app.get_window("main").unwrap()` inside the tray menu handler and four more
   * times immediately after it, so any tray click made after the window had been
   * closed panicked and took the tray process down with it.
   */
  it("never unwraps a window lookup", () => {
    for (const [file, source] of rust) {
      const offenders = code(source)
        .split("\n")
        .filter((l) => /get_(webview_)?window\([^)]*\)\s*\.unwrap\(\)/.test(l));
      expect(offenders, `${file}: ${offenders.join(" | ")}`).toEqual([]);
    }
  });

  it("has no .unwrap() or .expect() on window operations at all", () => {
    for (const [file, source] of rust) {
      const offenders = code(source)
        .split("\n")
        .filter((l) => /\bwin(dow)?\s*\.\s*\w+\([^)]*\)\s*\.\s*(unwrap|expect)\b/.test(l));
      expect(offenders, `${file}: ${offenders.join(" | ")}`).toEqual([]);
    }
  });

  it("spawns the long-running server rather than executing it", () => {
    expect(rust.some(([, s]) => /\.spawn\(\)/.test(s))).toBe(true);
    expect(rust.some(([, s]) => /shell\(\)\s*\.\s*execute/.test(s))).toBe(false);
  });

  it("binds the loopback interface on an OS-assigned port, never 3000", () => {
    const server = rust.find(([f]) => f === "server.rs")![1];
    expect(server).toContain('TcpListener::bind(("127.0.0.1", 0))');
    expect(server).toContain('.env("HOSTNAME", "127.0.0.1")');
    for (const [file, source] of rust) {
      expect(code(source), `${file} hardcodes a port`).not.toMatch(/\b(3000|7895)\b/);
    }
  });

  it("waits for the port to accept before revealing the window", () => {
    expect(main).toContain("wait_until_accepting");
    const waitAt = main.indexOf("wait_until_accepting");
    const showAt = main.indexOf("show_main(&boot_app);\n                        }");
    expect(waitAt).toBeGreaterThan(-1);
    expect(showAt).toBeGreaterThan(waitAt);
  });

  it("kills the child on window close, on exit and on signal", () => {
    expect(main).toContain("WindowEvent::CloseRequested");
    expect(main).toContain("RunEvent::Exit");
    expect(main).toContain("ctrlc::set_handler");
    // Every one of those paths goes through the same idempotent shutdown.
    expect(main.match(/\.shutdown\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("carries the standalone environment contract onto the sidecar", () => {
    const server = rust.find(([f]) => f === "server.rs")![1];
    // AGENTS.md: omitting this runs every job twice, at ~4x the model bill.
    expect(server).toContain('.env("TRENT_QUEUE_FALLBACK", "disabled")');
  });

  it("reads tray state instead of printing the old literal", () => {
    const tray = rust.find(([f]) => f === "tray.rs")![1];
    expect(code(tray)).not.toContain("Pending Approvals (0)");
    expect(tray).toContain("fn labels(snap: &FleetSnapshot)");
  });
});

describe("Cargo manifest", () => {
  const cargo = readFileSync(join(DESKTOP, "src-tauri/Cargo.toml"), "utf8");

  it("is on Tauri v2 with the tray in core", () => {
    expect(cargo).toMatch(/^tauri = \{ version = "2"/m);
    expect(cargo).toContain('features = ["tray-icon"]');
    // There is no tray plugin in v2 — the tray moved into core.
    expect(cargo).not.toContain("tauri-plugin-tray");
    expect(cargo).not.toContain('version = "1.6');
  });

  it("drops the filesystem plugin nothing was using", () => {
    expect(cargo).not.toContain("tauri-plugin-fs");
  });
});
