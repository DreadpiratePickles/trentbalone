# 2026-09-20 W4: `media_image`, image generation for the creator and social agents

Branch `feature/trent-fleet-v2`, HEAD 7243f91. Nothing committed or staged by this session (the
orchestrating session owns the commits). Other agents were editing `tools/business/**`,
`tools/social/**`, `improve/**`, `fleet-memory/**`, `doctor/checks/business.ts` and
`docs/doctor.md` in the same tree at the same time; none of those files were touched here.

## What landed (RED first for each, exact commands below)

Provider facts confirmed by fetch on 2026-09-20 before any code:
- https://ai.google.dev/api/generate-content: `POST /v1beta/models/{model}:generateContent`,
  `generationConfig.responseModalities` TEXT|IMAGE, `imageConfig` aspectRatio and imageSize,
  the image as `candidates[].content.parts[].inlineData` {mimeType, data}.
- https://ai.google.dev/gemini-api/docs/image-generation: model ids `gemini-3.1-flash-image`
  (default here), `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`
  (legacy); the key in the `x-goog-api-key` header. (That page now documents the newer
  Interactions API; the generateContent path is the reference above and is what the tool uses.)
- https://ai.google.dev/gemini-api/docs/pricing: $60/M image output tokens on 3.1 flash
  (1120 tokens per 1K image = $0.067), $30/M on 3.1 flash lite ($0.0336), $120/M on 3 pro
  ($0.134), 2.5 flash $0.039 (1290 tokens). Rounded UP to 7, 4, 14, 4 integer cents.
- https://developers.openai.com/api/docs/guides/image-generation: `POST /v1/images/generations`,
  `data[0].b64_json`, sizes 1024x1024 / 1536x1024 / 1024x1536; the current model ids and prices
  were not stable enough to ship, so a non-Gemini provider needs `image_model` and
  `image_price_cents` in the profile.

Files:
- `packages/trent-core/src/tools/media/image.ts` (new, 278 lines): the price table with its
  source and date, `resolveImageRoute` (typed `TrentError` exit 3 naming the variable or the
  config key), the Gemini and OpenAI-images request builders and parsers, `generateImage` (key
  read at send time, header only, redacted from any error text), `imageFileName`
  (`<sha256[0:16]>.<ext>`), `briefPrompt` (the thumbnail-brief "Generation prompt (for later)"
  paragraph per variant).
- `packages/trent-core/src/tools/media/image-tool.ts` (new, 180 lines): the adapter side. Plan
  (prompt or brief, aspect, route, price) -> `requireBoundApproval` with the prompt and the
  price as the preview unless `media.image_auto_approve_under_cents` covers it (strictly under)
  -> one HTTP call -> file under the workspace -> `recordToolSpend` (`surface: tool`,
  `provider`, `model`, integer cents, `units: 1`, the run id from the tool-call context).
  `dryRun` stamps the bound row (`currentBoundApprovals().preview`) so a step's yes covers the
  replay of exactly this call, the way `autonomy-dispatch.ts` does for the class floor.
- `tools/media/schemas.ts`: the `media_image` schema (`brief` declared as a path) and spec;
  `tools/media/index.ts`: wiring, `fetchImpl` and `seat` options, exports;
  `tools/tool-names.ts`: `media_image` in the media row (the tools-index test holds every scope
  to that table).
- `config/sections/media.ts`: `image_provider` (auto|google|openai|ollama|lmstudio|deepseek|groq,
  named literally the way `sections/models.ts` names the aliases; `image.test.ts` holds the list
  to `PROVIDER_ALIASES`), `image_model`, `image_price_cents`, `image_auto_approve_under_cents`
  (default 0 = always ask). `config/defaults.ts` media block; `schema-split.input.json` values;
  `schema-split.snapshot.json` regenerated (`npx tsx scripts/dev/regen-snapshot.mjs`, keys 38).
- `doctor/checks/media.ts`: `describeImageRoute` and one sentence on the Media Pipeline line
  (provider, model, cents per image, key variable, asks or runs unasked; or the config error);
  `details.imageGeneration`. `doctor/checks/media.test.ts`: one test.
- `docs/media.md`: "Image generation" (providers, the price table with source and date, the
  approval rule, the ledger row, the file name, the doctor line), the config block, the tests
  paragraph.
- Tests: `tools/media/image.test.ts` (9 tests over a `node:http` server on the loopback reached
  through `GEMINI_BASE_URL` / `OPENAI_BASE_URL`), `tools/media/media.test.ts` (six tools now),
  `tools/media/image.live.test.ts` (gated on `TRENT_TEST_LIVE=1`).

RED evidence:
- `npx vitest run packages/trent-core/src/tools/media/image.test.ts` before `image.ts` existed:
  "Cannot find module './image.js'", exit 1.
- `doctor/checks/media.test.ts` new case against HEAD's `checks/media.ts` (the file checked out
  from HEAD, the new version parked in the scratchpad, then restored): 1 failed / 4 passed,
  "expected 'Media tools run on the host backend: ...' to match /media_image.*not configured/".
- `media.test.ts` "declares the five tools" failed on the sixth name until updated.

## Live proof (one image attempted, none produced, 0 cents)

`TRENT_TEST_LIVE=1 npx vitest run packages/trent-core/src/tools/media/image.live.test.ts` with
the key from `gem.env` (never printed): `google answered HTTP 429: You exceeded your current
quota, please check your plan and billing details` on `gemini-3.1-flash-image`, and again with
`TRENT_LIVE_IMAGE_MODEL=gemini-3.1-flash-lite-image`. The same key passes
`tools/vision/vision.live.test.ts` on `gemini-3.5-flash-lite` in the same minute, so the key is
live and the request reached the image model (an unknown model is a 404, a malformed body a
400); the plan behind this key has no image-generation quota (the Gemini API bills image models
on the paid tier). The tool's failure path did what the docs say: `failed` record naming the
status, nothing written, nothing charged, no key in the record. Cost of this session's live
calls: 0 cents on images; the vision probe is a few tokens on the lite text model.

To finish the live proof once billing is enabled on the key: the same command, one 1:1 image,
7 cents, the ledger row asserted.

## Not done, and why

- `docs/tools.md` media row and `docs/configuration.md` media block still describe five tools
  and three keys: both files are shared with the other wave agents' G7 rows and config blocks;
  the config keys are documented in `docs/media.md`. One-line follow-ups for the orchestrator.
- `apps/cli` tsc reports one error in `packages/trent-core/src/improve/golden-store.ts`
  (`RetrievalGolden` not assignable to `StoredGolden`), a file W3 is editing; not touched here.
