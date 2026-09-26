/**
 * [L2] `trent setup --mode local`: from a runtime on this machine to a profile that runs on it.
 *
 * Quick setup on `--provider ollama` (L0-3) answers "is the runtime up and is the model there". This
 * mode sets up the whole local stack from 02_plan/output/local-models-plan-2026-09-26.md (L2):
 *   1. find the runtimes that answer (`local-detect.ts`) and list what each has, with sizes and roles;
 *   2. choose the chat model by memory tier and the embedding model by role (`local-plan.ts`), offering
 *      `--pull` (after a confirmation per model) for what is missing on Ollama;
 *   3. write provider, model, `memory.embedder`, `terminal.backend: local` when Docker does not answer,
 *      `agent.mode: solo` (one prompt prefix to prefill instead of eleven) unless `--fleet`, and
 *      `models.reasoning_effort: none` when the route can switch the model's thinking off (Ollama with a
 *      `thinking` model; `model-gateway/openai-route.ts` sends it nowhere else);
 *   4. print the tier's honest expectation.
 * `--dry-run` does 1 and 2 with GET requests only, prints the plan and writes nothing.
 */
import os from "node:os";
import { RUNTIME_LABEL, createLocalDiscovery, serverRoot, type LocalDiscoveryPort, type RuntimeFound, type RuntimeProbe } from "./local-detect.js";
import { createLocalRuntime, pullCommand } from "./local-runtime.js";
import { expectationFor } from "./local-setup.js";
import { memoryGigabytes, tierForMemory } from "./local-tiers.js";
import {
  DEFAULT_LOCAL_EMBEDDER_DOWNLOAD,
  aliasEnvFor,
  applyLocalWrites,
  chooseChat,
  chooseEmbedder,
  chooseRuntime,
  formatSize,
  localWrites,
  planRuntime,
  providerFor,
  type ChatChoice,
  type EmbedderChoice,
  type LocalSetupPlan,
} from "./local-plan.js";
import { dockerAnswers } from "./docker-probe.js";
import { quickToolsets } from "./QuickSetup.js";
import { SetupRun } from "./SetupRun.js";
import { STARTER_AGENTS, applyToolsets, withFleet } from "./steps.js";
import { aliasBaseUrl } from "../model-gateway/providers.js";
import type { SetupOptions, SetupResult } from "./types.js";

export class LocalModeSetup extends SetupRun {
  private plan!: LocalSetupPlan;

