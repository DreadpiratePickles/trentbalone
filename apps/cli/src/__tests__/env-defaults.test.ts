/**
 * The CLI entry owns the queue-fallback default, so a user never has to export it.
 *
 * Without `TRENT_QUEUE_FALLBACK=disabled` the wrapped app's inline queue fallback races the CLI's
 * own drain loop and every job runs twice (`packages/trent-core/src/runtime/env.ts`). Every run
 * surface already applies that in-process, but the doctor reads the raw process environment, so a
 * fresh shell failed "Standalone Environment Contract" until the user exported the variable by hand
 * (public-readiness audit 2026-09-25, fix 5).
 *
 * These tests spawn the real entry (`apps/cli/src/index.ts`, the same file every build compiles)
 * in a minimal environment, the way a new user's shell would start it, and read the doctor's own
 * verdict for the environment contract. The check is looked up by the name the check itself
 * exports, never by a string spelled here.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigManager } from "@trent/core/config/ConfigManager.js";
import { checkEnvironment } from "@trent/core/doctor/checks/environment.js";
import type { CheckResult, DoctorReport } from "@trent/core/doctor/types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CLI_ENTRY = path.join(REPO_ROOT, "apps/cli/src/index.ts");
/** tsx's loader by absolute URL, so a child can run from a scratch cwd that has no node_modules. */
const TSX_LOADER = pathToFileURL(createRequire(path.join(REPO_ROOT, "package.json")).resolve("tsx")).href;

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run `trent doctor --json` from a clean environment: PATH and a throwaway HOME/TRENT_HOME only.
 * Nothing is inherited from this test process, so no provider key, no Redis URL, no NODE_ENV=test
 * and no TRENT_QUEUE_FALLBACK reach the child unless `extra` names them.
 */
function doctorEnvironmentCheck(extra: Record<string, string>): { exitCode: number | null; check: CheckResult } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-env-defaults-"));
  scratchDirs.push(home);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TRENT_HOME: path.join(home, ".trent"),
    TMPDIR: os.tmpdir(),
    NO_COLOR: "1",
    ...extra,
  };
  const child = spawnSync(process.execPath, ["--import", "tsx", CLI_ENTRY, "doctor", "--json", "--timeout", "2000"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 110_000,
  });
  expect(child.error, `spawning the CLI failed: ${String(child.error)}`).toBeUndefined();
  let report: DoctorReport;
  try {
    report = JSON.parse(child.stdout) as DoctorReport;
  } catch {
    throw new Error(`doctor --json did not print one JSON document (exit ${child.status}); stderr: ${child.stderr.slice(0, 2000)}`);
  }
  const check = report.results.find((result) => result.name === checkEnvironment.name);
  expect(check, "the doctor report has no environment-contract result").toBeDefined();
  return { exitCode: child.status, check: check! };
}

describe("the CLI entry defaults TRENT_QUEUE_FALLBACK", () => {
  it("passes the environment contract when the variable is not set at all", () => {
    const { check } = doctorEnvironmentCheck({});
    expect(check.status).toBe("ok");
    expect(check.details?.violations).toBeUndefined();
  }, 120_000);

  it("treats an empty value as unset, because an empty value still enables the fallback", () => {
    const { check } = doctorEnvironmentCheck({ TRENT_QUEUE_FALLBACK: "" });
    expect(check.status).toBe("ok");
  }, 120_000);

  it("never overrides a value the user set: an explicit non-disabled value still fails the contract", () => {
    const { check } = doctorEnvironmentCheck({ TRENT_QUEUE_FALLBACK: "enabled" });
    expect(check.status).toBe("fail");
    const violations = (check.details?.violations ?? []) as string[];
    expect(violations.some((line) => line.startsWith("TRENT_QUEUE_FALLBACK "))).toBe(true);
  }, 120_000);
});

// ── [L0-1] G1 / G5 / G14: the profile's models reach the app's model table ────────────────────────
//
// `apps/web/lib/ai-client.ts` builds `MODELS` from the environment ONCE, when it is first evaluated,
// and the CLI's static graph evaluates it at start (`commands -> improve -> gepa/index.ts:16 ->
// apps/web/lib/gepa.ts:31`), long before `createOrchestrator` writes the configured models. So under
// `provider: ollama` every seat asked the local runtime for `gpt-5.2` / `gpt-4.1-mini` (a 404 on a
// real Ollama), the consolidator's `callText` did the same, and the ledger recorded the gpt names
// (local-path audit 2026-09-26, section 4). The entry's FIRST import must apply the profile's models.

/** A scratch profile with only `config.yaml`: the provider, the model and a local terminal. */
function scratchProfile(settings: Record<string, string>, profile = "default"): { home: string; trentHome: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-model-env-"));
  scratchDirs.push(home);
  const trentHome = path.join(home, ".trent");
  const manager = new ConfigManager({ baseDir: trentHome, profile });
  for (const [key, value] of Object.entries(settings)) manager.set(key, value);
  return { home, trentHome };
}

