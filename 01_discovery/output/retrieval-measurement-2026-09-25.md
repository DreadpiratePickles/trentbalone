# Retrieval on real documents: the measurement decision E was waiting for (2026-09-25)

Status: measured, HEAD 4a0e171 plus this change (uncommitted). Session log:
`docs/sessions/2026-09-25-p2-6-recall.md`. Suite: `packages/trent-core/src/improve/docs-corpus.test.ts`
(offline, enforced), `docs-corpus.live.test.ts` (live, opt-in).

**Question.** Since 2026-09-20 the reranker and contextual chunk prefixes have been deferred behind
one trigger: "recall@8 on the golden set below 0.9 after ingestion of real documents"
(`02_plan/output/upgrade-round-design.md` section 6, decision E; `docs/sessions/2026-09-19-upgrade-round.md`
deferred decision 5). The only golden set was five synthetic documents built to score 1.0. This page
is that measurement.

**Answer.** The trigger has fired, and not narrowly. The shipped hybrid scored **recall@8 0.400**
overall and **0.000 on paraphrased questions**. It scored below the embedding half on its own
(0.600), because its relatedness gate threw away answers it had itself ranked first.
Fixing the gate (+40/-12 lines in two files, failing test first) lifted it to **0.629 overall, 0.417 paraphrased**,
at zero per-query cost. The cheap contextual prefix is already shipped. No reweighting of the two
signals can reach 0.8 on paraphrases: the embedding order caps them at 0.667. So the reranker is
proposed below with its per-query cost. It is not built.

## Method

| Part | What |
|---|---|
| Corpus | The 28 top-level `docs/*.md` (458,634 chars), snapshotted into `improve/fixtures/docs-corpus/corpus.json` with a sha256 per file. It is a snapshot because other agents edit `docs/` daily, and an exam that moves under the ranker is not an exam |
| Import | `ingestDocuments`, the call `trent brain import` makes: 28 imported, 0 failed, **625 chunks** (heading-aware, 1,200 chars max, 150 overlap) |
| Questions | 40 in `questions.json`, written from the text alone and frozen before any ranker ran (details below) |
| Answer key | Each answerable question names its file and a phrase. The phrase resolves to chunk ids through the shipped chunker, and must resolve inside that file only. 34 resolve to one chunk and 1 to two overlapping chunks (hop-06) |
| Scoring | The shipped `evaluateRetrieval` (k = 8). recall@3 and MRR@8 are read from its per-query rank |
| Embedder | `gemini-embedding-001` through the shipped `createEmbedder`: OpenAI-compatible surface, 3,072 dims, calibrated floor 0.6, no task type |
| Ranker | `recallFromBrain`: `0.4 x TF-IDF + 0.6 x (cos - 0.6)/0.4`, related at `recallMinScore` 0.12, over `path title heading text`. The title and heading prefix is already there, and a spy test proves this is the exact string the embedder receives |

The four question categories, each defined so a test can check it:

- **exact_term (12):** names a config key or env var that appears in one doc only.
- **paraphrased (12):** shares zero tokens (the shipped `tokenize`) with anything the ranker reads of the answer chunk.
- **multi_hop (11):** a scenario that shares at most 2 tokens with the answer chunk.
- **no_answer (5):** SAML, Kubernetes/Helm, a Pro subscription, Salesforce and WebRTC calls. Each of these terms is verified absent from the corpus.

Four drafts were replaced because their answer also appeared in a second doc.

The three modes:

- **lexical:** the shipped ranker with no key. This is what an offline sweep and `trent improve retrieval` measure.
- **hybrid:** the shipped ranker with the embedder. This is what a seat's prompt gets on a keyed profile.
- **embedding:** the dense half alone, through the evaluator's `rank` seam. It ranks by cosine over the same text and keeps chunks above the embedder's floor. It is for measurement only.

**Offline = live.** CI replays recorded cosines (`embeddings.json`, 147 KB): each question against
each chunk, float32. Replay rebuilds 2-d vectors with exactly those cosines, so the shipped floor,
blend, gate and sort all run unchanged. The live test asserts that the replay reproduces the live
ranking question for question, in both vector modes. It passed before and after the fix.

## Results

### Before the fix (live, run 2)

| mode | recall@8 | recall@3 | MRR@8 | no-answer abstained |
|---|---:|---:|---:|---:|
| lexical | 0.343 (12/35) | 0.343 | 0.300 | 2/5 |
| embedding | 0.600 (21/35) | 0.486 | 0.479 | 2/5 |
| hybrid (shipped) | **0.400 (14/35)** | 0.400 | 0.371 | 3/5 |

