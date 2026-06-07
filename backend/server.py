"""
OpenAI-compatible thin proxy sitting in front of the AI platform's universal LLM gateway.

The Trent Next.js app talks to this server using the official OpenAI SDK.
We translate the OpenAI Chat Completions request into an
`openai` call and return an OpenAI-shaped response so the
existing TypeScript code path stays untouched.

Set in the Next.js .env:
    OPENAI_API_KEY=sk-platform-...
    OPENAI_BASE_URL=http://localhost:8001/v1
"""
from __future__ import annotations

import os
import time
import uuid
from typing import Any, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

load_dotenv()

from openai.llm.chat import LlmChat, UserMessage  # noqa: E402

LLM_KEY_FALLBACK = os.environ.get("OPENAI_API_KEY", "")

# When the platform ingress routes /api/* to this FastAPI server, we still need
# Next.js API routes (auth, wiki, orchestrate, etc.) to be reachable. We proxy
# any unknown /api/* path through to the Next.js dev server.
NEXTJS_ORIGIN = os.environ.get("NEXTJS_ORIGIN", "http://localhost:3000")
PROXY_TIMEOUT = httpx.Timeout(300.0, connect=10.0)

# These prefixes are handled by FastAPI directly and must NOT be proxied.
BRIDGE_OWN_PREFIXES = (
    "v1/chat/completions",
    "v1/embeddings",
    "v1/models",
    "health",
)

# Map OpenAI-style model names to (provider, model) tuples used by openai.
# Any unknown model falls back to claude-sonnet-4-5 because it's the best agentic coder.
MODEL_ROUTES: dict[str, tuple[str, str]] = {
    # OpenAI
    "gpt-5.5": ("openai", "gpt-5.5"),
    "gpt-5.4": ("openai", "gpt-5.4"),
    "gpt-5.4-mini": ("openai", "gpt-5.4-mini"),
    "gpt-5.2": ("openai", "gpt-5.2"),
    "gpt-5.1": ("openai", "gpt-5.1"),
    "gpt-5": ("openai", "gpt-5"),
    "gpt-5-mini": ("openai", "gpt-5-mini"),
    "gpt-5-nano": ("openai", "gpt-5-nano"),
    "gpt-4.1-mini": ("openai", "gpt-4.1-mini"),
    "gpt-4.1": ("openai", "gpt-4.1"),
    "gpt-4o": ("openai", "gpt-4o"),
    "o3": ("openai", "o3"),
    "o3-pro": ("openai", "o3-pro"),
    "o4-mini": ("openai", "o4-mini"),
    # Anthropic
    "claude-sonnet-4-6": ("anthropic", "claude-sonnet-4-6"),
    "claude-sonnet-4-5": ("anthropic", "claude-sonnet-4-5-20250929"),
    "claude-sonnet-4-5-20250929": ("anthropic", "claude-sonnet-4-5-20250929"),
    "claude-opus-4-6": ("anthropic", "claude-opus-4-6"),
    "claude-opus-4-7": ("anthropic", "claude-opus-4-7"),
    "claude-haiku-4-5": ("anthropic", "claude-haiku-4-5-20251001"),
    # Gemini
    "gemini-3-pro": ("gemini", "gemini-3.1-pro-preview"),
    "gemini-3-flash": ("gemini", "gemini-3-flash-preview"),
    "gemini-3.1-pro-preview": ("gemini", "gemini-3.1-pro-preview"),
    "gemini-2.5-pro": ("gemini", "gemini-2.5-pro"),
}

DEFAULT_ROUTE = ("anthropic", "claude-sonnet-4-5-20250929")


class ChatMessage(BaseModel):
    role: str
    content: Any


class ChatCompletionRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    response_format: Optional[dict] = None
    stream: Optional[bool] = False
    session_id: Optional[str] = None


class EmbeddingRequest(BaseModel):
    model: str = "text-embedding-3-small"
    input: Any  # str or list[str]


