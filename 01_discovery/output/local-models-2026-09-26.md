# Running the Trent fleet on local models: runtimes, models, embedders, harness practice, failure modes

Compiled 2026-09-26. Read-only research pass. Every row cites one primary source (vendor docs, model
cards, the runtime's own GitHub repository or source code, benchmark pages) and the date it was read.
Where something was looked for and not found, the row says **not found**; nothing is filled in from memory.

**Conventions.**
- `Read` = the date the URL was fetched. All fetches in this pass happened on 2026-09-26.
- **vendor-reported** = the model's publisher ran the benchmark on a harness it chose. **independent** =
  the Berkeley Function Calling Leaderboard (BFCL V4), which runs every model on one harness. The two do
  not agree and are never mixed in one column.
- **community (runtime repo)** = a benchmark posted in the runtime's own GitHub Discussions by a named user
  (not the maintainers). It is used only where no vendor figure exists and is labelled each time.
- **derived** = arithmetic on cited numbers, shown so it can be checked.
- GGUF sizes are the byte sizes of the files in the named Hugging Face repositories, read through the
  Hugging Face API (`/api/models/<repo>/tree/main`). They are file sizes, not total runtime memory: the KV
  cache and compute buffers come on top.

**Method caveat.** Some summaries were produced by a fetch tool that paraphrases pages. Every number used
in a table below was re-checked against the raw page, raw README or raw source file; one paraphrased figure
(DGX Spark, gpt-oss-120b) was wrong and is corrected here from the raw page.

---

## 0. The short version

**Minimum viable local stack, by hardware tier** (detail and evidence in §6):

| Tier | Runtime | Chat model, all roles | Embedder | Audio | Honest expectation |
|---|---|---|---|---|---|
| 16 GB Mac | Ollama (MLX runner) or llama.cpp `llama-server --jinja`, one model, 1 slot, 64K context | Qwen3.5-9B Q4_K_M (5.7 GB file) | Qwen3-Embedding-0.6B or EmbeddingGemma-300m | whisper.cpp `base`/`small` | Single tool calls mostly right; multi-step plans unreliable; slow cold prefill |
| 32-64 GB Mac or one 24 GB GPU | 24 GB GPU: llama.cpp; Mac: Ollama MLX or LM Studio | 24-32 GB: Qwen3.6-27B (or 3.8-27B) Q4_K_M (~17 GB); 48-64 GB Mac: Qwen3.6-35B-A3B (~22-24 GB). Speed-first alternative: gpt-oss-20b | Qwen3-Embedding-0.6B/4B | whisper.cpp `small`/`medium` | Tool execution good on short chains; planning adequate for bounded tasks, below hosted frontier |
| 128 GB+ unified or multi-GPU | vLLM on multi-GPU Linux; llama.cpp/Ollama on 128 GB unified memory | Planner/critic: gpt-oss-120b (63.4 GB) or Qwen3.5-122B-A10B Q4_K_M (76.5 GB); seats: Qwen3.6-35B-A3B | Qwen3-Embedding-4B/8B | whisper.cpp `large` | Planning near mid-tier hosted models on vendor evals; tool execution reliable once decoding is constrained |

**What Trent must change first** (full testable checklist in §8): constrain every JSON turn with
`response_format: json_schema` on local providers and flatten the tool call to `{tool, args}` with `tool`
as an enum; enforce a verified effective context of at least 64K and refuse rather than truncate; keep a
byte-stable prompt prefix per seat and cap in-flight calls at the server's slot count; repair-then-retry
tool arguments and never record an unparseable call as a success; add a local-stack doctor that measures
tool-call pass rate, time to first token at the real prompt size, prefix-cache hits and embedder calibration.

---

## 0.1 Where Trent stands today (from the repository, read 2026-09-26)

| Fact | Where | Why it matters locally |
|---|---|---|
| `ollama` and `lmstudio` are OpenAI-compatible aliases; a placeholder key `local` is sent so a real OpenAI key never goes to localhost | `packages/trent-core/src/model-gateway/providers.ts:22-69` | Good base. There is no `llamacpp`, `vllm` or `mlx` alias. |
| Default Ollama model is `llama3.2` | `providers.ts:58`, `setup/detect.ts:33` | BFCL V4 scores Llama-3.2-3B-Instruct (FC) at 21.95% overall and 4.00% multi-turn (§2.2). It is the weakest defensible default. |
| Only the Google path has a Trent-side streamer that sends `stream_options.include_usage` and `reasoning_effort`; other OpenAI-compatible providers use the app's streamer, which sends usage only for `openai` and logs `reasoning_effort_not_sent` | `model-gateway/openai-compat.ts:1-60`, `model-gateway/index.ts:221-233`, `apps/web/lib/ai-client.ts:411` | Local calls get estimated usage and no thinking control. |
| The app's OpenAI client is built with `timeout: 60_000` | `apps/web/lib/ai-client.ts:117,189` | Cold prefill of a long seat prompt on a Mac can approach or exceed this (§2.5). |
| Seat, planner and critic turns ask for JSON in the system message; the gateway has no `response_format`; the first JSON object is cut out of the reply | `orchestrator/seat-gateway-port.ts:19-33`, `model-gateway/completion-port.ts:13-20` | No constrained decoding on any local runtime, although all four servers support it (§1). |
| A tool call is a JSON turn whose `toolCall.action` is a string `"<tool> <json>"`, i.e. JSON escaped inside a JSON string | `tools/action.ts:1-10`, `apps/web/lib/seat-agent-loop.ts:74-88` | A format no model was trained on; BFCL V4 finds non-standard formats cost small models the most (§5). |
| Tool schemas are rendered as custom text (`name: description / action = "name {...}" with JSON keys:`) | `tools/web/schemas.ts:18-32` | BFCL V4: function docs in JSON score best across nearly all models (§5). |
| Progressive tool disclosure exists (`tool_search`, `tool_describe`, `tool_call`, threshold `tools.disclosure_threshold`) | `tools/tool_search/index.ts:1-24` | Already the right lever for small context windows. |
| With a local chat provider, the embedder takes the OpenAI route at the local base URL but keeps the OpenAI defaults: model `text-embedding-3-small`, 1536 dims, floor 0.3 ("Not measured here") | `fleet-memory/embedder.ts:99-110,206-216,265-273` | Ollama has no model by that name; the floor is not calibrated for any local embedder. |
| Audio already runs locally through `whisper-cli` (whisper.cpp) or faster-whisper after an ffmpeg 16 kHz mono conversion | `tools/media/commands.ts:9-56` | Whisper needs no new work, only a doctor check. |

---

## 1. Runtimes

### 1.1 Ollama

| Capability | Finding | Source | Read |
|---|---|---|---|
| Native tool calling | Yes, including multiple tool calls in one turn and tool calls while streaming | https://docs.ollama.com/capabilities/tool-calling | 2026-09-26 |
| Streaming with tool calls | Yes since 2025-05-28; the parser "directly references each model's template to understand the prefix of the tool call" | https://ollama.com/blog/streaming-tool | 2026-09-26 |
| OpenAI `/v1/chat/completions` fields | Supported: `tools`, `response_format`, `stream_options.include_usage`, `reasoning_effort`, `reasoning.effort`. **Not supported: `tool_choice`**, `logit_bias`, `n`, `user` | https://docs.ollama.com/api/openai-compatibility | 2026-09-26 |
| Other OpenAI endpoints | `/v1/completions`, `/v1/models`, `/v1/embeddings` (with `dimensions`), `/v1/responses` (no `previous_response_id`) | https://docs.ollama.com/api/openai-compatibility | 2026-09-26 |
| Anthropic `/v1/messages` | Tools and streaming yes; `tool_choice` no; `cache_control` prompt caching no; `budget_tokens` "accepted but not enforced"; no token counting | https://docs.ollama.com/api/anthropic-compatibility | 2026-09-26 |
| Structured outputs | JSON schema in `format`, and `response_format` on the OpenAI route; docs advise temperature 0 | https://docs.ollama.com/capabilities/structured-outputs | 2026-09-26 |
| Thinking control | `think`: true/false or model-defined levels (gpt-oss: low/medium/high, default medium); discover per model via `/api/show` | https://docs.ollama.com/capabilities/thinking | 2026-09-26 |
| Default context | By VRAM: under 24 GiB → 4k; 24-48 GiB → 32k; 48 GiB and up → 256k. Set with `OLLAMA_CONTEXT_LENGTH`; the OpenAI route cannot set it (Modelfile `num_ctx` instead) | https://docs.ollama.com/context-length | 2026-09-26 |
| Concurrency | `OLLAMA_NUM_PARALLEL` default 1, "Required RAM will scale by `OLLAMA_NUM_PARALLEL` * `OLLAMA_CONTEXT_LENGTH`"; `OLLAMA_MAX_LOADED_MODELS` default 3 x GPUs; `OLLAMA_MAX_QUEUE` 512 then HTTP 503 | https://docs.ollama.com/faq | 2026-09-26 |
| Model residency | `OLLAMA_KEEP_ALIVE` default 5 minutes | https://docs.ollama.com/faq | 2026-09-26 |
| KV cache type | `OLLAMA_KV_CACHE_TYPE` default `f16`; `q8_0` about half, `q4_0` about a quarter; applies to all models | https://docs.ollama.com/faq | 2026-09-26 |
| KV reuse across requests (Apple, MLX runner) | Ollama 0.19 on MLX "will now reuse its cache across conversations", with checkpoints; "shared prefixes survive longer even when older branches are dropped". Preview required a Mac with more than 32 GB | https://ollama.com/blog/mlx | 2026-09-26 |
| KV reuse mechanism | Prefix trie shared across conversations, snapshots paged in and out, 8 GiB paged-out eviction threshold | https://github.com/ollama/ollama/blob/main/mlxrunner/prefix_cache.go | 2026-09-26 |
| Multi-agent snapshots | "Each one resumes from its own saved state, and anything they have in common ... is only processed once" (2026-06-11) | https://ollama.com/blog/mlx-performance | 2026-09-26 |
| KV reuse on the GGUF path | **not found** in vendor docs | — | 2026-09-26 |
| Embeddings | `/api/embed`, L2-normalised; recommended: embeddinggemma, qwen3-embedding, all-minilm | https://docs.ollama.com/capabilities/embeddings | 2026-09-26 |
| Embedding truncation | `truncate` default true: over-length input is cut silently unless set false | https://docs.ollama.com/api/embed | 2026-09-26 |

### 1.2 LM Studio

| Capability | Finding | Source | Read |
|---|---|---|---|
| Tool calling | "Native" for models whose template and format LM Studio parses; others get a "default" format (`[TOOL_REQUEST]...[END_TOOL_REQUEST]`) injected via system prompt. Unparseable calls fall back to `message.content` | https://lmstudio.ai/docs/developer/openai-compat/tools | 2026-09-26 |
| Small-model caveat | "smaller models and models that were not trained for tool use may output improperly formatted tool calls" | https://lmstudio.ai/docs/developer/openai-compat/tools | 2026-09-26 |
| Streaming tool calls | Yes, as `delta.tool_calls` chunks | https://lmstudio.ai/docs/developer/openai-compat/tools | 2026-09-26 |
| `tool_choice` | `none`, `auto`, `required`; `required` on llama.cpp engines only (2025-04-24) | https://lmstudio.ai/blog/lmstudio-v0.3.15 | 2026-09-26 |
| Structured outputs | `response_format` JSON schema; GGUF via llama.cpp grammar, MLX via Outlines; "Not all models are capable of structured output, particularly LLMs below 7B parameters" | https://lmstudio.ai/docs/developer/openai-compat/structured-output | 2026-09-26 |
| Endpoints | `/v1/models`, `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/completions` | https://lmstudio.ai/docs/developer/openai-compat | 2026-09-26 |
| Reasoning control | `/v1/responses` takes `reasoning: {effort}`, stateful `previous_response_id`, function and MCP tools | https://lmstudio.ai/docs/developer/openai-compat/responses | 2026-09-26 |
| Reasoning control on chat completions | **not found** in the chat-completions parameter list | https://lmstudio.ai/docs/developer/openai-compat/chat-completions | 2026-09-26 |
| Default context | 8k tokens since 0.4.16 (2026-06-08) | https://lmstudio.ai/changelog/lmstudio/lmstudio-v0.4.16 | 2026-09-26 |
| Concurrency | "Max Concurrent Predictions" default 4, continuous batching; documented for llama.cpp (GGUF) | https://lmstudio.ai/docs/app/advanced/parallel-requests | 2026-09-26 |
| Headless server | `llmster` daemon since 0.4.0 (2026-01-28) | https://lmstudio.ai/blog/0.4.0 | 2026-09-26 |
| KV reuse (MLX engine) | v1.8.5 (2026-06-05): KV checkpoints saved at 256-token boundaries and restored for follow-ups; "2.2x faster end-to-end" on four parallel chats; "82% less extra RAM" | https://lmstudio.ai/blog/mlx-engine-agentic-workloads | 2026-09-26 |

### 1.3 llama.cpp `llama-server`

| Capability | Finding | Source | Read |
|---|---|---|---|
| Default context | `-c` default 0 = "loaded from model" (the training context); `--fit` on by default adjusts unset arguments to fit memory, minimum fit context 4096 | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md | 2026-09-26 |
| Slots | `-np` default -1 = auto; unified KV buffer by default when slots are auto; `--kv-unified-per-slot N` caps context per slot | same | 2026-09-26 |
| Tool calling | Jinja templates on by default (`--jinja`); `parallel_tool_calls` "only supported on some models"; `/v1/messages` (Anthropic) takes `tool_choice` auto/any/tool | same | 2026-09-26 |
| Tool-call handlers | Native handlers for listed families; otherwise "Generic" format, which "may consume more tokens and be less efficient"; parallel calls off by default | https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md | 2026-09-26 |
| KV quantization warning | "Beware of extreme KV quantizations (e.g. `-ctk q4_0`), they can substantially degrade the model's tool calling performance" | same | 2026-09-26 |
| Structured outputs | `json_schema` and `response_format` (`json_object` with schema, or `json_schema`), grammar-based sampling | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md | 2026-09-26 |
| Reasoning control | `reasoning_effort` per request ("If `none`, reasoning/thinking is disabled"); `--reasoning-effort`, `--reasoning-budget`, `--reasoning-format` (default auto), `chat_template_kwargs` | same | 2026-09-26 |
| Prompt cache | `cache_prompt` default true: only the unseen suffix is evaluated (logits may differ bit-for-bit); `--slot-prompt-similarity` 0.10; `--cache-ram` 8192 MiB host cache; 32 context checkpoints per slot; slot save/restore endpoints | same | 2026-09-26 |
| Endpoints | `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/embeddings`, token counting, `/slots`, `/metrics`, `/props`, model load/unload | same | 2026-09-26 |
| Embeddings | `--embedding`, `--pooling {none,mean,cls,last,rank}` (model default if unset) | same | 2026-09-26 |

### 1.4 vLLM

| Capability | Finding | Source | Read |
|---|---|---|---|
| Tool calling | `--enable-auto-tool-choice --tool-call-parser <family>`; parsers include `hermes`, `mistral`, `llama3_json`, `llama4_pythonic`, `qwen3_xml`, `glm45`, `glm47`, `kimi_k2`, `deepseek_v31`, `openai`, `granite`, `functiongemma` | https://docs.vllm.ai/en/latest/features/tool_calling.html | 2026-09-26 |
| `tool_choice` guarantees | `required` and named function use the structured-outputs backend (valid by construction); in `auto`, "arguments may occasionally be malformed" | same | 2026-09-26 |
| Parallel tool calls | "not supported for Llama 3"; Mistral "struggles to generate parallel tool calls correctly" | same | 2026-09-26 |
| Structured outputs | Backends `xgrammar`, `guidance`, `auto`; `response_format` JSON schema; with Qwen3 Coder reasoning, `--structured-outputs-config.enable_in_reasoning=True` is needed | https://docs.vllm.ai/en/latest/features/structured_outputs.html | 2026-09-26 |
| Reasoning control | Per-family reasoning parsers (`qwen3`, `glm45`, `gemma4`, `deepseek_v3`, ...); `reasoning_effort` injects `enable_thinking` into template kwargs | https://docs.vllm.ai/en/latest/features/reasoning_outputs.html | 2026-09-26 |
| Prefix caching | `enable_prefix_caching: bool = True` in source; the engine sets the default from `is_prefix_caching_supported` per model. (The feature page still says "not enabled by default"; the source is current.) | https://github.com/vllm-project/vllm/blob/main/vllm/config/cache.py | 2026-09-26 |
| Prefix-cache isolation | Per-request `cache_salt` restricts reuse to requests with the same salt | https://docs.vllm.ai/en/latest/design/prefix_caching.html | 2026-09-26 |
| Default context | `--max-model-len` derived from the model config when unset | https://docs.vllm.ai/en/latest/configuration/engine_args.html | 2026-09-26 |
| Concurrency | `max_num_seqs` 1024 on GPUs with 70 GiB or more (excluding A100), 256 otherwise; `gpu_memory_utilization` 0.92 | https://github.com/vllm-project/vllm/blob/main/vllm/engine/arg_utils.py | 2026-09-26 |
| Embeddings | Pooling runner, `/v1/embeddings`, `/v2/embed`, `/pooling` | https://docs.vllm.ai/en/latest/models/pooling_models.html | 2026-09-26 |
| gpt-oss specifics | Chat Completions tools via `--tool-call-parser openai`; function calling "only supports `tool_choice="auto"`"; Responses API streaming "fairly barebone" | https://docs.vllm.ai/projects/recipes/en/latest/OpenAI/GPT-OSS.html | 2026-09-26 |

### 1.5 MLX (`mlx_lm.server`, Apple)

| Capability | Finding | Source | Read |
|---|---|---|---|
| Positioning | "not recommended for production as it only implements basic security checks" | https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md | 2026-09-26 |
| Endpoints | `/v1/chat/completions`, `/v1/completions`, `/v1/models`; no embeddings route in source | https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py | 2026-09-26 |
| Tool calling | Accepts `tools` when the tokenizer declares tool calling, else errors "Received tools but model does not support tool calling"; parse failures logged as "tool text was likely truncated mid-generation" | same | 2026-09-26 |
| Structured outputs | **not found** (no `response_format` in source) | same | 2026-09-26 |
| Reasoning control | `chat_template_kwargs` (e.g. `{"enable_thinking":false}`); no `reasoning_effort` field found | same | 2026-09-26 |
| Defaults | `max_tokens` 512, temperature 0.0 | https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md | 2026-09-26 |
| Batching and cache | `--decode-concurrency` 32, `--prompt-concurrency` 8; LRU prompt cache, `--prompt-cache-size` 10; a quantized KV cache (`--kv-bits`) disables batching | https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py | 2026-09-26 |

### 1.6 Summary matrix (derived from 1.1-1.5)

| | Ollama | LM Studio | llama.cpp | vLLM | mlx_lm.server |
|---|---|---|---|---|---|
| Native tools, OpenAI shape | yes | yes (native or injected default) | yes (`--jinja`) | yes (parser flag) | yes if tokenizer supports |
| `tool_choice` | no | none/auto/required (required: GGUF only) | `/v1/messages` any/tool | auto/required/none/named | not found |
| JSON-schema constrained output | yes | yes | yes | yes | not found |
| Streaming tool calls | yes | yes | yes | yes | yes (parser on stream) |
| Thinking control over OpenAI API | `reasoning_effort` | Responses API only | `reasoning_effort`, `chat_template_kwargs` | `reasoning_effort`, `chat_template_kwargs` | `chat_template_kwargs` |
| Cross-request KV reuse | MLX runner: prefix trie | MLX: 256-token checkpoints | `cache_prompt`, slots, host cache | automatic prefix caching | LRU prompt cache |
| Embeddings endpoint | yes | yes | yes (`--embedding`) | yes (pooling runner) | no |
| Default context | 4k / 32k / 256k by VRAM | 8k | model's training context, fitted | model config | model config; 512 output tokens |
| Default concurrency | 1 per model | 4 | auto slots | 256 or 1024 sequences | 32 decode / 8 prefill |

---

## 2. Models

### 2.1 Identity, context, tool format

| Model | Class | Params (total / active) | Released | License | Context | Tool format / vLLM parser | Thinking control | Source | Read |
|---|---|---|---|---|---|---|---|---|---|
| gpt-oss-20b | MoE | 20.91B / 3.61B | 2025-08 | Apache-2.0 | 131,072 | Harmony format, calls on the `commentary` channel; vLLM `openai` | "Reasoning: low/medium/high" in system prompt | https://arxiv.org/html/2508.10925v1 | 2026-09-26 |
| gpt-oss-120b | MoE | 116.83B / 5.13B | 2025-08 | Apache-2.0 | 131,072 | same | same | https://arxiv.org/html/2508.10925v1 | 2026-09-26 |
| gpt-oss format rule | — | — | — | — | — | "should only be used with the harmony format as it will not work correctly otherwise" | — | https://huggingface.co/openai/gpt-oss-20b | 2026-09-26 |
| Qwen3-8B / 14B / 32B / 30B-A3B | dense / MoE | — | 2025 | Apache-2.0 | — | Hermes-style `<tool_call>` JSON; vLLM `hermes` | `enable_thinking` | https://qwen.readthedocs.io/en/latest/framework/function_call.html | 2026-09-26 |
| Qwen3.5-9B (also 0.8B/2B/4B) | dense, hybrid Gated DeltaNet | 9.65B | 2026-02-27 | Apache-2.0 | 262,144 | vLLM `qwen3_coder`, reasoning `qwen3` | thinking on by default | https://huggingface.co/Qwen/Qwen3.5-9B | 2026-09-26 |
| Qwen3.5-27B / 35B-A3B / 122B-A10B / 397B-A17B | dense / MoE | 122B-A10B: 125.1B total | 2026-02-16..24 | Apache-2.0 | 262,144 | `qwen3_coder` | same | https://huggingface.co/Qwen/Qwen3.5-122B-A10B | 2026-09-26 |
| Qwen3.6-35B-A3B | MoE, hybrid | 35.95B / 3B | 2026-04-15 | Apache-2.0 | 262,144 (1.01M with YaRN) | `qwen3_coder`, reasoning `qwen3` | `enable_thinking`, `preserve_thinking`; card: keep "at least 128K tokens to preserve thinking capabilities" | https://huggingface.co/Qwen/Qwen3.6-35B-A3B | 2026-09-26 |
| Qwen3.6-27B | dense, hybrid | 27.78B | 2026-04-21 | Apache-2.0 | 262,144 | `qwen3_coder`, reasoning `qwen3` | same | https://huggingface.co/Qwen/Qwen3.6-27B | 2026-09-26 |
| Qwen3.8-27B | dense; 16 x (3 Gated DeltaNet + 1 Gated Attention) | 27.78B | 2026-08-05 | Apache-2.0 | 262,144 (1M with YaRN) | parser **not found** in card | `reasoning_effort` xhigh (default) / medium / low; `preserve_thinking` | https://huggingface.co/Qwen/Qwen3.8-27B | 2026-09-26 |
| Qwen3.8-Flash-Next | MoE | 125B / 6B (+51B n-gram embedding) | 2026-08-24 | qwen-community-1.0 | 262,144 | **not found** | `reasoning_effort`, `enable_thinking` | https://huggingface.co/Qwen/Qwen3.8-Flash-Next | 2026-09-26 |
| Qwen release list (all dates above) | — | — | — | — | — | — | — | https://huggingface.co/api/models?author=Qwen&sort=createdAt&direction=-1 | 2026-09-26 |
| Gemma 4 E2B / E4B / 12B / 26B-A4B / 31B | dense + one MoE (26B: 25.2B / 3.8B) | see name | 2026-04-02 (12B later) | Apache-2.0 | 128K (E2B, E4B); 256K (12B, 26B, 31B) | Special tokens: `<\|tool_call>call:name{...}<tool_call\|>` | `<\|think\|>` token in system prompt | https://ai.google.dev/gemma/docs/core/model_card_4 | 2026-09-26 |
| Gemma 4 function-call format | — | — | — | — | — | "Always validate function names and arguments before execution" | — | https://ai.google.dev/gemma/docs/capabilities/function-calling | 2026-09-26 |
| Devstral Small 2 (2512) | dense | 24.0B | 2025-11-28 | Apache-2.0 | 256k | vLLM `mistral`; recommended temperature 0.15 | — | https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512 | 2026-09-26 |
| Mistral Small 4 (2603) | MoE, 128 experts / 4 active | 119B / 6.5B | 2026-01-23 | Apache-2.0 | 256k | vLLM `mistral` | `reasoning_effort` `none` / `high` | https://huggingface.co/mistralai/Mistral-Small-4-119B-2603 | 2026-09-26 |
| Ministral 3 8B / 14B (2512) | dense | 8.9B / 13.9B | 2025-10-31 | Apache-2.0 | **not found** | **not found** | — | https://huggingface.co/api/models/mistralai/Ministral-3-8B-Instruct-2512 | 2026-09-26 |
| GLM-4.7-Flash | MoE "30B-A3B" | 31.2B | 2026-01-19 | MIT | **not found** in card | vLLM `glm47`, reasoning `glm45`; "Preserved Thinking" for multi-turn agents | — | https://huggingface.co/zai-org/GLM-4.7-Flash | 2026-09-26 |
| GLM-5.3-Flash | — | 321B | 2026-08-25 | MIT | — | — | — | https://huggingface.co/api/models/zai-org/GLM-5.3-Flash | 2026-09-26 |
| Granite 4.2 3B / 8B / 30B | dense | 8.79B (8B) | 2026-08-25 | Apache-2.0 | 128K (512K extended) | XML `<tool_call><function=name><parameter=...>`; vLLM `qwen3_coder` | `enable_thinking`, `low_effort` | https://huggingface.co/ibm-granite/granite-4.2-8b | 2026-09-26 |
| Nemotron 3.5 Lightning 30B-A3B | Mamba-2 + MoE + attention | 30B / 3B | 2026-08-11 | NVIDIA (other) | up to 1M (256K on one H100) | vLLM/SGLang `qwen3_coder` | `enable_thinking` | https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 | 2026-09-26 |
| Muse Glimmer 30B (Meta Superintelligence Labs) | — | 30B + 1.8B vision encoder | 2026-08-10 | Apache-2.0 | 128K+ | "low-latency, back-to-back tool calling" (no format given) | low/medium/high/xhigh | https://ollama.com/blog/muse-glimmer | 2026-09-26 |
| Llama 3.3 70B / Llama 4 Scout / Maverick | dense / MoE | — | 2024-11 / 2025-04 | Llama community | **not found** (cards gated) | vLLM `llama3_json`, `llama4_pythonic` | — | https://docs.vllm.ai/en/latest/features/tool_calling.html | 2026-09-26 |
| DeepSeek-V4-Flash (0731) / V4.1-Flash | MoE | 304B / 763B total | 2026-07-31 / 2026-09-10 | MIT | — | vLLM `deepseek_v31` family | — | https://huggingface.co/api/models?author=deepseek-ai&sort=createdAt&direction=-1 | 2026-09-26 |
| Kimi K2.6 / K2.7-Code / K3 | MoE | K3: 2.78T total | 2026-04..06 | other | — | vLLM `kimi_k2` | — | https://huggingface.co/api/models?author=moonshotai&sort=createdAt&direction=-1 | 2026-09-26 |

DeepSeek V4, Kimi K3 and GLM-5.3 are server-class only: none fits the 128 GB tier at 4-bit. MiniMax open
text models: the Hugging Face listing for `MiniMaxAI` returned only music, video and image models in this
pass, so the MiniMax-M line is **not verified**.

### 2.2 Tool-call reliability, independent (BFCL V4, Berkeley; leaderboard "Last Updated: 2026-04-12")

Overall accuracy and selected categories. **Relevance** = the model calls a tool when one fits; **Irrelevance**
= the model abstains when none fits (1 minus this is the hallucinated-call rate on that set). Multi-turn
is the closest proxy for an agent loop. BFCL V4 has **no entries** for gpt-oss, Qwen3.5/3.6/3.8, Gemma 4,
Devstral 2, GLM-4.7/5.x, Granite 4.2 or Nemotron 3.5 as of its last update.

| Model (mode) | Overall | Non-live AST | Live | Multi-turn | Relevance | Irrelevance | Source | Read |
|---|---|---|---|---|---|---|---|---|
| Claude-Opus-4.5 (FC), reference ceiling | 77.47 | 88.58 | 79.79 | 68.38 | 62.50 | 84.72 | https://gorilla.cs.berkeley.edu/data_overall.csv | 2026-09-26 |
| GLM-4.6 (FC thinking), best open | 72.38 | 87.56 | 80.90 | 68.00 | 75.00 | 84.96 | same | 2026-09-26 |
| Kimi-K2-Instruct (FC) | 59.06 | 81.60 | 78.68 | 50.63 | 75.00 | 87.34 | same | 2026-09-26 |
| DeepSeek-V3.2-Exp (Prompt + Thinking) | 56.73 | 85.52 | 76.02 | 44.88 | 93.75 | 67.00 | same | 2026-09-26 |
| xLAM-2-32b-fc-r (FC), CC-BY-NC | 54.66 | 89.60 | 75.50 | 69.50 | 81.25 | 80.23 | same | 2026-09-26 |
| Qwen3-235B-A22B-Instruct-2507 (Prompt) | 52.15 | 90.33 | 78.68 | 44.62 | 93.75 | 78.89 | same | 2026-09-26 |
| Qwen3-32B (FC) | 48.71 | 88.77 | 82.01 | 47.87 | 93.75 | 76.37 | same | 2026-09-26 |
| Qwen3-8B (FC) | 42.57 | 87.58 | 80.53 | 41.75 | 93.75 | 79.07 | same | 2026-09-26 |
| Qwen3-30B-A3B-Instruct-2507 (FC) | 41.39 | 85.77 | 77.94 | 30.00 | 81.25 | 79.90 | same | 2026-09-26 |
| Qwen3-14B (FC) | 41.03 | 84.94 | 80.01 | 34.75 | 87.50 | 81.94 | same | 2026-09-26 |
| Llama-4-Maverick-17B-128E (FC) | 37.29 | 88.65 | 73.65 | 20.25 | 100.00 | 55.97 | same | 2026-09-26 |
| Mistral-small-2506 (FC) | 37.15 | — | — | — | — | — | same | 2026-09-26 |
| Llama-3.3-70B-Instruct (FC) | 31.90 | 88.02 | 76.61 | 21.50 | 100.00 | 53.53 | same | 2026-09-26 |
| Gemma-3-12b-it (Prompt) | 30.43 | 79.44 | 74.24 | 5.75 | 93.75 | 70.29 | same | 2026-09-26 |
| Gemma-3-27b-it (Prompt) | 29.47 | 87.17 | 74.54 | 10.75 | 81.25 | 73.67 | same | 2026-09-26 |
| Llama-4-Scout-17B-16E (FC) | 28.13 | 89.38 | 74.69 | 9.00 | 100.00 | 44.92 | same | 2026-09-26 |
| Llama-3.1-8B-Instruct (Prompt) | 25.83 | 84.00 | 70.76 | 11.12 | 93.75 | 42.70 | same | 2026-09-26 |
| Llama-3.2-3B-Instruct (FC), Trent's current Ollama default family | 21.95 | 82.67 | 58.33 | 4.00 | 87.50 | 52.06 | same | 2026-09-26 |
| Leaderboard version and date | "BFCL V4", "Last Updated: 2026-04-12" | | | | | | https://gorilla.cs.berkeley.edu/leaderboard.html | 2026-09-26 |

Reading: single calls (AST columns) are 80-90% for nearly every open model above 7B. The gap is in
**multi-turn** (4-48% for local-sized models versus 68% for the best) and, for the Llama family,
**irrelevance** (44-56%: roughly half the time they call a tool when none fits).

### 2.3 Agent benchmarks, vendor-reported (not comparable across vendors)

| Model | Benchmark: score | Compared in the same table | Source | Read |
|---|---|---|---|---|
| gpt-oss-120b | Tau-Bench Retail: 49.4 / 62.0 / 67.8 (low / medium / high reasoning) | — | https://arxiv.org/html/2508.10925v1 | 2026-09-26 |
| gpt-oss-20b | Tau-Bench Retail: 35.0 / 47.3 / 54.8 | — | https://arxiv.org/html/2508.10925v1 | 2026-09-26 |
| Qwen3.5-9B / Qwen3.5-4B | BFCL-V4 66.1 / 50.3; TAU2 79.1 / 79.9 | Qwen3-30B-A3B-Thinking-2507: BFCL-V4 42.4, TAU2 41.9 | https://huggingface.co/Qwen/Qwen3.5-9B | 2026-09-26 |
| Qwen3.5-122B-A10B / 27B / 35B-A3B | BFCL-V4 72.2 / 68.5 / 67.3; TAU2 79.5 / 79.0 / 81.2; Terminal Bench 2: 49.4 / 41.6 / 40.5 | GPT-5-mini: BFCL-V4 55.5, TAU2 69.8, TB2 31.9; GPT-OSS-120B TB2 18.7 | https://huggingface.co/Qwen/Qwen3.5-122B-A10B | 2026-09-26 |
| Qwen3.6-35B-A3B | TAU3-Bench 67.2; MCPMark 37.0; MCP-Atlas 62.8; Terminal-Bench 2.0 51.5; SWE-bench Verified 73.4 | Gemma4-31B: TAU3 67.5, MCPMark 18.1; Gemma4-26B-A4B: TAU3 59.0, MCPMark 14.2; Qwen3.5-27B: TAU3 68.4, MCPMark 36.3 | https://huggingface.co/Qwen/Qwen3.6-35B-A3B | 2026-09-26 |
| Qwen3.6-27B | SWE-bench Verified 77.2; Terminal-Bench 2.0 59.3 | — | https://huggingface.co/Qwen/Qwen3.6-27B | 2026-09-26 |
| Qwen3.8-27B | Terminal Bench 2.1 73.0; CoWorkBench 70.7; OSWorld-Verified 84.3 | Qwen3.6-27B: 63.4 / 61.0 / 63.9; Muse Glimmer-30B: TB2.1 51.7, OSWorld 65.9 | https://huggingface.co/Qwen/Qwen3.8-27B | 2026-09-26 |
| Qwen3.8-Flash-Next | Toolathlon Verified 73.5; SWE-bench Pro 62.5 | — | https://huggingface.co/Qwen/Qwen3.8-Flash-Next | 2026-09-26 |
| Gemma 4 31B / 26B-A4B / 12B / E4B / E2B | Tau2 (average over 3): 76.9 / 68.2 / 69.0 / 42.2 / 24.5 | Gemma 3 27B: 16.2 | https://huggingface.co/google/gemma-4-31B-it | 2026-09-26 |
| GLM-4.7-Flash | tau2-Bench 79.5; SWE-bench Verified 59.2 | Qwen3-30B-A3B-Thinking-2507: 49.0 / 22.0; GPT-OSS-20B: 47.7 / 34.0 | https://huggingface.co/zai-org/GLM-4.7-Flash | 2026-09-26 |
| Granite 4.2 3B / 8B / 30B | BFCL v4 52.41 / 52.39 / 61.39; tau3-bench avg 45.78 / 58.06 / 62.00 | — | https://huggingface.co/ibm-granite/granite-4.2-8b | 2026-09-26 |
| Devstral Small 2 (24B) / Devstral 2 (123B) | SWE-bench Verified 68.0 / 72.2; Terminal Bench 2: 22.5 / 32.6 | — | https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512 | 2026-09-26 |
| Nemotron 3.5 Lightning | SWE-bench Verified 51.56; Terminal-Bench 2.1 24.58 | Qwen3.6-35B-A3B: 70.12 / 44.38; Gemma 4 26B-A4B: 57.40 / 37.22; GPT-OSS-20B: 52.44 / 15.17 | https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 | 2026-09-26 |
| Mistral Small 4 | tau2 / BFCL / SWE-bench: **not found** in card | — | https://huggingface.co/mistralai/Mistral-Small-4-119B-2603 | 2026-09-26 |

### 2.4 Memory at common quantizations (GGUF file size; add KV cache and buffers)

| Model | Q3_K_M | Q4_K_M | Q6_K | Q8_0 | Other | Source | Read |
|---|---|---|---|---|---|---|---|
| Qwen3.5-9B | 4.7 GB | 5.7 GB | 7.5 GB | 9.5 GB | — | https://huggingface.co/unsloth/Qwen3.5-9B-GGUF | 2026-09-26 |
| Qwen3-8B | 4.1 GB | 5.0 GB | 6.7 GB | 8.7 GB | — | https://huggingface.co/unsloth/Qwen3-8B-GGUF | 2026-09-26 |
| Ministral 3 8B | 4.2 GB | 5.2 GB | 7.0 GB | 9.0 GB | — | https://huggingface.co/unsloth/Ministral-3-8B-Instruct-2512-GGUF | 2026-09-26 |
| Granite 4.2 8B | 4.3 GB | 5.3 GB | 7.2 GB | 9.3 GB | — | https://huggingface.co/ibm-granite/granite-4.2-8b-GGUF | 2026-09-26 |
| Gemma 4 E4B | 4.1 GB | 5.0 GB | 7.1 GB | 8.2 GB | — | https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF | 2026-09-26 |
| Gemma 4 12B (Google QAT) | — | — | — | — | Q4_0 QAT 7.0 GB | https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf | 2026-09-26 |
| Ministral 3 14B | 6.7 GB | 8.2 GB | 11.1 GB | 14.4 GB | — | https://huggingface.co/unsloth/Ministral-3-14B-Instruct-2512-GGUF | 2026-09-26 |
| gpt-oss-20b | — | — | — | — | MXFP4 12.1 GB; 17.9 GB total at full 131k context | https://huggingface.co/ggml-org/gpt-oss-20b-GGUF ; https://github.com/ggml-org/llama.cpp/discussions/15396 | 2026-09-26 |
| Devstral Small 2 24B | 11.5 GB | 14.3 GB | 19.3 GB | 25.1 GB | — | https://huggingface.co/unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF | 2026-09-26 |
| Gemma 4 26B-A4B | 12.7 GB | 16.9 GB | 23.2 GB | 26.9 GB | MXFP4_MOE 16.6 GB | https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF | 2026-09-26 |
| Qwen3.6-27B | 13.6 GB | 16.8 GB | 22.5 GB | 28.6 GB | — | https://huggingface.co/unsloth/Qwen3.6-27B-GGUF | 2026-09-26 |
| Qwen3.8-27B | — | 16.5 GB | 22.0 GB | 29.0 GB | — | https://huggingface.co/unsloth/Qwen3.8-27B-GGUF | 2026-09-26 |
| Granite 4.2 30B | 14.1 GB | 17.7 GB | 24.0 GB | 31.1 GB | — | https://huggingface.co/ibm-granite/granite-4.2-30b-GGUF | 2026-09-26 |
| GLM-4.7-Flash | 14.6 GB | 18.3 GB | 24.7 GB | 31.8 GB | MXFP4_MOE 17.0 GB | https://huggingface.co/unsloth/GLM-4.7-Flash-GGUF | 2026-09-26 |
| Gemma 4 31B | 14.7 GB | 18.3 GB | 25.2 GB | 32.6 GB | — | https://huggingface.co/unsloth/gemma-4-31B-it-GGUF | 2026-09-26 |
| Qwen3.6-35B-A3B | 16.6 GB | 22.1 GB | 29.3 GB | 36.9 GB | MXFP4_MOE 21.7 GB | https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF | 2026-09-26 |
| Nemotron 3.5 Lightning 30B-A3B | — | 25.3 GB | — | 35.0 GB | MXFP4_MOE 23.2 GB | https://huggingface.co/unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF | 2026-09-26 |
| Qwen3-Coder-Next (80B) | 38.3 GB | 48.5 GB | 65.6 GB | 84.8 GB | — | https://huggingface.co/unsloth/Qwen3-Coder-Next-GGUF | 2026-09-26 |
| gpt-oss-120b | — | — | — | — | MXFP4 63.4 GB; 68.5 GB total at full 131k context | https://huggingface.co/ggml-org/gpt-oss-120b-GGUF ; https://github.com/ggml-org/llama.cpp/discussions/15396 | 2026-09-26 |
| Mistral Small 4 119B | 54.4 GB | 73.8 GB | 99.4 GB | 126.5 GB | — | https://huggingface.co/unsloth/Mistral-Small-4-119B-2603-GGUF | 2026-09-26 |
| Qwen3.5-122B-A10B | 56.4 GB | 76.5 GB | 101.0 GB | 129.9 GB | — | https://huggingface.co/unsloth/Qwen3.5-122B-A10B-GGUF | 2026-09-26 |
| Qwen3.8-Flash-Next | — | UD-Q4_K_XL 111.3 GB | UD-Q6_K_XL 169.2 GB | 188.2 GB | — | https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF | 2026-09-26 |
| Ollama tags (download size) | qwen3.5:9b 6.6 GB; qwen3.6:27b 18 GB; qwen3.6:35b 23 GB (MLX 24 GB); qwen3.8:27b 18 GB; gemma4:12b 7.6 GB; gemma4:26b 19 GB; gemma4:31b 20 GB; qwen3.5:122b 81 GB | | | | | https://ollama.com/library/qwen3.6 ; https://ollama.com/library/gemma4 ; https://ollama.com/library/qwen3.5 ; https://ollama.com/library/qwen3.8 | 2026-09-26 |
| Apple MLX memory, 4096-token prompt | Qwen3-8B 4-bit 5.61 GB; Qwen3-14B 4-bit 9.16 GB; gpt-oss-20b 12.08 GB; Qwen3-30B-A3B 4-bit 17.31 GB | | | | | https://machinelearning.apple.com/research/exploring-llms-mlx-m5 | 2026-09-26 |

Two structural facts for sizing: Qwen3.6/3.8 are hybrid (in Qwen3.8-27B only 1 in 4 layer groups is full
attention: "16 × (3 × (Gated DeltaNet → FFN) → 1 × (Gated Attention → FFN))", https://huggingface.co/Qwen/Qwen3.8-27B,
read 2026-09-26), so their KV cache per token is far below a plain transformer of the same size; and Macs
do not give the GPU all unified memory: "Macs don't allow to utilize the full 16GB memory by the GPU, so in
this case you have to keep part of the layer on the CPU" (https://github.com/ggml-org/llama.cpp/discussions/15396,
read 2026-09-26; the same guide raises the limit on large Macs with `sudo sysctl iogpu.wired_limit_mb=...`).