| mode | exact_term (12) r@8 / r@3 / MRR | paraphrased (12) | multi_hop (11) |
|---|---|---|---|
| lexical | 1.000 / 1.000 / 0.875 | 0.000 / 0.000 / 0.000 | 0.000 / 0.000 / 0.000 |
| embedding | 0.833 / 0.750 / 0.762 | 0.500 / 0.333 / 0.323 | 0.455 / 0.364 / 0.341 |
| hybrid | 1.000 / 1.000 / 0.958 | **0.000** / 0.000 / 0.000 | 0.182 / 0.182 / 0.136 |

### After the fix (live, run 3; the offline suite asserts the same numbers)

| mode | recall@8 | recall@3 | MRR@8 | no-answer abstained |
|---|---:|---:|---:|---:|
| lexical | 0.343 (12/35) | 0.343 | 0.300 | 2/5 |
| embedding | 0.600 (21/35) | 0.486 | 0.479 | 2/5 |
| hybrid | **0.629 (22/35)** | 0.571 | 0.529 | 2/5 |

| mode | exact_term (12) r@8 / r@3 / MRR | paraphrased (12) | multi_hop (11) |
|---|---|---|---|
| hybrid | 1.000 / 1.000 / 0.958 | **0.417** / 0.333 / 0.313 | 0.455 / 0.364 / 0.295 |

Lexical and embedding are unchanged by the fix; only the hybrid's gate moved.

### Spend

Every chunk and question was embedded exactly once:

| Run | Texts | Chars | Estimated cost (chars/4 tokens) |
|---|---:|---:|---:|
| Run 1 (stopped by HTTP 429) | 96 | 87,194 | 0.33 cents |
| Run 2 | 569 | 468,997 | 1.76 cents |
| Run 3 (re-measure) | 0 (all cache hits) | 0 | 0 cents |
| One probe request | 1 | 5 | ~0 |
| **Total** | **665** | **556,191** | **2.09 cents** |

That is **2.78 cents** at the chars/3 bound, at Google's paid-tier list price of $0.15 per million
tokens.

The key behaves as a free-tier key (it hit a 30k-tokens-per-minute limit), so the actual bill is
probably $0. The endpoint returns no `usage`, which is why tokens are estimated from characters.

## Failure analysis (from the recorded cosines; no spend)

1. **Cosines are compressed on documents.** A question against a 1,200-character chunk sits at
   cosine 0.55-0.73. The 0.6 Gemini floor was calibrated on sentence pairs (unrelated 0.529,
   paraphrase 0.754, `embedder.ts`). A chunk that shares no word earns `0.6 x (c - 0.6)/0.4` and
   needs c >= 0.68 to reach 0.12. Paraphrase answers sat at 0.547-0.675.