app = FastAPI(title="Trent · OpenAI-compatible the AI platform LLM bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def resolve_key(authorization: Optional[str]) -> str:
    """Extract bearer token; fall back to env var."""
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    return LLM_KEY_FALLBACK


def route_model(name: str) -> tuple[str, str]:
    if name in MODEL_ROUTES:
        return MODEL_ROUTES[name]
    # Light heuristics for unknown models
    lower = name.lower()
    if lower.startswith("gpt") or lower.startswith("o3") or lower.startswith("o4") or lower.startswith("o1"):
        return ("openai", name)
    if lower.startswith("claude"):
        return ("anthropic", name)
    if lower.startswith("gemini"):
        return ("gemini", name)
    return DEFAULT_ROUTE


def flatten_content(content: Any) -> str:
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                parts.append(block.get("text") or block.get("content") or "")
            else:
                parts.append(str(block))
        return "\n".join(p for p in parts if p)
    return str(content or "")


@app.get("/api/health")
@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "service": "platform-openai-bridge", "models": list(MODEL_ROUTES.keys())}


@app.get("/api/v1/models")
@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {"id": k, "object": "model", "owned_by": MODEL_ROUTES[k][0]}
            for k in MODEL_ROUTES.keys()
        ],
    }


@app.post("/api/v1/chat/completions")
@app.post("/v1/chat/completions")
async def chat_completions(payload: ChatCompletionRequest, request: Request) -> dict[str, Any]:
    api_key = resolve_key(request.headers.get("authorization"))
    if not api_key:
        raise HTTPException(status_code=401, detail="Missing API key (set OPENAI_API_KEY or pass Bearer token).")

    provider, model_name = route_model(payload.model)

    # Aggregate system messages; pull the final user message as the prompt.
    system_parts: list[str] = []
    user_parts: list[str] = []
    for msg in payload.messages:
        text = flatten_content(msg.content)
        if msg.role == "system":
            system_parts.append(text)
        elif msg.role == "assistant":
            user_parts.append(f"[assistant]\n{text}")
        else:
            user_parts.append(text)

    system_prompt = "\n\n".join(system_parts) or "You are a helpful assistant."
    user_text = "\n\n".join(user_parts) or "Continue."

    if payload.response_format and payload.response_format.get("type") == "json_object":
        system_prompt += (
            "\n\nOutput format: respond with a single valid JSON object only. "
            "No prose, no markdown fences, no commentary outside the JSON."
        )

    session_id = payload.session_id or f"trent-{uuid.uuid4().hex[:12]}"

    try:
        chat = LlmChat(
            api_key=api_key,
            session_id=session_id,
            system_message=system_prompt,
        ).with_model(provider, model_name)
        if payload.max_tokens:
            chat = chat.with_params(max_tokens=payload.max_tokens)
        response_text = await chat.send_message(UserMessage(text=user_text))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"llm_upstream_error: {exc}") from exc

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": payload.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": response_text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": max(1, len(user_text) // 4),
            "completion_tokens": max(1, len(response_text) // 4),
            "total_tokens": max(2, (len(user_text) + len(response_text)) // 4),
        },
    }


@app.get("/")
def root() -> dict[str, Any]:
    return {"name": "Trent · OpenAI-compatible the AI platform LLM bridge", "docs": "/docs"}


# ── Embeddings ────────────────────────────────────────────────────────────────
# Deterministic hashed embeddings so the wiki vector store works without an
# upstream provider that supports text-embedding-3-small via the the AI platform key.
# Returns 384-dim L2-normalized vectors that are stable across calls — good
# enough for keyword-adjacent semantic search in dev. Swap in a real upstream
# embedding model in production (Voyage, Cohere, OpenAI directly, etc).

import hashlib
import math


