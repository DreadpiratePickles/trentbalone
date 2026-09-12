import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";
import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type AttioCrmAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
};

type AttioObjectSummary = {
  api_slug?: string;
  singular_noun?: string;
  plural_noun?: string;
};

type AttioRecordSummary = {
  id?: { record_id?: string };
  values?: Record<string, unknown>;
};

const ATTIO_BASE = "https://api.attio.com/v2";
const WRITE_ACTION_RE = /\b(create|update|delete|patch|sync|import|export|merge|archive|write|outbound|send)\b/i;

export function createAttioCrmAdapter(options: AttioCrmAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: "Attio CRM",
    scopes: ["crm:read", "crm:search", "attio:objects:read", "attio:records:read"],
    availability: "real",
    async healthCheck() {
      const token = attioToken(env);
      return token && isHttpHeaderValueSafe(token) ? "connected" : "needs_credentials";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return WRITE_ACTION_RE.test(action);
    },
    async execute(action, payload) {
      const token = attioToken(env);
      if (!token) {
        return failed(action, "Attio CRM is not configured. Set ATTIO_TOKEN before agents can read real CRM data.");
      }
      if (!isHttpHeaderValueSafe(token)) {
        return failed(action, malformedCredentialSummary("Attio token"));
      }
      if (WRITE_ACTION_RE.test(action)) {
        return failed(action, "Attio CRM adapter is read-only in this agent tool path. CRM writes must use approval-gated draft/update flows.");
      }

      try {
        const objects = await attioGetObjects(fetchImpl, token);
        const objectSlug = requestedObjectSlug(action, payload, objects);
        const records = objectSlug
          ? await attioQueryRecords(fetchImpl, token, objectSlug, boundedLimit(payload.limit))
          : [];
        return {
          adapter: "Attio CRM",
          action,
          status: "completed",
          summary: summarizeAttioSnapshot(objects, objectSlug, records),
        };
      } catch (error) {
        return failed(action, `Attio CRM read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async dryRun(action) {
      return {
        adapter: "Attio CRM",
        action,
        status: WRITE_ACTION_RE.test(action) ? "needs_approval" : "mocked",
        summary: "Attio CRM dry-run: Trent would read CRM objects and selected records without writing to Attio.",
      };
    },
  };
}

export function summarizeAttioSnapshot(
  objects: AttioObjectSummary[],
  objectSlug: string | undefined,
  records: AttioRecordSummary[],
) {
  const objectLabels = objects
    .map((object) => objectLabel(object))
    .filter((label): label is string => Boolean(label))
    .slice(0, 8);
  const lines = [
    `${objects.length} Attio object${objects.length === 1 ? "" : "s"} available${objectLabels.length ? `: ${objectLabels.join(", ")}` : ""}.`,
  ];
  if (objectSlug) {
    const samples = records.map(recordDisplayName).filter((name): name is string => Boolean(name)).slice(0, 5);
    lines.push(`${objectSlug}: ${records.length} record${records.length === 1 ? "" : "s"} returned${samples.length ? `; samples: ${samples.join(", ")}` : ""}.`);
  }
  return lines.join(" ");
}

async function attioGetObjects(fetchImpl: FetchLike, token: string) {
  const response = await fetchImpl(`${ATTIO_BASE}/objects`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(body) || `HTTP ${response.status}`);
  }
  return arrayBody(body, "data").filter(isAttioObjectSummary);
}

async function attioQueryRecords(fetchImpl: FetchLike, token: string, objectSlug: string, limit: number) {
  const response = await fetchImpl(`${ATTIO_BASE}/objects/${encodeURIComponent(objectSlug)}/records/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ limit }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(body) || `HTTP ${response.status}`);
  }
  return arrayBody(body, "data").filter(isAttioRecordSummary);
}

function requestedObjectSlug(
  action: string,
  payload: Record<string, unknown>,
  objects: AttioObjectSummary[],
) {
  const explicit = typeof payload.object === "string" ? payload.object : typeof payload.objectSlug === "string" ? payload.objectSlug : undefined;
  const candidate = normalizeObjectSlug(explicit)
    ?? objects.map((object) => object.api_slug).find((slug) => slug && action.toLowerCase().includes(slug.toLowerCase()));
  return candidate;
}

function normalizeObjectSlug(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error(`Unsupported Attio object slug "${trimmed}".`);
  }
  return trimmed;
}

function boundedLimit(value: unknown) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 10;
  return Math.min(50, Math.max(1, parsed));
}

function attioToken(env: EnvLike = process.env) {
  return firstNonEmpty(env.ATTIO_TOKEN, env.ATTIO_API_KEY);
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function arrayBody(body: unknown, key: string) {
  if (typeof body !== "object" || body === null) return [];
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function isAttioObjectSummary(item: unknown): item is AttioObjectSummary {
  return typeof item === "object" && item !== null;
}

function isAttioRecordSummary(item: unknown): item is AttioRecordSummary {
  return typeof item === "object" && item !== null;
}

function objectLabel(object: AttioObjectSummary) {
  return object.plural_noun || object.singular_noun || object.api_slug;
}

function recordDisplayName(record: AttioRecordSummary) {
  const values = record.values ?? {};
  for (const key of ["name", "company_name", "full_name", "title"]) {
    const value = safeValue(values[key]);
    if (value) return value;
  }
  return record.id?.record_id;
}

function safeValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (typeof item === "object" && item !== null) {
      const record = item as Record<string, unknown>;
      for (const key of ["value", "name", "title"]) {
        const nested = record[key];
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      }
    }
  }
  return undefined;
}

function errorMessage(body: unknown) {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    if (typeof record.detail === "string") return record.detail;
  }
  return undefined;
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: "Attio CRM", action, status: "failed", summary };
}
