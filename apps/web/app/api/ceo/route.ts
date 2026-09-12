import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { ceoChatResponse, generalChatResponse } from "@/lib/ai";
import { buildArtifactDraft, inferArtifactRequest } from "@/lib/artifacts";
import { normalizeCeoChatMode } from "@/lib/ceo-chat-mode";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";

// GET /api/ceo?companyId=xxx — load messages and suggestions
export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const [messages, suggestions, artifacts] = await Promise.all([
    store.listCeoMessages(companyId),
    store.listCeoSuggestions(companyId),
    store.listArtifacts(companyId)
  ]);

  return NextResponse.json({ messages, suggestions, artifacts: artifacts.slice(0, 6) });
}

// POST /api/ceo — owner sends a message, CEO replies
export async function POST(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await req.json();
  const { companyId, message } = body as { companyId: string; message: string };
  const mode = normalizeCeoChatMode((body as { mode?: unknown }).mode);

  if (!companyId || !message?.trim()) {
    return NextResponse.json({ error: "companyId and message required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });

  // Persist owner message
  await store.addCeoMessage({
    companyId,
    direction: "from_owner",
    kind: "chat",
    content: message.trim()
  });

  // Load context for CEO
  const [history, tasks, cycles, documents, reports] = await Promise.all([
    store.listCeoMessages(companyId),
    store.listTasks(companyId),
    store.listCycles(companyId),
    store.listDocuments(companyId),
    store.listReports(companyId)
  ]);
  const lastCycle = cycles[0];

  // Generate response. Org mode is company-aware and may create company work.
  // Gen mode is a direct general LLM bridge with no company side effects.
  const response = mode === "gen"
    ? await generalChatResponse(history, message.trim())
    : await ceoChatResponse(company, history, message.trim(), { tasks, lastCycle, documents, reports });

  // Persist CEO reply
  const ceoMsg = await store.addCeoMessage({
    companyId,
    direction: "from_ceo",
    kind: "chat",
    content: response.message
  });

  // Persist any out-of-scope suggestions the CEO surfaced
  const savedSuggestions = mode === "gen" ? [] : await Promise.all(
    (response.suggestions ?? []).map((s) =>
      store.addCeoSuggestion({ companyId, ...s })
    )
  );

  // Create tasks that the CEO routed to specialist agents
  const createdTasks = mode === "gen" ? [] : await Promise.all(
    (response.createTasks ?? []).map((t) =>
      store.createTask({
        companyId,
        title: t.title,
        prompt: t.prompt,
        agentRole: t.agentRole,
        priority: t.priority,
        tags: [...(t.tags ?? []), "from_chat"],
        status: t.agentRole === "engineer" ? "waiting_approval" : "queued",
        costCents: 0,
      })
    )
  );

  const requestedArtifacts = mode === "gen"
    ? []
    : response.createArtifacts?.length
      ? response.createArtifacts
      : inferArtifactRequest(message.trim())
        ? [inferArtifactRequest(message.trim())!]
        : [];

  const createdArtifacts = await Promise.all(
    requestedArtifacts.map((artifactRequest) =>
      store.createArtifact(buildArtifactDraft({
        company,
        prompt: artifactRequest.prompt || message.trim(),
        title: artifactRequest.title,
        type: artifactRequest.type,
        createdByAgent: artifactRequest.createdByAgent,
        exportFormat: artifactRequest.exportFormat,
        tasks: [...createdTasks, ...tasks],
        cycles,
        documents,
        reports
      }))
    )
  );

  return NextResponse.json({
    ceoMessage: ceoMsg,
    mode,
    suggestions: savedSuggestions,
    createdTasks,
    createdArtifacts,
    understood: response.understood,
  });
}

// PATCH /api/ceo — update a suggestion status
export async function PATCH(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await req.json();
  const { id, status } = body as { id: string; status: "done" | "dismissed" };

  if (!id || !status) return NextResponse.json({ error: "id and status required" }, { status: 400 });
  const suggestion = await store.getCeoSuggestion(id);
  if (!suggestion) return NextResponse.json({ error: "suggestion not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: suggestion.companyId });
  if (!check.ok) return forbidden();

  const updated = await store.updateCeoSuggestion(id, status);
  if (!updated) return NextResponse.json({ error: "suggestion not found" }, { status: 404 });

  return NextResponse.json({ suggestion: updated });
}
