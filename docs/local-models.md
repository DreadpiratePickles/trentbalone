# Local models

Trent can run on a model served from your own machine: Ollama, LM Studio, or a llama.cpp
`llama-server`. None of them needs a key and no call is priced. This page covers the hardware tiers,
the commands from a clean machine to a first solo turn, what to expect (with the numbers measured on
the development machine), the doctor's check, the settings, the known limits, and what escalating
to a hosted model means today.

Sources: `01_discovery/output/local-models-2026-09-26.md` (runtimes, models, embedders and tiers,
every row with its URL, read 2026-09-26), `01_discovery/output/trent-local-path-audit-2026-09-26.md`,
and the L0 session logs `docs/sessions/2026-09-26-l0-*.md` for everything measured here.

## The three hardware tiers

One chat model serves every role where memory allows: planner, critic and seats share one prompt
cache and no model is swapped in and out. The embedder is small and stays resident beside it.

| Tier | Runtime | Chat model | Embedder | Audio (media toolset) |
|---|---|---|---|---|
| 16 GB Mac (Apple Silicon) | Ollama with `OLLAMA_CONTEXT_LENGTH=65536` and `OLLAMA_NUM_PARALLEL=1`; or `llama-server --jinja -c 65536 -np 1` | Qwen3.5-9B Q4_K_M: `qwen3.5:9b`, 6.6 GB | `qwen3-embedding:0.6b`, 639 MB | whisper.cpp `base` or `small` |
| 32-64 GB Mac, or one 24 GB GPU | Mac: Ollama 0.19+ (MLX runner) or LM Studio's MLX engine; 24 GB GPU: `llama-server --jinja -c 131072` | 32 GB: Qwen3.6-27B, `qwen3.6:27b`, 18 GB; 48-64 GB Mac: Qwen3.6-35B-A3B, `qwen3.6:35b-a3b`, 23 GB | `qwen3-embedding:0.6b` | whisper.cpp `small` or `medium` |
| 128 GB+ unified memory, or multi-GPU | vLLM on multi-GPU Linux; llama.cpp or Ollama on 128 GB | planner and critic: gpt-oss-120b (63.4 GB) or Qwen3.5-122B-A10B Q4_K_M (76.5 GB); seats: Qwen3.6-35B-A3B | Qwen3-Embedding-4B or 8B | whisper.cpp `large` |