2. **7 of the hybrid's 21 misses were ranked in the blend's own top 8 and then dropped by the
   gate:** para-05 (#2), para-07 (#8), para-10 (#1), para-12 (#1), hop-03 (#2), hop-04 (#4) and
   hop-09 (#1). For para-10 and para-12 the brain block was **empty**, although the answer was the
   best chunk in the corpus. This is the defect that was fixed.
3. **The other 14 are ordering failures.** Incidental tokens carry 0.4 of the weight and outrank
   the dense signal, and some answers sit past the dense top 8 (para-09 is 81st by cosine).
4. **Ceiling for any score fusion.** A paraphrase has lexical 0 by construction. So any fusion
   that is non-decreasing in both signals ranks its answer no higher than its cosine rank. With no
   gate at all, dense order puts **8 of 12** paraphrases in the top 8 (0.667). Reweighting, RRF or a
   threshold therefore cannot reach 0.8. Simulated for the record:

   | Variant | recall@8 | Paraphrased | No-answer abstained |
   |---|---:|---:|---:|
   | RRF, equal weights | 0.486 | 0.000 | 0/5 |
   | RRF, 0.4/0.6 | 0.629 | 0.333 | 0/5 |
   | Dense order, no gate | 0.686 | 0.667 (exact-term 0.833) | 0/5 |

5. **No-answer questions cannot be separated by any absolute score.** Kubernetes (none-03) and
   WebRTC (none-05) reach cosine 0.693 and 0.675 against the fleet and configuration pages.
   Paraphrase answers sit as low as 0.547. After the fix, the weakest answered first-place hybrid
   score is 0.032, while none-03 returns 0.213. Abstention needs a judgment of "does this chunk
   answer the question", not a floor. That is a reranker's job.

## What changed (red first)

- `fleet-memory/lexical.ts`:
  - New `scoreAgainstWithEvidence`. It returns the same scores, plus which candidates' cosine clears the embedder's own calibrated floor.
  - `scoreAgainst` delegates to it and is byte-for-byte unchanged, so run recall and search are unchanged.
- `fleet-memory/brain-index.ts` (`recallFromBrain`):
  - A chunk is related when its blend reaches `recallMinScore` **or** its cosine clears the floor.
  - The order is still the blend's.
- Total: +40/-12 lines.

**RED.** Before the production change, 2 brain-index unit tests failed:

- "expected [] to deeply equal [Array(1)]"
- "expected ['memory'] to deeply equal ['memory','decisions']"

2 golden-set tests also failed:

- "recall@8 0.4; missed para-01..."
- "expected 14 to be >= 21", from the test that the blend is never worse than either half.

**GREEN.** 18/18 in the targeted files, and the live re-measure matched the prediction to the question.

The price is one abstention: none-02 ("Trent Pro subscription") now returns Buffer's plan
pricing (`social#4`) instead of nothing.

## Decision

- **Decision E's trigger has fired.** Hybrid recall@8 is 0.629 against a floor of 0.9, and
  paraphrased is 0.417 against a bar of 0.8. The suite asserts the breach through the gate's own
  grader.
- **The prefix fix is not a lever here.** Title and heading are already prepended to every chunk
  before embedding and before TF-IDF.
- **Reranker: proposed, not built.** As the task specified, it is proposed because paraphrased
  recall stays under 0.8 with the prefix in place.

**Proposal.** A second stage over a candidate pool, returning the top 8.

1. **Candidate pool.** The pool must be **dense top-20 ∪ lexical top-20**, not the gated blend.
   That pool holds 31/35 answers (0.886) and 10/12 paraphrases (0.833). The blend's own top 40
   holds only 7/12 paraphrases. A perfect reranker over that pool tops out at 0.886, just under
   the 0.9 floor. Reaching 0.9 also needs better first-stage vectors.
2. **Option A, local cross-encoder.** For example `bge-reranker-base` (ONNX) via
   `@huggingface/transformers`.
   - 0 cents per query.
   - A one-time model download.
   - About 1 s per 40 pairs on CPU (the design's cited figure, not measured here).
3. **Option B, LLM pointwise rerank on `gemini-3.5-flash-lite`** ($0.30/M in, $2.50/M out,
   `model-gateway/pricing.ts`). The average chunk as ranked is 885 chars, so 40 candidates is
   about 35k chars:
   - input 8.9k-11.8k tokens plus about 0.5k of instructions;
   - output about 200 tokens.
   - That is **about 0.33-0.42 cents per query**.
   - Brain recall runs once per (run, seat), so a five-seat run is **about 1.7-2.1 cents**.
   - On `gemini-3.6-flash` it would be about 0.8-1.0 cents per query.
   - Option B also gives abstention: "none of these answers it" is a valid output.
4. **Measure first, at no per-query cost: Gemini's asymmetric task types.** Queries would be
   embedded as `RETRIEVAL_QUERY` and chunks as `RETRIEVAL_DOCUMENT`. The shipped embedder sends
   `{model, input}` only. Whether the OpenAI-compatible surface accepts a task type is unverified;
   the native `embedContent` endpoint takes one.
   - Cost: one re-embed of the corpus, about 2 cents.
   - What to check: whether it raises the dense ceiling (0.667 paraphrased), which bounds every
     option above.

## Enforcement from now on

`docs-corpus.test.ts` runs in the default suite with no key, in about 32 s. It asserts:

- **Fixture integrity.** The snapshot is byte-verified. Every phrase names one page. The
  categories hold to their definitions. The text the ranker embeds is byte-identical to what the
  recording is keyed on.
- **Recording coverage.** The recording covers every chunk and every question, so the hybrid is
  never silently measured as its lexical fallback.
- **The gate breach.** At its default floor (0.9) the gate reports a measured breach.
- **Floors.**

  | Mode | Floor |
  |---|---|
  | hybrid, overall | recall@8 22/35 |
  | hybrid, exact-term | 12/12 |
  | hybrid, paraphrased | 5/12 or more |
  | hybrid, multi-hop | 5/11 or more |
  | hybrid, no-answer | 2/5 or more abstained |
  | lexical | 12/35 overall and 12/12 exact-term |
  | embedding | 21/35 overall and 6/12 paraphrased |

  The blend must never do worse than either half.

To re-record after a change to the chunker, the importer or the ranked text (about 2 cents, about
10 minutes on a free-tier key):

```
( set -a; source gem.env; set +a
  TRENT_TEST_LIVE=1 TRENT_RECORD_DOCS_CORPUS=1 TRENT_QUEUE_FALLBACK=disabled \
  npx vitest run packages/trent-core/src/improve/docs-corpus.live.test.ts )
```

## Limits

- **Small set.** 35 answerable questions: one question is 2.9 points.
- **One author.** The questions and the fix have the same author. The fix was chosen from the
  analysis before the variants were simulated. It has no tuned constant (the floor is the
  shipped one), which limits how far it can fit this set, but a second person's questions
  would be stronger evidence.
- **Corpus.** Trent's own technical docs, not a founder's contracts or PDFs.
- **Cost figures.** List-price estimates from characters, because the endpoint reports no usage.
- **Open follow-up.** `lexical.ts` now carries part of the ranking decision, but it is not in
  the improve loop's frozen `ranking` surface (`improve/frozen-surface.ts`).

## Appendix: per question (rank in the top 8, `-` for a miss)

| id | category | answer chunk(s) | lexical | embedding | hybrid before | hybrid after |
|---|---|---|---:|---:|---:|---:|
| exact-01 | exact_term | cron#8 | 1 | 1 | 1 | 1 |
| exact-02 | exact_term | goals#5 | 1 | 1 | 1 | 1 |
| exact-03 | exact_term | gateway#25 | 1 | 1 | 1 | 1 |
| exact-04 | exact_term | media#17 | 2 | 1 | 1 | 1 |
| exact-05 | exact_term | improve#4 | 1 | 1 | 1 | 1 |
| exact-06 | exact_term | configuration#60 | 1 | 1 | 1 | 1 |
| exact-07 | exact_term | configuration#52 | 2 | 1 | 1 | 1 |
| exact-08 | exact_term | a2a#12 | 1 | 1 | 1 | 1 |
| exact-09 | exact_term | browser#2 | 2 | 1 | 1 | 1 |
| exact-10 | exact_term | connect#2 | 1 | - | 1 | 1 |
| exact-11 | exact_term | security#20 | 1 | - | 1 | 1 |
| exact-12 | exact_term | heartbeat#1 | 1 | 7 | 2 | 2 |
| para-01 | paraphrased | tools#9 | - | - | - | - |
| para-02 | paraphrased | service#6 | - | - | - | - |
| para-03 | paraphrased | skills#5 | - | - | - | - |
| para-04 | paraphrased | gateway#3 | - | - | - | - |
| para-05 | paraphrased | fleet#11 | - | 1 | - | 1 |
| para-06 | paraphrased | terminal#10 | - | 8 | - | - |
| para-07 | paraphrased | checkpoints#8 | - | 4 | - | 4 |
| para-08 | paraphrased | desktop#3 | - | - | - | - |
| para-09 | paraphrased | service#13 | - | - | - | - |
| para-10 | paraphrased | development-methodology-and-coding-rulebook#24 | - | 1 | - | 1 |
| para-11 | paraphrased | social#5 | - | 2 | - | 2 |
| para-12 | paraphrased | doctor#13 | - | 1 | - | 1 |
| hop-01 | multi_hop | troubleshooting#8 | - | 1 | 1 | 1 |
| hop-02 | multi_hop | gateway#8 | - | 1 | 2 | 2 |
| hop-03 | multi_hop | service#9 | - | 2 | - | 2 |
| hop-04 | multi_hop | checkpoints#6 | - | 4 | - | 4 |
| hop-05 | multi_hop | mcp#4 | - | - | - | - |
| hop-06 | multi_hop | business#5, business#6 | - | - | - | - |
| hop-07 | multi_hop | skills#7 | - | - | - | - |
| hop-08 | multi_hop | goals#4 | - | - | - | - |
| hop-09 | multi_hop | social#5 | - | 1 | - | 1 |
| hop-10 | multi_hop | doctor#12 | - | - | - | - |
| hop-11 | multi_hop | terminal#4 | - | - | - | - |

| id | query | lexical top | embedding top | hybrid before | hybrid after |
|---|---|---|---|---|---|
| none-01 | SAML single sign-on | nothing | nothing | nothing | nothing |
| none-02 | Trent Pro subscription per month | social#10 0.152 | getting-started#17 0.633 | nothing | social#4 0.054 |
| none-03 | Kubernetes cluster with Helm | fleet#16 0.184 | fleet#16 0.693 | fleet#16 0.213 | fleet#16 0.213 |
| none-04 | sync customer records with Salesforce | nothing | nothing | nothing | nothing |
| none-05 | live voice calls over WebRTC | configuration#79 0.177 | configuration#79 0.675 | configuration#79 0.184 | configuration#79 0.184 |

## P2-13: task-type embeddings and an LLM reranker, measured (2026-09-25, later)

Session log: `docs/sessions/2026-09-25-p2-13-rerank.md`. Same corpus, same 40 questions, same
grader. HEAD fb90bcb plus uncommitted changes.

### What was built

- **Task types.** The embedder can now embed a query as `RETRIEVAL_QUERY` and a chunk as `RETRIEVAL_DOCUMENT`.
  - Google's OpenAI-compatible endpoint takes no task type, so role-bearing calls go to the native `batchEmbedContents`. The key travels in the `x-goog-api-key` header.
  - Vectors are cached per task type, and symmetric cache keys are unchanged.
  - The task-typed space has its own calibrated floor, `queryFloor` 0.63. It was set by the symmetric floor's own rule on the same three sentences: unrelated 0.571, paraphrase 0.769 (symmetric: 0.529 and 0.754).
  - Brain recall passes roles. Run recall, search and the doctor probe do not, so they are byte-identical.
- **Rerank.** Config key `brain.rerank`: `mode: off | llm`, plus `model`, `max_cents_per_query` (default 1) and `min_score` (default 0.5).
  - **Pool:** cosine top-20 ∪ TF-IDF top-20, in blend order.
  - **Call:** one call per query to the profile's cheapest model (`gemini-3.5-flash-lite`). The prompt carries labels `c1..cN`, title and heading, and the first 300 chars of each candidate. The reply is a JSON list of labels with 0-1 scores.
  - **Order:** picks (score ≥ `min_score`) lead, then the rest of the blend's related set.
  - **No picks** is an empty block ("no answer").
  - **Cost cap:** a worst case over `max_cents_per_query` is refused without a call, and the blend order is kept. The worst case is priced as prompt chars/3 plus the full 2,048-token output allowance, at list price.
  - **Metering:** spend goes on the run's meter (`recordRunModelCall`, seat `brain_rerank`), so the ledger row carries the run's surface.
  - **Frozen:** `lexical.ts`, `rerank.ts` and `rerank-llm.ts` are now in the improve loop's frozen `ranking` surface.

### Results

| Stage | recall@8 | recall@3 | MRR@8 | exact (12) | para (12) | hop (11) | no-answer abstained | cents/query |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Before**: hybrid, symmetric (P2-6, shipped) | 0.629 (22/35) | 0.571 | 0.529 | 1.000 | 0.417 | 0.455 | 2/5 | 0 |
| **Task types** (hybrid, task-typed) | not measured | | | | | | | 0 |
| **Rerank** at `min_score` 0.5 (live) | **0.571 (20/35)** | 0.514 | 0.426 | 0.583 | 0.417 | 0.727 | 4/5 | 0.210 (max 0.271) |

**Task types: blocked by quota.** The re-embed stopped at 317 of 665 texts with HTTP 429.

- The quota is `EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier`, 1,000 per day, and every text in a batch counts as one request.
- P2-6's 665 texts plus today's 317 used up the day.
- A full run needs 665 requests. That fits in a fresh day (the quota resets at midnight Pacific), at about 2 cents.

**Rerank: live.** The model was `gemini-3.5-flash-lite` at model-default thinking. It made 40 calls:

- 23 ranked, 16 abstained, 1 failed (a reply with no `ranked` list, which kept the blend order).
- Metered from provider usage: 3.0k-4.0k input tokens and 237-514 output tokens per call.
- **8.41 cents in total.**
- The offline replay of the recorded scores reproduces the live ranking question for question (35 answerable, 5 no-answer).

**Why rerank lost.** 21 of the 35 answer phrases start past character 300 of their chunk, so the model never saw them.

- It scored exact-term answers the hybrid ranked first at 0 or 0.4: exact-04, -09, -10, -11 and -12.
- It then abstained on those questions.
- Multi-hop gained (5 to 8 of 11), because the scenario questions are about what a section is *about*, which its first 300 characters show.

**Threshold sensitivity.** These rows replay the same recorded scores, with no spend. They are chosen on the test set, so they are information, not a default.

| `min_score` | recall@8 | exact | para | hop | no-answer abstained |
|---:|---:|---:|---:|---:|---:|
| 0 (never abstain) | 0.771 (27/35) | 1.000 | 0.583 | 0.727 | 1/5 |
| 0.1-0.4 (identical: scores sit on the rubric anchors 0 / 0.4 / 0.7 / 0.9 / 1) | 0.743 (26/35) | 0.833 | 0.667 | 0.727 | 3/5 |
| 0.5 (shipped, fixed before the run) | 0.571 (20/35) | 0.583 | 0.417 | 0.727 | 4/5 |
| 0.7 | 0.543 (19/35) | 0.583 | 0.333 | 0.727 | 4/5 |

**Pool ceiling.** Measured offline over the symmetric recording: 31/35 (0.886). By category: exact 12/12, para 10/12, hop 9/11. The four the pool misses are para-04, para-09, hop-05 and hop-07. Pool size is 23-40 (mean 34).

- No reranker over this pool can reach recall@8 0.9.
- A perfect one reaches 0.833 on paraphrases.

### Spend

| Item | Cents |
|---|---:|
| Calibration (6 short texts, native endpoint) | ~0.001 |
| Task-typed re-embed, 325 texts / 287,258 chars (chars/4; bound chars/3: 1.44) | 1.08 |
| Rerank probe, 2 questions (metered) | 0.34 |
| Rerank measurement, 40 questions (metered) | 8.41 |
| **Total** | **9.83** |

Failed (429) requests are not billed. The key is on the free tier, so the real bill is likely $0.

### Decision

1. **Task types did not reach the bars, because they were not measured.** The embedder supports them, but `createEmbedder` turns them on only when a caller asks (`taskTypes: true`).
   - Production brain recall is exactly the measured P2-6 hybrid.
   - They become the default only after the corpus re-measure beats 22/35.
   - The command:
     `( set -a; source gem.env; set +a; TRENT_TEST_LIVE=1 TRENT_RECORD_DOCS_CORPUS=1 TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/improve/docs-corpus.live.test.ts )`.
     It writes `fixtures/docs-corpus/embeddings-task-types.json`. Before it runs, check the embedding requests other suites have spent that day.
2. **Rerank does not reach the bars and stays off by default.**
   - At the shipped threshold it is worse than the hybrid (0.571 against 0.629).
   - Its ceiling over this pool is 0.886 overall, under 0.9.
   - Its cost, 0.21 cents a query, is under the 0.5-cent line, but the rule sets the default to `llm` only when the bars are reached.
   - `brain.rerank.mode: llm` remains an opt-in that this measurement does not recommend.
3. **The next measurement is the 300-character snippet.** The data points to it more than to the threshold.
   - Changing one variable, whole chunks (up to 1,200 chars), would cost about 0.36 cents a query, or about 15 cents for the set.
   - The 2,048-token output allowance must be lowered, or the cap raised, for the largest pools to stay under the 1-cent worst case.
   - Reaching 0.9 overall also needs a first stage whose pool holds more than 31/35. That is where task types, measured, come in.
4. **Wiring gap, recorded rather than hidden.** `rerankerForProfile(config, gateway)` builds the reranker from config, and `recallFromBrain({ rerank, runId })` uses it. But neither the fleet-memory hook (`fleet-memory/orchestrator-hook.ts`) nor the CLI wiring (`apps/cli/src/repl/fleet-memory.ts`) passes one yet. Until they do, `mode: llm` changes no seat run. This matters only once a measurement justifies turning rerank on.

### Enforcement added (`improve/docs-corpus.test.ts`, offline, no key)

- The P2-6 floors are unchanged, because the shipped space is unchanged.
- The replay must not call the task-typed and symmetric spaces into each other (`modeMismatches` 0).
- The frozen surface refuses `lexical.ts`, `rerank.ts` and `rerank-llm.ts`.
- The rerank replay must cover all 40 questions on their recorded pools. It asserts:
  - statuses 23 ranked, 16 abstained, 1 failed;
  - pool coverage 31/35;
  - floors: 20/35 overall, exact ≥ 7, para ≥ 5, hop ≥ 8, abstained ≥ 4;
  - cost: mean 0.2102 cents and max 0.2714 cents a query, under `max_cents_per_query`.
