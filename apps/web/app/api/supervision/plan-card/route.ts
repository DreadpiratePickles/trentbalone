import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { createPreActionPlanCard } from "@/lib/supervision/plan-card";
import type { SupervisionSideEffect } from "@/lib/supervision/risk";
import { withRlsContext } from "@/lib/with-rls";

const allowedSideEffects: SupervisionSideEffect[] = [
  "internal_state_change",
  "external_api_call",
  "spends_money",
  "publishes_content",
  "sends_message",
  "changes_permissions",
  "deploys_code",
  "delete_data",
];

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = parseBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: parsed.value.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.value.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(parsed.value.companyId, async () => {
    const company = await store.getCompany(parsed.value.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const planCard = createPreActionPlanCard({ ...parsed.value, actorId: user.id, companyId: company.id });
    return NextResponse.json({ planCard }, { status: 201 });
  });
}

function parseBody(body: unknown):
  | { ok: true; value: Parameters<typeof createPreActionPlanCard>[0] }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Request body is required" };
  const record = body as Record<string, unknown>;
  const companyId = requiredString(record.companyId);
  const action = requiredString(record.action);
  const objectType = requiredString(record.objectType);
  const objectId = requiredString(record.objectId);
  const reason = requiredString(record.reason);
  const estimatedCostCents = integerValue(record.estimatedCostCents);
  const dryRun = parseDryRun(record.dryRun);
  const sideEffects = parseSideEffects(record.sideEffects);

  if (!companyId || !action || !objectType || !objectId || !reason) {
    return { ok: false, error: "companyId, action, objectType, objectId, and reason are required" };
  }
  if (estimatedCostCents === undefined || estimatedCostCents < 0) {
    return { ok: false, error: "estimatedCostCents must be a non-negative integer" };
  }
  if (!dryRun) return { ok: false, error: "dryRun.summary and dryRun.operations are required" };
  if (!sideEffects) return { ok: false, error: "sideEffects contains an unsupported value" };

  return {
    ok: true,
    value: {
      companyId,
      actorId: "pending_auth",
      action,
      objectType,
      objectId,
      reason,
      estimatedCostCents,
      sideEffects,
      dryRun,
    },
  };
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integerValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function parseDryRun(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const summary = requiredString(record.summary);
  if (!summary || !Array.isArray(record.operations)) return undefined;
  const operations = record.operations.map(requiredString);
  if (operations.some((operation) => !operation)) return undefined;
  return { summary, operations: operations as string[] };
}

function parseSideEffects(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const sideEffects = value.map(requiredString);
  if (sideEffects.some((effect) => !effect || !allowedSideEffects.includes(effect as SupervisionSideEffect))) {
    return undefined;
  }
  return sideEffects as SupervisionSideEffect[];
}