What `trent setup` proposes, from the memory the operating system reports
(`packages/trent-core/src/setup/local-tiers.ts`): under 32 GB the 9B, from 32 GB the 27B, from 64 GB
the 35B-A3B. On a 128 GB machine it still proposes the 35B-A3B for every role; putting the planner and
critic on a larger model is yours to do with `models.planner` (and `models.judge`, the critic's)
([configuration.md](configuration.md), "Model tiers").

Why these models. Qwen3.5-9B reports BFCL-V4 66.1 and TAU2 79.1 on its own card
(https://huggingface.co/Qwen/Qwen3.5-9B); Berkeley's independent leaderboard has no Qwen3.5 entry, and
scores the previous generation's Qwen3-8B at 87.58 on single calls and 41.75 on multi-turn
(https://gorilla.cs.berkeley.edu/data_overall.csv). Qwen3.6-27B documents a tool parser
(`qwen3_coder`, https://huggingface.co/Qwen/Qwen3.6-27B); Qwen3.8-27B scores higher on its card but
names none (https://huggingface.co/Qwen/Qwen3.8-27B). Qwen3.6-35B-A3B is OpenHands's first local pick
and runs 3B parameters per token (https://huggingface.co/Qwen/Qwen3.6-35B-A3B,
https://docs.openhands.dev/openhands/usage/llms/local-llms). The 128 GB rows are from the gpt-oss
paper and the Qwen3.5-122B card (https://arxiv.org/html/2508.10925v1,
https://huggingface.co/Qwen/Qwen3.5-122B-A10B) with GGUF sizes from
https://huggingface.co/ggml-org/gpt-oss-120b-GGUF and https://huggingface.co/unsloth/Qwen3.5-122B-A10B-GGUF.
The Ollama tags and download sizes were read from https://ollama.com/library/qwen3.5 and
https://ollama.com/library/qwen3.6. The old default, `llama3.2`, scores 21.95% overall and 4% on
multi-turn tasks on Berkeley's board and is no longer proposed anywhere.

Embeddings: Qwen3-Embedding-0.6B is the best quality per byte published (MTEB multilingual 64.33,
https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) and the one model with a recorded recall floor in
Trent; `nomic-embed-text` is the most pulled on Ollama (https://ollama.com/search?c=embedding) and is
taken when Qwen's is absent. Audio runs through whisper.cpp in the `media` toolset
(https://github.com/ggml-org/whisper.cpp, [media.md](media.md)); setup does not choose it.

## From a clean machine to a first solo turn

```bash
# 1. A runtime. Ollama is shown (https://ollama.com/download); LM Studio and llama.cpp are below.
ollama serve                                 # skip if the Ollama app is already running
ollama pull qwen3.5:9b                       # 6.6 GB; or let setup offer the tier's model with --pull
ollama pull qwen3-embedding:0.6b             # 639 MB: semantic recall

# 2. Trent (getting-started.md, sections 1 and 2)
git clone <your remote> trent && cd trent
npm install

# 3. Look, then write
npm run cli -- setup --mode local --dry-run  # probes the runtimes, prints the plan, writes nothing
npm run cli -- setup --mode local            # the same, then one question, then config.yaml
npm run cli -- setup --mode local --pull     # also offers to pull what is missing, one question per model

# 4. Check, then talk
npm run cli -- doctor                        # the Local Model check, below
npm run cli                                  # the REPL
```

LM Studio: start its server (`lms server start`) with a model downloaded in the app, then
`npm run cli -- setup --mode local --provider lmstudio`. A llama.cpp server:

```bash
llama-server --jinja -m Qwen3.5-9B-Q4_K_M.gguf -c 65536 -np 1 --port 8080 --reasoning off
npm run cli -- setup --mode local --base-url http://127.0.0.1:8080
```

The first solo turn. Setup writes `agent.mode: solo`: one agent with one tool loop and no seats, so a
turn prefills one prompt instead of the planner's, the critic's and nine seats'. The solo runner is
built and tested (`packages/trent-core/src/solo/`), and the surfaces that read `agent.mode` (the
REPL, `trent run`, the gateway, and `trent solo` / `--solo` for one launch) are the surfaces wave, S2,
landing now: until it lands, every surface runs the fleet whatever `agent.mode` says
([configuration.md](configuration.md), "Agent mode"). `--fleet` writes `agent.mode: fleet` instead.

## What `setup --mode local` does

1. **Finds the runtimes.** Ollama and LM Studio where a run will send its calls (`OLLAMA_BASE_URL`,
   `LMSTUDIO_BASE_URL`, else `http://127.0.0.1:11434` and `http://127.0.0.1:1234`), and `--base-url`
   when given. Each is identified by what answers, not by its port: Ollama `GET /api/version`, llama.cpp
   `GET /props`, LM Studio `GET /api/v1/models`, anything else serving `GET /v1/models`.
2. **Lists what each has**, with sizes and roles, the way the runtime reports them: Ollama `/api/tags`
   (`size`, and `capabilities` such as `tools`, `thinking`, `embedding`; `/api/show` when the listing
   has none), LM Studio `/api/v1/models` (`size_bytes`, `type`, `trained_for_tool_use`), llama.cpp
   `/v1/models` (`meta.size`). An Ollama cloud model (`:cloud`) is listed as one and never chosen.
3. **Chooses the chat model**: `--model` if the runtime has it; else the tier's model; else, when that
   is not there, a smaller tier's model that is, with the exact line to move up; else it stops. A model
   the runtime lists without `tools` is never chosen for you. A llama.cpp server serves one model, so
   that is the one.
4. **Chooses the embedding model**: `qwen3-embedding:0.6b`, else another Qwen3-Embedding size, else
   `nomic-embed-text`, on the chat runtime first, then on any other runtime that answered (a llama.cpp
   chat server can take its embeddings from Ollama). With none, recall is lexical, and setup prints the
   pull line.
5. **Offers `--pull`** on Ollama for what is missing, one confirmation per model (so it needs a
   terminal), then reads the listing again.
6. **Writes**, after one confirmation, the toolsets and starter agents quick setup writes, plus:

| Key | Written | When |
|---|---|---|
| `provider` | `ollama`; `lmstudio` for LM Studio, a llama.cpp server or any other OpenAI-compatible server | always |
| `model` | the chat model | always |
| `memory.embedder.provider`, `.model` | `ollama` or `lmstudio` and the model, or `none` | always |
| `memory.embedder.base_url` | the embedding runtime's URL | when it is not where that route already points |
| `terminal.backend` | `local` | when `docker info` does not answer ([terminal.md](terminal.md): no sandbox) |
| `agent.mode` | `solo`, or `fleet` with `--fleet` | always |
| `models.reasoning_effort` | `none` | on Ollama, when the model lists `thinking` |
| `LMSTUDIO_BASE_URL` or `OLLAMA_BASE_URL` in the profile `.env` | `<base-url>/v1` | when `--base-url` names a server the alias does not already point to; not a secret |

`reasoning_effort` is written only where the gateway sends it: Ollama maps it per model
(https://docs.ollama.com/api/openai-compatibility); LM Studio's chat completions take no such field
(https://lmstudio.ai/docs/developer/openai-compat/chat-completions); llama.cpp accepts `none` per
request (https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) but is reached
through the `lmstudio` provider, which the gateway never sends it on, so start `llama-server` with
`--reasoning off` instead.

It stops, exit 3, with one reason a script can branch on: `runtime-unreachable` (nothing answered;
the message names every URL it tried and the start commands) or `model-not-pulled` (the runtime has
no usable chat model; on Ollama the message carries the `ollama pull` line). `--json` prints one document: the
summary plus `local`, with `runtimes` (each with its `models`, `size`, `role`, `capabilities`),
`runtime`, `url`, `provider`, `chat` (`model`, `recommended`, `source`: requested, recommended,
fallback, served or pulled), `embedder`, `docker`, `mode`, `pull`, `env`, `writes` and `expectation`.
`--dry-run` sends only reads to the runtimes' URLs (GET, and `/api/show`), asks nothing, pulls nothing
and writes nothing, not even the profile directory.

## What to expect

Setup prints the expectation for the model it chose; the three sentences per tier are in
[getting-started.md](getting-started.md), section 11. In short: at 9B single tool calls mostly work
and multi-step plans do not; at 27B and 35B-A3B short chains work and planning is adequate for
bounded tasks; everywhere, every cold prompt pays for prefill before the first token.

Measured on the development machine, an Apple M1 Max with 32 GB, `qwen3.5:9b` on Ollama 0.32.9. The
machine was shared with other agents' test runs the whole time (load averages 170 to 1000, swap
nearly full), so these are numbers under contention, not the model's best:

| What | Measured | Where |
|---|---|---|
| Decode speed | about 3 tokens/s (893 tokens at 3.04 tok/s; 1,267 at 2.99) | L0-2 log |
| First token, planner prompt (3,773 tokens) | about 91 s | L0-2 log |
| First token, seat prompt (5,935 tokens) | about 157 s | L0-2 log |
| Thinking on a one-word answer | 201 tokens in 92 s by default; 2 tokens with thinking off (still 87 s under that load) | L0-3 log |
| Doctor tool-call smoke test | 1/5 on the seat's `"<tool> <json>"` action format | L0-4 log |
| Effective context window | 32768 tokens (Ollama `/api/ps`) | L0-2, L0-4 logs |
| A fleet run, "Say the word ready" | stopped by the app's 10-minute job timeout, 0 of 2 steps | L0-2, L0-3 logs |

The smoke failures were the model's: it wrote `"action": "read_file", {...}` instead of the action
string (L0-4). That format is why constrained output is the first item of the next wave, and why a
9B is for short, explicit objectives today.

## The doctor's Local Model check

`npm run cli -- doctor` runs it whenever the provider is local ([doctor.md](doctor.md), "The Local
Model check"): it names the runtime and its version, fails with the exact `ollama pull` line when a
configured model is missing, runs a five-case tool-call smoke test through the wrapper's gateway
(scored N/5, each failure named), times the first token on a fresh 4K-token prompt, and reads the
effective context window and the server's slots. With the runtime stopped it exits 3 naming the URL.
The Recall Embedder check reports the local embedder's dimensions and floor, or "lexical only".

## Settings

| Setting | What it does | Documented in |
|---|---|---|
| `models.local.ttft_seconds`, `idle_seconds`, `context_tokens`, `max_in_flight` | budgets for a local call: 300 s to the first token, 120 s of silence, a 32768-token window when the server cannot be asked, 1 call in flight on Ollama and 4 on LM Studio | [configuration.md](configuration.md), "Local models" |
| `memory.embedder.provider`, `model`, `base_url`, `batch_size` | the recall embedder; `ollama`, `lmstudio`, `llamacpp` or `none` | [configuration.md](configuration.md), "Embedder" |
| `agent.mode` | `solo` or `fleet` | [configuration.md](configuration.md), "Agent mode" |
| `models.reasoning_effort` | `none` turns thinking off on Ollama | [configuration.md](configuration.md), "Pinned models and reasoning effort" |
| `improve.judge_model` | a second local model for the improvement judge, which never falls back to a hosted one | [improve.md](improve.md) |
| `OLLAMA_CONTEXT_LENGTH`, `OLLAMA_NUM_PARALLEL`, `OLLAMA_KEEP_ALIVE` | Ollama's own: its window, its slots, how long a model stays loaded | https://docs.ollama.com/faq, https://docs.ollama.com/context-length |

## Known limits

- **Context.** Ollama sizes its default window by VRAM: 4k under 24 GiB, 32k to 48 GiB, 256k above
  (https://docs.ollama.com/context-length); this machine runs at 32768. A seat prompt measured about
  6.2k tokens, and the gateway refuses a prompt that does not fit the window rather than letting the
  server cut it. 64K is the floor other harnesses recommend
  (https://hermes-agent.nousresearch.com/docs/integrations/providers): `OLLAMA_CONTEXT_LENGTH=65536`.
- **Thinking tokens.** Qwen3.5 and 3.6 think by default (https://huggingface.co/Qwen/Qwen3.5-9B).
  `models.reasoning_effort: none` stops it on Ollama; on LM Studio it stays at the model's setting;
  on llama.cpp use `--reasoning off`.
- **The app's job timeout.** A fleet step is a job in the wrapped app, which ends it after 10 minutes
  (`apps/web/lib/queue.ts`, `TRENT_JOB_TIMEOUT_MS`). At the speeds above a local seat can exceed that.
  Sizing it through `models.local` is planned for the next wave (L1), not built.
- **The tool-call format.** The fleet's seats call tools with a JSON string inside JSON, a format no
  model was trained on; constrained output with a flat `{tool, args}` is planned for L1, not built.
- **Other paths.** `trent heartbeat` and `trent improve` build their own gateways and get the
  `models.local` defaults, not your values; the app's consolidator call keeps a 60 s timeout (L0-2 log).

## Escalating to a hosted model

Planned, not built: `models.escalate` naming a hosted model that only the planner, the critic or a
failed step may use, each time behind the approval gate with a preview of exactly what would leave
the machine (the local-models plan, wave L1). Today a profile is local or hosted as a whole. Keep a
second profile for hosted work and pick it per command:
`npm run cli -- --profile hosted setup --mode quick --provider openai` (with the provider's key set,
[getting-started.md](getting-started.md), section 6), then `npm run cli -- --profile hosted doctor`
and so on, or `TRENT_PROFILE=hosted npm run cli` for the REPL ([configuration.md](configuration.md),
"Profiles").
