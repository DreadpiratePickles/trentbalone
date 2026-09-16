/**
 * T3.3: what Trent checks about an MCP server beyond "it answers".
 *
 * Install-time scan (`trent mcp add`): every string a server hands the seat as instructions,
 * meaning each tool's name, description and the `description` fields of its input schema, is run
 * through `skills/SecurityScan`, the same jailbreak/exfiltration patterns a SKILL.md must pass.
 * A finding names the tool and the category, never the matched text: the text is the attack,
 * and echoing it would put it in a log the seat might later read.
 *
 * Result scrubbing (`callTool`): a tool result is a prompt-bound string, so it passes through the
 * secret detectors the T3.2 prompt redactor uses, with the same numbered-token shape. Secret kinds
 * only: an MCP result legitimately carries emails and phone numbers, so the PII detectors of the
 * prompt pass are deliberately not applied here, and neither is the generic long-base64 sweep,
 * which would blank a git SHA, a content hash or an encoded payload the seat asked for. Hits are
 * reported as counts per kind.
 */
import { redactText as errorLayerRedact } from "../../errors/index.js";
import { redactionToken, type RedactedText, type RedactionHit } from "../../model-gateway/redact.js";
import { SecurityScan } from "../../skills/SecurityScan.js";
import { REDACTED_SECRET, secretDetectors } from "../../telemetry/redact.js";
import type { McpToolInfo } from "./client.js";

export interface McpScanFinding {
  readonly tool: string;
  readonly categories: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Every `description` (and `title`) string nested anywhere in a JSON schema. */
function schemaStrings(node: unknown, out: string[], depth = 0): void {
  if (depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) schemaStrings(item, out, depth + 1);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if ((key === "description" || key === "title") && typeof value === "string") out.push(value);
    else schemaStrings(value, out, depth + 1);
  }
}

/** The strings a tool contributes to the seat's instructions. */
export function toolInstructionStrings(tool: McpToolInfo): string[] {
  const out = [tool.name, tool.description];
  schemaStrings(tool.inputSchema, out);
  return out.filter((s) => s.length > 0);
}

/** Findings per tool, categories only. An empty array means the server may be installed. */
export function scanMcpTools(tools: readonly McpToolInfo[]): McpScanFinding[] {
  const findings: McpScanFinding[] = [];
  for (const tool of tools) {
    const categories = new Set<string>();
    for (const text of toolInstructionStrings(tool)) for (const reason of SecurityScan.scan(text).findings) categories.add(reason);
    if (categories.size) findings.push({ tool: tool.name, categories: [...categories].sort() });
  }
  return findings;
}

/** Same rename the prompt redactor applies, so a reader sees one vocabulary of kinds. */
const KIND_BY_RULE: Readonly<Record<string, string>> = { "provider-key": "api-key", pem: "private-key" };
/** The one heuristic rule (any 40+ char alphanumeric run) that is noise, not a secret kind, in a tool result. */
const RESULT_SCRUB_SKIPS: ReadonlySet<string> = new Set(["base64-run"]);

class Counter {
  readonly #next = new Map<string, number>();
  readonly #counts = new Map<string, number>();

  token(kind: string): string {
    const index = (this.#next.get(kind) ?? 0) + 1;
    this.#next.set(kind, index);
    this.#counts.set(kind, (this.#counts.get(kind) ?? 0) + 1);
    return redactionToken(kind, index);
  }

  hits(): RedactionHit[] {
    return [...this.#counts.entries()].map(([kind, count]) => ({ kind, count }));
  }
}

/** Masks secret-shaped runs in a tool result; PII stays. */
export function scrubMcpResult(text: string): RedactedText {
  const counter = new Counter();
  let out = text;
  for (const rule of secretDetectors()) {
    if (RESULT_SCRUB_SKIPS.has(rule.name)) continue;
    const kind = KIND_BY_RULE[rule.name] ?? rule.name;
    const single = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", ""));
    out = out.replace(rule.pattern, (match: string) => match.replace(single, rule.replacement.replace(REDACTED_SECRET, counter.token(kind))));
  }
  // The error layer's floor, as in both other redactors: a token it calls a secret never gets out.
  out = out.replace(/\S+/g, (token) => (errorLayerRedact(token) === token ? token : counter.token("secret")));
  return { text: out, hits: counter.hits() };
}
