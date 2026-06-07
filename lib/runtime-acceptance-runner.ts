import { readFile, writeFile } from "node:fs/promises";
import { AGENT_MISSION_E2E_FIXTURE_ID, buildAgentMissionE2EActuals } from "@/lib/agent-mission-e2e-eval";
import {
  buildRuntimeAcceptanceEvalSuite,
  buildRuntimeAcceptancePassingActuals,
  type RuntimeAcceptanceActuals,
} from "@/lib/runtime-acceptance-evals";
import { runEvalSuite, type EvalSuiteResult } from "@/lib/eval-harness";

export type RuntimeAcceptanceEvalCommandResult = {
  exitCode: number;
  result: EvalSuiteResult;
};

export async function runRuntimeAcceptanceEvalCommand(
  args: string[],
  io: { write(text: string): Promise<void> | void } = { write: (text) => { process.stdout.write(text); } },
): Promise<RuntimeAcceptanceEvalCommandResult> {
  const options = parseArgs(args);
  const actuals = options.agentMissionE2E
    ? await buildAgentMissionE2EActuals()
    : options.smoke
    ? buildRuntimeAcceptancePassingActuals()
    : options.actualsPath
      ? await readActuals(options.actualsPath)
      : {};
  const result = await runEvalSuite(buildRuntimeAcceptanceEvalSuite({
    actuals,
    fixtureIds: options.agentMissionE2E ? [AGENT_MISSION_E2E_FIXTURE_ID] : undefined,
  }));
  const summary = [
    `Runtime acceptance eval score: ${result.score}`,
    `Threshold: ${options.threshold}`,
    `Passed fixtures: ${result.fixtures.filter((fixture) => fixture.passed).length}/${result.fixtures.length}`,
    `Failure clusters: ${Object.entries(result.failureClusters).map(([tag, count]) => `${tag}:${count}`).join(", ") || "none"}`,
  ].join("\n");

  await io.write(`${summary}\n`);
  if (options.outPath) await writeFile(options.outPath, JSON.stringify(result, null, 2));
  return { exitCode: result.score >= options.threshold ? 0 : 1, result };
}

function parseArgs(args: string[]) {
  let threshold = 0.8;
  let actualsPath: string | undefined;
  let outPath: string | undefined;
  let smoke = false;
  let agentMissionE2E = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--smoke") smoke = true;
    else if (arg === "--agent-mission-e2e") agentMissionE2E = true;
    else if (arg === "--threshold") threshold = Number(args[++i]);
    else if (arg === "--actuals") actualsPath = args[++i];
    else if (arg === "--out") outPath = args[++i];
    else throw new Error(`Unknown runtime eval argument: ${arg}`);
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("--threshold must be a number between 0 and 1");
  }
  return { threshold, actualsPath, outPath, smoke, agentMissionE2E };
}

async function readActuals(path: string): Promise<RuntimeAcceptanceActuals> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Runtime acceptance actuals must be a JSON object keyed by fixture id");
  }
  return raw as RuntimeAcceptanceActuals;
}
