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
