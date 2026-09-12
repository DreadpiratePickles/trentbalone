"""
Reverse proxy for the Trent Next.js app in split-port preview environments.

Trent is a full-stack Next.js 15 application that serves BOTH its UI and its
`/api/*` route handlers on port 3000. The Kubernetes ingress in this environment
routes requests with the `/api` prefix to port 8001 and everything else to
port 3000. This thin FastAPI app sits on 8001 and forwards every request
(headers, body, query string, and streaming responses such as SSE) straight to
the Next.js server on localhost:3000 so the public `/api/*` endpoints resolve to
the Next.js route handlers.

LLM traffic does NOT pass through here. The Next.js app talks to the configured
OpenAI-compatible provider directly via `OPENAI_API_KEY` and optional
`OPENAI_BASE_URL`.
"""
from __future__ import annotations

import os

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import Response, StreamingResponse

NEXT_ORIGIN = os.environ.get("NEXT_ORIGIN", "http://localhost:3000")

app = FastAPI(title="Trent ingress proxy")

# Long timeout: orchestration/agent endpoints and SSE streams are long-lived.
_client = httpx.AsyncClient(base_url=NEXT_ORIGIN, timeout=httpx.Timeout(600.0, connect=10.0))

_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "content-encoding",
    "host",
}


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True, "proxy_to": NEXT_ORIGIN}


@app.api_route(
    "/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def proxy(path: str, request: Request) -> Response:
    url = httpx.URL(path="/" + path, query=request.url.query.encode("utf-8"))
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}
    body = await request.body()

    req = _client.build_request(request.method, url, headers=headers, content=body)
    upstream = await _client.send(req, stream=True)

    # Preserve ALL headers including duplicate Set-Cookie entries. A plain dict
    # collapses duplicates (dropping NextAuth's session + csrf cookies), which
    # silently breaks login through this proxy. Build a raw header list instead.
    raw_headers: list[tuple[bytes, bytes]] = []
    for k, v in upstream.headers.multi_items():
        if k.lower() in _HOP_BY_HOP:
            continue
        raw_headers.append((k.encode("latin-1"), v.encode("latin-1")))

    async def body_iterator():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    response = StreamingResponse(
        body_iterator(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )
    response.raw_headers = raw_headers
    return response
