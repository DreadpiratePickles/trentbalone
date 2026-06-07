---
name: lightrag
description: Use LightRAG to build a queryable knowledge graph from Phase 0/1/2 source files before any Phase 3 coding work. Invoke this skill whenever you need to understand structural relationships between modules (workbench provider ↔ credential boundary ↔ cost enforcement ↔ artifact capture), map tight coupling risks, or answer questions about a codebase without loading every file into context. TRIGGER when: user says "load files into LightRAG", "query the knowledge graph", "map dependencies", "what's coupled to X", or starts any Phase 3 implementation session in trent-os.
---

# LightRAG — Graph-RAG for Codebase Analysis

LightRAG builds a **knowledge graph** from source files and supports four query modes that recover different granularities of structural knowledge. Use it to answer questions like "what calls the credential boundary?" or "what breaks if I change the E2B provider?" without reading every file.

---

## Installation

```bash
pip install "lightrag-hku[api]"
# Embeddings need OpenAI key (Anthropic embed is deprecated)
pip install openai
```

Required env vars:
```bash
ANTHROPIC_API_KEY=...     # LLM for entity/relation extraction
OPENAI_API_KEY=...        # Embeddings (text-embedding-3-small)
```

---

## Core Workflow: Init → Insert → Query

```python
import asyncio, os
from lightrag import LightRAG, QueryParam
from lightrag.llm.anthropic import anthropic_complete_if_cache
from lightrag.llm.openai import openai_embed

WORKING_DIR = "./.lightrag/trent-phase1"   # persists between sessions

async def make_llm_func(model="claude-3-5-sonnet-20241022"):
    async def llm_func(prompt, system_prompt=None, history_messages=None, **kwargs):
        return await anthropic_complete_if_cache(
            model, prompt,
            system_prompt=system_prompt,
            history_messages=history_messages or [],
            api_key=os.getenv("ANTHROPIC_API_KEY"),
            **kwargs
        )
    return llm_func

async def build_graph(file_paths: list[str]):
    os.makedirs(WORKING_DIR, exist_ok=True)
    rag = LightRAG(
        working_dir=WORKING_DIR,
        llm_model_func=await make_llm_func(),
        embedding_func=openai_embed,
    )
    await rag.initialize_storages()

    for path in file_paths:
        text = open(path).read()
        # tag text with the filename so the graph knows provenance
        await rag.ainsert(f"# FILE: {path}\n\n{text}")

    await rag.finalize_storages()
    return rag

async def query(q: str, mode="hybrid"):
    rag = LightRAG(
        working_dir=WORKING_DIR,
        llm_model_func=await make_llm_func(),
        embedding_func=openai_embed,
    )
    await rag.initialize_storages()
    result = await rag.aquery(q, param=QueryParam(mode=mode))
    await rag.finalize_storages()
    return result
```

The `working_dir` persists the graph as JSON files — re-inserting the same files is idempotent unless you delete the directory.

---

## Query Modes

| Mode | What it finds | Use for |
|------|--------------|---------|
| `naive` | Pure vector similarity | "Show me code that does X" |
| `local` | Entity neighbourhood (1-2 hops) | "What does `withRlsContext` call?" |
| `global` | Community-level themes | "What are the architectural layers?" |
| `hybrid` | local + global fused | **Default for audit work** |

---

## Phase 3 Pre-Coding Protocol (trent-os)

**Run every step before touching any implementation file for Phase 3.**

### Step 1 — Load Phase 0 / 1 / 2 files into LightRAG

```python
PHASE_FILES = [
    # Phase 0 — security layer
    "lib/with-rls.ts", "lib/rate-limit.ts", "lib/secrets.ts",
    "lib/audit-log.ts", "lib/spend.ts",
    # Phase 1 — execution engine
    "lib/workbench.ts", "lib/workbench-provider.ts",
    "lib/workbench-local-provider.ts", "lib/workbench-e2b-provider.ts",
    "lib/workbench-orchestrator.ts", "lib/workbench-safety.ts",
    "lib/workbench-browser.ts", "lib/workbench-workspace.ts",
    "lib/workbench-artifact-capture.ts", "lib/workbench-screenshot.ts",
    "lib/workbench-preview.ts",
    # Phase 2 (when it exists) — money movement
    # "lib/billing/...", "lib/stripe/...",
]
```

### Step 2 — Run dependency-mapping queries

After inserting, run these four hybrid queries and record the answers before designing anything:

```python
questions = [
    "What are all the callers of the credential injection boundary? Which files pass secrets to the sandbox?",
    "What is tightly coupled between the E2B provider and the session orchestration layer? What would break if E2B's API changed?",
    "What does the per-session budget enforcement depend on? List every function and data structure in the dependency chain.",
    "What Phase 1 modules does the artifact capture layer depend on? Could it be extracted as a standalone subagent?",
]
for q in questions:
    print(await query(q, mode="hybrid"))
```

### Step 3 — Read Claude Mem before designing

After running LightRAG queries, read mem0 for prior Phase 3 architectural decisions (see `mem0` skill). Only then open implementation files.

---

## Tight Coupling Audit Pattern

Run this after loading any set of files to get a coupling report:

```python
coupling_query = """
List every pair of modules that share internal data structures or call each other's private functions.
Rate each pair: TIGHT (breaks together), LOOSE (interface only), or ISOLATED.
Focus especially on: provider ↔ credential injection, orchestrator ↔ cost enforcement, artifact capture ↔ store.
"""
print(await query(coupling_query, mode="global"))
```

---

## Storage

The graph is stored under `working_dir` as:
- `kv_store_full_docs.json` — raw inserted text
- `kv_store_text_chunks.json` — chunks
- `vdb_entities.json` / `vdb_relationships.json` — vector index
- `graph_chunk_entity_relation.graphml` — the knowledge graph (inspect with Gephi or networkx)

Delete the working dir to rebuild from scratch. Keep it between sessions — loading is fast; rebuilding takes LLM calls.

---

## Troubleshooting

- **Rate limit on insert**: set `llm_model_max_async=2` in `LightRAG()` constructor to slow down parallel extraction calls.
- **anthropic_embed deprecated**: always use `openai_embed` for embeddings; it needs `OPENAI_API_KEY`.
- **Graph too small**: LightRAG needs prose-style text to extract entities. TypeScript source works well. If extraction is sparse, set `entity_extract_max_gleaning=2`.
