# 2026-09-26 — L0-5: local embeddings (G9, G10, doctor embedder check, docs-corpus recall)

Wave L0 of `02_plan/output/local-models-plan-2026-09-26.md`; gaps G9 and G10 of
`01_discovery/output/trent-local-path-audit-2026-09-26.md` §6 (and §5). Branch `feature/trent-fleet-v2`.
One Opus agent, no subagents, no commits. Other L0 agents edit the tree concurrently; this task owns only:
`fleet-memory/{embedder.ts,embedder-google.ts,embedder-cache.ts,embedder.test.ts,embedder.live.test.ts}`,
a new `fleet-memory/embedder-local.ts` (+ test), `doctor/checks/embedder.ts` (+ test),
`config/sections/memory.ts` (a `// [L0-5] local embedder` block) with `schema-split.input.json` and the
regenerated snapshot, `improve/docs-corpus.live.test.ts` (a recording mode for the local embedder only),
the offline local case in `improve/docs-corpus.test.ts`, one `// [L0-5]` hunk in `orchestrator/model-env.ts`
(L0-1's file), one section of `docs/brain.md`, the embedder lines of `docs/configuration.md`, and this log.

Rules in force: no cloud call of any kind, `gem.env` never opened, real Ollama only on 127.0.0.1:11434, one
embedding model pulled (under 1 GB), `TRENT_QUEUE_FALLBACK=disabled`, vitest from the repo root.

## Log

- 01:46Z Read AGENTS.md, CONTEXT.md, the rulebook, audit §2/§5/§6 (G9, G10), research §3, §5.1 F1, §8.4-8.5,
  the embedder files, `lexical.ts` (read only: it swallows an embedder failure into lexical at `:159-163`),
  the docs-corpus suites, the doctor check and `memory.ts`. HEAD at start `c6df7bc`.
- 01:48Z **Pulled `qwen3-embedding:0.6b`** (`ollama pull qwen3-embedding:0.6b`, exit 0): 639 MB, Q8_0,
  595.78M parameters, embedding length 1024, context length 32768, capabilities `embedding`. The only model
  pulled by this task. Live probes on 127.0.0.1:11434 (no cloud):
  - `/api/embed` with two inputs: 1024 dims each; cold load 4.70 s of 4.79 s total.
  - `/api/embed` with ~48k words and `truncate: false`: HTTP 400 `{"error":"the input length exceeds the
    context length"}` — the error the embedder must split around, not a silent cut.
  - `/api/embed` with `text-embedding-3-small`: HTTP 404 `model "text-embedding-3-small" not found, try
    pulling it first` (the audit's per-step 404).
  - `/v1/embeddings` with the pulled model: HTTP 200, OpenAI shape, `usage.prompt_tokens` present.
- 01:50Z **G10 finding (read only on apps/web).** The app has TWO embedding paths, not one:
  `lib/wiki-embeddings.ts:20,105-129` (`semanticSearch` embeds every step's objective via
  `source-grounding.ts:41` from `orchestrator-runtime.ts:610,1312`) and `lib/semantic-router.ts:14,88-111`
  (seat/tool routing). Every env name either reads: `EMBEDDING_MODEL` (both, frozen at module load),
  `OPENAI_API_KEY` (both, per call: unset means hash / lexical vectors and NO request),
  `OPENAI_BASE_URL` (both, per call), `WIKI_EMBED_STORE` (wiki only, load time). No other switch exists
  (`grep -rhoE "process\.env\.[A-Z0-9_]*(EMBED|WIKI|SEMANTIC|GROUND|VECTOR)[A-Z0-9_]*" lib app`).
  So the app can be **redirected** (`EMBEDDING_MODEL` to a pulled local embedding model on the same runtime
  the alias points `OPENAI_BASE_URL` at) but NOT **switched off** by env: its only off switch,
  `OPENAI_API_KEY`, is the same variable the app's OpenAI chat client (`ai-client.ts:82,115`,
  `isProviderConfigured`, `createAIClient`) needs, and openai-node 4.x fetches through `node-fetch`, so a
  wrapper-side `fetch` interception is not available either. Probe: neither `commands/index.ts`,
  `orchestrator/index.ts` nor `runtime/headless.ts` evaluates `wiki-embeddings.ts` at load
  (`globalThis.__trentWikiEmbeds` unset after import; tsx probe, exit 0 each), so an env written in
  `createOrchestrator` is early enough for it.
- 01:55Z Probe: `semantic-router.ts` is not evaluated at load either (its `ROUTING_SIMILARITY_THRESHOLD` follows a
  `SEMANTIC_ROUTING_THRESHOLD` written after importing each entry; tsx probe, exit 0 each).
- 01:58Z **RED** `npx vitest run packages/trent-core/src/fleet-memory/embedder-local.test.ts
  packages/trent-core/src/fleet-memory/embedder-local.app-env.test.ts` -> exit 1, 2 files failed:
  `Cannot find module './embedder-local.js'` (the module does not exist yet). Tests written: selection under a
  local alias (never `text-embedding-3-small`), runtime base URLs, Ollama `/api/embed` with `truncate: false`,
  the OpenAI dialect for LM Studio / llama.cpp, the (provider, model, task type) cache, per-model prefixes,
  the split around an over-long input, live calibration of an unrecorded model, one WARN line then lexical,
  the pull line on a 404; G10: `EMBEDDING_MODEL` written by `applyModelEnv`, and the app's real
  `wiki-embeddings` module asking a fake loopback runtime for the configured model.
- 02:20Z **GREEN (unit)**: new `fleet-memory/embedder-local.ts` (local routes, prefixes, split around an
  over-long input, the one-line-per-outage breaker, G10 `applyAppEmbeddingEnv`) and
  `fleet-memory/embedder-calibration.ts` (triples, the floor rule, recorded floors; split out so
  `embedder-local.ts` stays under 500 lines); `embedder.ts` routes local providers there and shares its HTTP
  helpers (`postJsonWithRetry`, `parseOpenAiEmbeddings`) instead of keeping a copy. Second red first: before
  the model-env hunk, `applyModelEnv carries it` failed `expected undefined to be 'nomic-embed-text'` and
  the app's real `wiki-embeddings.semanticSearch` asked the fake loopback runtime for
  `"model": "text-embedding-3-small"` (exactly the audit's per-step 404). Then ONE marked `// [L0-5]` call
  in `orchestrator/model-env.ts` after `applyProviderAliasEnv` (plus its import line, also marked).
  `npx vitest run fleet-memory/embedder-local.test.ts fleet-memory/embedder-local.app-env.test.ts
  fleet-memory/embedder.test.ts orchestrator/model-env.test.ts orchestrator/model-env.pin.test.ts` -> exit 0,
  5 files, 72 tests. `RECORDED_LOCAL_FLOORS` still holds placeholders; the live calibration is next.
- **Wiring gap to hand back (not my file):** `applyModelEnv` sees `memory` only if its caller passes it.
  `apps/cli/src/runtime/headless.ts:~360` builds the model dep as `{ provider, model, overrides?, models?,
  pin? }`, so in a real `trent run` the hunk finds no `memory.embedder` and writes nothing
  (`reason: "no_embedder_config"`). One line there — `...(config.memory?.embedder ? { memory: { embedder:
  config.memory.embedder } } : {})` in `model` — makes it live. L0-1's early bridge
  (`model-env-early.ts`) reads only `provider`, `model`, `models`, which is fine: both app modules load lazily.
- 02:08Z First live calibration run (`env -i ... TRENT_TEST_LIVE=1 TRENT_EMBEDDER_LIVE_LOCAL=ollama npx vitest run
  fleet-memory/embedder.live.test.ts`) -> exit 1: `TimeoutError: embedding request exceeded 20000ms`. Ollama was
  holding another agent's `qwen3.5:9b`; one `/api/embed` of one word then took 28.4 s by `curl` (4.8 s idle). The
  failure did print exactly one structured WARN (`embedder.local_unavailable`, reason `unreachable`, fix
  `start Ollama (ollama serve) ...`, fallback `lexical`) — the fail-loudly-once path, live. Local routes now get
  `LOCAL_EMBED_TIMEOUT_MS` = 120 s (hosted stays 20 s); the doctor's local probe gets 40 s and the check declares
  `timeoutMs` (L0-4's per-check budget in `doctor/types.ts`, already in the tree).
- 02:14Z **Calibrated floor, `qwen3-embedding:0.6b`** (second live run, exit 0, 11.1 s, 1024 dims measured):

  | space | triple 1 para / unrel | triple 2 | triple 3 | rule floor |
  |---|---|---|---|---|
  | symmetric | 0.7125 / 0.3432 | 0.7264 / 0.2868 | 0.7570 / 0.2763 | **0.46** (0.3432 + 0.3 x 0.3693 = 0.454, rounded up) |
  | query prefixed (Qwen3 instruction on the query) | 0.6025 / 0.1957 | 0.6539 / 0.1586 | 0.6085 / 0.1801 | **0.32** (0.318) |

  Recorded in `embedder-calibration.ts` `RECORDED_LOCAL_FLOORS` as `vectorFloor 0.46, queryFloor 0.32`. Gemini's
  for comparison: 0.60 symmetric, 0.63 task-typed. The prefixed space widens the gap (0.41 against 0.37) and
  drops the unrelated baseline, as the model card says an instruction should.
- **Doctor RED** (original check restored from HEAD for the run, then my version put back; `cmp` equal):
  `npx vitest run doctor/checks/embedder.test.ts` -> exit 1, 5 failed / 6 passed: `none` message lacked
  "lexical only"; a cloud 404 said "could not be reached" instead of naming `gemini-embedding-001`; the three
  local cases (dims/floor/sanity, unreachable + `ollama serve`, not pulled + `ollama pull`) had no local path.
- 02:25Z Doctor GREEN: `npx vitest run doctor/checks/embedder.test.ts fleet-memory/embedder-local.test.ts` -> exit 0,
  24 tests. The local path lists the runtime's models (`/api/tags`, or `/v1/models`), gives the pull line when the
  model is absent (no embed request), then embeds the three triples in the shipped space and reports dims, the
  floor (recorded, or calibrated live for an unrecorded model) and the sanity score; a cloud 404 names the model.
- 02:30Z Config RED: `EmbedderConfigSchema.parse({ provider: "ollama" })` -> ZodError `invalid_enum_value ...
  Expected 'auto' | 'gemini' | 'openai' | 'none', received 'ollama'` (exit 1). Then the marked `// [L0-5] local
  embedder` block in `config/sections/memory.ts` (enum + `base_url`), `base_url` added to
  `schema-split.input.json`, `npx tsx scripts/dev/regen-snapshot.mjs` -> exit 0 ("snapshot keys: 43"). The
  regenerated snapshot also carries other agents' input changes already in the tree (`models.local`,
  `agent.mode`): it is derived from the whole current schema.
- 02:40Z `docs/configuration.md` embedder lines updated (provider values, `base_url`, local defaults, floors, the
  one WARN line, and the honest G10 limits). Machine load average 300-850 from concurrent agents' test runs;
  `tsc --noEmit -p packages/trent-core` shows no error in any file of mine.
- 02:58Z Started the ONE docs-corpus recording run with the local embedder:
  `env -i ... TRENT_TEST_LIVE=1 TRENT_RECORD_DOCS_CORPUS=1 TRENT_DOCS_CORPUS_EMBEDDER=ollama
  TRENT_DOCS_CORPUS_REPORT=<scratch>/docs-corpus-local.json TRENT_DOCS_CORPUS_CACHE_DIR=<scratch>/docs-corpus-cache
  npx vitest run packages/trent-core/src/improve/docs-corpus.live.test.ts` (query-prefixed space recorded; the
  symmetric space measured on the same run for the report).
- 03:05Z **Docs-corpus recording, ONE run, exit 0** (429 s; 24 embedding requests, 705 inputs, 562,862 chars,
  local runtime, 0 cents). The replay of the new fixture equalled the live ranking question for question
  (embedding and hybrid; `missingQueries []`, `missingChunks 0`, `modeMismatches 0`). New fixture
  `improve/fixtures/docs-corpus/embeddings-local-qwen3-embedding-0.6b.json` (147 KB, `task_types: true`,
  `vector_floor 0.32`); `embeddings.json` (Gemini) untouched. Local = `qwen3-embedding:0.6b`, query instruction
  on, floor 0.32; Gemini = `gemini-embedding-001`, symmetric, floor 0.60 (retrieval-measurement-2026-09-25.md,
  "After the fix"):

  | mode | recall@8 | recall@3 | MRR@8 | no-answer abstained |
  |---|---:|---:|---:|---:|
  | lexical (both) | 0.343 (12/35) | 0.343 | 0.300 | 2/5 |
  | **local hybrid** | **0.600 (21/35)** | 0.486 | 0.480 | 0/5 |
  | Gemini hybrid | 0.629 (22/35) | 0.571 | 0.529 | 2/5 |
  | local embedding | 0.600 (21/35) | 0.514 | 0.492 | 0/5 |
  | Gemini embedding | 0.600 (21/35) | 0.486 | 0.479 | 2/5 |
  | local hybrid, no instruction | 0.514 (18/35) | 0.457 | 0.413 | 0/5 |
  | local embedding, no instruction | 0.457 (16/35) | 0.371 | 0.367 | 0/5 |

  | mode | exact_term (12) r@8 / r@3 / MRR | paraphrased (12) | multi_hop (11) |
  |---|---|---|---|
  | local hybrid | 1.000 / 1.000 / 1.000 | **0.417** / 0.167 / 0.176 | 0.364 / 0.273 / 0.242 |
  | Gemini hybrid | 1.000 / 1.000 / 0.958 | **0.417** / 0.333 / 0.313 | 0.455 / 0.364 / 0.295 |
  | local embedding | 0.917 / 0.917 / 0.861 | 0.417 / 0.250 / 0.285 | 0.455 / 0.364 / 0.314 |
  | Gemini embedding | 0.833 / 0.750 / 0.762 | 0.500 / 0.333 / 0.323 | 0.455 / 0.364 / 0.341 |
  | local hybrid, no instruction | 1.000 / 1.000 / 1.000 | 0.083 / 0.083 / 0.042 | 0.455 / 0.273 / 0.178 |

  Reading: the 639 MB local model matches Gemini's dense half at recall@8 (21/35) and is one question short in the
  hybrid (21 against 22: one multi-hop), paraphrased equal at 5/12 but ranked lower (r@3 0.167 against 0.333).
  The query instruction is worth 5 questions dense and 3 hybrid (paraphrased 5/12 against 1/12), which confirms
  the prefixed space as the shipped local default. The cost: 0/5 no-answer abstentions against Gemini's 2/5 —
  the 0.32 floor from sentence triples lets question-vs-chunk cosines of unanswerable questions clear it. A
  corpus-calibrated query floor is the next measurement (the recording holds every cosine it needs, offline).
- 03:10Z Offline case added to `improve/docs-corpus.test.ts` (a separate describe, floors = the measured numbers:
  hybrid >= 21/35, exact 12, paraphrased >= 5, multi-hop >= 4; dense >= 21, paraphrased >= 5; the fixture must be
  the shipped local space with the recorded query floor). Written after the recording, so its only red was the
  fixture not existing. `npx vitest run packages/trent-core/src/improve/docs-corpus.test.ts` -> exit 0, 17 tests.
- 03:12Z **Live doctor line** (tsx probe calling `checkEmbedder.run` on a scratch profile, `provider: ollama`,
  real Ollama on 127.0.0.1, exit 0 each):
  - default (`auto`): `ok` in 21.1 s under load — "Fleet recall is hybrid: Ollama qwen3-embedding:0.6b (1024
    dimensions) blended with lexical TF-IDF; floor 0.32 (recorded), sanity 3/3."
  - `model: nomic-embed-text` (not pulled): `warn`, fix `ollama pull nomic-embed-text`, no embed request.
  - `provider: none`: `skip`, "fleet recall is lexical only ... no embedding endpoint was contacted."
  - `base_url: http://127.0.0.1:9`: `warn` in 1.1 s, "Ollama is not reachable at http://127.0.0.1:9", fix
    `start Ollama (ollama serve) ...`.
- 03:14Z **Live recall** (the audit's §5 probe, same two questions; `recallFromBrain` with `embedderForProfile`, exit 0 each):
  - local (`auto` under `provider: ollama`): "what time does the bakery open on saturday" -> `docs/hours.md`;
    "discount for coffee shops ordering bread in bulk" -> **`docs/wholesale.md`** (the audit recorded `[]`).
  - `none`: hours -> `docs/hours.md`; the paraphrase -> `[]` (lexical, as documented).
  - unreachable base URL: ONE `embedder.local_unavailable` WARN line for the two recalls, then lexical
    (hours found, the paraphrase `[]`). No silent 404.
- 03:20Z Verification, first full pass: `npx vitest run packages/trent-core/src/fleet-memory packages/trent-core/src/improve
  packages/trent-core/src/doctor/checks/embedder.test.ts packages/trent-core/src/config
  apps/cli/src/commands/__tests__/docs-truth.test.ts packages/trent-core/src/wrapped-modules.test.ts` -> exit 1,
  82 files, 600 passed / 2 failed / 14 skipped, 5 files failed:
  - `docs-truth` "resolves every documented slash command": my `` `/v1` `` in the `base_url` row read as a slash
    command. Rephrased ("/v1" in quotes). Rerun of docs-truth + wrapped-modules -> exit 0, 15 tests.
  - hook / test timeouts at load average 300-850 (other agents' suites): `fleet-memory.orchestrator`,
    `interrupted.orchestrator` (hooks 120 s / 180 s), `app-memory.bun` (60 s), `wrapped-modules` "every referenced
    lib file exists" (60 s). Each rerun alone: orchestrator pair -> exit 0, 9 tests; `app-memory.bun` -> exit 0,
    6 tests; `wrapped-modules` -> exit 0 (with docs-truth, above).
- `cd packages/trent-core && npm run build` -> exit 2: 24 errors, all in other agents' in-flight files
  (`governance/auto-review*.test.ts`, `solo/router.test.ts`, `tools/mcp/http-egress.test.ts`,
  `tools/mcp/http-oauth.test.ts`), none in a file of mine. `cd apps/cli && npx tsc -p tsconfig.json --noEmit` ->
  exit 2, 1 error, `approvals.test.ts` importing the missing `governance/auto-review.js` (not mine).
- `node scripts/ci/repo-scan.mjs` -> exit 0 (1136 files; canned strings, hex colours, emoji: 0 violations).
- `base_url` is now honoured on a hosted alias route too, and the `taskTypes` option documents the local default.
- 03:30Z **Final verification** (the brief's list plus L0-1's two model-env suites, since my hunk sits in that file):
  `npx vitest run packages/trent-core/src/fleet-memory packages/trent-core/src/improve
  packages/trent-core/src/doctor/checks/embedder.test.ts packages/trent-core/src/config
  apps/cli/src/commands/__tests__/docs-truth.test.ts packages/trent-core/src/wrapped-modules.test.ts
  packages/trent-core/src/orchestrator/model-env.test.ts packages/trent-core/src/orchestrator/model-env.pin.test.ts`
  -> exit 1: 84 files, 643 passed, 1 failed — `wrapped-modules` "references at least 8" hit `ENOENT ...
  tools/mcp/h2-red-probe.test.ts`, a probe file another agent created and deleted while the walk ran. Rerun alone
  -> exit 0, 3 tests (44 distinct apps/web/lib files). Build rerun (`cd packages/trent-core && npm run build`) ->
  exit 2, 18 errors, all in other agents' in-flight `solo/*` and `tools/mcp/http-oauth-wire.ts`; none in mine.

## State at close

**Pulled:** `qwen3-embedding:0.6b` (Ollama tag; 639 MB, Q8_0, 1024 dims). **Calibrated floors:** 0.46 symmetric,
0.32 with the query instruction (the shipped local space). **Docs corpus:** local hybrid recall@8 0.600 (21/35),
paraphrased 0.417 (5/12); Gemini 0.629 (22/35), 0.417 (5/12). Tables above.

**Files (mine):** new `fleet-memory/embedder-local.ts`, `fleet-memory/embedder-calibration.ts`,
`fleet-memory/embedder-local.test.ts`, `fleet-memory/embedder-local.app-env.test.ts`,
`improve/fixtures/docs-corpus/embeddings-local-qwen3-embedding-0.6b.json`, this log; changed
`fleet-memory/embedder.ts`, `fleet-memory/embedder.live.test.ts`, `doctor/checks/embedder.ts` (+ test),
`config/sections/memory.ts` (`// [L0-5]` block), `config/schema-split.input.json` + regenerated snapshot,
`improve/docs-corpus.live.test.ts` (local recording mode), `improve/docs-corpus.test.ts` (one `[L0-5]` describe),
`orchestrator/model-env.ts` (two `// [L0-5]` lines: the import and the call), `docs/configuration.md` (Embedder
lines), `docs/brain.md` (new section 10).

**Open, for the parent:**
1. G10 wiring: `apps/cli/src/runtime/headless.ts` must carry `memory.embedder` in the `model` dep (one line) or the
   `[L0-5]` hunk never sees it in a real run. Until then the docs tell the operator to export `EMBEDDING_MODEL`.
2. G10 under `none`: BLOCKED on an app edit. No env switches the app's two embedding calls off without switching
   off its chat client (`OPENAI_API_KEY`). The smallest fix is a one-line gate in `apps/web/lib/wiki-embeddings.ts`
   `embedMany` and `semantic-router.ts` `embedMany` (e.g. an `EMBEDDING_MODEL=none` check before the request) —
   an apps/web edit, which AGENTS.md invariant 1 reserves for a deliberate bug fix with its own commit and Bobby's OK.
   Today under `none` + a local alias those calls stay on the loopback runtime (404, hash fallback); under a hosted
   chat provider with an `OPENAI_API_KEY` in the environment they reach api.openai.com.
3. No-answer abstention with the local model is 0/5 (Gemini 2/5): the 0.32 floor from sentence triples sits under
   many question-to-chunk cosines. A corpus-calibrated query floor can be measured offline from the new recording.
4. `packages/trent-core/src/fleet-memory/README.md` still says the embedder has three outcomes (not my file).
5. Unverified: LM Studio and llama.cpp routes (neither running here) and their default model names; nomic /
   EmbeddingGemma prefixes are asserted by unit tests only.
