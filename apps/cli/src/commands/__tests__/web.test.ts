/**
 * `trent web --start`: the CLI serving the same `.next/standalone` tree the desktop sidecar runs,
 * driven through `runCli` with a fake `spawn` so no Next.js process is involved. The fake binds a
 * tiny HTTP server on the port it was handed, which is what lets the real readiness poll run
 * against it. One gated test at the end starts the real standalone build when it exists.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "../index.js";
import type { CliOverrides, WebChild, WebSpawnOptions } from "../context.js";
import { AUTH_SECRET_FILE, waitForReady } from "../web-server.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const REAL_ENTRIES = [
  path.join(REPO_ROOT, "apps/web/.next/standalone/server.js"),
  path.join(REPO_ROOT, "apps/web/.next/standalone/apps/web/server.js"),
];
const realEntry = REAL_ENTRIES.find((p) => fs.existsSync(p));

let scratch: string;
let home: string;
let repo: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-web-"));
  home = path.join(scratch, "trent-home");
  repo = path.join(scratch, "repo");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A clone layout: apps/web/package.json plus, optionally, a standalone entry at one of the two layouts. */
function layoutClone(root: string, entry?: "flat" | "nested"): string | undefined {
  fs.mkdirSync(path.join(root, "apps/web"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps/web/package.json"), '{"name":"web"}\n');
  if (entry === undefined) return undefined;
  const file =
    entry === "flat"
      ? path.join(root, "apps/web/.next/standalone/server.js")
      : path.join(root, "apps/web/.next/standalone/apps/web/server.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "// fake next standalone entry\n");
  return file;
}

type SpawnCall = { command: string; args: readonly string[]; options: WebSpawnOptions };

/** A `spawn` that never starts Next: it listens on the requested PORT and answers 200 to `/`. */
function fakeSpawn(): { calls: SpawnCall[]; servers: http.Server[]; overrides: CliOverrides } {
  const calls: SpawnCall[] = [];
  const servers: http.Server[] = [];
  const webSpawn = (command: string, args: readonly string[], options: WebSpawnOptions): WebChild => {
    calls.push({ command, args, options });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>fake</html>");
    });
    server.listen(Number(options.env.PORT), "127.0.0.1");
    servers.push(server);
    const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    return {
      pid: 4242,
      kill: (signal?: NodeJS.Signals) => {
        server.close();
        for (const l of listeners) l(null, signal ?? "SIGTERM");
        return true;
      },
      once: (_event: "exit", listener) => {
        listeners.push(listener);
      },
    };
  };
  return { calls, servers, overrides: { webSpawn } };
}

function closeAll(servers: http.Server[]): Promise<void> {
  return Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined);
}

describe("trent web --start from a clone", () => {
  it("spawns the standalone entry with the desktop's env contract and a private AUTH_SECRET", async () => {
    const entry = layoutClone(repo, "nested");
    const fake = fakeSpawn();
    const result = await runCli(["web", "--start", "--json", "--port", "43117"], {
      overrides: { ...fake.overrides, webRepoRoot: repo },
    });
    await closeAll(fake.servers);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.keepAlive).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0] as SpawnCall;
    expect(call.args).toEqual([entry]);
    expect(call.options.cwd).toBe(path.dirname(entry ?? ""));
    expect(call.options.env.PORT).toBe("43117");
    expect(call.options.env.HOSTNAME).toBe("127.0.0.1");
    expect(call.options.env.NODE_ENV).toBe("production");
    // The standalone contract from packages/trent-core/src/runtime/env.ts.
    expect(call.options.env.TRENT_QUEUE_FALLBACK).toBe("disabled");
    expect(call.options.env.SKILL_INJECTION_ENABLED).toBe("1");
    expect(call.options.env.REDIS_URL).toBe("");
    expect(call.options.env.TRENT_EVAL_SYNC_QUEUE).toBeUndefined();

    // Same derivation as apps/desktop/src-tauri/src/auth_secret.rs: 32 random bytes, hex, 0600.
    const secret = call.options.env.AUTH_SECRET ?? "";
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const secretFile = path.join(home, AUTH_SECRET_FILE);
    expect(fs.readFileSync(secretFile, "utf8").trim()).toBe(secret);
    expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);

    const data = JSON.parse(result.stdout) as { port: number; url: string; pid: number; source: string };
    expect(data).toEqual({ port: 43117, url: "http://127.0.0.1:43117", pid: 4242, source: "clone" });
    expect(result.stdout).not.toContain(secret);
  });

  it("reuses the persisted secret and tightens a loose file to 0600", async () => {
    layoutClone(repo, "flat");
    const secretFile = path.join(home, AUTH_SECRET_FILE);
    fs.writeFileSync(secretFile, "pre-existing-secret\n", { mode: 0o644 });
    const fake = fakeSpawn();
    const result = await runCli(["web", "--start", "--json", "--port", "43118"], {
      overrides: { ...fake.overrides, webRepoRoot: repo },
    });
    await closeAll(fake.servers);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(fake.calls[0]?.options.env.AUTH_SECRET).toBe("pre-existing-secret");
    expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
  });

  it("exits CONFIG with the build command when the standalone tree is missing", async () => {
    layoutClone(repo);
    const fake = fakeSpawn();
    const result = await runCli(["web", "--start"], { overrides: { ...fake.overrides, webRepoRoot: repo } });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stderr).toContain("cd apps/web && npm run build");
    expect(result.stderr).toContain("--build");
    expect(fake.calls).toHaveLength(0);
  });

  it("--dry-run spawns nothing, writes no secret and reports the plan", async () => {
    const entry = layoutClone(repo, "nested");
    const fake = fakeSpawn();
    const result = await runCli(["web", "--start", "--dry-run", "--json", "--port", "43119"], {
      overrides: { ...fake.overrides, webRepoRoot: repo },
    });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.keepAlive).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(fs.existsSync(path.join(home, AUTH_SECRET_FILE))).toBe(false);
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(data.dryRun).toBe(true);
    expect(data.source).toBe("clone");
    expect(data.entry).toBe(entry);
    expect(data.port).toBe(43119);
    expect(result.stdout).not.toContain("AUTH_SECRET=");
  });

  it("--open hands the URL to the opener as an argument, never a shell string", async () => {
    layoutClone(repo, "nested");
    const fake = fakeSpawn();
    const opened: string[] = [];
    const result = await runCli(["web", "--start", "--open", "--json", "--port", "43120"], {
      overrides: { ...fake.overrides, webRepoRoot: repo, webOpen: (url) => opened.push(url) },
    });
    await closeAll(fake.servers);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(opened).toEqual(["http://127.0.0.1:43120"]);
  });
});