  async execute(options: Partial<SetupOptions> = {}): Promise<SetupResult> {
    const { env } = this.ctx;
    const dryRun = options.dryRun === true;
    const memory = this.ctx.totalMemoryBytes ?? os.totalmem();
    const tier = tierForMemory(memory);
    const discovery = this.ctx.localDiscovery ?? createLocalDiscovery();

    this.say("A model on this machine needs no API key.");
    const probes = await discovery.detect({ env, ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }) });
    this.plan = { dryRun, memoryGb: memoryGigabytes(memory), tier: tier.id, runtimes: probes.map(planRuntime), chat: { recommended: tier.ollama }, embedder: { provider: "none" }, pull: [], writes: {} };
    for (const probe of probes) this.sayProbe(probe);
    if (options.baseUrl === undefined) this.say("llama.cpp: not probed. To use a llama-server, run setup again with --base-url http://127.0.0.1:8080 (its address).");

    const choice = chooseRuntime(probes, { ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }), ...(options.provider === undefined ? {} : { provider: options.provider }) });
    if (!choice.ok) return this.stop(choice.message, "runtime-unreachable");
    let runtime = choice.runtime;
    this.plan.runtime = runtime.kind;
    this.plan.url = runtime.url;
    this.plan.provider = providerFor(runtime.kind);

    this.say(`This machine has ${memoryGigabytes(memory)} GB of memory, so the ${tier.memory} tier's model is ${tier.ollama} (${tier.download} download).`);
    const chat = chooseChat(runtime, { ...(options.model === undefined ? {} : { requested: options.model }), totalMemoryBytes: memory, pull: options.pull === true });
    this.plan.chat = { recommended: chat.recommended };
    let embedder = chooseEmbedder(probes, runtime, options.pull === true);

    const model = await this.settleChat(runtime, chat, dryRun);
    if (model === undefined) return this.stop(chat.missing ?? `${chat.recommended} was not pulled.`, "model-not-pulled");
    embedder = await this.settleEmbedder(runtime, embedder, dryRun);
    if (!dryRun && this.plan.pull.length > 0) runtime = await this.reprobe(discovery, runtime, options.baseUrl);

    const thinking = await this.thinking(runtime, model, discovery.capabilities.bind(discovery));
    const docker = await (this.ctx.dockerPresent ?? (() => dockerAnswers(env)))();
    const mode = options.fleet === true ? "fleet" : "solo";
    const envWrites = runtime.source === "base-url" ? aliasEnvFor(runtime, env) : undefined;
    const provider = providerFor(runtime.kind);
    const embedderDefaultRoot = embedder.provider === "none" ? undefined : serverRoot(aliasBaseUrl(embedder.provider, { ...env, ...envWrites }));
    const writes = localWrites({ provider, model, embedder, ...(embedderDefaultRoot === undefined ? {} : { embedderDefaultRoot }), docker, mode, thinkingOff: thinking === "off" });
    const expectation = expectationFor(model, memory);
    Object.assign(this.plan, { docker, mode, writes, expectation, ...(envWrites === undefined ? {} : { env: envWrites }) });
    if (thinking !== "unknown") this.plan.chat = { ...this.plan.chat, thinking: thinking !== "none" };

    this.sayDecisions(runtime, embedder, docker, mode, thinking, model);
    this.say(`What to expect: ${expectation}`);

    if (dryRun) {
      this.blank();
      this.say(`Dry run: nothing was pulled or written. Setup would write to ${this.ctx.configManager.getConfigPath()}:`);
      for (const [key, value] of Object.entries(writes)) this.say(`  ${key}: ${value}`);
      for (const [key, value] of Object.entries(envWrites ?? {})) this.say(`  ${key}=${value} (profile .env)`);
      for (const name of this.plan.pull) this.say(`  and would pull ${name} after asking`);
      return { mode: "local", success: true, message: `Dry run: would set provider ${provider}, model ${model}, embedder ${describeEmbedder(embedder)}, agent mode ${mode}. Nothing written.`, config: null, secretsConfigured: [], output: [...this.lines], local: this.plan };
    }
    return await this.write(writes, envWrites, runtime, model, embedder, mode);
  }

  private sayProbe(probe: RuntimeProbe): void {
    if (!probe.reachable) {
      const where = probe.source === "base-url" ? `runtime at --base-url ${probe.url}` : `${probe.source === "ollama" ? "Ollama" : "LM Studio"} at ${probe.url}`;
      this.say(`No ${where}: ${probe.error}.`);
      return;
    }
    const version = probe.version === undefined ? "" : ` ${probe.version}`;
    const extra = probe.kind === "llama.cpp" && probe.contextTokens !== undefined ? `, context ${probe.contextTokens} tokens, ${probe.slots ?? 1} slot(s)` : "";
    this.say(`${RUNTIME_LABEL[probe.kind]}${version} is answering at ${probe.url}${extra}. Models it has:`);
    if (probe.models.length === 0) this.say("  none yet");
    const width = Math.max(0, ...probe.models.map((m) => m.id.length));
    for (const m of probe.models) {
      const size = m.role === "cloud" ? "cloud" : formatSize(m.sizeBytes) ?? "size not reported";
      const role = m.role === "cloud"
        ? "runs on ollama.com, not here; never chosen"
        : m.role === "embedding"
          ? "embedding"
          : m.capabilities === undefined ? "chat" : `chat, ${m.capabilities.includes("tools") ? "tools" : "no tools"}${m.capabilities.includes("thinking") ? ", thinking" : ""}`;
      this.say(`  ${m.id.padEnd(width)}  ${size.padEnd(9)}  ${role}`);
    }
  }

  /** The chat model to write; pulls first when the choice says so and the operator agrees. */
  private async settleChat(runtime: RuntimeFound, chat: ChatChoice, dryRun: boolean): Promise<string | undefined> {
    for (const note of chat.notes) this.say(note);
    if (chat.model === undefined) {
      const line = runtime.kind === "ollama" && chat.missingModel !== undefined ? pullCommand("ollama", chat.missingModel) : undefined;
      if (line !== undefined) this.say(`${chat.missingModel} is not pulled yet. To pull it:`);
      if (line !== undefined) this.say(`  ${line}`);
      return undefined;
    }
    if (chat.pull === undefined) {
      this.plan.chat = { ...this.plan.chat, model: chat.model, source: chat.source!, pulled: true };
      return chat.model;
    }
    const size = chat.pull === chat.recommended ? ` (${tierForMemory(this.ctx.totalMemoryBytes ?? os.totalmem()).download})` : "";
    if (dryRun) this.plan.pull.push(chat.pull); // offered, not pulled: the plan says what a real run would ask
    if (dryRun || (await this.pullWithConsent(runtime, chat.pull, `Pull ${chat.pull} into Ollama now${size}?`, "pull"))) {
      this.plan.chat = { ...this.plan.chat, model: chat.model, source: "pulled", pulled: !dryRun };
      return chat.model;
    }
    if (chat.fallback !== undefined) {
      this.say(`Not pulled. Using ${chat.fallback}, which is already there.`);
      this.plan.chat = { ...this.plan.chat, model: chat.fallback, source: "fallback", pulled: true };
      return chat.fallback;
    }
    this.say(`  ${pullCommand("ollama", chat.pull)}`);
    chat.missing = `${chat.pull} is not pulled into Ollama at ${runtime.url}. Run: ollama pull ${chat.pull}, then run setup again.`;
    return undefined;
  }

  private async settleEmbedder(runtime: RuntimeFound, embedder: EmbedderChoice, dryRun: boolean): Promise<EmbedderChoice> {
    if (embedder.pull === undefined) {
      this.plan.embedder = { provider: embedder.provider, ...(embedder.model === undefined ? {} : { model: embedder.model, pulled: true }) };
      return embedder;
    }
    const target = embedder.url === runtime.url ? runtime : ({ ...runtime, kind: "ollama", url: embedder.url! } as RuntimeFound);
    if (dryRun) this.plan.pull.push(embedder.pull);
    if (dryRun || (await this.pullWithConsent(target, embedder.pull, `Pull the embedding model ${embedder.pull} into Ollama now (${DEFAULT_LOCAL_EMBEDDER_DOWNLOAD})?`, "pull_embedder"))) {
      this.plan.embedder = { provider: "ollama", model: embedder.pull, pulled: !dryRun };
      return embedder;
    }
    const lexical: EmbedderChoice = { provider: "none", notes: [`Not pulled, so recall stays lexical (memory.embedder.provider none). Later: ollama pull ${embedder.pull}, then run setup again.`] };
    this.plan.embedder = { provider: "none" };
    return lexical;
  }

  private async pullWithConsent(runtime: RuntimeFound, model: string, message: string, id: string): Promise<boolean> {
    const yes = await this.ctx.prompts.confirm({ id, message, default: false });
    if (!yes) return false;
    this.say(`Pulling ${model}...`);
    const runtimePort = this.ctx.localRuntime ?? createLocalRuntime();
    await runtimePort.pull(model, { ...this.ctx.env, OLLAMA_BASE_URL: `${runtime.url}/v1` }, (line) => this.say(line));
    this.plan.pull.push(model);
    return true;
  }

  /** After a pull, the runtime's listing again, so capabilities come from the model now there. */
  private async reprobe(discovery: LocalDiscoveryPort, runtime: RuntimeFound, baseUrl: string | undefined): Promise<RuntimeFound> {
    const again = await discovery.detect({ env: this.ctx.env, ...(baseUrl === undefined ? {} : { baseUrl }) });
    const same = again.find((p): p is RuntimeFound => p.reachable && p.url === runtime.url);
    return same ?? runtime;
  }

  /** `off`: the route can switch thinking off; `on`: it thinks and the route cannot; `none`: it does not think. */
  private async thinking(runtime: RuntimeFound, model: string, capabilities: (url: string, model: string) => Promise<readonly string[] | undefined>): Promise<"off" | "on" | "none" | "unknown"> {
    const listed = runtime.models.find((m) => m.id === model);
    const caps = listed?.capabilities ?? (runtime.kind === "ollama" && listed !== undefined ? await capabilities(runtime.url, model) : undefined);
    if (caps === undefined) return "unknown";
    if (!caps.includes("thinking")) return "none";
    return runtime.kind === "ollama" ? "off" : "on";
  }

  private sayDecisions(runtime: RuntimeFound, embedder: EmbedderChoice, docker: boolean, mode: "solo" | "fleet", thinking: string, model: string): void {
    this.say(`Chat model: ${model} on ${RUNTIME_LABEL[runtime.kind]}${runtime.kind === "ollama" ? "" : `, reached through the lmstudio provider`}.`);
    for (const note of embedder.notes) this.say(note);
    if (embedder.model !== undefined) this.say(`Embedding model: ${embedder.model} on ${embedder.provider === "ollama" ? "Ollama" : "LM Studio"} (memory.embedder).`);
    this.say("Audio: whisper belongs to the media toolset (docs/media.md); setup does not choose it.");
    this.say(docker
      ? "Docker answered, so agent commands keep running in the Docker sandbox (terminal.backend unchanged)."
      : "Docker did not answer, so terminal.backend is local: agent commands run on this machine with its environment, not in a sandbox (docs/terminal.md). Start Docker and set terminal.backend docker for the sandbox.");
    this.say(mode === "solo"
      ? "Agent mode: solo, one agent with one tool loop: one prompt prefix to prefill per turn, not eleven. --fleet keeps the planner and seats."
      : "Agent mode: fleet (--fleet): the planner, the critic and the seats, each with its own prompt to prefill.");
    if (thinking === "off") this.say(`Thinking: ${model} thinks by default; models.reasoning_effort none turns it off on every call.`);
    if (thinking === "on" && runtime.kind === "lmstudio") this.say(`Thinking: ${model} thinks, and LM Studio's chat completions take no reasoning_effort, so it stays at the model's own setting.`);
    if (thinking !== "off" && (runtime.kind === "llama.cpp" || runtime.kind === "openai-compatible")) this.say("Thinking: Trent cannot switch it per call on this route; start llama-server with --reasoning off to turn it off.");
  }

  private async write(writes: Record<string, string>, envWrites: Record<string, string> | undefined, runtime: RuntimeFound, model: string, embedder: EmbedderChoice, mode: string): Promise<SetupResult> {
    const { configManager, prompts } = this.ctx;
    const { toolsets, line } = await quickToolsets(this.ctx);
    this.blank();
    for (const [key, value] of Object.entries(writes)) this.say(`${key}: ${value}`);
    for (const [key, value] of Object.entries(envWrites ?? {})) this.say(`${key}=${value} (profile .env; not a secret)`);
    this.say(line);
    this.say(`Starter agents: ${STARTER_AGENTS.join(", ")}`);

    const proceed = await prompts.confirm({ id: "confirm", message: "Write this configuration?", default: true });
    if (!proceed) return this.stop("Setup cancelled. No configuration was written.", "cancelled");

    const config = applyLocalWrites(withFleet(applyToolsets(configManager.loadConfig(), toolsets), STARTER_AGENTS), writes);
    configManager.saveConfig(config);
    if (envWrites !== undefined) configManager.saveSecrets(envWrites);
    await this.doctor();
    const result = this.ok(
      "local",
      `Local setup complete. ${RUNTIME_LABEL[runtime.kind]} at ${runtime.url}, model ${model}, embedder ${describeEmbedder(embedder)}, agent mode ${mode}, config at ${configManager.getConfigPath()}.`,
      configManager.loadConfig(),
    );
    return { ...result, local: this.plan };
  }

  private stop(message: string, reason: "runtime-unreachable" | "model-not-pulled" | "cancelled"): SetupResult {
    return { ...this.abort("local", message, reason), local: this.plan };
  }
}

function describeEmbedder(embedder: EmbedderChoice): string {
  return embedder.model === undefined ? "none (lexical recall)" : `${embedder.provider} ${embedder.model}`;
}
