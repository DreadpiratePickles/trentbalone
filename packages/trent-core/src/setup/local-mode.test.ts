/**
 * [L2] `trent setup --mode local`: the product path onto a model on this machine
 * (02_plan/output/local-models-plan-2026-09-26.md, L2).
 *
 * It finds the runtimes that answer (Ollama, LM Studio, a llama.cpp server on `--base-url`), lists
 * what each has with sizes, picks a chat model by memory tier (L0-3's `local-tiers.ts`) and an
 * embedding model by role (`qwen3-embedding:0.6b`, else `nomic-embed-text`), offers `--pull` for what
 * is missing, and writes the local stack: provider, model, `memory.embedder`, `terminal.backend: local`
 * when Docker does not answer, `agent.mode: solo` unless `--fleet`, and `models.reasoning_effort: none`
 * when the route can switch the model's thinking off. Every runtime here is a fake `fetch` speaking
 * the documented routes (`local-fakes.test-helpers.ts`); nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigManager } from "../config/index.js";
import { SetupWizard } from "./SetupWizard.js";
import { ScriptedPrompts } from "./ScriptedPrompts.js";
import { CollectingOutput } from "./ports.js";
import { createLocalRuntime } from "./local-runtime.js";
import { createLocalDiscovery } from "./local-detect.js";
import { LOCAL_TIERS } from "./local-tiers.js";
import { CHAT_CAPS, fakeLocal, type FakeLocal, type FakeLocalSpec } from "./local-fakes.test-helpers.js";
import type { SetupOptions } from "./types.js";

const GIB = 1024 ** 3;
const NINE_B = { name: "qwen3.5:9b", capabilities: [...CHAT_CAPS, "vision"] };
const EMBED = { name: "qwen3-embedding:0.6b", capabilities: ["embedding"] };

let tempDir: string;
let configManager: ConfigManager;
let output: CollectingOutput;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-local-mode-"));
  configManager = new ConfigManager({ baseDir: tempDir });
  output = new CollectingOutput();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.LMSTUDIO_BASE_URL;
  delete process.env.OLLAMA_BASE_URL;
});

interface Run {
  fake: FakeLocal;
  prompts: ScriptedPrompts;
  res: Awaited<ReturnType<SetupWizard["run"]>>;
}

async function run(spec: FakeLocalSpec, options: Partial<SetupOptions> = {}, extra: { memoryGiB?: number; docker?: boolean; answers?: Record<string, unknown>; env?: NodeJS.ProcessEnv } = {}): Promise<Run> {
  const fake = fakeLocal(spec);
  const prompts = new ScriptedPrompts(extra.answers ?? { confirm: true });
  const wizard = new SetupWizard({
    configManager,
    prompts,
    output,
    env: extra.env ?? {},
    localRuntime: createLocalRuntime({ fetch: fake.fetch }),
    localDiscovery: createLocalDiscovery({ fetch: fake.fetch }),
    dockerPresent: async () => extra.docker ?? false,
    mediaBackendPresent: async () => false,
    totalMemoryBytes: (extra.memoryGiB ?? 16) * GIB,
  });
  const res = await wizard.run({ mode: "local", ...options });
  return { fake, prompts, res };
}

const said = (r: Run): string => [...r.prompts.asked.map((a) => a.message), ...output.lines].join("\n");
const onDisk = (): Record<string, any> => parseYaml(fs.readFileSync(configManager.getConfigPath(), "utf8")) as Record<string, any>;

describe("[L2] setup --mode local on Ollama", () => {
  it("lists what Ollama has with sizes and roles, and writes the local stack for a 16 GB machine without Docker", async () => {
    const r = await run({ ollama: { models: [NINE_B, EMBED] } });

    expect(r.res.success, r.res.message).toBe(true);
    const config = onDisk();
    expect(config.provider).toBe("ollama");
    expect(config.model).toBe("qwen3.5:9b");
    expect(config.memory.embedder).toMatchObject({ provider: "ollama", model: "qwen3-embedding:0.6b" });
    expect(config.terminal.backend).toBe("local");
    expect(config.agent.mode).toBe("solo");
    expect(config.models.reasoning_effort).toBe("none");

    const text = said(r);
    expect(text).toContain("6.6 GB");
    expect(text).toContain("639 MB");
    expect(text).toMatch(/qwen3-embedding:0\.6b\s+639 MB\s+embedding/);
    expect(text).toContain(LOCAL_TIERS[0]!.expectation);
    expect(text).not.toContain("API_KEY");

    const plan = r.res.local!;
    expect(plan.runtime).toBe("ollama");
    expect(plan.chat).toMatchObject({ model: "qwen3.5:9b", recommended: "qwen3.5:9b", pulled: true });
    expect(plan.embedder).toMatchObject({ provider: "ollama", model: "qwen3-embedding:0.6b" });
    expect(plan.docker).toBe(false);
    expect(plan.writes).toMatchObject({ provider: "ollama", model: "qwen3.5:9b", "agent.mode": "solo", "terminal.backend": "local", "models.reasoning_effort": "none" });
    const listed = plan.runtimes.find((rt) => rt.runtime === "ollama")!;
    expect(listed.models).toContainEqual(expect.objectContaining({ id: "qwen3.5:9b", size: "6.6 GB", role: "chat" }));
  });

  it("leaves terminal.backend alone when Docker answers, and --fleet keeps the fleet", async () => {
    const r = await run({ ollama: { models: [NINE_B, EMBED] } }, { fleet: true }, { docker: true });
    expect(r.res.success, r.res.message).toBe(true);
    expect(onDisk().terminal.backend).toBe("docker");
    expect(onDisk().agent.mode).toBe("fleet");
    expect(r.res.local!.writes["terminal.backend"]).toBeUndefined();
  });

  it("does not write reasoning_effort for a model that cannot think, and reads /api/show when /api/tags has no capabilities", async () => {
    const plain = await run({ ollama: { models: [{ name: "qwen3.5:9b", capabilities: ["completion", "tools"] }, EMBED], tagsCapabilities: false } });
    expect(plain.res.success, plain.res.message).toBe(true);
    expect(plain.fake.calls).toContain("POST http://127.0.0.1:11434/api/show");
    expect(onDisk().models?.reasoning_effort).toBeUndefined();
  });

  it("on a 32 GB machine recommends qwen3.6:27b, runs the pulled 9B meanwhile and prints the line to move up", async () => {
    const r = await run({ ollama: { models: [NINE_B, EMBED] } }, {}, { memoryGiB: 32 });
    expect(r.res.success, r.res.message).toBe(true);
    expect(onDisk().model).toBe("qwen3.5:9b");
    expect(r.res.local!.chat).toMatchObject({ model: "qwen3.5:9b", recommended: "qwen3.6:27b", source: "fallback" });
    expect(said(r)).toContain("ollama pull qwen3.6:27b");
    expect(said(r)).toContain(LOCAL_TIERS[0]!.expectation);
  });

  it("never picks a cloud model or one without tools, and stops with model-not-pulled when nothing else is there", async () => {
    const r = await run({ ollama: { models: [{ name: "nemotron-3-ultra:cloud", size: 389, capabilities: [...CHAT_CAPS], remote: true }, { name: "qwen3.8-27b-abliterated:latest", capabilities: ["completion"] }] } }, {}, { memoryGiB: 32 });
    expect(r.res.success).toBe(false);
    expect(r.res.reason).toBe("model-not-pulled");
    expect(r.res.message).toContain("ollama pull qwen3.6:27b");
    expect(fs.existsSync(configManager.getConfigPath())).toBe(false);
    const text = said(r);
    expect(text).toMatch(/nemotron-3-ultra:cloud.*cloud/);
    expect(text).toMatch(/qwen3\.8-27b-abliterated:latest.*no tools/);
    expect(r.prompts.asked.map((a) => a.id)).not.toContain("confirm");
  });

  it("with no embedding model pulled writes embedder none and prints the pull line; nomic-embed-text is taken when qwen3-embedding is absent", async () => {
    const none = await run({ ollama: { models: [NINE_B] } });
    expect(none.res.success, none.res.message).toBe(true);
    expect(onDisk().memory.embedder.provider).toBe("none");
    expect(onDisk().memory.embedder.model).toBeUndefined();
    expect(said(none)).toContain("ollama pull qwen3-embedding:0.6b");

    const nomic = await run({ ollama: { models: [NINE_B, { name: "nomic-embed-text:latest", capabilities: ["embedding"] }] } });
    expect(nomic.res.success, nomic.res.message).toBe(true);
    expect(onDisk().memory.embedder).toMatchObject({ provider: "ollama", model: "nomic-embed-text:latest" });
  });

  it("--pull asks before each missing model, pulls both through Ollama, and writes them", async () => {
    const r = await run({ ollama: { models: [] } }, { pull: true }, { memoryGiB: 32, answers: { pull: true, pull_embedder: true, confirm: true } });
    expect(r.res.success, r.res.message).toBe(true);
    expect(r.prompts.asked.map((a) => a.id)).toEqual(["pull", "pull_embedder", "confirm"]);
    expect(r.fake.pulled).toEqual(["qwen3.6:27b", "qwen3-embedding:0.6b"]);
    expect(onDisk().model).toBe("qwen3.6:27b");
    expect(onDisk().memory.embedder.model).toBe("qwen3-embedding:0.6b");
    expect(said(r)).toContain(LOCAL_TIERS[1]!.expectation);
  });

  it("an explicit --model wins when it is pulled", async () => {
    const r = await run({ ollama: { models: [NINE_B, EMBED, { name: "gemma4:12b", capabilities: [...CHAT_CAPS] }] } }, { model: "gemma4:12b" });
    expect(r.res.success, r.res.message).toBe(true);
    expect(onDisk().model).toBe("gemma4:12b");
    expect(r.res.local!.chat.source).toBe("requested");
  });
});

describe("[L2] setup --mode local: no runtime, other runtimes", () => {
  it("refuses with runtime-unreachable when nothing answers, naming every URL and start command, asking nothing", async () => {
    const r = await run({});
    expect(r.res.success).toBe(false);
    expect(r.res.reason).toBe("runtime-unreachable");
    expect(r.res.message).toContain("http://127.0.0.1:11434");
    expect(r.res.message).toContain("http://127.0.0.1:1234");
    expect(r.res.message).toContain("ollama serve");
    expect(r.res.message).toContain("--base-url");
    expect(r.res.message).not.toContain("\n");
    expect(r.prompts.asked).toHaveLength(0);
    expect(fs.existsSync(configManager.getConfigPath())).toBe(false);
    expect(r.res.local!.runtimes.every((rt) => rt.reachable === false)).toBe(true);
  });

  it("a --base-url that does not answer is refused even when Ollama answers", async () => {
    const r = await run({ ollama: { models: [NINE_B] } }, { baseUrl: "http://127.0.0.1:8080" });
    expect(r.res.reason).toBe("runtime-unreachable");
    expect(r.res.message).toContain("http://127.0.0.1:8080");
  });

  it("a llama.cpp server on --base-url is routed through the lmstudio alias with its URL in the profile .env, embeddings from Ollama", async () => {
    const r = await run({ llamacpp: { url: "http://127.0.0.1:8080", id: "Qwen3.5-9B-Q4_K_M.gguf", size: 5_680_000_000 }, ollama: { models: [EMBED] } }, { baseUrl: "http://127.0.0.1:8080" });
    expect(r.res.success, r.res.message).toBe(true);
    const config = onDisk();
    expect(config.provider).toBe("lmstudio");
    expect(config.model).toBe("Qwen3.5-9B-Q4_K_M.gguf");
    expect(config.models?.reasoning_effort).toBeUndefined();
    expect(config.memory.embedder).toMatchObject({ provider: "ollama", model: "qwen3-embedding:0.6b" });
    expect(fs.readFileSync(configManager.getSecretsPath(), "utf8")).toContain("LMSTUDIO_BASE_URL=http://127.0.0.1:8080/v1");
    expect(r.res.local!.runtime).toBe("llama.cpp");
    expect(r.res.local!.env).toEqual({ LMSTUDIO_BASE_URL: "http://127.0.0.1:8080/v1" });
    expect(said(r)).toContain("5.7 GB");
    expect(said(r)).toContain("--reasoning off");
    expect(r.res.secretsConfigured).toEqual([]);
  });

  it("LM Studio: sizes and roles from /api/v1/models, the tier model by name, its own embedding model", async () => {
    const r = await run({
      lmstudio: {
        models: [
          { key: "qwen/qwen3.5-9b", type: "llm", size_bytes: 6_600_000_000 },
          { key: "text-embedding-qwen3-embedding-0.6b", type: "embedding", size_bytes: 639_000_000 },
        ],
      },
    });
    expect(r.res.success, r.res.message).toBe(true);
    expect(onDisk().provider).toBe("lmstudio");
    expect(onDisk().model).toBe("qwen/qwen3.5-9b");
    expect(onDisk().memory.embedder).toMatchObject({ provider: "lmstudio", model: "text-embedding-qwen3-embedding-0.6b" });
    expect(onDisk().models?.reasoning_effort).toBeUndefined();
    expect(said(r)).toContain("6.6 GB");
    expect(r.fake.calls).toContain("GET http://127.0.0.1:1234/api/v1/models");
  });
});

describe("[L2] setup --mode local --dry-run", () => {
  it("prints the plan, asks nothing, pulls nothing and writes nothing, not even the profile directories", async () => {
    const profileDir = path.join(tempDir, "fresh-home");
    configManager = new ConfigManager({ baseDir: profileDir });
    const r = await run({ ollama: { models: [NINE_B] } }, { dryRun: true, pull: true }, { memoryGiB: 32 });

    expect(r.res.success, r.res.message).toBe(true);
    expect(r.res.config).toBeNull();
    expect(r.prompts.asked).toHaveLength(0);
    expect(r.fake.calls.some((c) => c.startsWith("POST http://127.0.0.1:11434/api/pull"))).toBe(false);
    expect(fs.existsSync(profileDir)).toBe(false);

    const plan = r.res.local!;
    expect(plan.dryRun).toBe(true);
    expect(plan.pull).toEqual(["qwen3.6:27b", "qwen3-embedding:0.6b"]);
    expect(plan.writes).toMatchObject({ provider: "ollama", model: "qwen3.6:27b", "memory.embedder.provider": "ollama", "memory.embedder.model": "qwen3-embedding:0.6b", "agent.mode": "solo" });
    expect(said(r)).toMatch(/dry run/i);
    expect(said(r)).toContain("would pull qwen3.6:27b");
  });
});