describe("trent web --start from an installed layout", () => {
  it("exits CONFIG pointing at `trent desktop install` when neither a clone nor desktop resources exist", async () => {
    const fake = fakeSpawn();
    const result = await runCli(["web", "--start"], { overrides: { ...fake.overrides, webRepoRoot: repo } });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stderr).toContain("trent desktop install");
    expect(fake.calls).toHaveLength(0);
  });

  it("serves from the desktop bundle's resources when the manifest points at one", async () => {
    const app = path.join(scratch, "Applications/Trent Fleet.app");
    const entry = path.join(app, "Contents/Resources/server/apps/web/server.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "// fake\n");
    fs.mkdirSync(path.join(home, "desktop"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "desktop/manifest.json"),
      JSON.stringify({ version: "1.0.0", platform: "darwin", arch: "arm64", format: "dmg", paths: [app], launch: { command: "open", args: [app] } }),
    );
    const fake = fakeSpawn();
    const result = await runCli(["web", "--start", "--json", "--port", "43121"], {
      overrides: { ...fake.overrides, webRepoRoot: repo },
    });
    await closeAll(fake.servers);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(fake.calls[0]?.args).toEqual([entry]);
    expect((JSON.parse(result.stdout) as { source: string }).source).toBe("desktop");
  });
});

describe("waitForReady", () => {
  it("polls until the server stops answering 503", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(hits <= 2 ? 503 : 200);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const elapsed = await waitForReady(`http://127.0.0.1:${port}/`, { timeoutMs: 5_000, intervalMs: 20 });
    server.close();
    expect(hits).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it("gives up after the deadline", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    await expect(waitForReady(`http://127.0.0.1:${port}/`, { timeoutMs: 150, intervalMs: 20 })).rejects.toThrow(/did not become ready/);
    server.close();
  });
});

describe.skipIf(realEntry === undefined)("trent web --start against the real standalone build", () => {
  it("starts on a random port and serves /", async () => {
    const started = Date.now();
    let child: WebChild | undefined;
    const webSpawn: CliOverrides["webSpawn"] = (command, args, options) => {
      const real = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "ignore", "pipe"] });
      child = real;
      return real;
    };
    const result = await runCli(["web", "--start", "--json", "--port", "0"], {
      overrides: { webSpawn, webRepoRoot: REPO_ROOT },
    });
    try {
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(EXIT.OK);
      const data = JSON.parse(result.stdout) as { port: number; url: string; pid: number; source: string };
      expect(data.port).toBeGreaterThan(0);
      expect(data.source).toBe("clone");
      const response = await fetch(`${data.url}/`, { redirect: "manual" });
      expect([200, 302, 307]).toContain(response.status);
      process.stdout.write(`[web.test] real standalone ready and served / (${response.status}) in ${Date.now() - started} ms\n`);
    } finally {
      child?.kill("SIGTERM");
    }
  }, 60_000);
});
