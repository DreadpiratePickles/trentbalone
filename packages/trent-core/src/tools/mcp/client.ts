/**
 * One live connection per configured MCP server, over the official SDK client.
 *
 * stdio: the child gets `scrubChildEnv(env)` (the allowlist from `terminal/env-scrub.ts`, so no
 * host secret ever leaks) plus ONLY the vars the server declares in `env`, resolved from the
 * host env at connect time. Its stderr is discarded, never captured: a server that echoes its
 * environment must not be able to put a value into a Trent log or summary.
 *
 * http: every request goes through the egress fetch from `tools/web` (HTTP CONNECT through the
 * proxy, SSRF floors on every hop) after `checkUrlSafety` has refused private, loopback and
 * metadata targets up front. Without an egress transport an http server is unavailable; there
 * is no "direct" mode.
 *
 * A failure anywhere in here becomes an `unavailable` reason. Reasons name env vars and hosts,
 * never values or headers.
 *
 * Every `callTool` result passes through `scrubMcpResult` (`./scan.ts`) before it reaches the
 * seat: secret-shaped runs become numbered tokens, hit counts are logged, values never are.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../../config/schema.js";
import { scrubChildEnv } from "../../terminal/env-scrub.js";
import { StructuredLogger } from "../../telemetry/logger.js";
import { createEgressFetch, type EgressClientOptions, type FetchLike } from "../web/proxied-fetch.js";
import { checkUrlSafety, type LookupFn } from "../web/url-safety.js";
import { resolveTemplateRecord } from "./config.js";
import { scrubMcpResult } from "./scan.js";

const CLIENT_INFO = { name: "trent-fleet", version: "1.0.0" };
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface McpCallResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface McpConnection {
  readonly server: string;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpConnectDeps {
  /** The host env: source of `${VAR}` values and of the scrubbed base env for stdio children. */
  readonly env: NodeJS.ProcessEnv;
  /** The egress proxy as reachable from THIS process; required for http servers. */
  readonly egress?: Omit<EgressClientOptions, "lookup">;
  /** Test seam: replaces the egress fetch for http servers. */
  readonly fetchImpl?: FetchLike;
  readonly lookup?: LookupFn;
  /** cwd for stdio children; defaults to the process cwd. */
  readonly cwd?: string;
  readonly connectTimeoutMs?: number;
  /** Where result-scrub hit counts go; defaults to a `StructuredLogger` on stderr. Never carries a value. */
  readonly redactionLog?: (event: string, fields: Record<string, unknown>) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toToolInfo(raw: unknown): McpToolInfo | undefined {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) return undefined;
  const schema = isRecord(raw.inputSchema) ? raw.inputSchema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : undefined;
  return {
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    inputSchema: { type: "object", properties, ...(required?.length ? { required } : {}) },
  };
}

function renderContent(result: unknown): McpCallResult {
  const record = isRecord(result) ? result : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .filter(isRecord)
    .map((item) => (typeof item.text === "string" ? item.text : JSON.stringify(item)))
    .join("\n");
  return { text: text || "(MCP tool returned no content)", isError: record.isError === true };
}

function wrap(server: string, client: Client, deps: McpConnectDeps, closeExtra?: () => Promise<void>): McpConnection {
  const logger = deps.redactionLog === undefined ? new StructuredLogger({ runId: "mcp" }) : undefined;
  const redactionLog = deps.redactionLog ?? ((event, fields) => logger?.info(event, fields));
  return {
    server,
    async listTools() {
      const result = await client.listTools(undefined, { timeout: MCP_CALL_TIMEOUT_MS });
      return (Array.isArray(result.tools) ? result.tools : []).map(toToolInfo).filter((t): t is McpToolInfo => t !== undefined);
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: MCP_CALL_TIMEOUT_MS });
      const rendered = renderContent(result);
      const scrubbed = scrubMcpResult(rendered.text);
      if (scrubbed.hits.length > 0) redactionLog("mcp.result.redacted", { server, tool: name, hits: scrubbed.hits });
      return { text: scrubbed.text, isError: rendered.isError };
    },
    async close() {
      await client.close().catch(() => undefined);
      await closeExtra?.();
    },
  };
}

async function connectStdio(name: string, config: Extract<McpServerConfig, { transport: "stdio" }>, deps: McpConnectDeps): Promise<McpConnection> {
  const declared = resolveTemplateRecord(config.env, deps.env);
  if (declared.missing.length) throw new Error(`env references unset variable(s): ${declared.missing.join(", ")}`);
  const env = { ...scrubChildEnv(deps.env), ...declared.values };
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...config.args],
    env,
    stderr: "ignore",
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
  });
  const client = new Client(CLIENT_INFO);
  try {
    await withTimeout(client.connect(transport), deps.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS, `connecting to ${name}`);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
  return wrap(name, client, deps);
}

async function connectHttp(name: string, config: Extract<McpServerConfig, { transport: "http" }>, deps: McpConnectDeps): Promise<McpConnection> {
  const fetchImpl = deps.fetchImpl ?? (deps.egress ? createEgressFetch({ ...deps.egress, lookup: deps.lookup }) : undefined);
  if (!fetchImpl) throw new Error("the egress proxy is not running; http MCP servers have no transport");
  const verdict = await checkUrlSafety(config.url, { lookup: deps.lookup });
  if (!verdict.ok) throw new Error(`refused by the SSRF floor: ${verdict.reason}`);
  const headers = resolveTemplateRecord(config.headers, deps.env);
  if (headers.missing.length) throw new Error(`headers reference unset variable(s): ${headers.missing.join(", ")}`);
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    fetch: fetchImpl,
    requestInit: { headers: headers.values },
  });
  const client = new Client(CLIENT_INFO);
  try {
    await withTimeout(client.connect(transport), deps.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS, `connecting to ${name}`);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
  return wrap(name, client, deps);
}

/** Connects to one configured server. Throws with a value-free reason on any failure. */
export function connectMcpServer(name: string, config: McpServerConfig, deps: McpConnectDeps): Promise<McpConnection> {
  return config.transport === "stdio" ? connectStdio(name, config, deps) : connectHttp(name, config, deps);
}

/** The message a failed connect is reported with; never a header, an env value or a stack. */
export function connectFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.slice(0, 300) || "unknown error";
}
