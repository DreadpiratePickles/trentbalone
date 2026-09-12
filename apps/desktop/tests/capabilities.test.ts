import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = dirname(dirname(fileURLToPath(import.meta.url)));
const CAP_DIR = join(DESKTOP, "src-tauri/capabilities");
const CONF = join(DESKTOP, "src-tauri/tauri.conf.json");

type Capability = {
  identifier: string;
  local?: boolean;
  remote?: { urls: string[] };
  windows?: string[];
  permissions: Array<string | { identifier: string; allow?: unknown[] }>;
};

const capabilityFiles = readdirSync(CAP_DIR).filter((f) => f.endsWith(".json"));
const capabilities: Array<[string, Capability]> = capabilityFiles.map((f) => [
  f,
  JSON.parse(readFileSync(join(CAP_DIR, f), "utf8")) as Capability,
]);
const conf = JSON.parse(readFileSync(CONF, "utf8"));

const permissionIds = (cap: Capability) =>
  cap.permissions.map((p) => (typeof p === "string" ? p : p.identifier));

describe("shipped capability files", () => {
  it("ships at least one capability", () => {
    expect(capabilityFiles.length).toBeGreaterThan(0);
  });

  /**
   * The load-bearing one. In Tauri v2 a `remote` capability grants the listed
   * origin access to the IPC layer, and therefore to local system capabilities.
   * A wildcard there would hand that access to any origin that matches.
   */
  it.each(capabilities)("%s contains no wildcard anywhere", (_file, cap) => {
    const raw = JSON.stringify({ ...cap, description: undefined });
    expect(raw).not.toContain("*");
  });

  it.each(capabilities)("%s scopes every remote url to the loopback host", (_file, cap) => {
    for (const url of cap.remote?.urls ?? []) {
      expect(url).not.toContain("*");
      expect(url.startsWith("http://127.0.0.1")).toBe(true);
      // Only the ephemeral port may vary, and it is a URLPattern named
      // group (`::port`) — never a wildcard.
      expect(url.replace("http://127.0.0.1", "")).toMatch(/^(|:\d+|::[a-z]+)$/);
    }
  });

  it("grants the remote web UI nothing but event listening", () => {
    const remote = capabilities.filter(([, c]) => c.remote?.urls?.length);
    expect(remote.length).toBeGreaterThan(0);
    for (const [file, cap] of remote) {
      expect(cap.local, `${file} must not also cover local content`).toBe(false);
      expect(permissionIds(cap).sort()).toEqual([
        "core:event:allow-listen",
        "core:event:allow-unlisten",
      ]);
    }
  });

  it("spawns the sidecar with allow-spawn, never allow-execute", () => {
    const all = capabilities.flatMap(([, c]) => permissionIds(c));
    expect(all).toContain("shell:allow-spawn");
    // `execute` blocks until the process ends; the Next server never ends.
    expect(all).not.toContain("shell:allow-execute");
    expect(all).not.toContain("shell:default");
  });

  it("grants no filesystem, http or arbitrary window control to any origin", () => {
    const all = capabilities.flatMap(([, c]) => permissionIds(c));
    for (const forbidden of ["fs:", "http:", "core:window:allow-create"]) {
      expect(all.filter((p) => p.startsWith(forbidden))).toEqual([]);
    }
  });

  it("scopes the shell permission to the bundled bun sidecar only", () => {
    const scoped = capabilities
      .flatMap(([, c]) => c.permissions)
      .filter((p): p is { identifier: string; allow?: unknown[] } => typeof p !== "string");
    const shell = scoped.find((p) => p.identifier === "shell:allow-spawn");
    expect(shell?.allow).toEqual([{ name: "binaries/bun", sidecar: true, args: true }]);
  });
});

describe("tauri.conf.json", () => {
  it("sets an explicit CSP rather than leaving it null", () => {
    const csp = conf.app?.security?.csp;
    expect(typeof csp).toBe("string");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("wraps the web app instead of shipping a from-scratch SPA", () => {
    // The v1 app set distDir "../dist" and built its own Vite React UI.
    expect(conf.build.frontendDist).toBe("../splash");
    expect(conf.bundle.externalBin).toEqual(["binaries/bun"]);
    expect(conf.bundle.resources).toEqual({ "resources/server": "server" });
  });

  it("keeps the window hidden until the sidecar is accepting", () => {
    const main = conf.app.windows.find((w: { label: string }) => w.label === "main");
    expect(main.visible).toBe(false);
  });

  it("declares the tray in core, with no v1 allowlist left behind", () => {
    expect(conf.app.trayIcon.id).toBe("trent-fleet");
    expect(conf.tauri).toBeUndefined();
    expect(JSON.stringify(conf)).not.toContain("allowlist");
  });

  it("never hardcodes a port", () => {
    expect(JSON.stringify(conf)).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(JSON.stringify(conf)).not.toContain("localhost:3000");
  });
});
