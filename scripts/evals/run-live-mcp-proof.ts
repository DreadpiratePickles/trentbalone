import fs from "node:fs";
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";
import { createMcpServer, updateMcpServer } from "@/lib/mcp-store";
import { createMcpToolAdapter, discoverMcpTools } from "@/lib/mcp-tool-adapter";
import { store } from "@/lib/store";

type Args = {
  envFile?: string;
  outFile?: string;
  serverUrl?: string;
  serverName: string;
};

type ProofOutput = {
  passed: boolean;
  serverName: string;
  serverUrl: string;
  companyId?: string;
  serverId?: string;
  loadedEnvKeys: string[];
  discoveredToolCount?: number;
  discoveredTools?: string[];
  defaultApprovalRequired?: boolean;
  searchStatus?: string;
  readStatus?: string;
  readPreview?: string;
  failures: string[];
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedEnvKeys = args.envFile ? loadEnvFile(args.envFile) : [];
  const output = await runLiveMcpProof(args, loadedEnvKeys);
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.outFile) {
    fs.mkdirSync(dirname(args.outFile), { recursive: true });
    fs.writeFileSync(args.outFile, serialized, "utf8");
  }
  process.stdout.write(serialized);
  process.exitCode = output.passed ? 0 : 1;
}

async function runLiveMcpProof(args: Args, loadedEnvKeys: string[]): Promise<ProofOutput> {
  const failures: string[] = [];
  const serverUrl = args.serverUrl ?? process.env.MCP_TEST_SERVER_URL ?? "https://mcp.stripe.com";
  const token = process.env.MCP_TEST_SERVER_TOKEN ?? process.env.STRIPE_SECRET_KEY;
  if (!process.env.DATABASE_URL) failures.push("DATABASE_URL is required to seed the MCP server record.");
  if (!token) failures.push("MCP_TEST_SERVER_TOKEN or STRIPE_SECRET_KEY is required.");
  if (failures.length) {
    return { passed: false, serverName: args.serverName, serverUrl, loadedEnvKeys, failures };
  }

  const company = await store.createCompany({
    name: `Live MCP Proof ${new Date().toISOString()}`,
    brief: { vision: "Verify a real MCP server can be discovered and called through Trent's adapter spine." },
  });
  let server = await createMcpServer({
    companyId: company.id,
    name: args.serverName,
    url: serverUrl,
    transport: "http",
    token,
  });

  const tools = await discoverMcpTools(server);
  const discoveredTools = tools.map((tool) => tool.name);
  for (const required of ["stripe_api_search", "stripe_api_read"]) {
    if (!discoveredTools.includes(required)) failures.push(`Stripe MCP tool missing: ${required}`);
  }

  server = await updateMcpServer(company.id, server.id, {
    discoveredTools: tools,
    status: "connected",
    lastError: null,
    toolAllowlist: ["stripe_api_search", "stripe_api_read"],
    reversibleTools: [],
  }) ?? server;
  const approvalAdapter = createMcpToolAdapter(server);
  const readAction = `stripe_api_read ${JSON.stringify({
    stripe_api_operation_id: "GetBalance",
    parameters: {},
  })}`;
  const defaultApprovalRequired = approvalAdapter.requiresApproval(readAction);
  if (!defaultApprovalRequired) failures.push("MCP read tool did not default to approval-required before reversible policy was set.");

  server = await updateMcpServer(company.id, server.id, {
    reversibleTools: ["stripe_api_search", "stripe_api_read"],
  }) ?? server;
  const adapter = createMcpToolAdapter(server);
  const search = await adapter.execute(`stripe_api_search ${JSON.stringify({ query: "balance" })}`, {});
  const read = await adapter.execute(readAction, {});
  if (search.status !== "completed") failures.push(`Stripe MCP search failed: ${search.summary}`);
  if (read.status !== "completed") failures.push(`Stripe MCP read failed: ${read.summary}`);

  return {
    passed: failures.length === 0,
    serverName: args.serverName,
    serverUrl,
    companyId: company.id,
    serverId: server.id,
    loadedEnvKeys,
    discoveredToolCount: tools.length,
    discoveredTools: discoveredTools.slice(0, 20),
    defaultApprovalRequired,
    searchStatus: search.status,
    readStatus: read.status,
    readPreview: read.summary.slice(0, 500),
    failures,
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = { serverName: "Stripe" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--env-file") {
      if (!next) throw new Error("--env-file requires a path");
      args.envFile = next;
      i++;
      continue;
    }
    if (arg === "--out") {
      if (!next) throw new Error("--out requires a file path");
      args.outFile = next;
      i++;
      continue;
    }
    if (arg === "--server-url") {
      if (!next) throw new Error("--server-url requires a URL");
      args.serverUrl = next;
      i++;
      continue;
    }
    if (arg === "--server-name") {
      if (!next) throw new Error("--server-name requires a display name");
      args.serverName = next;
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnvFile(path: string): string[] {
  return loadAllowedEvalEnvFile(path, (key) => [
    "DATABASE_URL",
    "SECRET_ENCRYPTION_KEY",
    "MCP_TEST_SERVER_URL",
    "MCP_TEST_SERVER_TOKEN",
    "STRIPE_SECRET_KEY",
  ].includes(key));
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index) || "/";
}

function printHelp() {
  console.log([
    "Usage: tsx scripts/evals/run-live-mcp-proof.ts [--env-file PATH] [--out PATH]",
    "",
    "Seeds a real MCP server record, discovers tools, verifies default approval,",
    "and executes read-only Stripe MCP calls through Trent's MCP ToolAdapter.",
  ].join("\n"));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
