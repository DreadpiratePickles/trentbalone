# CS329A applied to Trent's self-improvement loop (Layer 3 reference)

Source: `/Users/bobbymeher/Desktop/STANFORD_CS329A_COMPLETE_STUDY_GUIDE.md` (5,101 lines, read in full).
Citations are `L<n> @mm:ss (guide line N)`. Trent code as of 2026-09-13 on `feature/trent-fleet-v2`.
Read-only analysis; nothing in the repo was modified except this file.

## 0. Code facts the delta rests on (verified, not assumed)

| fact | where |
|---|---|
| Real suites `ads` and `prospecting` have 6 fixtures each, 37 / 54 `llm_rubric` assertions, and zero `contains` / `required_tools` graders. | `apps/web/.agents/skills/{ads,prospecting}/evals/evals.json` |
| So `scoreUnder`'s deterministic stage is empty for them (`deterministic.length === 0`) and the "deterministic first, judge second" property never fires. | `packages/trent-core/src/improve/gate.ts:140-158` |
| Without a judge every rubric scores 0.75 tagged `llm_judge_pending`, baseline and candidate alike; delta 0, tag present in both cluster maps, so `executeGate` returns `promoted: true`. | `gate.ts:196-201`, `apps/web/lib/eval-harness.ts:109` |
| The baseline is re-executed on every sweep (`cachedBaseline` is per call). Gate cost is never summed: `report.costCents` starts at 0 and is never incremented. | `sweep.ts:244-249`, `sweep.ts:311` |
| Rubric failures produce one tag, `rubric_failed`, so the frontier's cluster profile has at most two buckets. | `eval-harness.ts:106`, `apps/web/lib/gepa.ts:146` |
| `evalScore` is never set on a written trace, so `high_score_no_skill` never fires and `worstPerformingRole` is always null. | `trace-writer.ts:108`, `apps/web/lib/trace-store.ts:96` |
| Executor and judge are the same model, `gemini-3.5-flash-lite`, temperature 0, one sample per fixture. | `gate.ts:246-258`, `improve.live.test.ts:17` |
| GEPA reflection asks for a minimal edit but nothing enforces a length bound on the proposal. | `apps/web/lib/gepa.ts:82-84`, `gepa-pass.ts:75-78` |
| The Foundry's `error_recovery` trigger deliberately selects runs containing a retried/escalated step. | `apps/web/lib/trace-store.ts:152-154` |
| Golden capture stores objective + reason only; the human's corrected output is not attached. | `golden-capture.ts:60-66` |

## 1. Taxonomy, mapped

### 1.1 Test-time compute scaling (L1, L2, L7)
Claims: coverage follows a power law in samples; per problem pass@k = 1-(1-p)^k (L2 @07:33, line 793-797). Llama-3 8B beats 1-sample GPT-4o at 10k samples (L1 @22:50, line 328-331); DeepSeek-V3 beats Claude 3.5 Sonnet on SWE-bench after 1,000 samples (L2 @03:37, line 770). Only holds with a verifier: majority voting plateaus at 10-50 samples (L2 @16:45, line 840). Compute-optimal split: easy problems want sequential revision, hard ones parallel (L2 @37:01, line 963-968). Small models are viable with inference compute except on the hardest tier (L2 @39:00, line 977-979). AlphaCode 2 reached AlphaCode's 1M-sample score with 100 samples by upgrading the base model and the scorer (L7 @30:28, line 3747).
**Verdict: Trent does a degenerate form (k=1, temp 0) and should not add more.** The loop is a prompt/skill optimiser scoring 6-fixture suites, not a solver. The lesson that transfers is cost discipline: Archon optimises under an explicit inference-call budget (L2 @46:01, line 1010; @61:09, line 1099); Trent's sweep has none.