### 2.5 Measured speed (tokens/second): pp = prompt processing (prefill), tg = generation

| Hardware | Model / quant / runtime | pp (prefill) | tg (decode) | Kind | Source | Read |
|---|---|---|---|---|---|---|
| RTX 4090 24 GB | gpt-oss-20b MXFP4, llama.cpp | 8,022 (2k); 5,112 (32k) | 221.95 | maintainer | https://github.com/ggml-org/llama.cpp/discussions/15396 | 2026-09-26 |
| RTX 5090 32 GB | gpt-oss-20b MXFP4, llama.cpp | 9,848 (2k); 6,291 (32k) | 282.51 | maintainer | same | 2026-09-26 |
| RTX 5090 32 GB | Qwen3.5-35B-A3B Q4_K_XL (~19 GB), llama.cpp | 6,960 (2k); 6,461 (32k) | 194.0 | community (runtime repo) | https://github.com/ggml-org/llama.cpp/discussions/19890 | 2026-09-26 |
| M4 Max 36 GB | gpt-oss-20b MXFP4, llama.cpp Metal | 1,277 (2k); 568 (32k) | 92.36 | maintainer | https://github.com/ggml-org/llama.cpp/discussions/15396 | 2026-09-26 |
| M2 Ultra 192 GB | gpt-oss-20b | 2,191 (2k); 1,219 (32k) | 116.08 | maintainer | same | 2026-09-26 |
| M2 Ultra 192 GB | gpt-oss-120b | 1,245 (2k); 752 (32k) | 79.68 | maintainer | same | 2026-09-26 |
| DGX Spark 128 GB | gpt-oss-120b MXFP4 | 967 (2k); 678 (2k at 32k depth) | 42.00 (34.02 at 32k depth) | maintainer | https://github.com/ggml-org/llama.cpp/discussions/16578 | 2026-09-26 |
| DGX Spark 128 GB | gpt-oss-20b MXFP4 | 2,009 (2k) | 60.85 | maintainer | same | 2026-09-26 |
| M5-family Mac (chip not named) | Qwen3.5-35B-A3B NVFP4, Ollama 0.19 MLX | 1,810 | 112 | vendor | https://ollama.com/blog/mlx | 2026-09-26 |
| MacBook Pro M5 Max | Gemma 4 12B, Ollama MLX, 8,300-token prompt | — | NVFP4 55; q4_K_M 46 | vendor | https://ollama.com/blog/mlx-performance | 2026-09-26 |
| M5 Max 128 GB | Qwen3.5-9B: llama.cpp Q4_K_M vs MLX mxfp4 | — | 70 vs 96 | harness vendor (Hermes) | https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/local-llm-on-mac.md | 2026-09-26 |
| MacBook Pro M5 24 GB | MLX, 4096-token prompt | TTFT "under 10 seconds for a dense 14B", "under 3 seconds for a 30B MoE"; M5 vs M4 TTFT speedup 3.3-4.1x | M5 vs M4 decode speedup 1.19-1.27x | vendor (Apple) | https://machinelearning.apple.com/research/exploring-llms-mlx-m5 | 2026-09-26 |
| 16 GB Mac, any model | — | **not found** | **not found** | — | — | 2026-09-26 |
| 24 GB GPU, dense 27B-31B | — | **not found** | **not found** | — | — | 2026-09-26 |

