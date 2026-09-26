/**
 * [C11] LIVE: solo on a real model (council C11, "Accept"). A three-turn solo session on ONE conversation,
 * each turn needing at least one real tool call on a temp workspace (read a file the test wrote, list a
 * directory, write a summary file), through the real gateway, the real `file_ops` adapter (local sandbox,
 * writes auto-approved), the real run meter, and the settings the runtime passes (`soloTurnSettings`: the
 * solo envelope as `response_format` under a local alias, none on a hosted provider). Printed per turn:
 * every model call's time to first token, tokens in and out, the meter's cents and the list price in
 * micro-cents, the tool calls and the answer.
 *
 *   -t "qwen"     the local run: `qwen3.5:9b` (`TRENT_LIVE_LOCAL_MODEL`) through Ollama (`OLLAMA_BASE_URL`,
 *                 default 127.0.0.1:11434) under the `ollama` alias, as `applyModelEnv` routes it; every hosted
 *                 key is removed for the run, so nothing leaves the machine.
 *   -t "gemini"   the hosted run: `gemini-3.5-flash-lite` (`TRENT_LIVE_SOLO_HOSTED_MODEL`); the key from
 *                 GEMINI_API_KEY or <repo>/gem.env, never printed. One attempt: the gateway's own retry only.
 *   -t "doctor"   the doctor's Local Model check on the local model: the seat and the SOLO-FORMAT smoke
 *                 scores (section 7 item 4 decides the default mode on the latter), with a 300 s case
 *                 deadline instead of 60 s so a loaded machine is not scored as a weak model; each case's ms
 *                 is printed, so a case over the shipped 60 s is visible.
 * Gated on TRENT_TEST_LIVE=1; without it every case is SKIPPED, which is not a pass. Run one case at a time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigManager } from "../config/ConfigManager.js";
import { createLocalModelCheck } from "../doctor/checks/local-model.js";
import { collectCompletion } from "../model-gateway/complete.js";
import { createModelGateway } from "../model-gateway/index.js";
import { readContextWindow } from "../model-gateway/local-probe.js";
import { LOCAL_MODEL_DEFAULTS, LOCAL_MODEL_ENV } from "../model-gateway/local-runtime.js";
import { priceCallMicroCents } from "../model-gateway/pricing.js";
import { activeProviderAlias, aliasBaseUrl, isProviderAlias } from "../model-gateway/providers.js";
import type { GatewayStreamEvent, ModelGateway } from "../model-gateway/types.js";
import { applyModelEnv, modelEnvKeys } from "../orchestrator/model-env.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { createFileOpsAdapter } from "../tools/file_ops/index.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { createRunLedgerMeter } from "./meter.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession } from "./session-store.js";
import { soloTurnSettings } from "./turn-settings.js";
import type { SoloGateway } from "./types.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const LIVE = process.env.TRENT_TEST_LIVE === "1";
const LOCAL_MODEL = process.env.TRENT_LIVE_LOCAL_MODEL?.trim() || "qwen3.5:9b";
const HOSTED_MODEL = process.env.TRENT_LIVE_SOLO_HOSTED_MODEL?.trim() || "gemini-3.5-flash-lite";
const OLLAMA_URL = (process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
if (!LIVE) console.error("[solo.live] SKIPPED: needs TRENT_TEST_LIVE=1 (and Ollama with the model, or GEMINI_API_KEY). A skip is NOT a pass.");

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of fs.readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  } catch {
    /* no file: the hosted case is skipped below */
  }
  return undefined;
}

const HOSTED_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "TRENT_ESCALATE_MODEL", "TRENT_ESCALATE_PROVIDER", "TRENT_ESCALATE_ON"];
const ENV_TOUCHED = [...new Set([...HOSTED_KEYS, ...modelEnvKeys("ollama"), ...modelEnvKeys("google"), ...Object.values(LOCAL_MODEL_ENV), "OPENAI_BASE_URL", "OPENAI_API_KEY", "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS", "TRENT_JOB_TIMEOUT_MS", "TRENT_HOME"])];

const clip = (text: string, max = 400): string => (text.length <= max ? text : `${text.slice(0, max)}...`);

interface ModelCallRow {
  readonly ttftMs: number | null;
  readonly ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly gatewayCents: number;
  readonly microCents: number | null;
  readonly model: string;
  readonly provider: string;
  readonly estimated: boolean;
  readonly reply: string;
}

interface TurnRow {
  readonly turn: number;
  readonly objective: string;
  readonly modelCalls: ModelCallRow[];
  readonly toolCalls: Array<{ readonly action: string; readonly status: ToolCallRecord["status"]; readonly summary: string }>;
  end?: string;
  detail?: string;
  answer?: string;
  meterCents?: number;
  tokens?: number;
  ms?: number;
}

