import type { McpServerRecord } from "@/lib/mcp-store";

export type McpServerRank = {
  server: McpServerRecord;
  score: number;
  matchedTerms: string[];
};

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "to", "for", "of", "in", "on", "with", "by", "from", "this", "that",
  "do", "run", "make", "daily", "operator", "sweep",
]);

export function rankMcpServersForTask(
  servers: McpServerRecord[],
  query: string,
  options: { limit?: number } = {},
): McpServerRank[] {
  const limit = Math.max(1, options.limit ?? 4);
  const queryTerms = tokenize(query);
  const ranked = servers
    .filter((server) => server.enabled && server.status === "connected")
    .map((server) => rankServer(server, queryTerms))
    .sort((a, b) => b.score - a.score || b.server.discoveredTools.length - a.server.discoveredTools.length || a.server.name.localeCompare(b.server.name));

  const positive = ranked.filter((item) => item.score > 0);
  return (positive.length ? positive : ranked).slice(0, limit);
}

function rankServer(server: McpServerRecord, queryTerms: string[]): McpServerRank {
  const nameText = normalizeText(server.name);
  const toolText = normalizeText(server.discoveredTools.map((tool) => [
    tool.name,
    tool.title ?? "",
    tool.description,
    JSON.stringify(tool.annotations ?? {}),
  ].join(" ")).join(" "));
  const urlText = normalizeText(server.url);
  const matchedTerms: string[] = [];
  let score = 0;
  let firstMatchIndex = Number.POSITIVE_INFINITY;

  for (const [index, term] of queryTerms.entries()) {
    if (nameText.includes(term)) {
      score += 4;
      matchedTerms.push(term);
      firstMatchIndex = Math.min(firstMatchIndex, index);
    }
    if (toolText.includes(term)) {
      score += 2;
      if (!matchedTerms.includes(term)) matchedTerms.push(term);
      firstMatchIndex = Math.min(firstMatchIndex, index);
    }
    if (urlText.includes(term)) {
      score += 1;
      if (!matchedTerms.includes(term)) matchedTerms.push(term);
      firstMatchIndex = Math.min(firstMatchIndex, index);
    }
  }

  if (Number.isFinite(firstMatchIndex)) score += (queryTerms.length - firstMatchIndex) / 100;
  if (score === 0 && server.discoveredTools.length) score = 0.1;
  return { server, score, matchedTerms };
}

function tokenize(value: string): string[] {
  return Array.from(new Set(normalizeText(value).split(/\s+/).filter((term) => term.length > 2 && !STOP_WORDS.has(term))));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
