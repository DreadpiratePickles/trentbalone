import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import {
  buildDeliverable,
  DELIVERABLE_FORMATS,
  type DeliverableContent,
  type DeliverableFormat,
  type DeliverableSection,
  type DeliverableTable,
} from "@/lib/deliverable-builder";

const ADAPTER_NAME = "Deliverables";
const CREATE_ACTIONS = ["create", "generate", "render", "export", "build", "deliver"];
// Tool summaries flow into traces, the audit log, and back into the agent's
// own context — so never inline an unbounded artifact. Small reports/CSVs pass
// through whole; large HTML decks are clipped with a clear marker.
const MAX_INLINE_CHARS = 16_000;

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: ADAPTER_NAME, action, status: "failed", summary };
}

function parseFormat(value: unknown): DeliverableFormat | undefined {
  return typeof value === "string" && (DELIVERABLE_FORMATS as string[]).includes(value)
    ? (value as DeliverableFormat)
    : undefined;
}

function parseSections(value: unknown): DeliverableSection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value.flatMap((item): DeliverableSection[] => {
    if (!item || typeof item !== "object") return [];
    const s = item as Record<string, unknown>;
    if (typeof s.heading !== "string") return [];
    return [{
      heading: s.heading,
      body: typeof s.body === "string" ? s.body : undefined,
      bullets: Array.isArray(s.bullets) ? s.bullets.filter((b): b is string => typeof b === "string") : undefined,
    }];
  });
  return sections.length ? sections : undefined;
}

function parseTable(value: unknown): DeliverableTable | undefined {
  if (!value || typeof value !== "object") return undefined;
  const t = value as Record<string, unknown>;
  if (!Array.isArray(t.columns) || !Array.isArray(t.rows)) return undefined;
  const columns = t.columns.filter((c): c is string => typeof c === "string");
  if (!columns.length) return undefined;
  const rows = t.rows
    .filter((r): r is Array<string | number> => Array.isArray(r))
    .map((r) => r.map((c) => (typeof c === "number" ? c : String(c ?? ""))));
  return { columns, rows };
}

function parseContent(value: unknown): DeliverableContent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const c = value as Record<string, unknown>;
  if (typeof c.title !== "string" || !c.title.trim()) return undefined;
  return {
    title: c.title.trim(),
    subtitle: typeof c.subtitle === "string" ? c.subtitle : undefined,
    sections: parseSections(c.sections),
    table: parseTable(c.table),
  };
}

/**
 * Lets agents produce real native deliverables (Markdown report, styled HTML
 * report, HTML slide deck, or Excel-ready CSV) from structured content, so a
 * cycle can hand back a downloadable artifact rather than just chat text — the
 * Viktor "native outputs" edge. Pure/in-process: no credentials, no external
 * calls, no money, never approval-gated. The rendered artifact can then be
 * delivered via the Slack/Email adapters.
 */
export function createDeliverablesAdapter(): ToolAdapter {
  return {
    name: ADAPTER_NAME,
    scopes: ["deliverable:create", "artifact:render"],
    availability: "real",
    async healthCheck() {
      return "connected";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval() {
      return false;
    },
    async execute(action, payload): Promise<ToolCallRecord> {
      if (!CREATE_ACTIONS.some((word) => action.toLowerCase().includes(word))) {
        return failed(action, `Unsupported Deliverables action "${action}". Supported: ${CREATE_ACTIONS.join(", ")}.`);
      }
      const format = parseFormat(payload.format);
      if (!format) {
        return failed(action, `Deliverables requires payload.format ∈ {${DELIVERABLE_FORMATS.join(", ")}}.`);
      }
      const content = parseContent(payload.content);
      if (!content) {
        return failed(action, "Deliverables requires payload.content with at least a title.");
      }
      try {
        const deliverable = buildDeliverable(format, content);
        const bytes = Buffer.byteLength(deliverable.content, "utf8");
        const inline = deliverable.content.length > MAX_INLINE_CHARS
          ? `${deliverable.content.slice(0, MAX_INLINE_CHARS)}\n…[truncated ${deliverable.content.length - MAX_INLINE_CHARS} chars — full ${bytes}-byte artifact was rendered]`
          : deliverable.content;
        return {
          adapter: ADAPTER_NAME,
          action,
          status: "completed",
          summary: `Built ${format} deliverable "${deliverable.filename}" (${bytes} bytes). Deliver it via Slack/Email or attach to the cycle.\n\n${inline}`,
        };
      } catch (err: unknown) {
        return failed(action, (err as Error).message);
      }
    },
    async dryRun(action, payload) {
      const format = typeof payload.format === "string" ? payload.format : "(format)";
      return {
        adapter: ADAPTER_NAME,
        action,
        status: "mocked",
        summary: `Deliverables dry-run: Trent would render a ${format} artifact.`,
      };
    },
  };
}
