/**
 * A child process that IS `trent acp`, with the headless runtime replaced.
 *
 * ACP is a subprocess protocol: the editor spawns the agent and talks JSON-RPC down its pipes. The
 * only honest proof that `trent acp` speaks it is therefore a real child process over real pipes,
 * which is what `servers.test.ts` drives. The runtime is injected through the same
 * `overrides.gatewayRuntime` seam every other command test uses, so no proxy, sandbox or model is
 * involved and the text the editor sees is text this fake produced.
 *
 * `runCli` captures its own stdout rather than writing it (no `tee`), so stdout carries nothing but
 * the protocol. Anything this file needs to say goes to stderr.
 */

import { runCli } from "../index.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_acp_child", at: "2026-09-18T00:00:00.000Z", ...extra } as OrcEvent;
}

const runtime = {
  orchestrator: {},
  companyId: "cmp_acp_child",
  run: (objective: string) =>
    (async function* () {
      yield ev("run_start", { run: { objective } });
      yield ev("run_done", { run: { status: "completed", summary: `brief for: ${objective}` } });
    })(),
  cleanup: async () => undefined,
} as unknown as HeadlessRuntime;

const overrides: CliOverrides = { gatewayRuntime: async () => runtime };

const result = await runCli(process.argv.slice(2), { overrides });
process.stderr.write(`${JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout })}\n`);
