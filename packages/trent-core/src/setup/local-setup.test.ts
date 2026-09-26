/**
 * [L0-3] G3, G15 and the tiered default: setup on a local runtime needs no key.
 *
 * Before this, `trent setup --mode quick --provider ollama` aborted with "Set OLLAMA_API_KEY", a
 * variable nothing reads, and full setup said "OLLAMA_API_KEY is already set" on a machine where it
 * was not (01_discovery/output/trent-local-path-audit-2026-09-26.md, G3 and G15). The default model
 * was `llama3.2`, which Berkeley's leaderboard scores at 21.95% overall and 4% multi-turn
 * (01_discovery/output/local-models-2026-09-26.md §2.2).
 *
 * Every runtime here is a fake `fetch` speaking the real endpoints (`/api/version`, `/api/tags`,
 * `/api/pull`, LM Studio's `/v1/models`); nothing leaves the process.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ConfigManager } from "../config/index.js";
import { EXIT, TrentError } from "../errors/index.js";
import { SetupWizard } from "./SetupWizard.js";
import { ScriptedPrompts } from "./ScriptedPrompts.js";
import { CollectingOutput } from "./ports.js";
import { DEFAULT_MODELS } from "./detect.js";
import { createLocalRuntime } from "./local-runtime.js";
import { LOCAL_TIERS, recommendedLocalModel, tierForMemory } from "./local-tiers.js";

const GIB = 1024 ** 3;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

interface FakeRuntime {
  fetch: typeof fetch;
  calls: string[];
  pulled: string[];
}

function ndjson(lines: object[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Ollama and LM Studio as far as setup can see them. `up: false` refuses like a closed port. */
function fakeRuntime(options: { up?: boolean; models?: string[] } = {}): FakeRuntime {
  const calls: string[] = [];
  const pulled = [...(options.models ?? [])];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (options.up === false) {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    }
    if (url.endsWith("/api/version")) return Response.json({ version: "0.32.9" });
    if (url.endsWith("/api/tags")) return Response.json({ models: pulled.map((name) => ({ name })) });
    if (url.endsWith("/api/pull")) {
      const body = JSON.parse(String(init?.body)) as { model: string };
      pulled.push(body.model);
      return new Response(ndjson([{ status: "pulling manifest" }, { status: "pulling 6488c96f", total: 100, completed: 50 }, { status: "success" }]));
    }
    if (url.endsWith("/v1/models")) return Response.json({ data: pulled.map((id) => ({ id })) });
    return new Response("not found", { status: 404 });
  };
  return { fetch: fake as typeof fetch, calls, pulled };
}

