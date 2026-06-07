// In-memory, per-company memory store for the GBrain sidecar.
// Zero dependencies. Persists mission memory logs and answers recall/advise
// pings. GBrain advises; Trent decides — nothing here executes actions.

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "at", "by", "from", "as", "is", "are", "was", "were", "be", "been", "it",
  "this", "that", "these", "those", "how", "what", "did", "do", "does", "our",
  "we", "i", "you", "they", "them", "their", "its",
]);

function stem(token) {
  if (token.length <= 3) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("es")) return token.slice(0, -2);
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

function excerptFor(content, queryTokens) {
  const sentences = String(content || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return "";
  let best = sentences[0];
  let bestScore = -1;
  for (const sentence of sentences) {
    const tokens = new Set(tokenize(sentence));
    let score = 0;
    for (const token of queryTokens) if (tokens.has(token)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  return best.length > 280 ? `${best.slice(0, 277)}...` : best;
}

export function createStore() {
  // companyId -> array of { id, runId, title, content, source, tags, createdAt }
  const byCompany = new Map();
  let counter = 0;

  function nextId() {
    counter += 1;
    return `gbdoc_${Date.now().toString(36)}_${counter}`;
  }

  function ingest({ companyId, runId, title, content, source, tags }) {
    if (!companyId) throw new Error("companyId is required");
    if (!title && !content) throw new Error("title or content is required");
    const doc = {
      id: nextId(),
      runId: runId || "",
      title: title || "Untitled mission memory",
      content: content || "",
      source: source || "agent-mission",
      tags: Array.isArray(tags) ? tags : [],
      createdAt: new Date().toISOString(),
    };
    const docs = byCompany.get(companyId) || [];
    docs.push(doc);
    byCompany.set(companyId, docs);
    return { documentId: doc.id };
  }

  function recall({ companyId, query, limit }) {
    const queryTokens = tokenize(query);
    const docs = byCompany.get(companyId) || [];
    const cap = typeof limit === "number" && limit > 0 ? limit : 5;

    if (queryTokens.length === 0 || docs.length === 0) {
      return {
        answer: "",
        citations: [],
        gaps: ["No prior mission memory found for this objective."],
      };
    }

    const scored = [];
    for (const doc of docs) {
      const haystack = tokenize(`${doc.title} ${doc.content} ${doc.tags.join(" ")}`);
      const haySet = new Set(haystack);
      let score = 0;
      for (const token of queryTokens) if (haySet.has(token)) score += 1;
      if (score > 0) scored.push({ doc, score });
    }

    scored.sort((a, b) => b.score - a.score || (a.doc.createdAt < b.doc.createdAt ? 1 : -1));
    const top = scored.slice(0, cap);

    if (top.length === 0) {
      return {
        answer: "",
        citations: [],
        gaps: ["No prior mission memory matched this objective."],
      };
    }

    const citations = top.map(({ doc }) => ({
      id: doc.id,
      title: doc.title,
      excerpt: excerptFor(doc.content, queryTokens),
    }));
    const answer = `Found ${top.length} prior mission memory log${top.length === 1 ? "" : "s"} relevant to this objective. Most relevant: "${top[0].doc.title}".`;
    return { answer, citations, gaps: [] };
  }

  function advise({ companyId, objective, question }) {
    const recalled = recall({ companyId, query: `${objective} ${question}`, limit: 3 });
    const clarifyingQuestions = [];
    if (!objective) clarifyingQuestions.push("What is the objective of this mission?");
    if (recalled.citations.length === 0) {
      clarifyingQuestions.push("There is no prior memory for this objective — what outcome defines success?");
    }

    const guidance = recalled.citations.length > 0
      ? `Based on ${recalled.citations.length} prior mission memory log(s), align this mission with what previously worked. ${recalled.answer}`
      : "No prior mission memory is available for this objective. Proceed with a small, reversible first step and capture the outcome for future recall.";

    const suggestedNextStep = recalled.citations.length > 0
      ? `Review prior log "${recalled.citations[0].title}" before drafting the plan.`
      : "Draft a minimal plan and route any external action through Trent's approval gates.";

    return {
      guidance,
      suggestedNextStep,
      clarifyingQuestions,
      citations: recalled.citations,
    };
  }

  return { ingest, recall, advise };
}