function childEnv(home: string, trentHome: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: home, TRENT_HOME: trentHome, TMPDIR: os.tmpdir(), NO_COLOR: "1", ...extra };
}

/** A script that imports the entry's first module, then the CLI's whole static graph, then asks the app. */
const PROBE = `
await import(${JSON.stringify(path.join(REPO_ROOT, "apps/cli/src/env-defaults.ts"))});
await import(${JSON.stringify(path.join(REPO_ROOT, "apps/cli/src/commands/index.ts"))});
const client = await import(${JSON.stringify(path.join(REPO_ROOT, "apps/web/lib/ai-client.ts"))});
process.stdout.write(JSON.stringify({ haiku: client.resolveModelName("haiku", "openai"), sonnet: client.resolveModelName("sonnet", "openai"), opus: client.resolveModelName("opus", "openai"), critic: client.MODELS.CRITIC }));
`;

function probeModelTable(env: Record<string, string>, argv: string[] = []): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-model-probe-"));
  scratchDirs.push(dir);
  const script = path.join(dir, "probe.mts");
  fs.writeFileSync(script, PROBE);
  const child = spawnSync(process.execPath, ["--import", TSX_LOADER, script, ...argv], {
    cwd: REPO_ROOT,
    env: { ...env, TSX_TSCONFIG_PATH: path.join(REPO_ROOT, "tsconfig.json") },
    encoding: "utf8",
    timeout: 110_000,
  });
  expect(child.status, `probe failed: ${child.stderr.slice(-2000)}`).toBe(0);
  return JSON.parse(child.stdout) as Record<string, string>;
}

describe("[L0-1] the entry applies the profile's models before the app's model table is built", () => {
  it("under provider ollama every OpenAI tier the app resolves is the configured model, not gpt-5.2", () => {
    const { home, trentHome } = scratchProfile({ provider: "ollama", model: "qwen3:4b" });
    expect(probeModelTable(childEnv(home, trentHome))).toEqual({ haiku: "qwen3:4b", sonnet: "qwen3:4b", opus: "qwen3:4b", critic: "qwen3:4b" });
  }, 120_000);

  it("honours an OPENAI_MODEL_* the operator exported, and fills only the rest", () => {
    const { home, trentHome } = scratchProfile({ provider: "ollama", model: "qwen3:4b" });
    const table = probeModelTable(childEnv(home, trentHome, { OPENAI_MODEL_STRONG: "qwen3:14b" }));
    // The critic is its own variable and follows the CONFIGURED opus tier (B2.1, `applyTierEnv`), not the export.
    expect(table).toEqual({ haiku: "qwen3:4b", sonnet: "qwen3:4b", opus: "qwen3:14b", critic: "qwen3:4b" });
  }, 120_000);

  it("reads the profile named by --profile, and a `run --model` pin beats the configured model", () => {
    const { home, trentHome } = scratchProfile({ provider: "ollama", model: "qwen3:4b" }, "local");
    const env = childEnv(home, trentHome);
    expect(probeModelTable(env, ["--profile", "local", "doctor"]).sonnet).toBe("qwen3:4b");
    expect(probeModelTable(env, ["--profile", "local", "run", "-", "--model", "gemma3:1b"]).opus).toBe("gemma3:1b");
  }, 120_000);
});

interface FakeRequest { path: string; model: string; stream: boolean; text: string }

