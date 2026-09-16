import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { ConfigManager } from "../config/index.js";
import { SetupWizard } from "./SetupWizard.js";
import { ScriptedPrompts } from "./ScriptedPrompts.js";
import { CollectingOutput } from "./ports.js";
import { PROVIDER_ENV_VARS } from "./detect.js";
import { DEFAULT_HEARTBEAT_MD, HEARTBEAT_MD } from "../heartbeat/checklist.js";

const EMOJI = /\p{Extended_Pictographic}/u;

/** Everything a human would have seen: prompt text plus printed lines. */
function transcript(prompts: ScriptedPrompts, output: CollectingOutput): string {
  return [...prompts.asked.map((a) => a.message), ...output.lines].join("\n");
}

describe("SetupWizard", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let output: CollectingOutput;

  function wizardWith(
    answers: Record<string, unknown>,
    env: NodeJS.ProcessEnv = {},
    runDoctor?: () => Promise<{ ok: boolean; summary: string }>,
  ): { wizard: SetupWizard; prompts: ScriptedPrompts } {
    const prompts = new ScriptedPrompts(answers);
    const wizard = new SetupWizard({
      configManager,
      prompts,
      output,
      env,
      ...(runDoctor ? { runDoctor } : {}),
    });
    return { wizard, prompts };
  }

  function configText(): string {
    return fs.readFileSync(configManager.getConfigPath(), "utf8");
  }

  function configOnDisk(): Record<string, any> {
    return parseYaml(configText()) as Record<string, any>;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-setup-test-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    output = new CollectingOutput();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ quick

  describe("quick mode", () => {
    it("detects a key already in the environment, confirms, and writes the config", async () => {
      const { wizard, prompts } = wizardWith({ confirm: true }, { ANTHROPIC_API_KEY: "sk-ant-live" });
      const res = await wizard.run({ mode: "quick" });

      expect(res.success).toBe(true);
      expect(res.config?.provider).toBe("anthropic");
      expect(configOnDisk().provider).toBe("anthropic");
      expect(configOnDisk().fleet.installed_agents).toEqual([
        "ceo",
        "eng-ai-engineer",
        "support-responder",
      ]);
      // The detected key's VALUE must never be shown.
      expect(transcript(prompts, output)).not.toContain("sk-ant-live");
      expect(transcript(prompts, output)).toContain("ANTHROPIC_API_KEY");
    });

    it("detects a key stored in the profile .env file", async () => {
      configManager.saveSecrets({ OPENAI_API_KEY: "sk-from-file" });
      const { wizard } = wizardWith({ confirm: true }, {});
      const res = await wizard.run({ mode: "quick" });

      expect(res.success).toBe(true);
      expect(res.config?.provider).toBe("openai");
      expect(configText()).not.toContain("sk-from-file");
    });

    it("with no keys present names the exact env var and file path and writes no config", async () => {
      const { wizard } = wizardWith({}, {});
      const res = await wizard.run({ mode: "quick" });

      expect(res.success).toBe(false);
      expect(res.config).toBeNull();
      expect(fs.existsSync(configManager.getConfigPath())).toBe(false);

      const text = [res.message, ...output.lines].join("\n");
      expect(text).toContain("OPENAI_API_KEY");
      expect(text).toContain("ANTHROPIC_API_KEY");
      expect(text).toContain(configManager.getSecretsPath());
      // Honesty over theatre: no pretend OAuth.
      expect(text.toLowerCase()).not.toContain("oauth");
      expect(text.toLowerCase()).not.toContain("browser");
    });

    it("runs the injected doctor check after writing the config", async () => {
      let ran = false;
      const { wizard } = wizardWith({ confirm: true }, { OPENAI_API_KEY: "sk-x" }, async () => {
        ran = true;
        return { ok: true, summary: "12 checks passed" };
      });
      const res = await wizard.run({ mode: "quick" });

      expect(res.success).toBe(true);
      expect(ran).toBe(true);
      expect(output.lines.join("\n")).toContain("12 checks passed");
    });

    it("writes the default HEARTBEAT.md into the profile once and never overwrites an edited one", async () => {
      const { wizard } = wizardWith({ confirm: true }, { OPENAI_API_KEY: "sk-x" });
      await wizard.run({ mode: "quick" });
      const file = path.join(configManager.getProfileDir(), HEARTBEAT_MD);
      expect(fs.existsSync(file)).toBe(true);
      const written = fs.readFileSync(file, "utf8");
      expect(written).toBe(DEFAULT_HEARTBEAT_MD);
      expect(written).toMatch(/approvals/i);
      expect(written).toMatch(/80 percent/);
      expect(written).not.toMatch(EMOJI);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);

      fs.writeFileSync(file, "# mine\n");
      const again = wizardWith({ confirm: true }, { OPENAI_API_KEY: "sk-x" });
      await again.wizard.run({ mode: "quick" });
      expect(fs.readFileSync(file, "utf8")).toBe("# mine\n");
    });

    it("writes no config when the user declines the confirmation", async () => {
      const { wizard } = wizardWith({ confirm: false }, { OPENAI_API_KEY: "sk-x" });
      const res = await wizard.run({ mode: "quick" });

      expect(res.success).toBe(false);
      expect(fs.existsSync(configManager.getConfigPath())).toBe(false);
    });
  });

  // ------------------------------------------------------------------- full

  describe("full mode", () => {
    const fullAnswers = {
      provider: "google",
      model: "gemini-2.5-pro",
      toolsets: ["file_ops", "terminal", "web"],
      agents: "ceo, eng-ai-engineer, data-analyst",
      daily_budget: "10.00",
      per_run_budget: "1.00",
      api_key_entry: false,
      confirm: true,
    };

    it("walks every step and writes what was answered", async () => {
      const { wizard, prompts } = wizardWith(fullAnswers, { GOOGLE_API_KEY: "sk-g" });
      const res = await wizard.run({ mode: "full" });

      expect(res.success).toBe(true);
      const ids = prompts.asked.map((a) => a.id);
      expect(ids).toEqual(
        expect.arrayContaining(["provider", "model", "toolsets", "agents", "daily_budget"]),
      );

      const onDisk = configOnDisk();
      expect(onDisk.provider).toBe("google");
      expect(onDisk.model).toBe("gemini-2.5-pro");
      expect(onDisk.toolsets).toEqual(["file_ops", "terminal", "web"]);
      expect(onDisk.fleet.installed_agents).toEqual(["ceo", "eng-ai-engineer", "data-analyst"]);
    });

    it("stores a ten-dollar cap as the integer 1000", async () => {
      const { wizard } = wizardWith(fullAnswers, { GOOGLE_API_KEY: "sk-g" });
      await wizard.run({ mode: "full" });

      const onDisk = configOnDisk();
      expect(onDisk.budget.daily_cap).toBe(1000);
      expect(onDisk.budget.per_run_cap).toBe(100);
      expect(Number.isInteger(onDisk.budget.daily_cap)).toBe(true);
      expect(configManager.loadConfig().budget.daily_cap).toBe(1000);
    });

    it("pre-fills every prompt: a second run answering nothing leaves the config unchanged", async () => {
      const first = wizardWith(fullAnswers, { GOOGLE_API_KEY: "sk-g" });
      await first.wizard.run({ mode: "full" });
      const afterFirst = configText();

      // A fresh manager so nothing is served from the first run's cache.
      configManager = new ConfigManager({ baseDir: tempDir });
      const second = wizardWith({}, { GOOGLE_API_KEY: "sk-g" });
      const res = await second.wizard.run({ mode: "full" });

      expect(res.success).toBe(true);
      expect(configText()).toBe(afterFirst);
      // Every prompt really was shown again — the run was not short-circuited.
      expect(second.prompts.asked.length).toBeGreaterThanOrEqual(5);
    });

    it("never echoes a key it was given, and writes it to .env and not config.yaml", async () => {
      const secret = "sk-test-supersecret-value";
      const { wizard, prompts } = wizardWith(
        { ...fullAnswers, api_key_entry: true, api_key: secret },
        {},
      );
      const res = await wizard.run({ mode: "full" });

      expect(res.success).toBe(true);
      expect(res.secretsConfigured).toEqual(["GOOGLE_API_KEY"]);
      expect(transcript(prompts, output)).not.toContain(secret);
      expect(res.message).not.toContain(secret);
      expect(configText()).not.toContain(secret);
      expect(fs.readFileSync(configManager.getSecretsPath(), "utf8")).toContain(secret);
    });
  });

  // ------------------------------------------------------------ blank slate

  describe("blank slate mode", () => {
    const blankAnswers = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      walkthrough: false,
    };

    it("writes both explicit disable lists, and they survive a reload", async () => {
      const { wizard } = wizardWith(blankAnswers, {});
      const res = await wizard.run({ mode: "blank-slate" });

      expect(res.success).toBe(true);

      const onDisk = configOnDisk();
      expect(onDisk.toolsets).toEqual(["file_ops", "terminal"]);
      expect(onDisk.platform_toolsets.cli).toEqual(["file_ops", "terminal"]);
      expect(onDisk.agent.disabled_toolsets).toEqual([
        "web",
        "browser",
        "code",
        "vision",
        "memory",
        "delegation",
        "cron",
        "skills",
        "plugins",
        "mcp",
      ]);
      expect(onDisk.disabled_toolsets).toEqual(onDisk.agent.disabled_toolsets);

      // A later load must still carry both lists, so `trent update` cannot silently re-enable.
      const reloaded = new ConfigManager({ baseDir: tempDir }).loadConfig() as Record<string, any>;
      expect(reloaded.platform_toolsets.cli).toEqual(["file_ops", "terminal"]);
      expect(reloaded.agent.disabled_toolsets).toHaveLength(10);
    });

    it("offers the walkthrough as an opt-in and runs it when accepted", async () => {
      const { wizard, prompts } = wizardWith(
        {
          ...blankAnswers,
          walkthrough: true,
          toolsets: ["file_ops", "terminal"],
          agents: "ceo",
          daily_budget: "5.00",
          per_run_budget: "1.00",
          api_key_entry: false,
          confirm: true,
        },
        { ANTHROPIC_API_KEY: "sk-a" },
      );
      const res = await wizard.run({ mode: "blank-slate" });

      expect(res.success).toBe(true);
      expect(prompts.asked.map((a) => a.id)).toContain("walkthrough");
      expect(configOnDisk().budget.daily_cap).toBe(500);
    });
  });

  // ------------------------------------------------------------- brand rule

  describe("output hygiene", () => {
    it("emits no emoji from any mode", async () => {
      const runs: Array<Record<string, unknown>> = [
        { mode: "quick" },
        { mode: "full" },
        { mode: "blank-slate" },
      ];

      for (const run of runs) {
        const localOutput = new CollectingOutput();
        const prompts = new ScriptedPrompts({
          provider: "openai",
          model: "gpt-5.6-terra",
          toolsets: ["file_ops", "terminal"],
          agents: "ceo",
          daily_budget: "10.00",
          per_run_budget: "1.00",
          api_key_entry: false,
          walkthrough: false,
          confirm: true,
        });
        const manager = new ConfigManager({
          baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "trent-emoji-")),
        });
        const wizard = new SetupWizard({
          configManager: manager,
          prompts,
          output: localOutput,
          env: { OPENAI_API_KEY: "sk-x" },
        });
        const res = await wizard.run(run as never);

        const text = transcript(prompts, localOutput) + "\n" + res.message;
        expect(EMOJI.test(text), `emoji found in ${String(run.mode)} output`).toBe(false);
      }
    });

    it("declares an env var for every provider it can configure", () => {
      for (const [provider, vars] of Object.entries(PROVIDER_ENV_VARS)) {
        expect(Array.isArray(vars), `${provider} must declare its env vars`).toBe(true);
      }
      expect(PROVIDER_ENV_VARS.openai).toContain("OPENAI_API_KEY");
      expect(PROVIDER_ENV_VARS.anthropic).toContain("ANTHROPIC_API_KEY");
    });
  });

  // -------------------------------------------------------- prompt contract

  describe("prompt contract", () => {
    it("fails loudly if a prompt is shown without a pre-filled default", async () => {
      const prompts = new ScriptedPrompts({});
      await expect(
        (prompts as unknown as { input(q: unknown): Promise<string> }).input({
          id: "no_default",
          message: "Model",
        }),
      ).rejects.toThrow(/pre-filled default/);
    });
  });
});
