# P2-3 voice notes: inbound audio on the gateway is transcribed (2026-09-25)

Wave P2 agent 3 (Opus, no subagents, no commits). Gap 4 of
`02_plan/output/hermes-parity-scorecard-2026-09-25.md`: a voice note sent on Telegram, WhatsApp,
Signal, Discord or Slack was dropped or ran as empty text; nothing on the gateway called
`tools/media/transcribe.ts`. Scope from the lead: the five adapters + their wire tests
(attachment handling only), `transport/types.ts` (additive attachment field), a new
`gateway/voice-notes.ts` (+test), the one dispatch call in `GatewayManager.handleInbound`,
`config/sections/gateway.ts` (a `// [P2-3] voice notes` block after P1-A's email block),
`schema-split.input.json` + regenerated snapshot, one section of `docs/gateway.md`, the
`docs/configuration.md` lines for the key, and this log. HEAD 3891b55, other agents editing the tree.

## Discovery (before any code)
- Pairing is decided first thing in `GatewayManager.handleInbound` (`this.pairing.authorize`, keyed
  on platform + senderId + scope + channelId); `ConversationQueue` only serialises turns that already
  passed. So the transcription call sits immediately after the `if (!decision.allowed) return` block.
- Consequence for the adapters: they must NOT download in their dispatch (that runs before pairing).
  They attach a lazy `open()` that fetches through the adapter's own `this.fetch` with its own auth;
  the gateway calls it only after pairing. The wire tests assert no download request before `open()`.
- `transport/http.ts` `httpRequest` decodes the body with `res.text()`, which corrupts binary audio,
  and it is not in this task's file set, so downloads go through `this.fetch` directly (the
  adapter's injected client, the same one tests point at a local server). Gateway adapters do not go
  through the egress proxy today (no `egress` reference under `gateway/`); noted, not changed.
- `tools/media/transcribe.ts` `planEngine` + `transcribeMedia` are the tool's resolution; the doctor's
  hint is `mediaInstallHint(["whisper-cli"])` in `doctor/checks/media.ts`.
- Hosted transcription: the tool asks for approval per call and writes the ledger inside a run's
  context. The gateway path has neither an approver nor a run context before the run starts, so voice
  notes are transcribed locally only (whisper.cpp / faster-whisper, host or media image). Reported
  to the lead as a decision.
- This machine: no `whisper-cli` on PATH; `ffmpeg`, `say` and the `trent-sandbox-media:1` image
  (whisper.cpp + ggml-base.en, `--network none`) are present.

## Progress
- RED (17:43): tests written first: one voice case per adapter wire test (telegram, whatsapp,
  signal, discord, slack), `gateway/voice-notes.test.ts` (3 unit + 9 dispatch + 1 opt-in real).
  First run failed on the missing module; with an exports-only skeleton of `voice-notes.ts`:
  `npx vitest run <the 6 files>` -> EXIT=1, `Tests 16 failed | 18 passed | 1 skipped (35)`. Failures
  are the behaviour: `expected { id: 'M7', ... } to deeply equal ObjectContaining{...}` (no
  attachment carried), `expected 'audio' to be 'ogg'`, `expected [ { id: '42', ... } ] to deeply
  equal []` (the run started on an over-cap note), telegram/signal voice updates never dispatched
  (`waitFor: timed out`). The unpaired guard already passes (nothing downloads yet) and must stay green.
- GREEN (17:52): `transport/types.ts` (`InboundAttachment`, `attachments?`, `isPinnedDownloadUrl`,
  `INBOUND_DOWNLOAD_TIMEOUT_MS`), `gateway/voice-notes.ts`, the five adapters, `config/sections/
  gateway.ts` `voice_notes` (optional block: `DEFAULT_CONFIG` lives in `config/defaults.ts`, outside
  this task, so a `.default({})` block would have broken its type), and one call in
  `GatewayManager.handleInbound` right after the pairing gate. Same 6 files -> EXIT=0,
  `Tests 34 passed | 1 skipped (35)`.
- Snapshot: `voice_notes` added to `schema-split.input.json` (gateway block);
  `npx tsx scripts/dev/regen-snapshot.mjs` -> EXIT=0, `snapshot keys: 42`, diff = the 5 new lines only.
- Docs: `docs/gateway.md` "Voice notes" (before "Not yet implemented"); `docs/configuration.md`
  YAML lines under `gateway:` + a "### Voice notes" paragraph.
- REAL transcription (opt-in test, `TRENT_TEST_VOICE_REAL=1`): `say -o note.aiff "book me for
  Tuesday"` -> ffmpeg 16 kHz wav -> `saveVoiceNote` -> `createMediaVoiceEngine` (docker backend,
  whisper.cpp + ggml-base.en in `trent-sandbox-media:1`, `--network none`). Output:
  `[P2-3 real transcript] backend=docker ffprobe=1.087938s {"ok":true,"text":"Book me for Tuesday.","engine":"whisper.cpp","durationSeconds":1.08}`
  EXIT=0. The first attempt passed vacuously (an early `return`): `mediaImagePresent()` says the
  image is absent because `docker inspect --type image trent-sandbox-media:1` answers "No such
  image" on this Docker 29.5.3 daemon while `docker image ls` lists it and `docker run` runs it.
  So `media.backend: auto` would fall back to the host here. Pre-existing, in `tools/media/backend.ts`
  (not this task's file); reported. The test now forces the backend and skips instead of returning.

## Verification (18:0x, TRENT_QUEUE_FALLBACK=disabled, repo root)
- `npx vitest run packages/trent-core/src/gateway packages/trent-core/src/config apps/cli/src/commands/__tests__/docs-truth.test.ts packages/trent-core/src/wrapped-modules.test.ts`
  -> EXIT=1, `Test Files 1 failed | 33 passed (34)`, `Tests 1 failed | 252 passed | 1 skipped (254)`.
  The one failure is docs-truth "states the command counts the registry actually has":
  `expected [ 34, 146 ] to deeply equal [ 35, 151 ]`: README's CLI count against a registry that
  grew with another agent's in-flight `service` command (`apps/cli/src/commands/index.ts` M,
  `groups/service*.ts` untracked). Not in this task's files; every config-key check (incl.
  `gateway.voice_notes`) passes. All gateway and config files pass.
- `cd packages/trent-core && npm run build` (tsc --noEmit) -> EXIT=0.
- `node scripts/ci/repo-scan.mjs` -> EXIT=0 (three PASS sections).
- Anchored TODO grep -> 0. Every touched file is under 500 lines (largest: voice-notes.test.ts 306).
- Dispatch order: `GatewayManager.ts:253` pairing decision, `:263` unpaired return,
  `:267` `prepareVoiceNote`, `:272` message replaced, `:275` decision parsing, `:297` the run.

## Open items for the lead
- `tools/media/backend.ts` `mediaImagePresent` false-negative on Docker 29.5.3 (see REAL above):
  `media.backend: auto` silently runs on the host on this machine although the image works.
- Hosted transcription deliberately not wired for voice notes (no approver, no run ledger yet).
- Gateway adapters' `this.fetch` is not the egress proxy; downloads use it, pinned to each
  platform's file host. Routing the gateway through egress is a separate change.
- A voice note is transcribed before `ConversationQueue`, so on a websocket platform a text sent
  right after a long voice note can start its turn first (Telegram's poll is sequential).
