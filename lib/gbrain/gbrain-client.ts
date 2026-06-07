import { decryptJson } from "@/lib/secrets";
import { store } from "@/lib/store";

// GBrain is a per-company sidecar that stores mission memory and answers recall
// and advisory pings. It advises; it never executes actions or bypasses approvals.

export type GbrainConnectionSource = "company" | "env" | "missing";

export type GbrainConnection = {
  source: GbrainConnectionSource;
  baseUrl?: string;
  apiKey?: string;
};

export type GbrainHttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type GbrainFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<GbrainHttpResponse>;

export type GbrainCitation = { id: string; title: string; excerpt?: string };

export type GbrainIngestInput = {
  companyId: string;
  runId: string;
  title: string;
  content: string;
  source: string;
  tags?: string[];
};

export type GbrainIngestResult = {
  status: "ingested" | "not_connected" | "error";
  source: "sidecar" | "none";
  documentId?: string;
  detail?: string;
};

export type GbrainRecallInput = {
  companyId: string;
  query: string;
  limit?: number;
};

export type GbrainRecallResult = {
  status: "ok" | "not_connected" | "error";
  source: "sidecar" | "local" | "none";
  answer: string;
  citations: GbrainCitation[];
  gaps: string[];
  detail?: string;
};

export type GbrainAdviseInput = {
  companyId: string;
  objective: string;
  question: string;
  context?: string;
};

export type GbrainAdviseResult = {
  status: "ok" | "not_connected" | "error";
  source: "sidecar" | "none";
  guidance: string;
  suggestedNextStep?: string;
  clarifyingQuestions: string[];
  detail?: string;
};

export type GbrainClient = {
  connected: boolean;
  ingest(input: GbrainIngestInput): Promise<GbrainIngestResult>;
  recall(input: GbrainRecallInput): Promise<GbrainRecallResult>;
  advise(input: GbrainAdviseInput): Promise<GbrainAdviseResult>;
};

export const GBRAIN_PROVIDER = "GBrain";

type GbrainCredentials = { baseUrl?: string; apiKey?: string };

export async function resolveGbrainConnection(companyId: string): Promise<GbrainConnection> {
  const integration = await store.getIntegration(companyId, GBRAIN_PROVIDER);
  if (integration?.status === "connected" && integration.encryptedData) {
    const credentials = safeDecrypt(integration.encryptedData);
    if (credentials?.baseUrl) {
      return { source: "company", baseUrl: credentials.baseUrl, apiKey: credentials.apiKey };
    }
  }

  const envUrl = process.env.GBRAIN_URL?.trim();
  if (envUrl) {
    return { source: "env", baseUrl: envUrl, apiKey: process.env.GBRAIN_API_KEY?.trim() };
  }

  return { source: "missing" };
}

export function createGbrainClient(connection: GbrainConnection, fetchImpl?: GbrainFetch): GbrainClient {
  const baseUrl = connection.baseUrl?.replace(/\/+$/, "");
  const connected = Boolean(baseUrl);
  const doFetch = fetchImpl ?? defaultFetch;

  async function post(path: string, payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
    const response = await doFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, status: response.status, data };
  }

  return {
    connected,
    async ingest(input) {
      if (!connected) return { status: "not_connected", source: "none" };
      try {
        const { ok, data } = await post("/ingest", {
          companyId: input.companyId,
          runId: input.runId,
          title: input.title,
          content: input.content,
          source: input.source,
          tags: input.tags ?? [],
        });
        if (!ok) return { status: "error", source: "sidecar", detail: "GBrain ingest returned a non-2xx response." };
        return { status: "ingested", source: "sidecar", documentId: typeof data.documentId === "string" ? data.documentId : undefined };
      } catch (error) {
        return { status: "error", source: "sidecar", detail: sanitize(error, connection.apiKey) };
      }
    },
    async recall(input) {
      if (!connected) return { status: "not_connected", source: "none", answer: "", citations: [], gaps: [] };
      try {
        const { ok, data } = await post("/recall", { companyId: input.companyId, query: input.query, limit: input.limit ?? 5 });
        if (!ok) {
          return { status: "error", source: "sidecar", answer: "", citations: [], gaps: [], detail: "GBrain recall returned a non-2xx response." };
        }
        return {
          status: "ok",
          source: "sidecar",
          answer: typeof data.answer === "string" ? data.answer : "",
          citations: Array.isArray(data.citations) ? (data.citations as GbrainCitation[]) : [],
          gaps: Array.isArray(data.gaps) ? (data.gaps as string[]) : [],
        };
      } catch (error) {
        return { status: "error", source: "sidecar", answer: "", citations: [], gaps: [], detail: sanitize(error, connection.apiKey) };
      }
    },
    async advise(input) {
      if (!connected) return { status: "not_connected", source: "none", guidance: "", clarifyingQuestions: [] };
      try {
        const { ok, data } = await post("/advise", {
          companyId: input.companyId,
          objective: input.objective,
          question: input.question,
          context: input.context ?? "",
        });
        if (!ok) {
          return { status: "error", source: "sidecar", guidance: "", clarifyingQuestions: [], detail: "GBrain advise returned a non-2xx response." };
        }
        return {
          status: "ok",
          source: "sidecar",
          guidance: typeof data.guidance === "string" ? data.guidance : "",
          suggestedNextStep: typeof data.suggestedNextStep === "string" ? data.suggestedNextStep : undefined,
          clarifyingQuestions: Array.isArray(data.clarifyingQuestions) ? (data.clarifyingQuestions as string[]) : [],
        };
      } catch (error) {
        return { status: "error", source: "sidecar", guidance: "", clarifyingQuestions: [], detail: sanitize(error, connection.apiKey) };
      }
    },
  };
}

const defaultFetch: GbrainFetch = async (url, init) => {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status, json: () => response.json() };
};

function safeDecrypt(encrypted: string): GbrainCredentials | undefined {
  try {
    return decryptJson<GbrainCredentials>(encrypted);
  } catch {
    return undefined;
  }
}

function sanitize(error: unknown, apiKey?: string): string {
  let message = error instanceof Error ? error.message : "GBrain request failed.";
  if (apiKey && apiKey.length >= 4) {
    message = message.split(apiKey).join("[REDACTED]");
  }
  return message;
}
