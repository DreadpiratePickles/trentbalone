/**
 * [L0-3] `trent setup --provider ollama --pull`: the CLI hands `--pull` to the wizard, and the two
 * local stops (`runtime-unreachable`, `model-not-pulled`) keep the setup contract: exit 3, and under
 * `--json` exactly one JSON document on stdout carrying the reason.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@trent/core/errors/index.js";
import type { SetupSummary } from "../context.js";
import { runCli } from "../index.js";
import { fakeLocal } from "@trent/core/setup/local-fakes.test-helpers.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-setup-local-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("[L0-3] trent setup on a local provider", () => {
  it("passes --provider, --model and --pull through to the wizard", async () => {
    let seen: Record<string, unknown> | undefined;
    const done: SetupSummary = { mode: "quick", success: true, message: "Quick setup complete.", secretsConfigured: [] };
    const result = await runCli(["setup", "--provider", "ollama", "--model", "qwen3.5:9b", "--pull", "--json"], {
      overrides: { runSetup: async (_mode, opts) => ((seen = opts), done) },
    });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(seen).toMatchObject({ provider: "ollama", model: "qwen3.5:9b", pull: true });
  });

  it("model-not-pulled and runtime-unreachable exit 3 with one JSON document naming the reason", async () => {
    for (const reason of ["model-not-pulled", "runtime-unreachable"] as const) {
      const summary: SetupSummary = { mode: "quick", success: false, reason, message: "Run: ollama pull qwen3.6:27b", secretsConfigured: [] };
      const result = await runCli(["setup", "--provider", "ollama", "--json"], { overrides: { runSetup: async () => summary } });
      expect(result.exitCode, reason).toBe(EXIT.CONFIG);
      const doc = JSON.parse(result.stdout) as SetupSummary;
      expect(doc.reason, reason).toBe(reason);
      expect(doc.success, reason).toBe(false);
    }
  });
});

// ── [L2] `trent setup --mode local` ────────────────────────────────────────────────────────────
// A real HTTP server on 127.0.0.1 plays Ollama (`local-fakes.test-helpers.ts` behind `node:http`);
// OLLAMA_BASE_URL points the wizard at it, LMSTUDIO_BASE_URL at a closed port, and PATH at an empty
// directory, so `docker` cannot be found and the plan does not depend on this machine's Docker.

describe("[L2] trent setup --mode local", () => {
  const saved: Record<string, string | undefined> = {};
  let server: http.Server | undefined;

  function setEnv(name: string, value: string): void {
    if (!(name in saved)) saved[name] = process.env[name];
    process.env[name] = value;
  }

  async function fakeOllama(): Promise<string> {
    const models = [{ name: "qwen3.5:9b", capabilities: ["completion", "tools", "thinking"] }, { name: "qwen3-embedding:0.6b", capabilities: ["embedding"] }];
    let origin = "";
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length === 0 || req.method === "GET" ? undefined : Buffer.concat(chunks).toString("utf8");
        void fake.handle(new Request(`${origin}${req.url ?? "/"}`, { method: req.method ?? "GET", ...(body ? { body } : {}) })).then(async (answer) => {
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(Buffer.from(await answer.arrayBuffer()));
        });
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fake = fakeLocal({ ollama: { url: origin, models } });
    return origin;
  }

  beforeEach(() => {
    const emptyBin = path.join(home, "empty-bin");
    fs.mkdirSync(emptyBin);
    setEnv("PATH", emptyBin);
    setEnv("LMSTUDIO_BASE_URL", "http://127.0.0.1:9/v1");
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      delete saved[name];
    }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("--dry-run --json probes the runtime and prints one JSON document with the plan, writing nothing", async () => {
    setEnv("OLLAMA_BASE_URL", `${await fakeOllama()}/v1`);
    const result = await runCli(["setup", "--mode", "local", "--dry-run", "--json"]);

    expect(result.exitCode, result.stderr).toBe(EXIT.OK);
    const doc = JSON.parse(result.stdout) as { success: boolean; mode: string; local: Record<string, any> };
    expect(doc.mode).toBe("local");
    expect(doc.success).toBe(true);
    expect(doc.local.dryRun).toBe(true);
    expect(doc.local.runtime).toBe("ollama");
    expect(doc.local.chat.model).toBe("qwen3.5:9b");
    expect(doc.local.writes).toMatchObject({ provider: "ollama", model: "qwen3.5:9b", "memory.embedder.provider": "ollama", "agent.mode": "solo", "terminal.backend": "local", "models.reasoning_effort": "none" });
    expect(doc.local.docker).toBe(false);
    // TRENT_HOME is the default profile's directory: nothing of setup's may appear in it.
    for (const file of ["config.yaml", ".env", "HEARTBEAT.md", "sessions"]) expect(fs.existsSync(path.join(home, file)), file).toBe(false);
  });

  it("exits 3 with runtime-unreachable in one JSON document when no runtime answers", async () => {
    setEnv("OLLAMA_BASE_URL", "http://127.0.0.1:9/v1");
    const result = await runCli(["setup", "--mode", "local", "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    const doc = JSON.parse(result.stdout) as SetupSummary & { local?: { runtimes: Array<{ reachable: boolean }> } };
    expect(doc.reason).toBe("runtime-unreachable");
    expect(doc.message).toContain("http://127.0.0.1:9");
    expect(doc.local?.runtimes.every((r) => !r.reachable)).toBe(true);
  });

  it("passes --base-url, --fleet and --pull to the wizard, and accepts local as a mode", async () => {
    let seen: { mode?: string; opts?: Record<string, unknown> } = {};
    const done: SetupSummary = { mode: "local", success: true, message: "Local setup complete.", secretsConfigured: [] };
    const result = await runCli(["setup", "--mode", "local", "--base-url", "http://127.0.0.1:8080", "--fleet", "--pull", "--json"], {
      overrides: { runSetup: async (mode, opts) => ((seen = { mode, opts }), done) },
    });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(seen.mode).toBe("local");
    expect(seen.opts).toMatchObject({ baseUrl: "http://127.0.0.1:8080", fleet: true, pull: true });

    const bad = await runCli(["setup", "--mode", "bogus", "--json"]);
    expect(bad.exitCode).toBe(EXIT.USAGE);
    expect(bad.stderr + bad.stdout).toMatch(/quick, full, blank-slate or local/);
  });
});
