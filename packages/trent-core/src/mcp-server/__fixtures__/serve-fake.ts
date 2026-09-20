/**
 * A child process that IS `trent mcp serve --stdio` with fake adapters behind the real gate chain.
 *
 * `stdio.test.ts` spawns it and talks to it with the SDK's own stdio client, which is the only
 * honest proof that the server speaks the transport: real pipes, real framing, nothing on stdout
 * but protocol. The toolsets are the real `file_ops` and `terminal` on the local backend (the
 * hardline refusal is asserted before either could run anything), plus one fake adapter standing
 * in for a brain reader. No model, no proxy, no sandbox image.
 *
 *   argv: <profileDir> <workspace> <home>
 */
import process from "node:process";
import { IdempotencyManager } from "../../governance/IdempotencyManager.js";
import { record as toRecord } from "../../tools/action.js";
import { buildTrentTools } from "../../tools/index.js";
import type { TrentToolAdapter } from "../../tools/types.js";
import { renderToolInstructions } from "../../tools/web/schemas.js";
import { createTrentMcpServer } from "../server.js";
import { serveStdio } from "../transport.js";

const [profileDir, workspace, home] = process.argv.slice(2);
if (!profileDir || !workspace || !home) {
  process.stderr.write("usage: serve-fake <profileDir> <workspace> <home>\n");
  process.exit(2);
}

const fakeBrain: TrentToolAdapter = {
  name: "brain_read",
  scopes: ["brain_read", "brain_echo"],
  availability: "real",
  instructions: renderToolInstructions([
    { name: "brain_echo", description: "Echo the text back.", parameters: { type: "object", properties: { text: { type: "string", description: "What to echo." } }, required: ["text"] } },
  ]),
  routingText: "fake brain",
  healthCheck: async () => "connected",
  estimateCost: () => 0,
  requiresApproval: () => false,
  async execute(action) {
    const args = JSON.parse(action.slice(action.indexOf("{"))) as { text?: string };
    return toRecord("brain_read", action, "completed", `echo: ${args.text ?? ""}`);
  },
  cleanup: async () => undefined,
};

const built = buildTrentTools(
  { toolsets: ["file_ops", "terminal"], disabled_toolsets: [] },
  { workspace, profileDir, backend: "local", home, idempotency: new IdempotencyManager({ dir: profileDir }), extraAdapters: [fakeBrain] },
);
const server = createTrentMcpServer({ adapters: built.adapters, profileDir, companyId: "cmp_stdio", log: () => undefined });
await serveStdio(server);
for (const adapter of built.adapters) await adapter.cleanup();
