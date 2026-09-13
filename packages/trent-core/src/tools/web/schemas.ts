/** Hermes's `web_search` and `web_extract` schemas, as data so the seat prompt can render them. */

/**
 * A JSON-schema-shaped description of one tool. Shared by the web, memory, skills and cron
 * toolsets (type-only imports); the wiring layer may hoist it to `tools/schema.ts`.
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Render schemas as the `<tool> <json>` usage block appended to a seat's tool instructions. */
export function renderToolInstructions(schemas: readonly ToolSchema[]): string {
  return schemas
    .map((s) => {
      const params = Object.entries(s.parameters.properties)
        .map(([k, v]) => {
          const d = v as { type?: string; description?: string; enum?: string[] };
          const req = s.parameters.required?.includes(k) ? ", required" : "";
          const en = d.enum ? ` one of ${d.enum.join("|")}` : "";
          return `    ${k} (${d.type ?? "any"}${req})${en}${d.description ? `: ${d.description}` : ""}`;
        })
        .join("\n");
      return `${s.name}: ${s.description}\n  action = "${s.name} {\"...\"}" with JSON keys:\n${params}`;
    })
    .join("\n\n");
}

export const WEB_EXTRACT_DEFAULT_CHARS = 15_000;
export const WEB_EXTRACT_MIN_CHARS = 2_000;
export const WEB_EXTRACT_MAX_URLS = 5;
export const WEB_SEARCH_MAX_LIMIT = 100;
export const WEB_SEARCH_DEFAULT_LIMIT = 5;

export const WEB_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "web_search",
    description:
      "Search the live web. Returns ranked results with title, url and a content snippet, plus a " +
      "synthesised answer when the provider offers one. Read-only; never needs approval.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: {
          type: "integer",
          description: `Maximum results to return (1-${WEB_SEARCH_MAX_LIMIT}, default ${WEB_SEARCH_DEFAULT_LIMIT}).`,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_extract",
    description:
      "Fetch up to five public http(s) URLs and return their readable text as markdown. Output is " +
      `capped at char_limit (default ${WEB_EXTRACT_DEFAULT_CHARS}) with a 75/25 head/tail split; the ` +
      "full text is saved to a file you can page through with read_file. Private, loopback and " +
      "cloud-metadata addresses are always refused.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: `Absolute http(s) URLs, at most ${WEB_EXTRACT_MAX_URLS}.`,
        },
        char_limit: {
          type: "integer",
          description: `Characters to return per page, at least ${WEB_EXTRACT_MIN_CHARS}.`,
        },
      },
      required: ["urls"],
    },
  },
];
