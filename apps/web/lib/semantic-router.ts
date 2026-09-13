/**
 * Semantic routing — embedding-based seat/tool selection with regex fallback.
 * One embedder caches seat + tool catalog vectors at boot; per-query vectors are ephemeral.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { SEAT_MANIFESTS, getSeatManifest } from "@/lib/seat-manifest";
import { adapters, onAdapterRegistryChange, type ToolAdapter } from "@/lib/tools";
import { store } from "@/lib/store";
import type { AgentRole, Document } from "@/lib/types";
import type { AgentEnvironmentConfig } from "@/lib/types";

const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EMBED_DIM = 384;
export const ROUTING_SIMILARITY_THRESHOLD = Number(process.env.SEMANTIC_ROUTING_THRESHOLD ?? "0.42");
export const DEFAULT_MEMORY_TOKEN_BUDGET = 1200;
const DEFAULT_TOOL_TOP_K = 3;

type EmbedFn = (texts: string[]) => Promise<number[][]>;

let testEmbedder: EmbedFn | null = null;
let seatCatalog: Array<{ role: AgentRole; text: string; vector: number[] }> | null = null;
let toolCatalog: Array<{ name: string; adapter: ToolAdapter; text: string; vector: number[] }> | null = null;
let sharedVocab: string[] | null = null;
let idfByToken: Map<string, number> | null = null;

export function setSemanticRouterEmbedderForTests(fn: EmbedFn | null) {
  testEmbedder = fn;
}

export function resetSemanticRouterForTests() {
  seatCatalog = null;
  toolCatalog = null;
  sharedVocab = null;
  idfByToken = null;
}
// Externally registered adapters (file_ops, terminal) must enter the catalog: rebuild it on the next route.
onAdapterRegistryChange(() => { toolCatalog = null; sharedVocab = null; idfByToken = null; });

function stemLite(word: string): string {
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("tion") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ly") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 4) return word.slice(0, -1);
  return word;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map(stemLite);
}

function normalizeVector(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function buildLexicalIndex(texts: string[]) {
  const df = new Map<string, number>();
  for (const text of texts) {
    const seen = new Set(tokenize(text));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const vocab = [...df.keys()].sort();
  const idf = new Map<string, number>();
  const n = texts.length || 1;
  for (const [t, count] of df) idf.set(t, Math.log(1 + n / (1 + count)));
  return { vocab, idf };
}

function lexicalVector(text: string, vocab: string[], idf: Map<string, number>): number[] {
  const tf = new Map<string, number>();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  const vec = vocab.map((term) => {
    const freq = tf.get(term) ?? 0;
    if (!freq) return 0;
    return (1 + Math.log(freq)) * (idf.get(term) ?? 1);
  });
  return normalizeVector(vec);
}

async function embedMany(texts: string[]): Promise<number[][]> {
  if (testEmbedder) return testEmbedder(texts);
  if (process.env.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL || undefined,
        timeout: 30_000,
      });
      const resp = await client.embeddings.create({ model: EMBED_MODEL, input: texts });
      return resp.data.map((d) => {
        const v = (d.embedding as unknown as number[]).slice(0, EMBED_DIM);
        return normalizeVector(v);
      });
    } catch {
      /* fall through to lexical */
    }
  }
  if (!sharedVocab || !idfByToken) {
    const corpus = collectRoutingCorpusTexts();
    const { vocab, idf } = buildLexicalIndex(corpus);
    sharedVocab = vocab;
    idfByToken = idf;
  }
  return texts.map((t) => lexicalVector(t, sharedVocab!, idfByToken!));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

function buildSeatRoutingText(role: AgentRole): string {
  const m = getSeatManifest(role);
  return [
    m.role,
    m.name,
    m.whenToUse,
    m.whenNotToUse,
    m.methodology,
    m.toolUseStrategy,
    m.contextNeeds.join(" "),
    m.outputContract.join(" "),
    m.evalRubric.join(" "),
    m.tools.map((t) => `${t.name} ${t.purpose} ${t.description}`).join(" "),
  ].join("\n");
}

function buildToolRoutingText(adapter: ToolAdapter): string {
  const manifestBits = Object.values(SEAT_MANIFESTS).flatMap((seat) =>
    seat.tools
      .filter(
        (t) =>
          t.name.replace(/_/g, " ").toLowerCase().includes(adapter.name.toLowerCase().slice(0, 6))
          || adapter.name.toLowerCase().includes(t.name.replace(/_/g, " ").slice(0, 6)),
      )
      .map((t) => `${t.purpose} ${t.description} ${t.actions.join(" ")}`),
  );
  const routingText = (adapter as { routingText?: unknown }).routingText;
  return [adapter.name, adapter.scopes.join(" "), ...(typeof routingText === "string" ? [routingText] : []), ...manifestBits].join("\n");
}

