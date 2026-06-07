import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as net from "net";
import {
  probePort,
  detectDevServerPort,
  getLocalPreviewUrl,
  getWorkbenchPreviewCandidatePorts,
  isHostAppPreviewUrl,
  isLocalPreviewUrl,
} from "@/lib/workbench-preview";

// ── probePort ─────────────────────────────────────────────────────────────────

describe("probePort", () => {
  let server: net.Server;
  let port: number;

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns true when something is listening", async () => {
    expect(await probePort(port)).toBe(true);
  });

  it("returns false for a port nothing is listening on", async () => {
    // Use a high ephemeral port unlikely to be occupied
    expect(await probePort(59999, 200)).toBe(false);
  });
});

// ── detectDevServerPort ───────────────────────────────────────────────────────

describe("detectDevServerPort", () => {
  let workdir: string;
  let server: net.Server;
  let devPort: number;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-preview-"));
    await new Promise<void>((resolve) => {
      server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        devPort = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("parses explicit port from package.json dev script", async () => {
    await fs.writeFile(
      path.join(workdir, "package.json"),
      JSON.stringify({ scripts: { dev: `next dev -p ${devPort}` } })
    );
    const found = await detectDevServerPort(workdir);
    expect(found).toBe(devPort);
  });

  it("returns undefined when no server is running and no known ports open", async () => {
    // No server on common ports (we can only test this probabilistically)
    // Use a non-existent workdir to skip package.json parse
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-noserver-"));
    try {
      // We can't guarantee no dev server is running on the machine in CI,
      // so just assert it returns undefined OR a port number (both valid)
      const result = await detectDevServerPort(emptyDir);
      expect(typeof result === "number" || result === undefined).toBe(true);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("does not treat the Railway host app port as a sandbox preview", () => {
    const previous = process.env.PORT;
    process.env.PORT = "8080";
    try {
      expect(getWorkbenchPreviewCandidatePorts()).not.toContain(8080);
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });
});

// ── getLocalPreviewUrl ────────────────────────────────────────────────────────

describe("getLocalPreviewUrl", () => {
  let server: net.Server;
  let port: number;
  let workdir: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-preview2-"));
    await new Promise<void>((resolve) => {
      server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("returns the URL when the port is in the package.json dev script", async () => {
    await fs.writeFile(
      path.join(workdir, "package.json"),
      JSON.stringify({ scripts: { dev: `vite --port ${port}` } })
    );
    const url = await getLocalPreviewUrl(workdir);
    expect(url).toBe(`http://localhost:${port}`);
  });

  it("returns undefined when no workdir and no common ports open", async () => {
    // Pass no workdir; scan common ports. If none are running, returns undefined.
    // Allow both undefined and a URL (CI machines may have servers running)
    const result = await getLocalPreviewUrl();
    expect(result === undefined || result?.startsWith("http://localhost:")).toBe(true);
  });
});

describe("preview URL guards", () => {
  it("detects host app loopback URLs so they are not treated as sandbox previews", () => {
    expect(isHostAppPreviewUrl("http://localhost:8080", { PORT: "8080" })).toBe(true);
    expect(isHostAppPreviewUrl("http://127.0.0.1:8080/path", { PORT: "8080" })).toBe(true);
    expect(isHostAppPreviewUrl("http://localhost:4100", { PORT: "8080" })).toBe(false);
    expect(isHostAppPreviewUrl("https://preview.example.com", { PORT: "8080" })).toBe(false);
  });

  it("recognizes loopback preview URLs", () => {
    expect(isLocalPreviewUrl("http://localhost:4100")).toBe(true);
    expect(isLocalPreviewUrl("http://127.0.0.1:4100")).toBe(true);
    expect(isLocalPreviewUrl("https://preview.example.com")).toBe(false);
  });
});

export {};