/** The gateway, each call timed to its first streamed token, each call's row added to the current turn. */
function timed(gateway: ModelGateway, current: () => TurnRow): SoloGateway {
  return {
    complete: async (request) => {
      const started = performance.now();
      let first: number | undefined;
      async function* tap(): AsyncGenerator<GatewayStreamEvent> {
        for await (const event of gateway.stream(request)) {
          if (first === undefined && event.type === "token") first = performance.now() - started;
          yield event;
        }
      }
      const completion = await collectCompletion(tap());
      const alias = completion.providerAlias !== undefined && isProviderAlias(completion.providerAlias) ? completion.providerAlias : undefined;
      const priced = priceCallMicroCents({ model: completion.model, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, cachedInputTokens: completion.cachedInputTokens ?? 0, ...(alias === undefined ? {} : { alias }) });
      current().modelCalls.push({
        ttftMs: first === undefined ? null : Math.round(first),
        ms: Math.round(performance.now() - started),
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        gatewayCents: completion.costCents,
        microCents: priced?.microCents ?? null,
        model: completion.model,
        provider: completion.providerAlias ?? completion.provider,
        estimated: completion.estimated,
        reply: clip(completion.text),
      });
      return completion;
    },
  };
}

/** The real adapter, each call's record added to the current turn. */
function recorded(adapter: TrentToolAdapter, current: () => TurnRow): TrentToolAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "execute") {
        return async (action: string, payload: Record<string, unknown>) => {
          const result = await target.execute(action, payload);
          current().toolCalls.push({ action: clip(action, 200), status: result.status, summary: clip(result.summary, 200) });
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const OBJECTIVES = [
  "Read the file notes/brief.txt and tell me the delivery code written in it.",
  "List the files in the notes directory.",
  "Write a two-line summary of what you have learned to summary.md in the workspace root.",
];

interface SessionRun {
  readonly turns: TurnRow[];
  readonly workspace: string;
}

async function soloSession(label: string, gateway: ModelGateway, windowTokens: number | undefined): Promise<SessionRun> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-live-ws-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-live-profile-"));
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes", "brief.txt"), "Order 7731 ships on Thursday.\nThe delivery code is PELICAN-42.\n", "utf8");
  fs.writeFileSync(path.join(workspace, "notes", "suppliers.txt"), "Acme Paper invoices monthly.\nBolt Couriers invoices weekly.\n", "utf8");
  const turns: TurnRow[] = [];
  const current = (): TurnRow => turns[turns.length - 1]!;
  const files = recorded(createFileOpsAdapter({ workspace, profileDir, backend: "local", autoApproveWrites: true }), current);
  const adapters = [files];
  const settings = soloTurnSettings({}, adapters);
  console.log(`[solo.live] ${label}: response_format ${settings.responseFormat === undefined ? "none (text protocol)" : `${settings.responseFormat.type} ${"json_schema" in settings.responseFormat ? settings.responseFormat.json_schema.name : ""}`}; window ${windowTokens ?? "provider-enforced"} tokens`);
  const runner = createSoloRunner({
    gateway: timed(gateway, current),
    tools: { adapters },
    session: memorySoloSession(),
    memory: async () => ({ stable: [], context: [] }),
    meter: createRunLedgerMeter({ surface: "live-test", companyId: "cmp_live" }),
    config: { ...settings, ...(windowTokens === undefined ? {} : { contextWindowTokens: windowTokens }) },
    workspace,
    profileDir,
  });
  try {
    for (const [i, objective] of OBJECTIVES.entries()) {
      turns.push({ turn: i + 1, objective, modelCalls: [], toolCalls: [] });
      const started = performance.now();
      const events: OrcEvent[] = [];
      for await (const event of runner.run({ objective })) events.push(event);
      const turn = current();
      const last = events.at(-1);
      const stepEnd = [...events].reverse().find((event) => event.kind === "step_end") as (OrcEvent & { step?: { tokens?: number; costCents?: number } }) | undefined;
      turn.end = last?.kind ?? "none";
      if (last?.kind === "run_done") turn.answer = clip(last.run?.summary ?? "", 600);
      else turn.detail = clip(last?.detail ?? "", 600);
      turn.meterCents = stepEnd?.step?.costCents ?? 0;
      turn.tokens = stepEnd?.step?.tokens ?? 0;
      turn.ms = Math.round(performance.now() - started);
      const sum = (pick: (row: ModelCallRow) => number): number => turn.modelCalls.reduce((total, row) => total + pick(row), 0);
      console.log(`[solo.live] ${label} turn ${turn.turn}: ${JSON.stringify({ ...turn, totals: { modelCalls: turn.modelCalls.length, inputTokens: sum((r) => r.inputTokens), outputTokens: sum((r) => r.outputTokens), gatewayCents: sum((r) => r.gatewayCents), microCents: sum((r) => r.microCents ?? 0), ttftMs: turn.modelCalls.map((r) => r.ttftMs) } }, null, 2)}`);
    }
    const summary = path.join(workspace, "summary.md");
    console.log(`[solo.live] ${label}: summary.md ${fs.existsSync(summary) ? `written (${fs.statSync(summary).size} bytes): ${JSON.stringify(clip(fs.readFileSync(summary, "utf8"), 300))}` : "NOT written"}`);
    return { turns, workspace };
  } finally {
    await files.cleanup();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

function assertEveryTurnCalledATool(run: SessionRun): void {
  expect(run.turns).toHaveLength(3);
  for (const turn of run.turns) {
    expect(turn.end, `turn ${turn.turn}: ${turn.detail ?? ""}`).toBe("run_done");
    expect(turn.toolCalls.filter((call) => call.status === "completed").length, `turn ${turn.turn} made no completed tool call`).toBeGreaterThanOrEqual(1);
  }
}

const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of ENV_TOUCHED) saved.set(name, process.env[name]);
  // The run meter and anything that reads a profile: a temp home, never the operator's.
  process.env.TRENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-live-home-"));
});
afterEach(() => {
  const home = process.env.TRENT_HOME;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (home !== undefined && home.includes("trent-solo-live-home-")) fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!LIVE)("[C11] LIVE: a three-turn solo session", () => {
  it(`local: ${LOCAL_MODEL} through Ollama, constrained`, { timeout: 3_600_000 }, async () => {
    for (const name of HOSTED_KEYS) delete process.env[name];
    process.env.OLLAMA_BASE_URL = OLLAMA_URL;
    // What the orchestrator's constructor writes for `provider: ollama` (the runtime builds the runner after it).
    applyModelEnv({ provider: "ollama", model: LOCAL_MODEL });
    expect(activeProviderAlias()).toBe("ollama");
    const window = await readContextWindow({ alias: "ollama", baseUrl: process.env.OPENAI_BASE_URL ?? aliasBaseUrl("ollama"), model: LOCAL_MODEL, fallbackTokens: LOCAL_MODEL_DEFAULTS.contextTokens });
    const gateway = await createModelGateway();
    const run = await soloSession(`local ${LOCAL_MODEL}`, gateway, window.tokens);
    fs.rmSync(run.workspace, { recursive: true, force: true });
    assertEveryTurnCalledATool(run);
    expect(run.turns.every((turn) => turn.modelCalls.every((call) => call.provider === "ollama"))).toBe(true);
  });

  const key = readGeminiKey();
  it.skipIf(key === undefined)(`hosted: ${HOSTED_MODEL}, the text protocol`, { timeout: 900_000 }, async () => {
    for (const name of [...modelEnvKeys("ollama"), "OPENAI_BASE_URL", "OPENAI_API_KEY"]) delete process.env[name];
    const gateway = await createModelGateway({ apiKeys: { google: key! }, preferredProvider: "google", allowedProviders: ["google"], models: { executor: HOSTED_MODEL } });
    const run = await soloSession(`hosted ${HOSTED_MODEL}`, gateway, undefined);
    fs.rmSync(run.workspace, { recursive: true, force: true });
    assertEveryTurnCalledATool(run);
    expect(run.turns.every((turn) => turn.modelCalls.every((call) => call.provider === "google" && !call.estimated))).toBe(true);
  });

  it(`doctor: the Local Model check on ${LOCAL_MODEL}, the seat and the solo-format smoke`, { timeout: 3_600_000 }, async () => {
    for (const name of HOSTED_KEYS) delete process.env[name];
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-live-doctor-"));
    try {
      const configManager = new ConfigManager({ baseDir });
      configManager.ensureDirs();
      const config = configManager.loadConfig();
      // What `trent setup --mode local` writes for this model on Ollama: solo, and thinking off (it lists `thinking`).
      configManager.saveConfig({ ...config, provider: "ollama" as never, model: LOCAL_MODEL, models: { ...config.models, reasoning_effort: "none" }, agent: { ...config.agent, mode: "solo" } });
      const check = createLocalModelCheck({ smokeCaseTimeoutMs: 300_000, ttftWarnMs: 300_000 });
      const result = await check.run({ baseDir, profile: "default", configManager, probeTimeoutMs: 10_000, env: { OLLAMA_BASE_URL: OLLAMA_URL } });
      console.log(`[solo.live] doctor: ${JSON.stringify({ status: result.status, message: result.message, fixHint: result.fixHint, smoke: result.details?.smoke, soloSmoke: result.details?.soloSmoke, ttft: result.details?.ttft, context: result.details?.context }, null, 2)}`);
      expect(result.details?.soloSmoke).toMatchObject({ total: 5 });
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
