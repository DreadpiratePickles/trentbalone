import fs from "node:fs";
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";
import { normalizeMcpTransport, type McpTransport } from "@/lib/mcp-transport";

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

type McpProofDeps = {
  createMcpServer: typeof import("@/lib/mcp-store").createMcpServer;
  updateMcpServer: typeof import("@/lib/mcp-store").updateMcpServer;
  createMcpToolAdapter: typeof import("@/lib/mcp-tool-adapter").createMcpToolAdapter;
  discoverMcpTools: typeof import("@/lib/mcp-tool-adapter").discoverMcpTools;
  store: typeof import("@/lib/store").store;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedEnvKeys = args.envFile ? loadEnvFile(args.envFile) : [];
  const output = await runLiveMcpProof(args, loadedEnvKeys, await loadMcpProofDeps());
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.outFile) {
    fs.mkdirSync(dirname(args.outFile), { recursive: true });
    fs.writeFileSync(args.outFile, serialized, "utf8");
  }
  process.stdout.write(serialized);
  process.exitCode = output.passed ? 0 : 1;
}

async function loadMcpProofDeps(): Promise<McpProofDeps> {
  const [{ createMcpServer, updateMcpServer }, { createMcpToolAdapter, discoverMcpTools }, { store }] = await Promise.all([
    import("@/lib/mcp-store"),
    import("@/lib/mcp-tool-adapter"),
    import("@/lib/store"),
  ]);
  return { createMcpServer, updateMcpServer, createMcpToolAdapter, discoverMcpTools, store };
}

async function runLiveMcpProof(args: Args, loadedEnvKeys: string[], deps: McpProofDeps): Promise<ProofOutput> {
  const failures: string[] = [];
  const serverUrl = args.serverUrl ?? process.env.MCP_TEST_SERVER_URL ?? "https://mcp.stripe.com";
  const transport = inferTransport(serverUrl);
  const token = providerToken(serverUrl);
  if (!process.env.DATABASE_URL) failures.push("DATABASE_URL is required to seed the MCP server record.");
  if (!token) failures.push("MCP_TEST_SERVER_TOKEN, STRIPE_SECRET_KEY, or SENTRY_ACCESS_TOKEN is required.");
  if (failures.length) {
    return { passed: false, serverName: args.serverName, serverUrl, loadedEnvKeys, failures };
  }
  if (!token) throw new Error("MCP proof token validation failed unexpectedly.");
  if (serverUrl === "stdio://sentry") {
    return runSentryStdioProof({ args, loadedEnvKeys, serverUrl, transport, token, deps });
  }

  const company = await deps.store.createCompany({
    name: `Live MCP Proof ${new Date().toISOString()}`,
    brief: { vision: "Verify a real MCP server can be discovered and called through Trent's adapter spine." },
  });
  let server = await deps.createMcpServer({
    companyId: company.id,
    name: args.serverName,
    url: serverUrl,
    transport,
    token,
  });

  const tools = await deps.discoverMcpTools(server);
  const discoveredTools = tools.map((tool) => tool.name);
  for (const required of ["stripe_api_search", "stripe_api_read"]) {
    if (!discoveredTools.includes(required)) failures.push(`Stripe MCP tool missing: ${required}`);
  }

  server = await deps.updateMcpServer(company.id, server.id, {
    discoveredTools: tools,
    status: "connected",
    lastError: null,
    toolAllowlist: ["stripe_api_search", "stripe_api_read"],
    reversibleTools: [],
  }) ?? server;
  const approvalAdapter = deps.createMcpToolAdapter(server);
  const readAction = `stripe_api_read ${JSON.stringify({
    stripe_api_operation_id: "GetBalance",
    parameters: {},
  })}`;
  const defaultApprovalRequired = approvalAdapter.requiresApproval(readAction);
  if (!defaultApprovalRequired) failures.push("MCP read tool did not default to approval-required before reversible policy was set.");

  server = await deps.updateMcpServer(company.id, server.id, {
    reversibleTools: ["stripe_api_search", "stripe_api_read"],
  }) ?? server;
  const adapter = deps.createMcpToolAdapter(server);
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

async function runSentryStdioProof(input: {
  args: Args;
  loadedEnvKeys: string[];
  serverUrl: string;
  transport: McpTransport;
  token: string;
  deps: McpProofDeps;
}): Promise<ProofOutput> {
  const failures: string[] = [];
  const company = await input.deps.store.createCompany({
    name: `Live Sentry MCP Proof ${new Date().toISOString()}`,
    brief: { vision: "Verify Sentry MCP can be discovered and called through Trent's stdio preset." },
  });
  let server = await input.deps.createMcpServer({
    companyId: company.id,
    name: input.args.serverName,
    url: input.serverUrl,
    transport: input.transport,
    token: input.token,
  });

  const tools = await input.deps.discoverMcpTools(server);
  const discoveredTools = tools.map((tool) => tool.name);
  if (!discoveredTools.includes("whoami")) failures.push("Sentry MCP tool missing: whoami");

  server = await input.deps.updateMcpServer(company.id, server.id, {
    discoveredTools: tools,
    status: "connected",
    lastError: null,
    toolAllowlist: ["whoami"],
    reversibleTools: [],
  }) ?? server;
  const approvalAdapter = input.deps.createMcpToolAdapter(server);
  const defaultApprovalRequired = approvalAdapter.requiresApproval("whoami");
  if (!defaultApprovalRequired) failures.push("Sentry MCP whoami did not default to approval-required.");

  server = await input.deps.updateMcpServer(company.id, server.id, {
    reversibleTools: ["whoami"],
  }) ?? server;
  const adapter = input.deps.createMcpToolAdapter(server);
  const read = await adapter.execute("whoami", {});
  if (read.status !== "completed") failures.push(`Sentry MCP whoami failed: ${read.summary}`);

  return {
    passed: failures.length === 0,
    serverName: input.args.serverName,
    serverUrl: input.serverUrl,
    companyId: company.id,
    serverId: server.id,
    loadedEnvKeys: input.loadedEnvKeys,
    discoveredToolCount: tools.length,
    discoveredTools: discoveredTools.slice(0, 20),
    defaultApprovalRequired,
    readStatus: read.status,
    readPreview: read.status === "completed" ? "Sentry whoami completed; response intentionally omitted." : read.summary.slice(0, 500),
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
    "SENTRY_AUTH_TOKEN",
    "SENTRY_ACCESS_TOKEN",
    "SENTRY_MCP_TOKEN",
  ].includes(key));
}

function inferTransport(serverUrl: string): McpTransport {
  if (serverUrl.startsWith("stdio://")) return "stdio";
  return normalizeMcpTransport(process.env.MCP_TEST_SERVER_TRANSPORT) ?? "http";
}

function providerToken(serverUrl: string): string | undefined {
  if (serverUrl === "stdio://sentry") {
    return process.env.SENTRY_AUTH_TOKEN
      ?? process.env.SENTRY_ACCESS_TOKEN
      ?? process.env.SENTRY_MCP_TOKEN
      ?? process.env.MCP_TEST_SERVER_TOKEN;
  }
  return process.env.MCP_TEST_SERVER_TOKEN ?? process.env.STRIPE_SECRET_KEY;
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
    "and executes read-only Stripe or Sentry MCP calls through Trent's MCP ToolAdapter.",
  ].join("\n"));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