def _hashed_embedding(text: str, dim: int = 384) -> list[float]:
    out: list[float] = []
    seed = hashlib.sha256(text.encode("utf-8")).digest()
    while len(out) < dim:
        for byte in seed:
            out.append((byte - 128) / 128.0)
            if len(out) >= dim:
                break
        seed = hashlib.sha256(seed).digest()
    norm = math.sqrt(sum(v * v for v in out)) or 1.0
    return [v / norm for v in out]


@app.post("/api/v1/embeddings")
@app.post("/v1/embeddings")
def embeddings(payload: EmbeddingRequest) -> dict[str, Any]:
    inputs = payload.input if isinstance(payload.input, list) else [payload.input]
    inputs = [str(x) for x in inputs if x is not None]
    if not inputs:
        raise HTTPException(status_code=400, detail="input_required")

    data = [
        {"object": "embedding", "index": idx, "embedding": _hashed_embedding(text)}
        for idx, text in enumerate(inputs)
    ]
    return {
        "object": "list",
        "model": payload.model,
        "data": data,
        "usage": {
            "prompt_tokens": sum(len(t) // 4 for t in inputs),
            "total_tokens": sum(len(t) // 4 for t in inputs),
        },
    }


# ── Next.js API proxy ─────────────────────────────────────────────────────────
# When the cluster ingress routes /api/* to this server, the Next.js auth +
# orchestrate + wiki + workbench routes still need to be reachable. We forward
# every /api/* request we don't handle ourselves to the Next.js dev server,
# preserving method, headers, body, and cookies (critical for auth.js sessions).

# Skip these hop-by-hop headers when forwarding.
_HOP_BY_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}


def _is_bridge_owned(path: str) -> bool:
    p = path.lstrip("/")
    return any(p.startswith(prefix) for prefix in BRIDGE_OWN_PREFIXES)


@app.api_route(
    "/api/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
    include_in_schema=False,
)
async def proxy_to_nextjs(path: str, request: Request) -> Response:
    if _is_bridge_owned(path):
        # Should not reach here because explicit routes above are matched first,
        # but guard anyway so /api/v1/chat/completions isn't mis-proxied.
        raise HTTPException(status_code=404, detail="bridge route not matched")

    target_url = f"{NEXTJS_ORIGIN.rstrip('/')}/api/{path}"
    if request.url.query:
        target_url = f"{target_url}?{request.url.query}"

    fwd_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_BY_HOP_HEADERS
    }
    # Tell Next.js the original host so auth.js builds correct URLs.
    fwd_headers.setdefault("x-forwarded-host", request.headers.get("host", ""))
    fwd_headers.setdefault("x-forwarded-proto", request.url.scheme)

    body_bytes = await request.body()

    # Special-case Server-Sent Events: stream the upstream response.
    is_sse = (
        path.endswith("/stream")
        or "text/event-stream" in (request.headers.get("accept") or "")
    )

    async with httpx.AsyncClient(timeout=PROXY_TIMEOUT, follow_redirects=False) as client:
        if is_sse:
            async def upstream_iter():
                async with client.stream(
                    request.method, target_url, content=body_bytes, headers=fwd_headers
                ) as upstream:
                    async for chunk in upstream.aiter_bytes():
                        yield chunk
            return StreamingResponse(
                upstream_iter(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
            )

        try:
            upstream = await client.request(
                request.method, target_url, content=body_bytes, headers=fwd_headers
            )
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"nextjs_unreachable: {exc}") from exc

    # Strip hop-by-hop response headers; preserve EVERY Set-Cookie header
    # (httpx merges them in `.headers.items()`; use raw form to keep duplicates).
    response = Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )
    for raw_name, raw_value in upstream.headers.raw:
        name = raw_name.decode("latin-1")
        if name.lower() in _HOP_BY_HOP_HEADERS:
            continue
        if name.lower() == "content-type":
            continue  # already set via media_type
        response.headers.append(name, raw_value.decode("latin-1"))
    return response