function collectRoutingCorpusTexts(): string[] {
  const roles = Object.keys(SEAT_MANIFESTS) as AgentRole[];
  return [...roles.map(buildSeatRoutingText), ...adapters.map(buildToolRoutingText)];
}

async function ensureSeatCatalog() {
  if (seatCatalog) return;
  const roles = Object.keys(SEAT_MANIFESTS) as AgentRole[];
  const texts = roles.map(buildSeatRoutingText);
  const vectors = await embedMany(texts);
  seatCatalog = roles.map((role, i) => ({ role, text: texts[i], vector: vectors[i] }));
}

async function ensureToolCatalog() {
  if (toolCatalog) return;
  const texts = adapters.map(buildToolRoutingText);
  const vectors = await embedMany(texts);
  toolCatalog = adapters.map((adapter, i) => ({
    name: adapter.name,
    adapter,
    text: texts[i],
    vector: vectors[i],
  }));
}

async function rankByEmbedding<T extends { vector: number[] }>(
  query: string,
  entries: T[],
): Promise<Array<{ item: T; score: number }>> {
  const [queryVec] = await embedMany([query]);
  return entries
    .map((entry) => ({ item: entry, score: cosineSimilarity(queryVec, entry.vector) }))
    .sort((a, b) => b.score - a.score);
}

/** Existing regex capability routing — kept for fallback and tests. */
export function capabilityToRoleRegex(capability: string): AgentRole | null {
  const c = capability.toLowerCase();
  if (/\b(set-okrs-goals|setting-okrs|gtm-operating-cadence|board-and-investor)\b/.test(c)) return null;
  if (c.includes("code") || c.includes("github") || c.includes("engineer") || c.includes("test") || c.includes("build") || c.includes("deploy") || c.includes("pull request")) return "engineer";
  if (c.includes("hyperframes") || c.includes("open generative") || c.includes("growth") || c.includes("ad") || c.includes("campaign") || c.includes("acquisition") || c.includes("experiment")) return "growth";
  if (c.includes("sales") || c.includes("pipeline") || c.includes("prospect") || c.includes("outreach") || c.includes("lead")) return "sales";
  if (c.includes("content") || c.includes("copy") || c.includes("post") || c.includes("blog") || c.includes("email") || c.includes("design")) return "content";
  if (c.includes("support") || c.includes("ticket") || c.includes("customer")) return "support";
  if (c.includes("fincept") || c.includes("ghostfolio") || c.includes("finance") || c.includes("billing") || c.includes("invoice") || c.includes("budget") || c.includes("spend")) return "finance";
  if (c.includes("camofox") || c.includes("steel") || c.includes("browser") || c.includes("web") || c.includes("scrape") || c.includes("screenshot") || c.includes("analys") || c.includes("metric") || c.includes("data") || c.includes("report") || c.includes("research")) return "analyst";
  if (c.includes("escalat") || c.includes("audit") || c.includes("human") || c.includes("approve")) return "escalation";
  return null;
}

export async function routeCapabilityToRole(capability: string): Promise<AgentRole | null> {
  const trimmed = capability.trim();
  if (!trimmed) return null;
  if (/\b(set-okrs-goals|setting-okrs|gtm-operating-cadence|board-and-investor)\b/i.test(trimmed)) return null;

  await ensureSeatCatalog();
  const ranked = await rankByEmbedding(
    trimmed,
    seatCatalog!.map(({ role, vector }) => ({ role, vector })),
  );
  const best = ranked[0];
  if (best && best.score >= ROUTING_SIMILARITY_THRESHOLD && best.item.role !== "ceo") {
    return best.item.role;
  }
  return capabilityToRoleRegex(trimmed);
}

function toolForStepRegex(
  stepText: string,
  environment: Pick<AgentEnvironmentConfig, "tools">,
): ToolAdapter | undefined {
  const allowedTools = new Set(environment.tools);
  const haystack = stepText.toLowerCase();
  return adapters.find(
    (adapter) => toolAllowed(adapter, allowedTools) && (
      haystack.includes(adapter.name.toLowerCase())
      || adapter.scopes.some((scope) => isSpecificScopeAlias(scope) && haystack.includes(scope.toLowerCase()))
    ),
  );
}

function isSpecificScopeAlias(scope: string) {
  return scope.includes(":") || scope.length >= 8;
}

function toolAllowed(adapter: ToolAdapter, allowedTools: ReadonlySet<string>) {
  return allowedTools.has(adapter.name) || adapter.scopes.some((scope) => allowedTools.has(scope));
}