**Derived:** a cold 16k-token seat prompt on the M4 Max above costs 16,384 / 779 ≈ 21 s of prefill for
gpt-oss-20b (pp16384 = 779.44 in the same source); eleven cold roles ≈ 3.9 minutes per fleet round before
any output. On the RTX 4090 the same prompt is 16,384 / 6,298 ≈ 2.6 s. On Apple hardware, prefill, not
decode, is the budget, which is why cross-request KV reuse is a requirement rather than an optimisation.

---

## 3. Local embeddings

| Model | Params | Dims (MRL) | Max tokens | Prefix / instruction | Quality (as published) | Local serving | Source | Read |
|---|---|---|---|---|---|---|---|---|
| nomic-embed-text v1.5 | 137M | 768 (512/256/128/64) | 8,192 | Required: `search_query:`, `search_document:`, `clustering:`, `classification:` | MTEB 62.28 (768d), 61.96 (512d) | Ollama `nomic-embed-text`, 274 MB, **tag context 2K** | https://huggingface.co/nomic-ai/nomic-embed-text-v1.5 ; https://ollama.com/library/nomic-embed-text | 2026-09-26 |
| nomic-embed-text v2 MoE | 305M | 768 (to 256) | 512 | `search_query: ` / `search_document: ` | BEIR 52.86, MIRACL 65.80 | Ollama `nomic-embed-text-v2-moe` | https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe | 2026-09-26 |
| mxbai-embed-large-v1 | 335M | 1024 (MRL, binary) | 512 | Query prompt "Represent this sentence for searching relevant passages:" | MTEB avg 64.68 (56 datasets) | Ollama `mxbai-embed-large` | https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1 | 2026-09-26 |
| bge-m3 | 567M | 1024 | 8,192 | None required; dense + sparse + multi-vector | MIRACL 69.20 (in Nomic's table) | Ollama `bge-m3` | https://huggingface.co/BAAI/bge-m3 | 2026-09-26 |
| gte-multilingual-base | 305M | 768 (elastic) | 8,192 | — | — | Official Ollama tag **not found** in the embedding catalog | https://huggingface.co/Alibaba-NLP/gte-multilingual-base | 2026-09-26 |
| Qwen3-Embedding-0.6B / 4B / 8B | 0.6B / 4B / 8B | 1024 / 2560 / 4096 (MRL) | 32K | Instruction-aware: `Instruct: {task}\nQuery:{q}`; "1% to 5%" better with instructions; last-token pooling | MTEB multilingual 64.33 / 69.45 / 70.58; MTEB English v2 70.70 / 74.60 / 75.22 | Ollama `qwen3-embedding`; llama.cpp needs `--embedding --pooling last` | https://huggingface.co/Qwen/Qwen3-Embedding-0.6B ; https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF | 2026-09-26 |
| EmbeddingGemma-300m | 300M | 768 (512/256/128) | 2,048 | `task: search result \| query: ...`; documents `title: none \| text: ...` | MTEB v2 multilingual 61.15, English 69.67; "activations do not support float16" | Ollama `embeddinggemma` | https://huggingface.co/google/embeddinggemma-300m | 2026-09-26 |
| Nemotron-3-Embed-1B | 1.14B | 2048 (sliceable) | 32,768 | `query: ` / `passage: ` | RTEB 72.38; MMTEB retrieval 71.04 | vLLM 0.25+; llama.cpp not listed; license OpenMDW-1.1 | https://huggingface.co/nvidia/Nemotron-3-Embed-1B-BF16 | 2026-09-26 |
| Ollama catalogue | nomic-embed-text 87.1M pulls, mxbai 15M, bge-m3 6.9M, qwen3-embedding 4.1M, all-minilm 3.6M, snowflake-arctic-embed 3.1M, embeddinggemma 2.2M | | | | | | https://ollama.com/search?c=embedding | 2026-09-26 |
| Ollama `/v1/embeddings` | Accepts `dimensions` and `encoding_format` | | | | | | https://docs.ollama.com/api/openai-compatibility | 2026-09-26 |

Implications for Trent's recall (which averages ~885 characters per chunk and calibrates a cosine floor per
model): every local model above needs its own measured floor, its own query and document prefixes, and a
re-index on change of model or dimension. Qwen3-Embedding-0.6B (Q8_0 GGUF 639 MB) is the best
quality-per-byte option published; EmbeddingGemma-300m is the smallest multilingual option.