describe("[L0-3] local setup", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let output: CollectingOutput;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-local-setup-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    output = new CollectingOutput();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function wizard(runtime: FakeRuntime, memoryGiB: number, answers: Record<string, unknown> = { confirm: true }, extra: { env?: NodeJS.ProcessEnv; interactive?: boolean } = {}) {
    const prompts = new ScriptedPrompts(answers);
    const w = new SetupWizard({
      configManager,
      prompts,
      output,
      env: extra.env ?? {},
      localRuntime: createLocalRuntime({ fetch: runtime.fetch }),
      totalMemoryBytes: memoryGiB * GIB,
      ...(extra.interactive === undefined ? {} : { interactive: extra.interactive }),
    });
    return { wizard: w, prompts };
  }

  const said = (prompts: ScriptedPrompts): string => [...prompts.asked.map((a) => a.message), ...output.lines].join("\n");
  const onDisk = (): Record<string, unknown> => parseYaml(fs.readFileSync(configManager.getConfigPath(), "utf8")) as Record<string, unknown>;

  describe("quick, --provider ollama", () => {
    it("needs no key: a reachable runtime with the recommended model pulled writes the config", async () => {
      const runtime = fakeRuntime({ models: ["qwen3.5:9b", "nomic-embed-text:latest"] });
      const { wizard: w, prompts } = wizard(runtime, 16);
      const res = await w.run({ mode: "quick", provider: "ollama" });

      expect(res.success, res.message).toBe(true);
      expect(onDisk().provider).toBe("ollama");
      expect(onDisk().model).toBe("qwen3.5:9b");
      const text = said(prompts);
      expect(text).not.toContain("OLLAMA_API_KEY");
      expect(text).not.toMatch(/already set/);
      expect(text).toMatch(/needs no API key/);
      expect(text).toContain("0.32.9");
      expect(text).toContain("nomic-embed-text:latest");
      expect(runtime.calls).toContain("GET http://127.0.0.1:11434/api/version");
    });

    it("says what to expect at the chosen model's tier, in three sentences", async () => {
      const { wizard: w, prompts } = wizard(fakeRuntime({ models: ["qwen3.5:9b"] }), 16);
      await w.run({ mode: "quick", provider: "ollama" });
      const tier = LOCAL_TIERS.find((t) => t.ollama === "qwen3.5:9b")!;
      expect(said(prompts)).toContain(tier.expectation);
    });

    it("on a 32 GB machine recommends a 27B Qwen, and with it not pulled prints the pull line and stops: model-not-pulled", async () => {
      const { wizard: w, prompts } = wizard(fakeRuntime({ models: ["qwen3.5:9b"] }), 32);
      const res = await w.run({ mode: "quick", provider: "ollama" });

      expect(res.success).toBe(false);
      expect(res.reason).toBe("model-not-pulled");
      expect(res.message).toContain("ollama pull qwen3.6:27b");
      expect(output.lines).toContain("  ollama pull qwen3.6:27b");
      expect(fs.existsSync(configManager.getConfigPath())).toBe(false);
      expect(prompts.asked.map((a) => a.id)).not.toContain("confirm");
    });

    it("an explicit --model that is pulled wins over the tier recommendation", async () => {
      const { wizard: w } = wizard(fakeRuntime({ models: ["qwen3.5:9b"] }), 32);
      const res = await w.run({ mode: "quick", provider: "ollama", model: "qwen3.5:9b" });
      expect(res.success, res.message).toBe(true);
      expect(onDisk().model).toBe("qwen3.5:9b");
    });

    it("stops before any question when the runtime is down, naming the URL and the start command", async () => {
      const { wizard: w, prompts } = wizard(fakeRuntime({ up: false }), 16);
      const res = await w.run({ mode: "quick", provider: "ollama" });

      expect(res.success).toBe(false);
      expect(res.reason).toBe("runtime-unreachable");
      expect(res.message).toContain("http://127.0.0.1:11434");
      expect(res.message).toContain("ollama serve");
      expect(res.message).not.toContain("\n");
      expect(prompts.asked).toHaveLength(0);
      expect(fs.existsSync(configManager.getConfigPath())).toBe(false);
    });

    it("probes the endpoint OLLAMA_BASE_URL names", async () => {
      const runtime = fakeRuntime({ models: ["qwen3.5:9b"] });
      const { wizard: w } = wizard(runtime, 16, { confirm: true }, { env: { OLLAMA_BASE_URL: "http://10.0.0.5:11434/v1" } });
      await w.run({ mode: "quick", provider: "ollama" });
      expect(runtime.calls).toContain("GET http://10.0.0.5:11434/api/version");
    });

    it("model-not-pulled needs no terminal: it stops before the one confirmation", async () => {
      const { wizard: w } = wizard(fakeRuntime({ models: [] }), 16, {}, { interactive: false });
      const res = await w.run({ mode: "quick", provider: "ollama" });
      expect(res.reason).toBe("model-not-pulled");
    });

    it("--pull asks first, then pulls the recommended tag through the runtime and writes the config", async () => {
      const runtime = fakeRuntime({ models: [] });
      const { wizard: w, prompts } = wizard(runtime, 16, { pull: true, confirm: true });
      const res = await w.run({ mode: "quick", provider: "ollama", pull: true });

      expect(res.success, res.message).toBe(true);
      expect(prompts.asked.map((a) => a.id)).toContain("pull");
      expect(runtime.calls).toContain("POST http://127.0.0.1:11434/api/pull");
      expect(runtime.pulled).toContain("qwen3.5:9b");
      expect(onDisk().model).toBe("qwen3.5:9b");
    });

    it("--pull declined pulls nothing and stops with model-not-pulled", async () => {
      const runtime = fakeRuntime({ models: [] });
      const { wizard: w } = wizard(runtime, 16, { pull: false });
      const res = await w.run({ mode: "quick", provider: "ollama", pull: true });
      expect(res.reason).toBe("model-not-pulled");
      expect(runtime.calls.some((c) => c.startsWith("POST"))).toBe(false);
    });

    it("--pull without a terminal refuses at its question, exit 2, and pulls nothing", async () => {
      const runtime = fakeRuntime({ models: [] });
      const { wizard: w } = wizard(runtime, 16, {}, { interactive: false });
      const failure = await w.run({ mode: "quick", provider: "ollama", pull: true }).then(() => undefined, (e: unknown) => e);
      expect(failure).toBeInstanceOf(TrentError);
      expect((failure as TrentError).code).toBe(EXIT.USAGE);
      expect(runtime.calls.some((c) => c.startsWith("POST"))).toBe(false);
    });
  });

  describe("quick, --provider lmstudio", () => {
    it("needs no key, and takes the listed model that matches the tier", async () => {
      const runtime = fakeRuntime({ models: ["text-embedding-nomic", "qwen/qwen3.5-9b"] });
      const { wizard: w, prompts } = wizard(runtime, 16);
      const res = await w.run({ mode: "quick", provider: "lmstudio" });

      expect(res.success, res.message).toBe(true);
      expect(onDisk().model).toBe("qwen/qwen3.5-9b");
      expect(said(prompts)).not.toContain("LMSTUDIO_API_KEY");
      expect(runtime.calls).toContain("GET http://127.0.0.1:1234/v1/models");
    });

    it("down: names the URL and the start command", async () => {
      const { wizard: w } = wizard(fakeRuntime({ up: false }), 16);
      const res = await w.run({ mode: "quick", provider: "lmstudio" });
      expect(res.reason).toBe("runtime-unreachable");
      expect(res.message).toContain("http://127.0.0.1:1234");
      expect(res.message).toContain("lms server start");
    });
  });

  describe("full, the interactive picker", () => {
    it("picking ollama asks for no key and never claims one is set; the model defaults to the tier's", async () => {
      const answers = { provider: "ollama", toolsets: ["file_ops", "terminal"], agents: "ceo", daily_budget: "5.00", per_run_budget: "1.00", confirm: true };
      const { wizard: w, prompts } = wizard(fakeRuntime({ models: ["qwen3.5:9b"] }), 16, answers);
      const res = await w.run({ mode: "full" });

      expect(res.success, res.message).toBe(true);
      const text = said(prompts);
      expect(text).not.toMatch(/already set/);
      expect(text).not.toContain("OLLAMA_API_KEY");
      expect(prompts.asked.map((a) => a.id)).not.toContain("api_key_entry");
      expect(text).toMatch(/needs no API key/);
      expect(onDisk().model).toBe("qwen3.5:9b");
    });

    it("says how to pull a chosen model that is not there yet", async () => {
      const answers = { provider: "ollama", model: "qwen3.6:27b", toolsets: ["file_ops"], agents: "ceo", daily_budget: "5.00", per_run_budget: "1.00", confirm: true };
      const { wizard: w, prompts } = wizard(fakeRuntime({ models: ["qwen3.5:9b"] }), 16, answers);
      await w.run({ mode: "full" });
      expect(said(prompts)).toContain("ollama pull qwen3.6:27b");
    });
  });
});

