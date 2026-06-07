// GBrain sidecar HTTP server. Zero dependencies — pure node:http.
// Runs as a separate Railway service from the same monorepo, reachable from
// Trent over private networking (http://gbrain.railway.internal:PORT).
//
// Contract (matches lib/gbrain/gbrain-client.ts):
//   GET  /health  -> { status: "ok" }
//   POST /ingest  { companyId, runId, title, content, source, tags } -> { documentId }
//   POST /recall  { companyId, query, limit } -> { answer, citations, gaps }
//   POST /advise  { companyId, objective, question, context }
//                 -> { guidance, suggestedNextStep, clarifyingQuestions }
// All POST routes require `Authorization: Bearer ${GBRAIN_API_KEY}` when that
// env var is set. GBrain advises; it never executes actions.

import http from "node:http";
import { createStore } from "./store.mjs";

const MAX_BODY_BYTES = 1_000_000;

export function createServer({ store = createStore(), apiKey = process.env.GBRAIN_API_KEY } = {}) {
  function authorized(req) {
    if (!apiKey) return true; // no key configured -> open (dev/private network only)
    const header = req.headers["authorization"] || "";
    return header === `Bearer ${apiKey}`;
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return sendJson(res, 200, { status: "ok" });
    }

    if (req.method !== "POST") {
      return sendJson(res, 404, { error: "not found" });
    }

    if (!authorized(req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (path !== "/ingest" && path !== "/recall" && path !== "/advise") {
      return sendJson(res, 404, { error: "not found" });
    }

    readJson(req)
      .then((body) => {
        if (path === "/ingest") {
          try {
            return sendJson(res, 200, store.ingest(body));
          } catch (error) {
            return sendJson(res, 400, { error: messageOf(error) });
          }
        }
        if (path === "/recall") {
          if (!body.companyId) return sendJson(res, 400, { error: "companyId is required" });
          if (!body.query) return sendJson(res, 400, { error: "query is required" });
          return sendJson(res, 200, store.recall(body));
        }
        // /advise
        if (!body.companyId) return sendJson(res, 400, { error: "companyId is required" });
        if (!body.objective && !body.question) {
          return sendJson(res, 400, { error: "objective or question is required" });
        }
        const { citations: _omit, ...advice } = store.advise(body);
        return sendJson(res, 200, advice);
      })
      .catch((error) => sendJson(res, 400, { error: messageOf(error) }));
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function messageOf(error) {
  return error instanceof Error ? error.message : "request failed";
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`gbrain sidecar listening on :${port}`);
  });
}
