# 2026-09-20 U6: the `media` toolset (host and docker backends, transcription) and `orchestrator.resume`

Branch `feature/trent-fleet-v2`. Nothing committed or staged by this session (the orchestrating
session owns the commits). Other agents were editing `governance/**`, `fleet/**`, `skills/**`,
`mcp-server/**` and `fleet-memory/ingest/**` in the same tree at the same time; none of those
files were touched here.

## What landed (RED first for each)

A1 `packages/trent-core/src/tools/media/` (new): `schemas.ts` (five tools, every file argument a
declared path), `paths.ts` (workspace confinement, symlink-safe, default `media-out/`),
`commands.ts` (pure argv builders and parsers: ffprobe JSON, whisper.cpp JSON, faster-whisper
JSON, scenedetect CSV, ffmpeg showinfo; SubRip writer; constant Python scripts for faster-whisper
and MediaPipe), `backend.ts` (allowlist `ffmpeg ffprobe whisper-cli scenedetect python3`; host =
`execFile` with `shell: false` and the scrubbed env; docker = `docker run --rm --network none
--cap-drop=ALL --security-opt=no-new-privileges --pids-limit 256 -v ws:/workspace` on
`trent-sandbox-media:1`, preferred when `docker inspect --type image` finds it; install report),
`transcribe.ts` (whisper.cpp, then faster-whisper, then the hosted provider only behind
`media.hosted_transcription`, spend row `surface: tool`), `index.ts` (the adapter; `preview` for
the hosted approval). Test `media.test.ts`: 10 tests over fake shell binaries on a temp PATH.

G7, all seven places: `config/sections/tools.ts` (`media` enum value), `tools/index.ts`
IMPLEMENTED_TOOLSETS and the build branch, TOOLSET_BY_ADAPTER, `tools/tool-names.ts`,
`fleet/seat-capabilities.ts` (shared toolset, like `vision`), `orchestrator/seat-wiring.ts`
(`media.egress` gate), `docs/tools.md` row. Plus `config/sections/media.ts` (new section, composed
before `personality:`; snapshot and input fixtures extended the way the goals commit did),
`config/defaults.ts` (default block; Blank Slate writes `media` off explicitly), quick setup
turns it on only when `mediaBackendPresent()` (injectable through `SetupContext`).

Voice: `voice/index.ts` no longer throws on principle; `transcribeVoice(bytes, {profileDir,...})`
writes the bytes to `<profile>/cache/voice/<tmp>/`, runs the same transcription backend, removes
the scratch, and throws a TrentError naming what to install when no engine exists.

A2 `doctor/checks/media.ts` (+ test): backend, present and missing binaries, whisper model, install
line per OS, the image build command, and the hosted-transcription egress named as a warning.

B `orchestrator/resume.ts` (new, 117 lines): `hydrateOrThrow`, `prepareResume` (terminal ->
report; awaiting approval -> wait; running job rows -> drain; no plan -> plan job; nothing left ->
consolidate; else ready steps or the steps left running), `describeResume`. `orchestrator/index.ts`
refactored: `run()` and `resume()` both go through one `drive(prepare, options)`; the drain loop
and `slugify` moved unchanged to `orchestrator/drain.ts` to stay under 500 lines (483 now).
`libs.ts` gained `runPersist` (`@/lib/orchestrator-run-persist`) and `runQueue`
(`@/lib/orchestrator-run-queue`) and `selectReadyStepsForEnqueue`. `types.ts`: `resume?` on
`Orchestrator` (optional so older fakes compile). `trent run --resume <runId>` in
`apps/cli/src/commands/groups/run.ts` (objective now `[objective]`; objective and `--resume`
together, or neither, is exit 2; dry-run reports both).

Test `orchestrator.resume.test.ts`: the scripted seat writes a file in step one, then aborts and
never answers (a kill leaves the run, the step and the job row `running` and the write's
idempotency row `completed`); the file is deleted; a fresh orchestrator resumes; step two runs
once, the run ends `completed`, the file is NOT rewritten (the idempotent dispatch answered the
replayed `write_file` from `<profile>/idempotency.json`); an unknown id is a TrentError naming it.
Two things learned on the way: a constant-vector embedder stub makes the semantic router advertise
only the app's own three adapters (so the test uses the lexical fallback), and the dead process's
bus subscription lives on in the same test process, so assertions about "what the first process
saw" are taken from a snapshot at the kill.

Docs: `docs/media.md` (new), `docs/tools.md` row, `docs/jobs.md` resume section.

## Verification (exact commands, exit codes)

- `npx vitest run packages/trent-core/src/tools packages/trent-core/src/voice packages/trent-core/src/doctor packages/trent-core/src/orchestrator packages/trent-core/src/config apps/cli/src/commands/__tests__/run.test.ts apps/cli/src/commands/__tests__/registry.test.ts packages/trent-core/src/wrapped-modules.test.ts` -> exit 0, 70 files, 1198 tests.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
- `npm --prefix packages/trent-core run build` -> exit 2, every error in other agents' in-flight
  test files (`src/mcp-server/server.test.ts`, `src/mcp-server/stdio.test.ts`,
  `src/fleet/export-record.test.ts`); zero errors in any file of this task.
- `node scripts/ci/repo-scan.mjs` -> exit 0.
- `docker build -f scripts/sandbox/media/Dockerfile -t trent-sandbox-media:1 scripts/sandbox/media`
  -> exit 0 after two fixes (ggml `-DGGML_NATIVE=OFF`: gcc 12's `-mcpu=native` fails on dotprod
  intrinsics under arm64; `mediapipe==0.10.18`, the last version with wheels for both arm64 and
  x86_64 Linux); image 1.74 GB.
- Live, through the container (scripts in the session scratchpad, not the repo): `say`-synthesised
  speech -> `media_probe` completed; `media_transcribe` completed by whisper.cpp with the bundled
  base.en model, text `Hello there. This is a short test of the media tool set.`; a generated
  two-scene MP4 -> `media_scenes` found the cut at 2.00 s by PySceneDetect, `media_thumbnail`
  wrote the PNG, `media_clip` with `crop: face` and captions produced a 202x360 H.264/AAC clip
  (no face in a test pattern, so the centre fallback; the MediaPipe script itself exits 0 with
  `faces: 0`), `media_probe` of the clip read it back.

## Not done, and why

- `trent sandbox build --media`: the sandbox command group is owned by another agent this round;
  the doctor and docs name the plain `docker build` line instead, and `mediaBuildArgs` /
  `mediaBuildCommand` are exported from core for whoever wires the flag.
- The hosted transcription path has no live proof (it would send audio to the provider); it is
  gated, previewed, ledgered and tested for being off by default.
- `portraitCrop` was corrected after the live clip to always produce an even width (libx264).
