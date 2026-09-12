/**
 * /api/companies/[id]/wiki/semantic — vector-embedded semantic search.
 *
 * POST { query, k? } → { results: [...], answer?: { answer, citations } }
 *
 * The endpoint:
 *   1. Embeds the query via the OpenAI-compatible bridge.
 *   2. Cosine-similarity retrieves top-K chunks from data/wiki-embeddings.jsonl
 *      (hybrid keyword boost).
 *   3. Generates a citation-grounded answer with Claude Sonnet 4.5 and refuses
 *      cleanly when retrieval is weak.
 */

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { semanticSearch, stats } from "@/lib/wiki-embeddings";

const ANSWER_MODEL = process.env.OPENAI_MODEL ?? "claude-sonnet-4-5";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();
  return NextResponse.json({ stats: await stats(companyId) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as { query?: string; k?: number; answer?: boolean };
  const query = body.query?.trim();
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  const results = await semanticSearch({ companyId, query, k: body.k });

  if (body.answer === false) {
    return NextResponse.json({ results });
  }

  // Compose grounded answer.
  const ctx = results.slice(0, 5).map((r, i) => `[#${i + 1} — ${r.title} (${r.path})]\n${r.text}`).join("\n\n---\n\n");
  const topScore = results[0]?.score ?? 0;
  const refusalThreshold = 0.08;

  let answer = "";
  let refusal: string | undefined;
  let citations: Array<{ idx: number; title: string; path: string; score: number }> = [];

  if (results.length === 0 || topScore < refusalThreshold) {
    refusal = "I don't have enough in the wiki to answer that confidently — try adding a note on this topic, then ask again.";
  } else if (!process.env.OPENAI_API_KEY) {
    answer = `Top match: **${results[0].title}** — ${results[0].text.slice(0, 360)}…`;
    citations = results.slice(0, 3).map((r, i) => ({ idx: i + 1, title: r.title, path: r.path, score: r.score }));
  } else {
    try {
      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL || undefined,
        timeout: 30_000,
      });
      const completion = await client.chat.completions.create({
        model: ANSWER_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: [
              "You answer questions strictly from the founder's company wiki.",
              "Rules:",
              "  • Cite using bracket markers like [#1], [#2] inline next to claims they support.",
              "  • If the context does not contain the answer, reply: \"Not in the wiki.\"",
              "  • Be concise. Markdown OK. End with a `↗ next action` if appropriate.",
            ].join("\n"),
          },
          { role: "user", content: `Question: ${query}\n\nWiki context:\n${ctx}` },
        ],
      });
      answer = completion.choices[0]?.message?.content?.trim() || "(no answer)";
      citations = results.slice(0, 5).map((r, i) => ({ idx: i + 1, title: r.title, path: r.path, score: r.score }));
    } catch (err) {
      answer = `Top match: **${results[0].title}** — ${results[0].text.slice(0, 360)}…`;
      citations = results.slice(0, 3).map((r, i) => ({ idx: i + 1, title: r.title, path: r.path, score: r.score }));
    }
  }

  return NextResponse.json({
    results,
    answer: { answer, refusal, citations, topScore },
  });
}