export async function routeToolsForStep(
  stepText: string,
  environment: Pick<AgentEnvironmentConfig, "tools">,
  k = DEFAULT_TOOL_TOP_K,
  opts: { degradedTools?: ReadonlySet<string> } = {},
): Promise<ToolAdapter[]> {
  const allowed = new Set(environment.tools);
  await ensureToolCatalog();
  let eligible = toolCatalog!.filter((entry) => toolAllowed(entry.adapter, allowed));
  if (!eligible.length) return [];

  // Health-aware grounding (OpenSpace quality-monitor → tool selection): avoid
  // tools the degradation cascade flagged as failing, but only when a healthy
  // alternative survives — never strand a step with no tool to call.
  const degraded = opts.degradedTools;
  if (degraded && degraded.size > 0) {
    const healthy = eligible.filter((entry) => !degraded.has(entry.name));
    if (healthy.length > 0) eligible = healthy;
  }

  const ranked = await rankByEmbedding(
    stepText,
    eligible.map(({ adapter, vector, name }) => ({ adapter, vector, name })),
  );
  if (ranked[0]?.score >= ROUTING_SIMILARITY_THRESHOLD) {
    return ranked.slice(0, k).map((r) => r.item.adapter);
  }

  // Regex fallback must also respect tool health — don't hand back a known-broken
  // tool just because it matched a keyword.
  const regexMatch = toolForStepRegex(stepText, environment);
  if (regexMatch && degraded?.has(regexMatch.name) && eligible.length > 0) {
    return [eligible[0].adapter];
  }
  return regexMatch ? [regexMatch] : [];
}

export async function toolForStepSemantic(
  stepText: string,
  environment: Pick<AgentEnvironmentConfig, "tools">,
): Promise<ToolAdapter | undefined> {
  const tools = await routeToolsForStep(stepText, environment, 1);
  return tools[0];
}

type MemoryTierClass = "episodic" | "weekly_report" | "misc";

function classifyMemoryTier(doc: Document): MemoryTierClass {
  if (doc.memoryTier === "episodic") return "episodic";
  if (doc.type === "weekly_report") return "weekly_report";
  return "misc";
}

const TIER_WEIGHT: Record<MemoryTierClass, number> = {
  episodic: 1.25,
  weekly_report: 1.0,
  misc: 0.85,
};

export type RecalledMemoryItem = {
  id: string;
  title: string;
  type: string;
  tier: MemoryTierClass;
  tierWeight: number;
  score: number;
  snippet: string;
};

export type RecalledMemory = {
  text: string;
  items: RecalledMemoryItem[];
  estimatedTokens: number;
};

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function memoryDocText(doc: Document): string {
  return `[${doc.type}${doc.memoryTier ? `/${doc.memoryTier}` : ""}] ${doc.title}: ${doc.content}`;
}

export async function recallRelevantMemory(
  companyId: string,
  objective: string,
  opts?: { k?: number; tokenBudget?: number },
): Promise<RecalledMemory> {
  const k = opts?.k ?? 5;
  const tokenBudget = opts?.tokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET;
  const documents = await store.listDocuments(companyId).catch(() => []);
  if (!documents.length || !objective.trim()) {
    return { text: "", items: [], estimatedTokens: 0 };
  }

  const texts = documents.map(memoryDocText);
  const vectors = await embedMany(texts);
  const [queryVec] = await embedMany([objective]);

  const scored = documents
    .map((doc, i) => {
      const tier = classifyMemoryTier(doc);
      const base = cosineSimilarity(queryVec, vectors[i]);
      const score = base * TIER_WEIGHT[tier];
      return { doc, tier, score, snippet: memoryDocText(doc) };
    })
    .sort((a, b) => b.score - a.score);

  const items: RecalledMemoryItem[] = [];
  const lines: string[] = [];
  let tokens = 0;

  for (const entry of scored) {
    if (items.length >= k) break;
    const line = entry.snippet.slice(0, 480);
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > tokenBudget) break;
    items.push({
      id: entry.doc.id,
      title: entry.doc.title,
      type: entry.doc.type,
      tier: entry.tier,
      tierWeight: TIER_WEIGHT[entry.tier],
      score: entry.score,
      snippet: line,
    });
    lines.push(line);
    tokens += lineTokens;
  }

  return {
    text: lines.join("\n"),
    items,
    estimatedTokens: tokens,
  };
}

/** Warm seat + tool catalogs — call at process boot when convenient. */
export async function warmSemanticRouterCatalogs(): Promise<void> {
  await Promise.all([ensureSeatCatalog(), ensureToolCatalog()]);
}
