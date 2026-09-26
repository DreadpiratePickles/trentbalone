/**
 * [L0-1] The early half of the model bridge: what the CLI entry applies before any app module loads
 * (local-path audit 2026-09-26, G1). It reads only `provider`, `model` and `models` from the active
 * profile's `config.yaml`, writes only model NAMES, keeps the operator's exports, forces a
 * `run --model` pin, and never throws. The end-to-end proof (a real run against a fake Ollama) is
 * `apps/cli/src/__tests__/env-defaults.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyModelNameEnv,
  applyProfileModelEnv,
  profileConfigPath,
  readProfileModelConfig,
  runPinFromArgv,
} from "./model-env-early.js";

const TOUCHED = [
  "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC",
  "ANTHROPIC_MODEL_FAST", "ANTHROPIC_MODEL_DEFAULT", "ANTHROPIC_MODEL_STRONG",
  "GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG",
  "WORKBENCH_PLANNER_MODEL", "WORKBENCH_EXECUTOR_MODEL", "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS",
  "TRENT_MODEL_ALIAS", "OPENAI_API_KEY", "OPENAI_BASE_URL",
];
const saved = new Map<string, string | undefined>();
const scratch: string[] = [];

beforeEach(() => {
  for (const name of TOUCHED) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function trentHome(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-model-env-early-"));
  scratch.push(home);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), body);
  }
  return home;
}

describe("which config.yaml the entry reads", () => {
  const env = { TRENT_HOME: "/h" };
  it("resolves the profile the way ConfigManager does", () => {
    expect(profileConfigPath({ argv: [], env })).toBe(path.join("/h", "config.yaml"));
    expect(profileConfigPath({ argv: ["--profile", "work", "run"], env })).toBe(path.join("/h", "profiles", "work", "config.yaml"));
    expect(profileConfigPath({ argv: ["--profile=work"], env })).toBe(path.join("/h", "profiles", "work", "config.yaml"));
    expect(profileConfigPath({ argv: ["-p", "work"], env })).toBe(path.join("/h", "profiles", "work", "config.yaml"));
    expect(profileConfigPath({ argv: [], env: { ...env, TRENT_PROFILE: "work" } })).toBe(path.join("/h", "profiles", "work", "config.yaml"));
    expect(profileConfigPath({ argv: [], env: {}, homeDir: "/u" })).toBe(path.join("/u", ".trent", "config.yaml"));
  });

  it("refuses a profile name that is not one path segment instead of reading outside the home", () => {
    expect(profileConfigPath({ argv: ["--profile", "../../etc"], env })).toBeUndefined();
    expect(profileConfigPath({ argv: ["--profile", "a/b"], env })).toBeUndefined();
  });
});

describe("readProfileModelConfig", () => {
  it("reads provider, model and the tier block, and nothing else", () => {
    const home = trentHome({ "config.yaml": "provider: Ollama\nmodel: qwen3:4b\nmodels:\n  planner: qwen3:14b\n  fallback_on_pin: true\n  reasoning_effort: low\nbudget:\n  daily_cap: 10\n" });
    expect(readProfileModelConfig({ argv: [], env: { TRENT_HOME: home } })).toEqual({
      provider: "ollama",
      model: "qwen3:4b",
      models: { planner: "qwen3:14b", fallback_on_pin: true },
    });
  });

  it("is undefined, never a throw, for no file, broken YAML, no provider, or a list", () => {
    for (const body of [undefined, "provider: [unclosed", "model: qwen3:4b\n", "- a\n- b\n", "provider: 42\n"]) {
      const home = trentHome(body === undefined ? {} : { "config.yaml": body });
      expect(readProfileModelConfig({ argv: [], env: { TRENT_HOME: home } }), String(body)).toBeUndefined();
    }
  });

  it("drops a model value that is not one model id rather than writing it into the environment", () => {
    const home = trentHome({ "config.yaml": "provider: ollama\nmodel: \"qwen3:4b; rm -rf /\"\nmodels:\n  fast: \"-x\"\n" });
    expect(readProfileModelConfig({ argv: [], env: { TRENT_HOME: home } })).toEqual({ provider: "ollama", model: "" });
  });
});

describe("applyModelNameEnv writes only the names the app freezes", () => {
  it("under ollama: the four OpenAI tier variables, and no alias identity, key or base URL", () => {
    const written = applyModelNameEnv({ provider: "ollama", model: "qwen3:4b" });
    expect(written).toEqual(["OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC"]);
    expect(process.env.OPENAI_MODEL_STRONG).toBe("qwen3:4b");
    for (const name of ["TRENT_MODEL_ALIAS", "OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS"]) {
      expect(process.env[name], name).toBeUndefined();
    }
  });

  it("keeps an operator's export and writes the configured tiers around it", () => {
    process.env.OPENAI_MODEL_STRONG = "qwen3:14b";
    applyModelNameEnv({ provider: "ollama", model: "qwen3:4b", models: { fast: "qwen3:1.7b" } });
    expect(process.env.OPENAI_MODEL_FAST).toBe("qwen3:1.7b");
    expect(process.env.OPENAI_MODEL_DEFAULT).toBe("qwen3:4b");
    expect(process.env.OPENAI_MODEL_STRONG).toBe("qwen3:14b");
  });

  it("names a hosted alias's model even before its key is loaded, and an empty model takes the alias default", () => {
    applyModelNameEnv({ provider: "groq", model: "" });
    expect(process.env.OPENAI_MODEL_DEFAULT).toBe("llama-3.3-70b-versatile");
  });

  it("maps a native provider onto its own table, and an unknown provider onto nothing", () => {
    applyModelNameEnv({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(process.env.ANTHROPIC_MODEL_STRONG).toBe("claude-sonnet-4-6");
    expect(applyModelNameEnv({ provider: "vllm", model: "x" })).toEqual([]);
  });
});

describe("the run pin in argv", () => {
  it("is the --model of a `run` command only", () => {
    expect(runPinFromArgv(["run", "-", "--model", "gemma3:1b"])).toBe("gemma3:1b");
    expect(runPinFromArgv(["--profile", "p", "run", "hello", "--model=gemma3:1b"])).toBe("gemma3:1b");
    expect(runPinFromArgv(["cron", "add", "--model", "gemma3:1b"])).toBeUndefined();
    expect(runPinFromArgv(["run", "--model", "--json"])).toBeUndefined();
  });

  it("is forced over the operator's export, the way `trent run --model` forces it", () => {
    const home = trentHome({ "config.yaml": "provider: ollama\nmodel: qwen3:4b\n" });
    process.env.OPENAI_MODEL_STRONG = "qwen3:14b";
    applyProfileModelEnv({ argv: ["run", "-", "--model", "gemma3:1b"], env: { TRENT_HOME: home } });
    expect(process.env.OPENAI_MODEL_STRONG).toBe("gemma3:1b");
    expect(process.env.WORKBENCH_PLANNER_MODEL).toBe("gemma3:1b");
  });

  it("a pin the provider cannot take writes nothing and leaves the refusal to `trent run`", () => {
    const home = trentHome({ "config.yaml": "provider: openrouter\nmodel: anthropic/claude-sonnet-4-6\n" });
    expect(applyProfileModelEnv({ argv: ["run", "-", "--model", "gpt-5"], env: { TRENT_HOME: home } })).toEqual([]);
  });
});