describe("[L0-3] the tiers", () => {
  it("maps memory to the model section 6 recommends: 16 GB 9B, 32 GB 27B, 64 GB 35B-A3B", () => {
    expect(recommendedLocalModel("ollama", 16 * GIB)).toBe("qwen3.5:9b");
    expect(recommendedLocalModel("ollama", 24 * GIB)).toBe("qwen3.5:9b");
    expect(recommendedLocalModel("ollama", 32 * GIB)).toBe("qwen3.6:27b");
    expect(recommendedLocalModel("ollama", 48 * GIB)).toBe("qwen3.6:27b");
    expect(recommendedLocalModel("ollama", 64 * GIB)).toBe("qwen3.6:35b-a3b");
    expect(recommendedLocalModel("ollama", 128 * GIB)).toBe("qwen3.6:35b-a3b");
  });

  it("never recommends llama3.2, at any tier or as the static default", () => {
    for (const gib of [8, 16, 32, 64, 256]) expect(recommendedLocalModel("ollama", gib * GIB)).not.toMatch(/llama3\.2/);
    expect(DEFAULT_MODELS.ollama).not.toMatch(/llama3\.2/);
  });

  it("states each tier's expectation in exactly three sentences", () => {
    for (const tier of LOCAL_TIERS) {
      const sentences = tier.expectation.split(/(?<=\.)\s+/).filter((s) => s.trim() !== "");
      expect(sentences, tier.id).toHaveLength(3);
    }
    expect(tierForMemory(16 * GIB).expectation).toMatch(/single tool calls mostly work/i);
    expect(tierForMemory(16 * GIB).expectation).toMatch(/multi-step plans are unreliable/i);
    expect(tierForMemory(16 * GIB).expectation).toMatch(/prefill/i);
  });

  it("docs/getting-started.md states every tier's tag and expectation exactly as setup prints them", () => {
    const page = fs.readFileSync(path.join(REPO_ROOT, "docs/getting-started.md"), "utf8").replace(/\s+/g, " ");
    expect(page).toMatch(/## \d+\. Local models/);
    for (const tier of LOCAL_TIERS) {
      expect(page, tier.id).toContain(`\`${tier.ollama}\``);
      expect(page, tier.id).toContain(tier.expectation);
    }
  });
});