### 1.2 Verification (L3, L2)
Claims: a trained verifier beats fine-tuning once it has >1,000 labels (L3 @12:03, line 1347); larger generator + smaller verifier beats the reverse (L3 @13:20, line 1353); gains stop at ~400 samples and degrade at 800 because the verifier cannot separate near-identical candidates (L3 @14:33-14:43, line 1357-1358). PRM > ORM > majority; PRM finds correct answers present in <5% of samples (L3 @29:48, line 1455); 100 ORM labels ~ 1 PRM label (L3 @30:44, line 1461); combine both (L3 @32:00, line 1466). Rollout-based step labels: n=4 was the sweet spot, hard estimate chosen (L3 @43:59, line 1532-1534). BEAVER: unweighted verifier ensembles help non-monotonically; weighting with ~1% labels helps consistently (L3 @54:26-54:43, line 1583-1584); an 8B generator + <=8B verifier pool reaches ~70%, roughly the 70B majority-vote class (L3 @62:29, line 1632-1635); a 400M distilled verifier keeps 97% of the pool's accuracy at 99%+ less compute (L3 @65:00, line 1647-1651). **Multi-agent verification (rubric-prompted LLM judging) did not beat majority voting and lost in two cases (L3 @61:42, line 1630).** Unit tests are simpler to write than the program (L2 @13:12, line 823).
**Verdict: Trent has the gate shape right (execute, deterministic first, judge second) but its only real graders are the weakest class the course measured.** Add mechanical graders to `evals.json`, refuse to promote when no verifier ran, and calibrate the judge against the human promote/reject ledger (BEAVER's 1%-label weighting, minus the training).

### 1.3 Tool use / execution feedback (L4 ReAct, RLEF)
Claims: ReAct 66.6 vs human 82.1 on WebShop, errors cascade across steps (L4 @21:48-21:55, line 2009-2010). RLEF: "the self-improvement loop works" with a binary reward on simple problems (L4 @40:10, line 2132-2134); what helps is seeing the error, not the faulty solution (L4 @36:18, line 2109); **public tests for iteration, private tests for the reward, so the model cannot memorise the test (L4 @31:33, line 2071-2074).**
**Verdict: Trent already does the runtime side (the app's orchestrator is ReAct-shaped with a per-step critic).** It should add the public/private split: the GEPA reflection sees failing traces, and if promoted goldens from those same failures join the gate suite, the prompt is tuned to its own test.

### 1.4 Self-critique / Constitutional AI (L4)
Claims: 16 human-written principles replace human labels; harmlessness up with helpfulness roughly held; SL alone underperforms, RL+CoT gives the best Pareto frontier (L4 @58:26, line 2228-2235). AI feedback validated by matching a sample against human judgments (L4 @57:40, line 2227). **Models are worse at critiquing themselves; use other models or a consensus (L4 @59:38-60:01, line 2240-2244).**
**Verdict: Trent does this (protected seat prompt = constitution; the app's critic; only a human promotes).** The caveat it ignores: the same flash-lite model executes and judges.

### 1.5 Planning and search (L5 LATS, SPRINT, SWiRL)
Claims: LATS value = LLM judge score + self-consistency frequency, UCT selection; near-human on WebShop with no fine-tuning; cost not analysed (L5 @10:19-11:18, line 2557-2562; @19:43-19:56, line 2612-2613). SPRINT +3.5% and ~40% fewer sequential tokens via planner/executor DAG (L5 @37:27, line 2709; @45:02, line 2746). SWiRL: judge the tool QUERY before executing it (L5 @62:09, line 2843); **process-filtered data beat outcome-filtered for RL (L5 @67:02, line 2874-2878), but SFT needed both filters because imitation of a wrong-outcome trajectory hurts (L5 @72:47-73:10, line 2902-2904)**; generalisation 65 -> 75.1 across tools (L5 @68:18, line 2883).
**Verdict: LATS/SPRINT do not apply (tree search is unaffordable on a free tier; no fine-tuning). SWiRL's filter rule applies directly to the Foundry**, which is imitation: it distils SKILL.md from trajectories, so it must only distil from process-AND-outcome-clean traces. The `error_recovery` trigger selects the opposite.

### 1.6 Train-time scaling: STaR, GRPO, DAPO (L6)
Claims: the loop is "filter test-time output, fine-tune, repeat" (L6 @05:23, line 3077); STaR needs enough successes to close the loop (L6 @13:32, line 3122); rationalisation = give the failed problem its answer, ask for the rationale, train on it without the hint (L6 @18:48, line 3154); STaR plateaus, uses 70-87% of data (L6 @28:44-28:54, line 3217-3218); GRPO 46.8 -> 51.7 with no critic (L6 @46:08, line 3311); **all-0 or all-1 reward groups teach nothing (L6 @48:40, line 3327)**; RL raised majority@k, not pass@k: the model got more consistent, not smarter (L6 @52:32-52:58, line 3348-3350). DAPO: naive scale-up collapses entropy, overconfidence, instability, length explosion (L6 @53:17, line 3352-3356); fixes: asymmetric clip, dynamic sampling that drops all-correct/all-wrong groups, token-level length penalty, 30 -> 36 -> 38 -> 41 -> 42 -> 50 on AIME (L6 @59:43-60:11, line 3389-3399); **monitor response length, entropy, and the fraction of all-1 groups; a plateau means the reward model is saturated (L6 @60:25-60:54, line 3401-3405)**; learning from failures "has not been nailed" (L6 @23:41, line 3182; @66:15, line 3433).
**Verdict: weight updates do not apply. Four loop-level analogues do:** (a) rationalisation -> attach the human's corrected output to a captured golden as `expected_output`; (b) dynamic sampling -> skip GEPA when the baseline is saturated at 1.0 and stop judging fixtures whose output did not change; (c) length penalty -> cap the proposed prompt's growth; (d) majority@k vs pass@k -> `gepaBestScore` on a frozen suite is consistency, and must not be reported as capability.

### 1.7 Search over samples: AlphaCode, Search-o1 (L7)
Claims: filter by the problem's public tests then cluster by behaviour; filtering removes 95% (L7 @29:33, line 3736); selection is the bottleneck: 10@k 30% vs pass@k 40% (L7 @18:39, line 3684); more samples only help if diversity grows (L7 @21:06-21:31, line 3696-3698); the scorer must not train on the same problems it ranks (L7 @36:21, line 3778); loss is a poor proxy for solve rate (L7 @23:10, line 3706). Search-o1: retrieve on demand, reason inside documents, keep only relevant chunks (L7 @52:38, line 3849).
**Verdict: Search-o1 is runtime, not loop.** The AlphaCode filter-before-score pattern is the shape of item 1.1's cost fix: score cheaply and deterministically first, spend the expensive verifier only on what survives.

### 1.8 Evaluation and long horizons (L8)
Claims: METR horizon doubles every 7 months at 50% reliability (L8 @14:29, line 4168) but **59 min at 50% becomes 8-15 min at 80% (L8 @20:48-21:59, line 4206-4212)**; failure modes: poor planning, wrong tool, wrong reasoning, premature abandonment, repetitive loops (L8 @22:56-23:41, line 4215-4218); **a model on an unseen codebase behaves like a contractor 5-18x slower than the maintainer, a "low context human" (L8 @26:30-27:00, line 4231-4233)**; GDPval win rate 12.4% -> 47.6%, linear not exponential (L8 @36:09-36:30, line 4303-4304); models promise to read reference data and hallucinate instead (L8 @38:50, line 4315); underspecified prompts cost points (L8 @45:40, line 4361); N tries + self-fix improved cost 1.6x, speed 1.4x (L8 @40:40-41:10, line 4327-4329); judges reach 70-80% human agreement (L8 @55:06, line 4414).
**Verdict: three direct hits.** (1) The contractor finding is the argument for turning `SKILL_INJECTION_ENABLED` on: every promoted skill is context the seat otherwise lacks. (2) One temp-0 pass is a 50%-reliability measurement; promotion needs a second draw on the fixtures that flipped. (3) The five failure modes are a free trace-level taxonomy; `repetitive_loop` is detectable from `toolCalls` with no model call.

### 1.9 Future directions (L9)
Claims: a single LLM's synthetic data stops helping after a few iterations for lack of diversity; multi-agent generation + critic keeps improving (L9 @07:49, line 4679; @13:42, line 4709). LLMs certify invalid proofs as valid (L9 @16:34, line 4725); **meta-verification checks whether the verifier's cited issues exist and whether the score follows from them (L9 @18:03-19:08, line 4730-4735)**, 42% on IMO shortlist at best@32 (L9 @20:55, line 4747), limited to easier-verification domains (L9 @22:34, line 4756). Self-proposed tasks: proposer reward 1 - success rate, zero if never solved, so tasks land at the frontier of ability; validate tasks before they enter training (L9 @27:07-28:08, line 4779-4785). Verifiers must return in minutes, not days (L9 @35:53, line 4830). Non-verifiable domains: train an offline reward model from collected outcomes (L9 @37:37, line 4840). Memory stores are easier; weights are needed to reason over new domains (L9 @63:03-63:24, line 4978-4979). Local <=20B models answer 88.7% of chat queries (L9 @49:24, line 4911).
**Verdict:** meta-verification has a zero-cost form Trent should add (judge cites evidence; gate checks the quote exists). The proposer reward is the rule for which goldens deserve judge budget. Multi-agent GEPA: not until a budget exists. Trent's memory-store choice is the course's "easier" branch, with the stated ceiling.

## 2. Where the lecturers disagree, and which side Trent's evidence supports

Guide section 2 (line 76-89) and the lecture notes carry six live tensions.

1. **Inference-time vs train-time.** Test-time compute recurs per query (L1 @26:21; L2 @40:00, line 987); train-time amortises but needs stable rewards and collapses when they saturate (L6 @52:32; L9 @60:54). Trent cannot fine-tune, so it is inference-side by necessity, and its recurring cost is the injected skill prelude on every prompt. Evidence supports adopting Hermes' write-time budget for injected context (already in the reference, item 7) and nothing else.
2. **Rule-based verifiers vs learned/ensembled verifiers.** Early lectures: unit tests (L1 @21:36, line 323). Later: BEAVER, meta-verification, LLM-as-judge for domains without oracles (L3 @54:38; L9 @17:07; L5 @56:48). The course's own measurement settles it for Trent: rubric-prompted LLM judging (MAV) lost to majority voting (L3 @61:42, line 1630). Trent's suites are 100% rubric. Trent's evidence supports the early lectures: write `contains` / `required_tools` first, keep the judge for what they cannot express.
3. **Process vs outcome reward.** L3: PRM > ORM and combine (line 1466). L4: "not completely solved, depends on domain" (L4 @40:30, line 2135). L5: process-filter wins for RL, both filters needed for SFT (line 2874-2904). Trent has both signals per trace (critic verdict per step = process, run status = outcome) and its Foundry is imitation. Evidence supports L5's SFT rule: distil only from traces that are clean on both.
4. **Generalisation vs specialisation.** RL raises majority@k not pass@k (L6 @52:32, line 3348); SWiRL transfers across tools (L5 @68:18, line 2883). Trent's per-agent frontier is specialisation by design, and its org-tier promotion runs the gate against every consuming agent's suite (`org-tier.ts`). That is the correct hedge; do not expect a seat skill to transfer without that gate.
5. **Same-family generator and verifier.** "Models like their own traces more" (L1 @38:03, line 398; L3 @72:11, line 1696) vs "a different class of verifier can help" (L3 @72:26) with no study either way (L3 @72:37, line 1698). Trent runs one model for both and has no evidence yet. The cheap experiment is logging judge verdict vs later human decision per iteration; that ledger already exists (`ledger.ts`).
6. **Can models critique themselves?** Constitutional AI says yes with principles (L4 @50:43); the same lecturer says self-critique is harder and consensus of other models is better (L4 @59:38-60:01, line 2240-2244). Trent's critic is the same model as the executor. Same experiment as 5.

## 3. Five highest-leverage additions, ranked

Cost basis: the `ads` seat suite is 6 fixtures and 37 rubric assertions. One gate run with a judge = 6 executor calls + 37 judge calls = 43. A sweep does baseline + skill candidate + GEPA candidate (+1 reflection) = **130 calls per agent**. Nine seats with such suites would be ~1,170 calls per sweep. Free-tier flash-lite limits are not in the repo; assume the order of 10-15 requests/min and ~1,000/day, so one full sweep is already the daily quota. Every addition below is measured against that 130.

### 3.1 Content-addressed baseline and memoised judge verdicts
- **From:** AlphaCode filter-before-score (L7 @29:33, line 3736); verifier ensembles are "very costly ... to run a ton of models for each solution", fix by caching/distilling (L3 @64:16, line 1641-1643); Archon's explicit call budget (L2 @61:09, line 1099).
- **Attach:** `packages/trent-core/src/improve/sweep.ts` (`cachedBaseline`), `gate.ts` (`scoreUnder`), plus a `gateCache` table in `sqlite-store.ts` keyed by `(suite.version, sha256(systemPrompt))` for the baseline and `(fixtureId, rubric, sha256(actual.text))` for verdicts.
- **RED asserts:** second `runImprovementSweep` with an unchanged seat prompt and suite version makes **0** actuals calls for the baseline; a candidate whose output on fixture X hashes equal to the baseline's makes **0** judge calls for X and reuses the stored verdict; `report.costCents` equals the sum of gate `costCents` (today it is always 0).
- **Cost:** baseline 43 -> 0 on every sweep after the first; candidate judge calls 37 -> only the assertions on fixtures whose text changed. Typical sweep 130 -> ~15-50.

### 3.2 Mechanical graders, and no verifier means no promotion
- **From:** unit tests as the verifier (L1 @21:36, line 323); a test is simpler to write than the program (L2 @13:12, line 823); MAV underperforms majority voting (L3 @61:42, line 1630); ORMs alone get reward-hacked (L3 @25:01, line 1426).
- **Attach:** `suites.ts` already maps `contains` / `required_tools`; the gap is `apps/web/.agents/skills/*/evals/evals.json` (read-only app, so add a wrapper-side overlay `<skills>/<name>/evals/mechanical.json` merged by `fileSuiteProvider`) and `gate.ts:executeGate`.
- **RED asserts:** a suite with only `llm_rubric` graders and `judge === undefined` yields `promoted: false, blockedBy: "unverified"`; with an overlay containing `contains`, `verdict.stage === "deterministic"` is reachable and a missing term blocks before any judge call.
- **Cost:** negative. Deterministic failures end the gate at 6 calls instead of 43.

### 3.3 Evidence-cited judge with deterministic meta-verification
- **From:** meta-verifier asks "do these issues actually exist, does the score follow" (L9 @18:03-19:08, line 4730-4735); verifiers should return reasoning with the score (L2 @50:38, line 1033); models are ~80% confident when 50% right (L7 @70:34, line 3940); validate AI feedback against human labels (L4 @57:40, line 2227).
- **Attach:** `gate.ts` `JudgeVerdict` gains `evidence?: string`; `scoreUnder` stage 2 checks `actual.text.includes(evidence)` and otherwise records `judge_unverified` with score 0 for that grader; `ledger.ts` gains `judgeAgreement` on human promote/reject so the weighting in 2.2 has data.
- **RED asserts:** a judge returning `{pass: true, evidence: "text not in output"}` scores the grader 0 with tag `judge_unverified`; a human `rejectDraft` on an iteration whose judge said pass writes an agreement row of `false`.
- **Cost:** 0 extra calls (same judge call, stricter contract).

### 3.4 Signal filtering: saturation skip, length guard, real cluster profiles
- **From:** all-1 / all-0 groups carry no gradient, filter them (L6 @48:40, line 3327; @55:29-56:27, line 3369-3373); length explosion needs a token-level penalty (L6 @53:17, line 3352-3356; @57:01, line 3381); plateau = saturated reward (L6 @60:54, line 3405); frontier diversity needs distinct profiles (L2 @21:22 diversity; `gepa.ts:146`).
- **Attach:** `gepa-pass.ts` (skip when `baseline.score === 1`, reject proposals longer than 1.25x the current prompt before the gate); `gate.ts` (rubric failure tag becomes `rubric_failed:<fixtureId>` so `clusterKey` has a real profile); `status.ts` reports `suiteSaturated`.
- **RED asserts:** baseline 1.0 -> `skipped: "suite_saturated"` with 0 actuals calls; a 2x-length proposal -> `skipped: "proposal_too_long"` with 0 calls; two candidates failing different fixtures land in two frontier slots instead of one.
- **Cost:** negative (skips whole gate runs).

### 3.5 Reliability re-draw on flipped fixtures
- **From:** 50% vs 80% horizon gap (L8 @20:48-21:59, line 4206-4212); pass@k = 1-(1-p)^k (L2 @07:33, line 795-797); verifier cannot separate near-identical candidates (L3 @17:35, line 1374); "run the task multiple times" for noisy feedback (L4 @24:23-24:30, line 2023-2024).
- **Attach:** `gate.ts:executeGate` after a `promoted` verdict: re-run only fixtures whose pass/fail differs from baseline, at temperature 0.7, once; promote only if the flip holds.
- **RED asserts:** a scripted actuals that passes fixture X on draw 1 and fails on draw 2 gives `promoted: false, blockedBy: "unstable"`; fixtures that did not flip are not re-run.
- **Cost:** + (flipped fixtures) executor calls + their assertions, bounded by the suite size; typically 1-2 fixtures = 8-15 calls.

**Prerequisite, not ranked:** flip `SKILL_INJECTION_ENABLED` on in the wrapper's runtime env. L8's contractor finding (line 4231-4233) is the whole reason the loop exists, and `appliedRate` stays 0 until it is on.

## 4. What the course says not to do that Trent does, or is about to

1. **A gate that promotes with no verifier.** No judge + rubric-only suite = 0.75 vs 0.75 = promoted. That is reward hacking by construction (L3 @25:01, line 1426; L9 @36:52, line 4835). Fix: 3.2.
2. **Rubric-prompted LLM judging as the only real verifier.** The one verifier class the course measured as worse than majority voting (L3 @61:42, line 1630). Both real suites are 100% this.
3. **Same model generating and judging.** "They like their own traces more" (L1 @38:03; L3 @72:11). No mitigation on a one-model free tier except logging agreement (3.3) and mechanical graders (3.2).
4. **Re-executing the baseline every sweep and judging every assertion on unchanged outputs.** The course's cost lessons (L7 @31:34, line 3752: 95% of samples wasted; L3 @64:16) are about exactly this. Fix: 3.1.
5. **No budget on the sweep.** Archon treats the call budget as an input (L2 @46:57, line 1013-1017). `report.costCents` is a constant 0; nothing stops a sweep from spending the day's quota.
6. **Distilling skills from trajectories with a wrong step.** `error_recovery` triggers on `sawRetry && finishedClean`. The Foundry is imitation, and SFT needs process-and-outcome-clean data (L5 @72:47-73:10, line 2902-2904). Either filter the retried step out of what the Foundry sees, or distil only the recovery as an explicit "when X fails, do Y" and gate it.
7. **Reporting `gepaBestScore` as improvement.** On a frozen suite it is majority@k, not pass@k (L6 @52:58, line 3350). Report it with the suite version and the number of fixtures, and only claim improvement when goldens were added.
8. **One temp-0 draw as a promotion decision.** A 50%-reliability measurement presented as a gate (L8 @20:48). Fix: 3.5.
9. **About to do: multi-agent GEPA / fusion.** Archon's fusion beats oracle selection (L2 @51:33, line 1042) and multi-agent diversity keeps the loop alive (L9 @13:42), but both multiply calls. Do not add until 3.1 and the budget exist.
10. **About to do: promoting goldens into the same suite GEPA reflects on.** RLEF's public/private split (L4 @31:33, line 2071-2074). Keep a private partition of the suite that reflection never sees.

## 5. Open problems the course flags that Trent hits

| problem | where flagged | mitigation offered | Trent |
|---|---|---|---|
| Generation-verification gap | L2 @17:50 (846); L3 @00:09 | ensembles (BEAVER), generated unit tests (Code Monkeys, L3 @68:28, line 1677) | goldens can carry `contains` / `required_tools`; write them at promotion time |
| Reward hacking of proxy judges | L3 @31:46 (1465); L9 @36:52 | PRM+ORM (L3 @32:00), rubric + tools (L3 @48:19, line 1559-1561), meta-verification (L9 @18:03) | 3.2, 3.3 |
| majority@k rises, pass@k does not | L6 @52:32 (3348); @66:47 | none; "open"; self-proposed curriculum is the nearest (L9 @27:07) | grow the suite from failures; report consistency honestly |
| Error cascading, repetitive loops | L4 @21:55 (2010); L8 @23:41 (4218) | backtracking, confidence, repeat and take best (L4 @23:34-24:30) | free `repetitive_loop` tag from `toolCalls`; feeds skill-health |
| Non-verifiable domains | L9 @35:20 (4826-4835) | offline reward model from collected outcomes (L9 @37:37) | growth/content/support seats: the human promote/reject ledger IS the collected outcome; use it to weight the judge |
| Static, human-curated prompts | L9 @06:02 (4671) | self-proposed tasks, validated before use (L9 @28:08) | goldens from `run_failed` are the proposer; human promotion is the validation; the proposer reward (1 - success rate) is the priority rule |
| Calibration / overconfidence | L4 @13:01 (1951); L7 @70:26 (3939) | second-pass confidence + RL (L7 @71:10) | log judge vs human agreement (3.3) |
| Single-model diversity collapse | L9 @07:49 (4679) | multi-agent generation + critic | GEPA single lineage; accept until budget |
| Same-family verifier bias | L3 @72:37 (1698) | none, "good research question" | measure via ledger |
| Continual learning | L4 @52:41 (2203); L9 @53:31 (4931) | memory store easier, weights for new-domain reasoning (L9 @63:03) | Trent chose memory; ceiling acknowledged |
| Tree-search cost never analysed | L5 @19:56 (2613) | none | reason not to add LATS |
| Verifier must answer in minutes | L9 @35:53 (4830) | offline reward model | executing gate at 43 calls/run is minutes on the free tier; 3.1 keeps it there |

## 6. Applied plan for the next iteration of `packages/trent-core/src/improve/`

Format per `02_plan/output/implementation-plan.md`: 2-5 minute tasks, the failing test first, `apps/web` untouched.

### Task I.1 — Sweep reports what it spent
- **RED** `sweep.test.ts`: a sweep whose scripted actuals charge 1 cent per call reports `report.costCents === totalCalls`. Expected failure: `expected 0 to be 43`.
- **Then** sum `verdict.costCents` from `gateDraft`, `measureBaseline` and `runGepaPass` into the report.
- **Commit:** `fix(improve): sweep cost is the sum of gate costs, not zero`

### Task I.2 — Budget cap on a sweep
- **RED** `sweep.test.ts`: `budgetCents: 10` with 1-cent calls stops after 10 and marks remaining drafts `blockedBy: "budget_exhausted"`. Expected failure: `expected 43 to be <= 10`.
- **Commit:** `feat(improve): integer-cent budget cap per sweep`

### Task I.3 — Baseline is content-addressed
- **RED** `sweep.test.ts`: two sweeps, same prompt and suite version, second makes 0 baseline actuals calls. Expected failure: `expected 6 to be 0`.
- **Then** `gateCache` table (`sqlite-store.ts`, `memory-store.ts`, `store-contract.ts`) keyed by `(suiteVersion, promptHash)`.
- **Commit:** `feat(improve): persisted baseline keyed by suite version and prompt hash`

### Task I.4 — Judge verdicts are memoised by output hash
- **RED** `gate.test.ts`: candidate whose fixture X output equals the baseline's makes 0 judge calls for X. Expected failure: `expected 1 to be 0`.
- **Commit:** `feat(improve): judge verdict cache keyed by fixture, rubric and output hash`

### Task I.5 — No verifier, no promotion
- **RED** `gate.test.ts`: rubric-only suite, no judge -> `promoted: false, blockedBy: "unverified"`. Expected failure: `expected true to be false`.
- **Commit:** `fix(improve): a candidate nobody verified cannot be promoted`

### Task I.6 — Mechanical grader overlay
- **RED** `suites.test.ts`: `fileSuiteProvider` merges `<skill>/evals/mechanical.json` (`contains`, `required_tools`) into the fixture graders; the merged suite version changes. Expected failure: `expected [] to contain {type:'contains'}`.
- **Commit:** `feat(improve): wrapper-side mechanical graders overlay the app's rubric suites`

### Task I.7 — Judge cites evidence, gate checks it
- **RED** `gate.test.ts`: `{pass: true, evidence: "absent"}` scores 0 with tag `judge_unverified`. Expected failure: `expected 1 to be 0`.
- **Commit:** `feat(improve): deterministic meta-verification of judge evidence`

### Task I.8 — Judge/human agreement ledger
- **RED** `lifecycle.test.ts`: `rejectDraft` on an iteration whose stored verdict was `promoted: true` writes `judgeAgreement: false`. Expected failure: property missing.
- **Commit:** `feat(improve): record judge-vs-human agreement on every promote and reject`

### Task I.9 — Per-fixture failure tags
- **RED** `gate.test.ts`: two candidates failing different fixtures produce different `failureClusters` keys and occupy two frontier slots. Expected failure: `expected 1 to be 2`.
- **Commit:** `fix(improve): rubric failures are tagged per fixture so the Pareto frontier has a profile`

### Task I.10 — Saturation skip
- **RED** `gepa-pass.test.ts`: baseline 1.0 -> `skipped: "suite_saturated"`, 0 actuals calls. Expected failure: `expected undefined to be 'suite_saturated'`.
- **Commit:** `feat(improve): no GEPA pass on a saturated suite`

### Task I.11 — Proposal length guard
- **RED** `gepa-pass.test.ts`: reflection returning a prompt 2x the current -> `skipped: "proposal_too_long"`, 0 gate calls. Expected failure: gate was called.
- **Commit:** `feat(improve): reject prompt proposals that grow more than 25 percent`

### Task I.12 — Re-draw on flipped fixtures
- **RED** `gate.test.ts`: fixture passes draw 1, fails draw 2 -> `blockedBy: "unstable"`; unflipped fixtures not re-run. Expected failure: `expected true to be false`.
- **Commit:** `feat(improve): a promotion must survive a second draw on the fixtures it changed`

### Task I.13 — Foundry sees clean traces only
- **RED** `sweep.test.ts`: a group with one `retry` step and a clean finish passes only the clean steps to `foundry.distill`, with `error_recovery` recorded on the iteration. Expected failure: `expected 3 to be 2`.
- **Commit:** `fix(improve): imitation distils from process-and-outcome-clean traces`

### Task I.14 — Golden carries the corrected output
- **RED** `golden-capture.test.ts`: a `step_end` with `humanCorrected` output after a `run_failed` golden attaches `expected_output` to that golden. Expected failure: property missing.
- **Commit:** `feat(improve): STaR-style rationalisation input on captured goldens`

### Task I.15 — Repetitive-loop tag
- **RED** `trace-writer.test.ts`: three identical consecutive tool calls in a step set `failureTags: ["repetitive_loop"]` on the row (new nullable column). Expected failure: column missing.
- **Commit:** `feat(improve): METR failure-mode tag for repetitive loops, no model call`

### Task I.16 — Private partition of the suite
- **RED** `suites.test.ts`: fixtures marked `private: true` are excluded from anything handed to `buildReflectionPrompt` and included in the gate. Expected failure: private fixture present in reflection input.
- **Commit:** `feat(improve): public/private suite split so GEPA cannot tune to its own test`

### Task I.17 — Enable skill injection in the wrapper runtime
- **RED** `runtime/env.test.ts`: `applyStandaloneEnv` sets `SKILL_INJECTION_ENABLED=1`; a run with a live skill writes a trace with `skillApplied: true`. Expected failure: `expected false to be true`.
- **Commit:** `feat(core): promoted skills reach the seat that earned them`

Order: I.1-I.5 first (cost and the vacuous gate), then I.17 (the loop's output finally lands), then the rest.

## Status (2026-09-13)

All 17 tasks landed on `feature/trent-fleet-v2`:

| Tasks | Commit | Evidence |
|---|---|---|
| I.1–I.5, I.17 | `8e79c0a` | gate cannot promote unverified; real cost meter; 71 tests |
| I.6–I.12 + seat-model wiring | `6393486` | mechanical overlay, evidence-cited judge, agreement ledger, per-fixture tags, saturation/length guards, second draw; 193 tests |
| I.13–I.16 | `a01cbab` | clean-trace goldens + rationales, repetitive-loop tag, private hold-out; 110 tests |

Session logs: `docs/sessions/2026-09-13-cs329a-batch-{2,3}.md`.