---

## 4. How the leading harnesses handle local models

| Harness | Exact config | What it warns about | What it degrades or changes for local | Source | Read |
|---|---|---|---|---|---|
| Hermes Agent (Nous) | `model: {provider: custom, base_url: http://localhost:11434/v1}`; vLLM `--enable-auto-tool-choice --tool-call-parser hermes --max-model-len 65536`; llama.cpp `--jinja -c 64000`; `lms load <model> --context-length 64000` | "at least 64,000 tokens"; smaller windows "rejected at startup"; system prompt + tool schemas "4k-8k"; "With -c 64000 -np 4, each slot only gets 16k"; without `--jinja` "raw JSON ... printed as a message"; full toolset "can exceed a 32k context window, producing an empty-stream error" | Restrict toolsets (`-t file,web`); `hermes prompt-size` to measure the fixed prompt | https://hermes-agent.nousresearch.com/docs/integrations/providers | 2026-09-26 |
| Hermes Agent | — | Ollama `/api/show` "reports the model's maximum context, not the effective `num_ctx`" | Auto-detects local endpoints: "read timeout raised from 120s to 1800s, stale stream detection disabled" | https://hermes-agent.nousresearch.com/docs/reference/faq | 2026-09-26 |
| Hermes Agent (Ollama guide) | `gemma4:31b` recommended, "Only model with reliable tool calling" of those listed; `OLLAMA_KEEP_ALIVE=24h`; `HERMES_API_TIMEOUT=1800` | Prefill "dominates the first turn"; states Ollama default context 2048 | "Hermes has auto-repair" for malformed calls; "if the local model fails 3 times, Hermes falls back to a cloud provider" | https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup | 2026-09-26 |
| Hermes Agent (Mac guide) | Qwen3.5-9B recommended; `llama-server -c 131072 -np 1 -fa on --cache-type-k q4_0 --cache-type-v q4_0` | KV at 128K: ~4-5 GB at q4 vs ~16 GB at f16 | Uses q4_0 KV (conflicts with llama.cpp's tool-calling warning, §7) | https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/local-llm-on-mac.md | 2026-09-26 |
| Hermes Agent (managed runtime) | `local_runtime: {enabled, backend: auto, detect_ports}` | Never offers builds below 4-bit ("quality loss is too severe") | Guarantees at least 64K context; spills expert weights to RAM first, "never the attention cache"; grows the window, else compresses; unloads idle models after 15 minutes | https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/local-models.md | 2026-09-26 |
| Hermes Agent (repair code) | `_repair_tool_call_arguments()` pass 0 `json.loads(strict=False)`, pass 4 escape 0x00-0x1F | "llama.cpp / Ollama backends emit literal tabs and newlines inside JSON string values" (merged 2026-04-24) | — | https://github.com/NousResearch/hermes-agent/pull/15356 | 2026-09-26 |
| Hermes Agent (open bug) | — | Truncated arguments "silently replaced with {}", the transcript "poisoned" (opened 2026-08-18) | Proposed: treat as failed, inject error, allow retry | https://github.com/NousResearch/hermes-agent/issues/89207 | 2026-09-26 |
| Codex CLI | `codex --oss` or `--local-provider ollama\|lmstudio`; `oss_provider = "ollama"`; `model_context_window = 128000`; `codex exec` errors if no provider set | — | — | https://learn.chatgpt.com/docs/config-file/config-advanced | 2026-09-26 |
| Codex CLI (source) | Default model `gpt-oss:20b` (Ollama) / `openai/gpt-oss-20b` (LM Studio); Responses wire API; refuses Ollama older than 0.13.4 | "Ollama {version} is too old" | Pulls the default model automatically | https://github.com/openai/codex/blob/main/codex-rs/ollama/src/lib.rs | 2026-09-26 |
| Codex CLI (issue, closed) | `model_context_windows` per model | "Codex defaults unknown models to 272K tokens, which causes compaction to never trigger" | — | https://github.com/openai/codex/issues/17261 | 2026-09-26 |
| Codex via Ollama | `ollama launch codex`; `codex --oss -m gpt-oss:120b` | "Use a context window of at least 64k tokens" | — | https://docs.ollama.com/integrations/codex | 2026-09-26 |
| Goose | Ollama provider (`OLLAMA_HOST`); Ramalama needs `--runtime-args="--jinja"` | Models without tool calling "can only do chat completion"; ignoring tools or hints means "default context length of 2048 tokens is too low" | Extensions must be disabled for non-tool models | https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/providers.md | 2026-09-26 |
| Goose tool shim | `GOOSE_TOOLSHIM=true`, interpreter `mistral-nemo` (`GOOSE_TOOLSHIM_OLLAMA_MODEL`) | "experimental" | Second local model turns prose into tool JSON with Ollama structured outputs | https://goose-docs.ai/docs/experimental/ollama/ | 2026-09-26 |
| Goose (measured) | — | "None of the models configured with the toolshim greater than a 41% success rate" (2025-03-31) | Best native open model then: qwen2.5-coder:32b 0.80 | https://goose-docs.ai/blog/2025/03/31/goose-benchmark/ | 2026-09-26 |
| Cline | Enable "Use Compact Prompt" (Settings → Features); Ollama, LM Studio or Atomic Chat | "Start a new task when context gets too large" | Compact prompt required | https://docs.cline.bot/running-models-locally/overview | 2026-09-26 |
| Cline (blog 2025-08-28) | Qwen3 Coder 30B A3B, 4-bit, LM Studio MLX, context 262,144 | KV cache quantization "will persist context between tasks and create unpredictable behavior. Keep it off" | Compact prompt "roughly 10% the size"; "you lose access to MCP tools, Focus Chain, and MTP features" | https://cline.bot/blog/local-models | 2026-09-26 |
| Aider | `.aider.model.settings.yml` → `extra_params: {num_ctx: 65536}` | Ollama "silently discards context that exceeds the window" (states 2k default) | By default sets `num_ctx` to the request plus 8k for the reply | https://aider.chat/docs/llms/ollama.html | 2026-09-26 |
| OpenHands | Qwen3.6-35B-A3B (2026-05-21); LM Studio; model prefix `openai/`; base URL `http://host.docker.internal:1234/v1` | Context minimum 22,000, 32,768 recommended; `OLLAMA_CONTEXT_LENGTH=32768`; 24 GB GPU or 64 GB Mac | "may exhibit chatbot-like behavior or constant failed tool calls" | https://docs.openhands.dev/openhands/usage/llms/local-llms | 2026-09-26 |
| OpenHands | `LLM_NUM_RETRIES` 4, min wait 5 s, max 30 s | "errors about malformed JSON ... try a stronger model, increase the context window" | "Native Tool Calling" toggle | https://docs.openhands.dev/openhands/usage/llms/llms | 2026-09-26 |
| Gemini CLI | `gemini gemma setup`; Gemma 3 1B via LiteRT-LM | "experimental" | Local model only classifies and routes to hosted Gemini; running the agent itself on a local model **not found** | https://geminicli.com/docs/core/local-model-routing/ | 2026-09-26 |

Across harnesses: they all set a context floor (22K-64K), trim the fixed prompt (compact prompt, toolset
restriction), relax timeouts for prefill, and either repair or shim tool calls. None documented
disabling parallel tool calls on its own; the runtimes do that (llama.cpp off by default, vLLM notes on Llama
3 and Mistral).

---

## 5. Known failure modes and mitigations

### 5.1 Failure modes

| # | Failure | Evidence | Source | Read |
|---|---|---|---|---|
| F1 | Silent context truncation: prompt plus tool schemas exceed the window; the model "forgets" tools | Ollama default 4k under 24 GiB VRAM | https://docs.ollama.com/context-length | 2026-09-26 |
| F1 | | Ollama "silently discards context that exceeds the window" | https://aider.chat/docs/llms/ollama.html | 2026-09-26 |
| F1 | | Full toolset over 32k gives "an empty-stream error from llama.cpp-family servers" | https://hermes-agent.nousresearch.com/docs/integrations/providers | 2026-09-26 |
| F1 | | Embeddings truncated by default (`truncate: true`); nomic tag context 2K | https://docs.ollama.com/api/embed ; https://ollama.com/library/nomic-embed-text | 2026-09-26 |
| F1 | | Harness assumes too large a window: Codex's 272K default for unknown models | https://github.com/openai/codex/issues/17261 | 2026-09-26 |
| F1 | | Output ceiling: mlx_lm.server `max_tokens` default 512; SGLang "defaults to 128 max output tokens" | https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md ; https://hermes-agent.nousresearch.com/docs/integrations/providers | 2026-09-26 |
| F2 | Tool call not parsed: server parsing off, so JSON arrives as text | "raw JSON like `{"name": "web_search", ...}` printed as a message" | https://hermes-agent.nousresearch.com/docs/integrations/providers | 2026-09-26 |
| F2 | | LM Studio returns unparseable calls in `message.content` | https://lmstudio.ai/docs/developer/openai-compat/tools | 2026-09-26 |
| F3 | Malformed tool JSON | vLLM auto mode: "arguments may occasionally be malformed or violate the function's parameter schema" | https://docs.vllm.ai/en/latest/features/tool_calling.html | 2026-09-26 |
| F3 | | Literal tabs and newlines inside JSON strings from llama.cpp / Ollama | https://github.com/NousResearch/hermes-agent/pull/15356 | 2026-09-26 |
| F3 | | Qwen: "not guaranteed that the model generation will always follow the protocol" | https://qwen.readthedocs.io/en/latest/framework/function_call.html | 2026-09-26 |
| F4 | Truncated arguments recorded as success | "silently replaced with `{}`" | https://github.com/NousResearch/hermes-agent/issues/89207 | 2026-09-26 |
| F5 | Hallucinated or irrelevant calls | BFCL V4 irrelevance: Llama-4-Scout 44.92, Llama-3.3-70B 53.53, Llama-3.2-3B 52.06; Qwen3-8B 79.07 | https://gorilla.cs.berkeley.edu/data_overall.csv | 2026-09-26 |
| F5 | | Missing-function tasks: the model "must not fabricate function calls" | https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html | 2026-09-26 |
| F6 | No tool call when one was needed | BFCL V4 relevance: Qwen3-14B 87.50, Gemma-3-27b 81.25, Qwen3-30B-A3B-2507 81.25 (misses 12-19%) | https://gorilla.cs.berkeley.edu/data_overall.csv | 2026-09-26 |
| F6 | | OpenHands: "chatbot-like behavior" | https://docs.openhands.dev/openhands/usage/llms/local-llms | 2026-09-26 |
| F7 | Multi-turn collapse | BFCL V4 multi-turn: Qwen3-8B 41.75, Qwen3-30B-A3B-2507 30.00, Gemma-3-12b 5.75, Llama-3.2-3B 4.00 | https://gorilla.cs.berkeley.edu/data_overall.csv | 2026-09-26 |
| F7 | | Root causes observed: skipped prerequisite steps, no state check, redundant steps | https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html | 2026-09-26 |
| F8 | Format sensitivity | Function docs: "highest with functions in JSON format, lower with XML, and lowest with Python"; XML return format hurts "even large LLMs"; small models drop on tag syntax | https://gorilla.cs.berkeley.edu/blogs/17_bfcl_v4_prompt_variation.html | 2026-09-26 |
| F9 | Thinking and format protocol errors | gpt-oss: harmony or it "will not work correctly"; drop prior chain-of-thought after a `final` message but keep it across tool calls | https://huggingface.co/openai/gpt-oss-20b ; https://developers.openai.com/cookbook/articles/openai-harmony | 2026-09-26 |
| F9 | | Qwen: stopword templates such as ReAct are "not recommended" for reasoning models | https://qwen.readthedocs.io/en/latest/framework/function_call.html | 2026-09-26 |
| F10 | KV cache thrash across agents | Ollama: 1 parallel request per model by default; RAM scales with parallel x context; unload after 5 minutes | https://docs.ollama.com/faq | 2026-09-26 |
| F10 | | llama.cpp: slots split context ("-c 64000 -np 4, each slot only gets 16k"); slot picked by prompt similarity 0.10 | https://hermes-agent.nousresearch.com/docs/integrations/providers ; https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md | 2026-09-26 |
| F10 | | mlx_lm.server keeps 10 distinct prompt caches | https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py | 2026-09-26 |
| F11 | Quantized KV cache degrades tool calling | "Beware of extreme KV quantizations (e.g. `-ctk q4_0`)" | https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md | 2026-09-26 |
| F12 | Cold prefill dominates latency | M4 Max, gpt-oss-20b: pp32768 568 t/s; prefill "dominates the first turn" | https://github.com/ggml-org/llama.cpp/discussions/15396 ; https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup | 2026-09-26 |

### 5.2 Mitigations harnesses and runtimes use

| Mitigation | Who does it, how | Source | Read |
|---|---|---|---|
| Grammar-constrained decoding | llama.cpp `json_schema` / `response_format`; Ollama `format`; LM Studio grammar (GGUF) / Outlines (MLX); vLLM xgrammar/guidance | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md ; https://docs.ollama.com/capabilities/structured-outputs ; https://lmstudio.ai/docs/developer/openai-compat/structured-output ; https://docs.vllm.ai/en/latest/features/structured_outputs.html | 2026-09-26 |
| Forced tool use that is valid by construction | vLLM `tool_choice: required` or named uses structured outputs; LM Studio `required` (GGUF); llama.cpp `/v1/messages` `any`/`tool` | https://docs.vllm.ai/en/latest/features/tool_calling.html ; https://lmstudio.ai/blog/lmstudio-v0.3.15 | 2026-09-26 |
| Repair then retry | Hermes repair passes; OpenHands retries (4); Hermes cloud fallback after 3 failures | https://github.com/NousResearch/hermes-agent/pull/15356 ; https://docs.openhands.dev/openhands/usage/llms/llms ; https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup | 2026-09-26 |
| Tool-name allowlist | Google: map names explicitly, never `globals()`; vLLM named function calling | https://ai.google.dev/gemma/docs/capabilities/function-calling | 2026-09-26 |
| Interpreter model for weak tool users | Goose tool shim (measured at no more than 41% success) | https://goose-docs.ai/blog/2025/03/31/goose-benchmark/ | 2026-09-26 |
| Prompt trimming | Cline compact prompt (~10%); Hermes toolset restriction and `hermes prompt-size` | https://cline.bot/blog/local-models ; https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup | 2026-09-26 |
| Per-model templates and parsers | vLLM `--tool-call-parser` per family; llama.cpp `--chat-template-file`; LM Studio injected default format; OpenHands prompt-based fallback | https://docs.vllm.ai/en/latest/features/tool_calling.html ; https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md | 2026-09-26 |
| Context floor enforced at startup | Hermes rejects windows under 64K; aider sets `num_ctx` per request | https://hermes-agent.nousresearch.com/docs/integrations/providers ; https://aider.chat/docs/llms/ollama.html | 2026-09-26 |
| Cross-request KV reuse | Ollama MLX prefix trie; LM Studio MLX checkpoints; llama.cpp `cache_prompt` and slots; vLLM APC | §1 rows | 2026-09-26 |
| Timeouts sized for prefill | Hermes local read timeout 1800 s | https://hermes-agent.nousresearch.com/docs/reference/faq | 2026-09-26 |
| Model kept resident | `OLLAMA_KEEP_ALIVE=24h` | https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup | 2026-09-26 |

---

## 6. Minimum viable local stack by hardware tier

Role mapping for all tiers: planner, critic and the nine role seats share **one chat model** where memory
allows. That shares one prefix cache and avoids model swaps. Only the 128 GB tier splits planner and critic
onto a larger model. The embedder and whisper stay small and resident.

### 6.1 16 GB Mac (Apple Silicon)

| Item | Choice | Evidence | Source | Read |
|---|---|---|---|---|
| Runtime | Ollama with `OLLAMA_CONTEXT_LENGTH=65536`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=24h`; or `llama-server --jinja -c 65536 -np 1` | 64K is the Hermes floor; 1 slot so the window is not split | https://hermes-agent.nousresearch.com/docs/integrations/providers | 2026-09-26 |
| Chat model | Qwen3.5-9B Q4_K_M (5.7 GB file; Ollama `qwen3.5:9b` 6.6 GB) | Hermes's Mac recommendation; vendor BFCL-V4 66.1, TAU2 79.1 | https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/local-llm-on-mac.md ; https://huggingface.co/Qwen/Qwen3.5-9B | 2026-09-26 |
| Alternative | Gemma 4 12B QAT Q4_0 (7.0 GB), 256K window | Vendor Tau2 69.0 | https://ai.google.dev/gemma/docs/core/model_card_4 | 2026-09-26 |
| Not recommended here | gpt-oss-20b | On 16 GB Macs the guide uses `--n-cpu-moe 12 -c 32768`, below the 64K floor | https://github.com/ggml-org/llama.cpp/discussions/15396 | 2026-09-26 |
| KV cache | f16 or `q8_0`, not `q4_0` | q8_0 halves KV memory; q4_0 is llama.cpp's named example of degrading tool calls | https://docs.ollama.com/faq ; https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md | 2026-09-26 |
| Embedder | Qwen3-Embedding-0.6B (Q8_0 639 MB) or `embeddinggemma` | §3 | https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF | 2026-09-26 |
| Audio | whisper.cpp `base` (~388 MB) or `small` (~852 MB) | Memory table | https://github.com/ggml-org/whisper.cpp | 2026-09-26 |
| Speed | **not found** for any model on a 16 GB Mac. Nearest: Apple reports a 14B dense model at under 10 s TTFT for a 4096-token prompt on M5, 3.3-4.1x faster than M4 | Expect tens of seconds of prefill per cold long prompt on M1-M4 | https://machinelearning.apple.com/research/exploring-llms-mlx-m5 | 2026-09-26 |
| Honest quality | Planning: weak; use the planner for short, explicit plans only. Tool execution: single calls mostly right; chains of 3+ calls fail often. Closest independent measure: Qwen3-8B (FC) non-live AST 87.58, multi-turn 41.75 | BFCL V4 | https://gorilla.cs.berkeley.edu/data_overall.csv | 2026-09-26 |

### 6.2 32-64 GB Mac, or one 24 GB GPU

| Item | Choice | Evidence | Source | Read |
|---|---|---|---|---|
| Runtime, 24 GB GPU | `llama-server --jinja -c 131072` with 2-4 slots (keep each slot at 64K or more), or vLLM on Linux | Prefix cache and slots in §1.3 | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md | 2026-09-26 |
| Runtime, Mac | Ollama 0.19+ MLX runner (`-mlx` tags), or LM Studio MLX engine 1.8.5+ | Cross-conversation cache reuse; 256-token checkpoints | https://ollama.com/blog/mlx ; https://lmstudio.ai/blog/mlx-engine-agentic-workloads | 2026-09-26 |
| Chat model, 24 GB GPU / 32 GB Mac | Qwen3.6-27B Q4_K_M (16.8 GB) or Qwen3.8-27B (16.5 GB); hybrid attention keeps KV small | Vendor: Qwen3.6-27B SWE-bench Verified 77.2; Qwen3.8-27B Terminal Bench 2.1 73.0 vs 63.4 | https://huggingface.co/Qwen/Qwen3.6-27B ; https://huggingface.co/Qwen/Qwen3.8-27B | 2026-09-26 |
| Alternative | Gemma 4 26B-A4B Q4_K_M (16.9 GB) or 31B (18.3 GB) | Hermes's Ollama pick is `gemma4:31b`; vendor Tau2 68.2 / 76.9 | https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup ; https://ai.google.dev/gemma/docs/core/model_card_4 | 2026-09-26 |
| Speed-first alternative | gpt-oss-20b MXFP4 (12.1 GB; 17.9 GB at full context) | RTX 4090: 222 t/s decode, 8,022 t/s pp2k; M4 Max: 92 t/s, 1,277 pp2k | https://github.com/ggml-org/llama.cpp/discussions/15396 | 2026-09-26 |
| Chat model, 48-64 GB Mac | Qwen3.6-35B-A3B (Ollama `qwen3.6:35b-mlx` 24 GB) | OpenHands's first local pick (2026-05-21), 64 GB Mac for quantized; Ollama MLX needs over 32 GB; Qwen3.5-35B-A3B at 1,810 prefill / 112 decode t/s on M5 | https://docs.openhands.dev/openhands/usage/llms/local-llms ; https://ollama.com/blog/mlx | 2026-09-26 |
| Qwen3.6-35B-A3B on 24 GB: marginal | OpenHands says a 24 GB GPU runs quantized variants, with context set to 22,000-32,768. But the Q4_K_M file is 22.1 GB, leaving under 2 GB for KV and buffers, so reaching the 64K floor on 24 GB means UD-Q3_K_M (16.6 GB) or offloading experts to CPU (derived) | GGUF sizes; OpenHands requirements | https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF ; https://docs.openhands.dev/openhands/usage/llms/local-llms | 2026-09-26 |
| Embedder | Qwen3-Embedding-0.6B (or 4B on 64 GB) | §3 | https://huggingface.co/Qwen/Qwen3-Embedding-0.6B | 2026-09-26 |
| Audio | whisper.cpp `small` or `medium` (~2.1 GB) | | https://github.com/ggml-org/whisper.cpp | 2026-09-26 |
| Honest quality | Tool execution: good on short chains, with constrained decoding. Planning: adequate for bounded, well-specified tasks, below hosted frontier. Vendor TAU3 67.2 (Qwen3.6-35B-A3B), 67.5 (Gemma4-31B). Independent anchor from the previous generation: Qwen3-32B (FC) multi-turn 47.87 versus Claude Opus 4.5 at 68.38 | | https://huggingface.co/Qwen/Qwen3.6-35B-A3B ; https://gorilla.cs.berkeley.edu/data_overall.csv | 2026-09-26 |

### 6.3 128 GB+ unified memory, or multi-GPU

| Item | Choice | Evidence | Source | Read |
|---|---|---|---|---|
| Runtime | Multi-GPU Linux: vLLM (prefix caching on, `tool_choice: required` valid by construction, 256+ sequences). 128 GB Mac or DGX Spark: llama.cpp or Ollama; on Mac raise `iogpu.wired_limit_mb` | §1.4; llama.cpp guide | https://docs.vllm.ai/en/latest/features/tool_calling.html ; https://github.com/ggml-org/llama.cpp/discussions/15396 | 2026-09-26 |
| Planner + critic | gpt-oss-120b (63.4 GB; 68.5 GB at full 131k) | Tau-Bench Retail 67.8 at high reasoning; M2 Ultra 79.7 t/s, DGX Spark 42.0 t/s decode | https://arxiv.org/html/2508.10925v1 ; https://github.com/ggml-org/llama.cpp/discussions/16578 | 2026-09-26 |
| Planner + critic, alternative | Qwen3.5-122B-A10B Q4_K_M (76.5 GB) | Vendor BFCL-V4 72.2, TAU2 79.5, TB2 49.4 vs GPT-5-mini 55.5 / 69.8 / 31.9 in the same table | https://huggingface.co/Qwen/Qwen3.5-122B-A10B | 2026-09-26 |
| Seats | Qwen3.6-35B-A3B Q4_K_M (22.1 GB) with 4 slots | §6.2 | https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF | 2026-09-26 |
| Memory check (derived) | 63.4 + 22.1 = 85.5 GB of weights, plus KV, embedder, whisper; fits 128 GB only with the GPU wired limit raised | | — | 2026-09-26 |
| Too big for this tier at 4-bit | Qwen3.8-Flash-Next (UD-Q4_K_XL 111.3 GB) alone fills it; GLM-5.3-Flash 321B; DeepSeek-V4-Flash 304B | | https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF | 2026-09-26 |
| Embedder | Qwen3-Embedding-4B or 8B | MTEB multilingual 69.45 / 70.58 | https://huggingface.co/Qwen/Qwen3-Embedding-0.6B | 2026-09-26 |
| Audio | whisper.cpp `large` (~3.9 GB) | | https://github.com/ggml-org/whisper.cpp | 2026-09-26 |
| Honest quality | Planning: close to mid-tier hosted models on vendor evals; still below the best hosted models on long multi-turn work (independent BFCL V4: best open GLM-4.6 72.38 vs Claude Opus 4.5 77.47). Tool execution: reliable with constrained decoding and repair | | https://gorilla.cs.berkeley.edu/data_overall.csv | 2026-09-26 |

---

## 7. Conflicts and caveats found in the sources

| Conflict | Side A | Side B | Resolution for Trent | Read |
|---|---|---|---|---|
| Ollama default context | Ollama docs: 4k / 32k / 256k by VRAM (https://docs.ollama.com/context-length) | Hermes, Aider and Goose docs say 2048 (https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup ; https://aider.chat/docs/llms/ollama.html) | Trust neither default: read the effective value from the server (`ollama ps` CONTEXT) and set it explicitly | 2026-09-26 |
| KV cache quantization | Hermes Mac guide uses `q4_0` K and V (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/local-llm-on-mac.md) | llama.cpp: q4_0 KV "can substantially degrade the model's tool calling" (https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md); Cline: keep it off (https://cline.bot/blog/local-models) | Default f16 or q8_0; the doctor warns on q4_0 | 2026-09-26 |
| vLLM prefix caching default | Feature page: "not enabled by default" (https://docs.vllm.ai/en/latest/features/automatic_prefix_caching.html) | Source: `enable_prefix_caching: bool = True` (https://github.com/vllm-project/vllm/blob/main/vllm/config/cache.py) | Treat as on where the model supports it; verify with a cached-token count | 2026-09-26 |
| Vendor vs independent tool scores | Qwen3.5-9B BFCL-V4 66.1 self-reported (https://huggingface.co/Qwen/Qwen3.5-9B) | Berkeley's own board has no Qwen3.5 entry; previous-gen Qwen3-8B measures 42.57 (https://gorilla.cs.berkeley.edu/data_overall.csv) | Measure with Trent's own doctor smoke test, per model | 2026-09-26 |
| Qwen3.6-35B-A3B on a 24 GB GPU | OpenHands: "at least 24GB of VRAM for quantized variants", context 22,000-32,768 (https://docs.openhands.dev/openhands/usage/llms/local-llms) | Q4_K_M file alone is 22.1 GB (https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) | On 24 GB, prefer a 27B dense model at the 64K floor; use 35B-A3B only at Q3 or with expert offload, and let the doctor's memory check (D5) decide | 2026-09-26 |
| Qwen3.6 context advice | Card: keep at least 128K "to preserve thinking capabilities" (https://huggingface.co/Qwen/Qwen3.6-35B-A3B) | Hermes floor is 64K | 64K is the floor for fitting; 128K preferred for Qwen3.6 when memory allows | 2026-09-26 |

---

## 8. Requirements for a harness: what Trent must do to run a local stack well

Each item names the component, the requirement and a test that fails today and passes when it is done.
File references are where the change would land in `packages/trent-core/src` (apps/web stays read-only).

### 8.1 Gateway (`model-gateway/`)

| ID | Requirement | Test | Evidence |
|---|---|---|---|
| G1 | Route every local alias (`ollama`, `lmstudio`, plus new `llamacpp`, `vllm`, `mlx`) through a Trent-side OpenAI-compatible streamer (the Google one generalised) that sends `stream_options.include_usage`, `max_tokens`, and `reasoning_effort` when the model supports it | Unit: fetch mock asserts the request body for `ollama` contains `include_usage: true` and `reasoning_effort`; the `model_gateway.reasoning_effort_not_sent` log no longer fires for local aliases | §1.1, §1.3, §1.4 |
| G2 | For planner, critic and seat JSON turns on a local provider, send `response_format: {type: "json_schema", json_schema: <turn schema>}` instead of only a system-message instruction | Unit: body contains the schema; live (skip if no server): 20 seat turns against Ollama parse on the first attempt 20/20 | §1.6, §5.2 |
| G3 | Turn schema lists the allowed tool names as an `enum` (per seat) so decoding cannot produce an unknown tool | Unit: generated schema's `tool` enum equals the seat's allowlist exactly | F5, §5.2 |
| G4 | Effective context contract: read the real window from the server (`/api/ps` or `ollama ps` for Ollama, `/props` `n_ctx` for llama.cpp, the loaded config for LM Studio, `max_model_len` for vLLM), never the model maximum; refuse a request whose prompt plus reply reserve exceeds it, with a typed error, before any network call | Unit: 70K-token prompt against a mocked 64K window raises `ContextBudgetExceeded`, no request sent | F1, Hermes `/api/show` note |
| G5 | Local timeouts sized for prefill: time-to-first-token budget of max(600 s, 2 x measured prefill time for this prompt size), separate from the cloud 60 s | Unit: mock server that sends its first byte after 90 s succeeds for `ollama`, times out for `openai` | F12, Hermes 1800 s |
| G6 | Per-endpoint concurrency cap equal to the server's slots (Ollama `OLLAMA_NUM_PARALLEL`, llama.cpp `/slots` count, LM Studio max concurrent predictions); excess calls queue in the gateway, not at the server | Unit: 11 concurrent seat calls against a mock with capacity 2 never exceed 2 in flight and all complete | F10 |
| G7 | Family-aware thinking handling: gpt-oss harmony rules (keep reasoning across tool calls, drop after `final`); Qwen `preserve_thinking` passthrough; strip `<think>...</think>` before JSON extraction | Unit: reply `<think>{"a":1}</think>{"toolCall":...}` extracts the second object | F9 |
| G8 | Explicit `max_tokens` on every local call, sized to the schema (mlx_lm default is 512, SGLang 128) | Unit: every local request body has `max_tokens` at or above the turn's configured minimum | F1 |
| G9 | Change the Ollama default from `llama3.2` to a tier-selected model (§6), and refuse a model whose `/api/show` capabilities lack `tools` | Unit: setup on a mocked 16 GB machine proposes `qwen3.5:9b`; a model without `tools` fails setup with a clear message | §0.1, §2.2 |
| G10 | Per-model sampling profile (Qwen: temperature/top_p/top_k/presence_penalty per mode; Devstral temperature 0.15) | Unit: profile lookup returns the card's values for each supported family | §2.1 |

### 8.2 Prompts and tool disclosure (`tools/`, `orchestrator/`)

| ID | Requirement | Test | Evidence |
|---|---|---|---|
| P1 | For local profiles, replace the nested `toolCall.action = "<tool> <json>"` string with a flat `{tool, args}` object; keep `parseAction` accepting both | Unit: a local-profile turn `{"tool":"read_file","args":{"path":"x"}}` executes the same adapter call as the legacy string form | F3, F8 |
| P2 | Render tool definitions as JSON Schema (not the custom text form) on local profiles | Snapshot: local-profile seat prompt contains JSON schemas and no `action = "...` lines | F8 |
| P3 | Fixed-prompt budget per seat: system prompt plus advertised tool schemas at most 25% of the effective window (16K at 64K); a `trent prompt-size --seat <role>` command reports it | CI: every seat's measured fixed prompt at or below budget on the 64K profile | F1, Hermes `prompt-size` |
| P4 | Lower `tools.disclosure_threshold` on local profiles so each seat advertises at most a small core set, the rest through `tool_search` | Unit: local profile advertises at most N (e.g. 8) tools per seat | Cline compact prompt, Hermes toolsets |
| P5 | Byte-stable prefix per seat: no timestamps, run IDs or reordered lists before the first variable message; volatile content last | Unit: two consecutive turns of one seat share an identical prefix of at least 90% of prompt tokens; live: second call reports cached prompt tokens (llama.cpp `cache_n`, OpenAI `cached_tokens`) above 0 | F10, F12 |

### 8.3 Retries and repair (`model-gateway/retry.ts`, tool bridge)

| ID | Requirement | Test | Evidence |
|---|---|---|---|
| R1 | Repair pass before failure: `strict=false`-equivalent parse, escape control characters inside strings, strip fences and think blocks, map `""` to `{}` for no-argument tools | Fixtures: literal tab and newline in a string, fenced JSON, think-wrapped JSON, empty-string arguments all parse | F3, Hermes PR 15356 |
| R2 | An unrepairable or truncated call is recorded as `failed` with the parse error, never as success with `{}`; one re-ask containing the error and the valid shape; cap 2 re-asks per turn | Unit: truncated arguments produce a `failed` record and exactly one re-ask | F4, Hermes issue 89207 |
| R3 | Unknown tool name is rejected with the nearest allowed names, counted as a hallucination metric on the trace | Unit: `write_fiel` returns an error naming `write_file`; trace counter increments | F5 |
| R4 | "Tool required but none called": when the seat contract requires a tool and the reply has none, re-ask once with `tool_choice: required` where supported (vLLM, LM Studio GGUF, llama.cpp `/v1/messages`), otherwise with a schema that makes `tool` mandatory | Unit: prose reply triggers one constrained re-ask; Ollama path uses the schema route (Ollama has no `tool_choice`) | F6 |
| R5 | No silent cloud fallback on a no-key profile; a fallback, if configured, is logged as an explicit event | Unit: local-only profile with three failures surfaces an error, makes no network call to a cloud host | Hermes fallback-after-3 |

### 8.4 Embedder (`fleet-memory/embedder.ts`)

| ID | Requirement | Test | Evidence |
|---|---|---|---|
| E1 | A local embedder route with its own default model (not `text-embedding-3-small`) and a floor measured by the live proof for that model | Live proof (skip without a server) prints unrelated and paraphrase cosines and the floor for `qwen3-embedding:0.6b`; unit: local route never sends `text-embedding-3-small` | §0.1, §3 |
| E2 | Per-model query and document prefixes (nomic `search_query:` / `search_document:`, EmbeddingGemma `task: search result \| query:`, Qwen3 `Instruct: ...\nQuery:`, mxbai query prompt, bge-m3 none) | Spy test asserts the exact string sent for query and for document, per model | §3 |
| E3 | Store model id and dimensions with the index; refuse mixed vectors; re-index on change | Unit: switching model without re-index raises; re-index rewrites dims | §3 |
| E4 | No silent truncation: pre-chunk to the model's effective window or send `truncate: false` | Unit: over-length input returns an error or is split, never truncated | F1, Ollama `/api/embed` |
| E5 | Correct pooling on llama.cpp (Qwen3-Embedding needs `--pooling last`), verified behaviourally | Doctor: paraphrase cosine exceeds unrelated cosine by a set margin | §3 |

### 8.5 Doctor (`doctor/`)

| ID | Requirement | Test | Evidence |
|---|---|---|---|
| D1 | Local runtime check: reachable, version (Ollama 0.13.4+ for Responses, 0.14+ for Anthropic route, 0.19+ for MLX), model present, `tools` capability, effective context at or above 64K, slot count, keep-alive | Fixture servers for each runtime produce pass, warn and fail lines | §1, §4 |
| D2 | Tool-call smoke test, five fixed cases: tool required; no tool fits (must abstain); missing function (must say so); two tools in one turn; argument containing a newline. Report pass rate per case | Doctor against a stub model that always calls a tool fails the "no tool fits" case | F5, F6, F3 |
| D3 | Speed at the real prompt size: time to first token for the largest seat's fixed prompt and decode tokens/second; estimate a full fleet round | Output includes TTFT and t/s; warns when a round exceeds a configured budget | F12, §2.5 |
| D4 | Prefix-cache check: two calls with the same prefix; second TTFT under half the first, or cached tokens above 0 | Stub server without caching makes the check warn | F10 |
| D5 | Memory budget: weights + KV at configured context x slots + embedder + whisper against usable memory (on Mac, below total RAM) | Unit: 16 GB profile with gpt-oss-20b at 64K warns | §2.4, llama.cpp 16 GB note |
| D6 | KV cache type: warn on `q4_0` | Unit: `OLLAMA_KV_CACHE_TYPE=q4_0` produces a warning | F11 |
| D7 | Embedder calibration: measured floor present for the configured local model; pooling behaviour check (E5) | Doctor fails when no floor is recorded for the model | E1, E5 |
| D8 | Audio: whisper model file present, ffmpeg present, a bundled 3-second WAV transcribes | Doctor on a machine without ffmpeg fails with the install hint | §0.1 |

---

## 9. Not found in this pass

- Measured tokens/second for any model on a 16 GB Mac, and for dense 27-31B models on a single 24 GB GPU.
- Context length in the GLM-4.7-Flash card; tool-call parser in the Qwen3.8 cards; Ministral 3 context and format.
- Llama 3.3 / Llama 4 context lengths (cards gated).
- BFCL V4 entries for gpt-oss, Qwen3.5/3.6/3.8, Gemma 4, Devstral 2, GLM-4.7+, Granite 4.2, Nemotron 3.5.
- A tau-bench public leaderboard table with open-weight rows (https://taubench.com/ showed only top three per board, read 2026-09-26).
- Vendor documentation of cross-request KV reuse on Ollama's GGUF path.
- `reasoning_effort` on LM Studio's chat-completions endpoint; structured outputs in `mlx_lm.server`.
- MiniMax open text models (Hugging Face listing returned media models only).
- Gemini CLI running its agent on a local model.