/** Stands in for Ollama's OpenAI-compatible API: records each request; seats get a JSON answer, the rest prose. */
async function startFakeOllama(): Promise<{ baseUrl: string; requests: FakeRequest[]; close(): Promise<void> }> {
  const requests: FakeRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: { model?: string; stream?: boolean; messages?: Array<{ content?: unknown }> } = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      const text = (body.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      requests.push({ path: req.url ?? "", model: body.model ?? "", stream: body.stream === true, text });
      if (!(req.url ?? "").endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `model "${body.model}" not found, try pulling it first` } }));
        return;
      }
      const content = text.includes("toolCall")
        ? JSON.stringify({ summary: "A tagline: fresh from our oven to your table.", findings: [], recommendations: [], workRequests: [] })
        : "Fresh from our oven to your table.";
      const usage = { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: Math.ceil(content.length / 4) };
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The real entry, asynchronously: the fake server lives in THIS process and must keep answering. */
function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI_ENTRY, ...args], {
      cwd,
      env: { ...env, TSX_TSCONFIG_PATH: path.join(REPO_ROOT, "tsconfig.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 170_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("[L0-1] a run under provider ollama names only the configured model, on the wire and in the ledger", () => {
  it("sends qwen3:4b on EVERY chat call (planner, seats, critic, consolidator) and the ledger rows say qwen3:4b", async () => {
    const fake = await startFakeOllama();
    try {
      const { home, trentHome } = scratchProfile({ provider: "ollama", model: "qwen3:4b", "terminal.backend": "local", "memory.embedder.provider": "none" });
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-model-ws-"));
      scratchDirs.push(workspace);
      fs.writeFileSync(path.join(workspace, "notes.md"), "# Bakery\nOpen 7-3.\n");
      const env = childEnv(home, trentHome, { OLLAMA_BASE_URL: fake.baseUrl });

      const run = await runCli(["run", "Write a one-line tagline for a bakery", "--json"], env, workspace);
      expect(run.code, `trent run failed: ${run.stdout.slice(-1500)} ${run.stderr.slice(-1500)}`).toBe(0);

      const chats = fake.requests.filter((r) => r.path.endsWith("/chat/completions"));
      const kinds = (needle: string) => chats.filter((r) => r.text.includes(needle));
      expect(kinds("toolCall").length, "no seat call reached the local runtime").toBeGreaterThan(0);
      expect(kinds("You are the consolidator").length, "no consolidator call reached the local runtime").toBeGreaterThan(0);
      expect(chats.length).toBeGreaterThan(kinds("toolCall").length);
      expect([...new Set(chats.map((r) => r.model))], "a chat call asked for another model").toEqual(["qwen3:4b"]);

      const usage = await runCli(["usage", "--json", "--by", "model"], env, workspace);
      expect(usage.code, usage.stderr.slice(-1500)).toBe(0);
      const report = JSON.parse(usage.stdout) as { today: { rows: number; groups: Array<{ key: string }> } };
      expect(report.today.rows).toBeGreaterThan(0);
      expect(report.today.groups.map((g) => g.key)).toEqual(["qwen3:4b"]);
    } finally {
      await fake.close();
    }
  }, 180_000);
});

// ── [L0-1] the entry's first module imports no app code ──────────────────────────────────────────
//
// `env-defaults.ts` exists to run BEFORE anything reads the model env at load. If it (or anything it
// imports) ever pulls an `apps/web` module in, that module is evaluated first and the fix silently
// undoes itself. So the whole static graph is walked from the source: every `import`/`export ... from`
// and `import()` of every file it reaches, resolved the way tsconfig's paths resolve them.

const SPECIFIER = /(?:^|[\s;])(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveSpecifier(from: string, specifier: string): { file?: string; external?: string; app?: string } {
  if (specifier.startsWith("@/")) return { app: specifier };
  if (specifier.startsWith("node:")) return { external: specifier };
  let base: string | undefined;
  if (specifier === "@trent/core") base = path.join(REPO_ROOT, "packages/trent-core/src/index");
  else if (specifier.startsWith("@trent/core/")) base = path.join(REPO_ROOT, "packages/trent-core/src", specifier.slice("@trent/core/".length));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  if (base === undefined) return { external: specifier };
  const stem = base.replace(/\.(js|ts|mjs)$/, "");
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, path.join(stem, "index.ts")]) {
    if (fs.existsSync(candidate)) return { file: candidate };
  }
  throw new Error(`${path.relative(REPO_ROOT, from)} imports ${specifier}, which resolves to no file`);
}

function staticGraph(entry: string): { files: string[]; externals: string[]; app: string[] } {
  const files = new Set<string>();
  const externals = new Set<string>();
  const app: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? "";
      const resolved = resolveSpecifier(file, specifier);
      if (resolved.app !== undefined) app.push(`${path.relative(REPO_ROOT, file)} -> ${resolved.app}`);
      if (resolved.external !== undefined) externals.add(resolved.external);
      if (resolved.file !== undefined) {
        if (resolved.file.startsWith(path.join(REPO_ROOT, "apps/web"))) app.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`);
        else queue.push(resolved.file);
      }
    }
  }
  return { files: [...files].map((f) => path.relative(REPO_ROOT, f)).sort(), externals: [...externals].sort(), app };
}

describe("[L0-1] the static graph of the entry's first module", () => {
  it("reaches no apps/web module, directly or through @trent/core", () => {
    const graph = staticGraph(path.join(REPO_ROOT, "apps/cli/src/env-defaults.ts"));
    expect(graph.app, "env-defaults.ts must stay app-free; make the import lazy or move the code").toEqual([]);
    expect(graph.files).toContain("packages/trent-core/src/orchestrator/model-env-early.ts");
    expect(graph.files.some((f) => f.includes("seat-capabilities")), "the seat manifest is app data").toBe(false);
    expect(graph.externals.filter((e) => !e.startsWith("node:"))).toEqual(["yaml"]);
  });

  it("the walker is not vacuous: model-env.ts, which needs the seat manifest, does reach the app", () => {
    const graph = staticGraph(path.join(REPO_ROOT, "packages/trent-core/src/orchestrator/model-env.ts"));
    expect(graph.app.length).toBeGreaterThan(0);
  });

  it("and at run time evaluating it evaluates neither the app's model table nor its orchestrator", async () => {
    const loaded: string[] = [];
    for (const specifier of ["@/lib/ai-client", "@/lib/orchestrator-runtime", "@/lib/seat-manifest", "@/lib/gepa"]) {
      vi.doMock(specifier, () => {
        loaded.push(specifier);
        return {};
      });
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-env-graph-"));
    scratchDirs.push(home);
    vi.stubEnv("TRENT_HOME", home);
    vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
    try {
      vi.resetModules();
      await import("../env-defaults.js");
      expect(loaded).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
