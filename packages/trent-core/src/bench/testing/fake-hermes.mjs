#!/usr/bin/env node
/**
 * [C16] A stand-in for the `hermes` binary in the bench's tests, so the Hermes runner is proven without Hermes
 * or a model. It behaves as `hermes chat -q ... --format stream-json` does at its edges
 * (hermes_cli/stream_json.py): it reads `mcp_servers` from `$HERMES_HOME/config.yaml`, connects to the named
 * MCP server over Streamable HTTP with the SDK's own client, calls the tools its plan lists, and writes
 * `system/init`, `tool_use`, `tool_result`, `text` and one `result` line per the protocol. What it calls and
 * says is the test's plan (`BENCH_FAKE_HERMES_PLAN`); nothing here is a model.
 *
 *   --version                          prints a version line and exits 0
 *   BENCH_FAKE_HERMES_ARGV_FILE=<path> writes the argv, HERMES_HOME, cwd and config it was given, as JSON
 *   plan.crash                         exits 3 after the init line, with no result
 *   plan.delayMs                       waits before the first tool call
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("Hermes Agent v0.21.3 (bench fake)\n");
  process.exit(0);
}

const home = process.env.HERMES_HOME ?? "";
const configText = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
if (process.env.BENCH_FAKE_HERMES_ARGV_FILE) {
  fs.writeFileSync(process.env.BENCH_FAKE_HERMES_ARGV_FILE, JSON.stringify({ argv, home, cwd: process.cwd(), config: configText }));
}

const plan = JSON.parse(process.env.BENCH_FAKE_HERMES_PLAN ?? "{}");
const started = Date.now();
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, timestamp: Date.now() })}\n`);
const model = argv.includes("-m") ? argv[argv.indexOf("-m") + 1] : "";
emit({ type: "system", subtype: "init", model, session_id: "fake-session" });
if (plan.crash === true) {
  process.stderr.write("the fake was told to crash\n");
  process.exit(3);
}
if (typeof plan.delayMs === "number") await new Promise((resolve) => setTimeout(resolve, plan.delayMs));

const config = JSON.parse(configText);
const client = new Client({ name: "hermes-agent", version: "0.21.3" });
await client.connect(new StreamableHTTPClientTransport(new URL(config.mcp_servers.trent.url)));
const { tools } = await client.listTools();
for (const [index, call] of (plan.calls ?? []).entries()) {
  const name = `mcp__trent__${call.name}`;
  const id = `call_${index + 1}`;
  emit({ type: "tool_use", name, tool_call_id: id, input: call.arguments });
  if (!tools.some((tool) => tool.name === call.name)) {
    emit({ type: "tool_result", name, tool_call_id: id, output: `no tool ${call.name}`, duration_ms: 0, is_error: true });
    continue;
  }
  const result = await client.callTool({ name: call.name, arguments: call.arguments });
  const output = (result.content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
  emit({ type: "tool_result", name, tool_call_id: id, output, duration_ms: 1, is_error: result.isError === true });
}
await client.close();

const answer = typeof plan.answer === "string" ? plan.answer : "";
for (const chunk of answer.split(/(?<= )/)) if (chunk !== "") emit({ type: "text", text: chunk });
const tokens = plan.tokens ?? {};
emit({
  type: "result",
  session_id: "fake-session",
  exit_code: 0,
  text: answer,
  tokens: { input: tokens.input ?? 0, output: tokens.output ?? 0, total: (tokens.input ?? 0) + (tokens.output ?? 0), cache_read: tokens.cache_read ?? 0, cache_write: 0 },
  duration_ms: Date.now() - started,
});
process.exit(0);
