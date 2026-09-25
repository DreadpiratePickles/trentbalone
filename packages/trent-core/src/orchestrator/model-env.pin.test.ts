/**
 * [P2-1] A per-run model pin (`trent run --model <id>`, a pinned cron job's child run).
 *
 * Every model name a run uses is resolved from this process's environment: a seat's through
 * `resolveModelName(tier, provider)` (the provider's FAST/DEFAULT/STRONG variables), the planner's,
 * the critic's and the consolidator's through the gateway's workbench route (`WORKBENCH_*_MODEL`
 * when it names the provider, else the STRONG variable). A pin therefore overwrites all of them,
 * operator values included, and narrows the provider chain to the pin's provider unless
 * `models.fallback_on_pin` says a pinned call may fall back.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT, TrentError } from "../errors/index.js";
import { SEAT_ROLES } from "./seat-wiring.js";
import { applyModelEnv, parseModelPin, resolveSeatModel } from "./model-env.js";

const PIN = "gemini-3.6-flash";

const KEYS = [
  "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS",
  "GOOGLE_MODEL_FAST",
  "GOOGLE_MODEL_DEFAULT",
  "GOOGLE_MODEL_STRONG",
  "OPENAI_MODEL_FAST",
  "OPENAI_MODEL_DEFAULT",
  "OPENAI_MODEL_STRONG",
  "OPENAI_MODEL_CRITIC",
  "ANTHROPIC_MODEL_FAST",
  "ANTHROPIC_MODEL_DEFAULT",
  "ANTHROPIC_MODEL_STRONG",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "TRENT_MODEL_ALIAS",
  "TRENT_MODEL_OVERRIDES",
  "TRENT_MODEL_FALLBACK_ON_PIN",
  "TRENT_REASONING_EFFORT",
  "WORKBENCH_EXECUTOR_MODEL",
  "WORKBENCH_PLANNER_MODEL",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("[P2-1] applyModelEnv with a per-run pin", () => {
  it("writes the pin over every model variable a run reads, the operator's own values included", () => {
    // An operator's shell value and a tiered profile: without the pin, each tier would keep its own model.
    process.env.GOOGLE_MODEL_STRONG = "gemini-2.5-pro";
    process.env.WORKBENCH_PLANNER_MODEL = "gemini-2.5-pro";
    const config = {
      provider: "google",
      model: "gemini-3.5-flash-lite",
      models: { fast: "gemini-3.5-flash-lite", executor: "gemini-3.5-flash", planner: "gemini-3.6-pro" },
      pin: PIN,
    };
    const report = applyModelEnv(config);

    for (const name of ["GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG", "WORKBENCH_PLANNER_MODEL", "WORKBENCH_EXECUTOR_MODEL"]) {
      expect(process.env[name], name).toBe(PIN);
    }
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBe("google");
    // A pinned call never falls back to another provider's model unless fallback_on_pin says so.
    expect(process.env.MODEL_ALLOWED_PROVIDERS).toBe("google");
    expect(report.written).toEqual(expect.arrayContaining(["GOOGLE_MODEL_STRONG", "WORKBENCH_PLANNER_MODEL", "MODEL_ALLOWED_PROVIDERS"]));
    expect(report.kept).not.toContain("GOOGLE_MODEL_STRONG");
    // Every seat, whatever its manifest tier, resolves to the pin.
    for (const seat of SEAT_ROLES) expect(resolveSeatModel(seat, config), seat).toBe(PIN);
  });

  it("leaves the provider chain open when models.fallback_on_pin is true", () => {
    process.env.MODEL_ALLOWED_PROVIDERS = "google,anthropic";
    applyModelEnv({ provider: "google", model: "gemini-3.5-flash-lite", models: { fallback_on_pin: true }, pin: PIN });
    expect(process.env.GOOGLE_MODEL_DEFAULT).toBe(PIN);
    expect(process.env.MODEL_ALLOWED_PROVIDERS).toBe("google,anthropic");
  });

  it("an unpinned config still never clobbers an operator's value (the pin is the only override)", () => {
    process.env.GOOGLE_MODEL_STRONG = "gemini-2.5-pro";
    applyModelEnv({ provider: "google", model: "gemini-3.5-flash-lite" });
    expect(process.env.GOOGLE_MODEL_STRONG).toBe("gemini-2.5-pro");
    expect(process.env.MODEL_ALLOWED_PROVIDERS).toBeUndefined();
  });

  it("pins the OpenAI names, the critic included, for OpenAI and for an alias that routes through it", () => {
    applyModelEnv({ provider: "openai", model: "gpt-4.1-mini", pin: "gpt-5.2" });
    for (const name of ["OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC"]) {
      expect(process.env[name], name).toBe("gpt-5.2");
    }
    expect(process.env.MODEL_ALLOWED_PROVIDERS).toBe("openai");

    for (const key of KEYS) delete process.env[key];
    const report = applyModelEnv({ provider: "ollama", model: "llama3.2", pin: "qwen3:8b" });
    expect(report.unroutableProvider).toBeUndefined();
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBe("openai");
    expect(process.env.OPENAI_MODEL_DEFAULT).toBe("qwen3:8b");
    expect(process.env.WORKBENCH_EXECUTOR_MODEL).toBe("qwen3:8b");
    expect(process.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:11434/v1");
  });

  it("openrouter: an anthropic/<model> pin reaches the seats through the Anthropic table; any other is refused", () => {
    applyModelEnv({ provider: "openrouter", model: "anthropic/claude-sonnet-4-6", pin: "anthropic/claude-haiku-4-5" });
    expect(process.env.ANTHROPIC_MODEL_DEFAULT).toBe("claude-haiku-4-5");
    expect(process.env.ANTHROPIC_MODEL_STRONG).toBe("claude-haiku-4-5");
    expect(process.env.WORKBENCH_PLANNER_MODEL).toBe("anthropic/claude-haiku-4-5");
    expect(process.env.MODEL_ALLOWED_PROVIDERS).toBe("openrouter");

    for (const key of KEYS) delete process.env[key];
    let caught: unknown;
    try {
      applyModelEnv({ provider: "openrouter", model: "anthropic/claude-sonnet-4-6", pin: "google/gemini-2.5-flash" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TrentError);
    expect((caught as TrentError).code).toBe(EXIT.CONFIG);
    expect((caught as TrentError).message).toContain("google/gemini-2.5-flash");
    // Refused before anything was written.
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBeUndefined();
  });
});

describe("[P2-1] parseModelPin", () => {
  it("accepts provider model ids and trims them", () => {
    for (const id of ["gemini-3.6-flash", "gpt-5.2", "claude-sonnet-4-6", "anthropic/claude-haiku-4.5", "qwen3:8b", "hf.co/org/model:Q4_K_M"]) {
      expect(parseModelPin(`  ${id} `)).toBe(id);
    }
  });

  it("refuses a blank, spaced, flag-like or oversized id with a configuration error", () => {
    for (const raw of ["", "   ", "gemini 3.6", "--help", "-m", "a".repeat(201), "gemini\n3.6", 42]) {
      let caught: unknown;
      try {
        parseModelPin(raw);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(raw)).toBeInstanceOf(TrentError);
      expect((caught as TrentError).code).toBe(EXIT.CONFIG);
    }
  });
});
