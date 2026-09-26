/**
 * [L0-3] Setup on a local runtime: no key, a reachable runtime, a pulled model.
 *
 * G3: quick setup on `--provider ollama|lmstudio` used to hunt for a key that nothing reads and
 * abort. G15: full setup said "OLLAMA_API_KEY is already set" on a machine where it was not. Here
 * the questions a local provider actually has are asked instead: is the runtime answering, what has
 * it pulled, and which model fits this machine (`local-tiers.ts`). The wording names the exact URL,
 * the exact start command and the exact `ollama pull` line, so the fix is a copy and paste.
 */

import { hasLocalModel, LOCAL_RUNTIME_LABEL, pullCommand, START_COMMAND, type LocalProvider, type LocalRuntimePort, type LocalRuntimeUp } from "./local-runtime.js";
import { memoryGigabytes, recommendedLocalModel, tierForMemory, tierForModel, type LocalTier } from "./local-tiers.js";
import type { PromptPort } from "./ports.js";

export interface LocalSetupInput {
  provider: LocalProvider;
  /** `--model`, or the answer to the model question. Absent: the tier's recommendation. */
  requested?: string;
  /** `--pull`: offer to pull a missing Ollama model, after a confirmation. */
  pull?: boolean;
  env: NodeJS.ProcessEnv;
  runtime: LocalRuntimePort;
  totalMemoryBytes: number;
  prompts: PromptPort;
  say(line: string): void;
}

export type LocalSetupOutcome =
  | { ok: true; model: string; expectation: string }
  | { ok: false; reason: "runtime-unreachable" | "model-not-pulled"; message: string };

/** One line: the runtime, its version, and what it can serve now. */
function describe(status: LocalRuntimeUp): string {
  const label = LOCAL_RUNTIME_LABEL[status.provider];
  const version = status.version === undefined ? "" : ` ${status.version}`;
  const models = status.models.length === 0 ? "none yet" : status.models.join(", ");
  return `${label}${version} is answering at ${status.url}. Models it has: ${models}.`;
}

/** The runtime's id for the tier's model: LM Studio names it by publisher, so match by name. */
function tierModelOn(status: LocalRuntimeUp, tier: LocalTier): string {
  if (status.provider === "ollama") return tier.ollama;
  const listed = status.models.find((id) => id.toLowerCase().replace(/[^a-z0-9.]+/g, "-").includes(tier.lmstudio));
  return listed ?? tier.lmstudio;
}

/** The expectation for the model actually chosen; an unknown model borrows the machine's tier, said so. */
export function expectationFor(model: string, totalMemoryBytes: number): string {
  const known = tierForModel(model);
  if (known !== undefined) return known.expectation;
  const machine = tierForMemory(totalMemoryBytes);
  return `Trent has no measurement for ${model}; for the ${machine.memory} tier's ${machine.ollama}: ${machine.expectation}`;
}

/** The model a local provider's model question is pre-filled with: the tier's, never `llama3.2`. */
export function localModelDefault(provider: LocalProvider, totalMemoryBytes: number): string {
  return recommendedLocalModel(provider, totalMemoryBytes);
}

export function noKeyLine(provider: LocalProvider): string {
  return `${LOCAL_RUNTIME_LABEL[provider]} runs on this machine and needs no API key.`;
}

/**
 * Quick: stop, with a reason a script can branch on, unless the runtime answers and has the model.
 * Nothing here asks a question except `--pull`'s confirmation, so a stop needs no terminal.
 */
export async function resolveLocalModel(input: LocalSetupInput): Promise<LocalSetupOutcome> {
  const { provider, runtime, env, say } = input;
  const label = LOCAL_RUNTIME_LABEL[provider];
  say(noKeyLine(provider));

  const status = await runtime.probe(provider, env);
  if (!status.reachable) {
    return {
      ok: false,
      reason: "runtime-unreachable",
      message: `${label} is not answering at ${status.url} (${status.error}). Start it with: ${START_COMMAND[provider]}, then run setup again.`,
    };
  }
  say(describe(status));

  const tier = tierForMemory(input.totalMemoryBytes);
  const model = input.requested ?? tierModelOn(status, tier);
  if (input.requested === undefined) {
    say(`This machine has ${memoryGigabytes(input.totalMemoryBytes)} GB of memory, so the recommended model is ${model} (${tier.download} download).`);
  }

  if (!hasLocalModel(status.models, model)) {
    const pulled = await offerPull(input, model, tier);
    if (!pulled) {
      const line = pullLine(provider, model);
      if (line !== undefined) {
        say(`${model} is not pulled yet. To pull it:`);
        say(line);
      }
      return notPulled(provider, status.url, model);
    }
  }
  return { ok: true, model, expectation: expectationFor(model, input.totalMemoryBytes) };
}

async function offerPull(input: LocalSetupInput, model: string, tier: LocalTier): Promise<boolean> {
  const { provider, runtime, env, say } = input;
  if (input.pull !== true || provider !== "ollama") return false;
  const size = tier.ollama === model ? ` (${tier.download})` : "";
  const yes = await input.prompts.confirm({ id: "pull", message: `Pull ${model} into Ollama now${size}?`, default: false });
  if (!yes) return false;
  say(`Pulling ${model}...`);
  await runtime.pull(model, env, say);
  const after = await runtime.probe(provider, env);
  return after.reachable && hasLocalModel(after.models, model);
}

function notPulled(provider: LocalProvider, url: string, model: string): LocalSetupOutcome {
  const label = LOCAL_RUNTIME_LABEL[provider];
  const command = pullCommand(provider, model);
  if (command === undefined) {
    return {
      ok: false,
      reason: "model-not-pulled",
      message: `${label} at ${url} has no model ${model}. Download and load it in ${label}, then run setup again with --model set to its id from the list above.`,
    };
  }
  return {
    ok: false,
    reason: "model-not-pulled",
    message: `${model} is not pulled into ${label} at ${url}. Run: ${command} (or run setup again with --pull), then run setup again.`,
  };
}

/** The exact pull line on a line of its own, so it can be copied; the caller prints the verdict. */
export function pullLine(provider: LocalProvider, model: string): string | undefined {
  const command = pullCommand(provider, model);
  return command === undefined ? undefined : `  ${command}`;
}

/**
 * Full and Blank Slate: the runtime is checked and reported, never a blocker; the user is walking
 * the wizard on purpose and may start the runtime afterwards. Returns what the runtime lists.
 */
export async function reportLocalRuntime(provider: LocalProvider, runtime: LocalRuntimePort, env: NodeJS.ProcessEnv, say: (line: string) => void): Promise<readonly string[] | undefined> {
  say(noKeyLine(provider));
  const status = await runtime.probe(provider, env);
  if (!status.reachable) {
    say(`${LOCAL_RUNTIME_LABEL[provider]} is not answering at ${status.url} (${status.error}). Start it before your first run: ${START_COMMAND[provider]}`);
    return undefined;
  }
  say(describe(status));
  return status.models;
}

/** After the model question: say how to fetch a chosen model the runtime does not have. */
export function reportModelPresence(provider: LocalProvider, models: readonly string[] | undefined, model: string, say: (line: string) => void): void {
  if (models === undefined || hasLocalModel(models, model)) return;
  const command = pullCommand(provider, model);
  say(command === undefined
    ? `${LOCAL_RUNTIME_LABEL[provider]} does not list ${model} yet. Download and load it in ${LOCAL_RUNTIME_LABEL[provider]} before your first run.`
    : `${model} is not pulled yet. Before your first run: ${command}`);
}
