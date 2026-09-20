# The `media` toolset

Five tools that turn a long recording into clips a phone will play, run entirely on this
machine: `media_probe`, `media_transcribe`, `media_scenes`, `media_clip` and `media_thumbnail`.
Implemented in `packages/trent-core/src/tools/media/` and proved by `tools/media/media.test.ts`,
`voice/voice.test.ts` and `doctor/checks/media.test.ts`, every one of them over fake binaries on
a temporary PATH: the standard tests spawn no ffmpeg, no whisper, no model and no provider.

| Tool | Arguments | What it does |
|---|---|---|
| `media_probe` | `input` | `ffprobe`: container, duration, size, streams (codec, resolution, frame rate, sample rate). Read-only |
| `media_transcribe` | `input`, `language`, `output` | `ffmpeg` extracts 16 kHz mono audio, a local whisper engine transcribes it; saves `media-out/<name>.transcript.json` with timestamped segments |
| `media_scenes` | `input`, `threshold` | Cut points: PySceneDetect when installed, else ffmpeg's scene filter; saves `media-out/<name>.scenes.json` |
| `media_clip` | `input`, `start`, `end`, `output`, `crop`, `captions`, `transcript` | `ffmpeg` cut; `crop` `center` or `face` (MediaPipe, falling back to centre) makes a 9:16 window; `captions` burns the transcript segments inside the window as SubRip |
| `media_thumbnail` | `input`, `at`, `width`, `output` | One frame at a second, optionally scaled, as PNG. Image generation is a different tool |

Every `input`, `output` and `transcript` is a **path argument**: declared as one in the schema so
the hardline path rules (`governance/autonomy-dispatch.ts`) inspect it, and confined to the
workspace by `tools/media/paths.ts` before any binary is spawned. A file outside the workspace is
refused as `blocked`; an output that would land outside it, or reach outside through a link, is
refused too. Outputs default to `media-out/` under the workspace and never leave it.

## Backends

The toolset never composes a shell string. Each call is one `execFile` with an argument array
built by `tools/media/commands.ts` from validated values, and the program is looked up on an
**allowlist** (`ffmpeg`, `ffprobe`, `whisper-cli`, `scenedetect`, `python3`): a name outside it
throws before anything runs. `python3` is only ever run with a script the wrapper ships as a
constant (faster-whisper, MediaPipe face tracking); the media path travels in argv, never inside
the script.

| Backend | When | How |
|---|---|---|
| `docker` | `trent-sandbox-media:1` exists (or `media.backend: docker`) | `docker run --rm --network none --cap-drop=ALL --security-opt=no-new-privileges --pids-limit 256 -v <workspace>:/workspace -w /workspace trent-sandbox-media:1 <binary> ...`, one container per call, no network |
| `host` | otherwise (or `media.backend: host`) | The host's own binaries on PATH, with the scrubbed child environment every local tool gets (`terminal/env-scrub.ts`) |

`media.backend: auto` (the default) prefers docker. The base sandbox image
(`scripts/sandbox/Dockerfile`) is untouched: `terminal` and `execute_code` still run in the inert
image with no package manager; only the media tools use the media image.

```yaml
media:
  backend: auto              # auto | host | docker
  hosted_transcription: false
  whisper_model: ""          # path of a whisper.cpp ggml model; empty: <profile>/models/ggml-*.bin
```

## Installing the binaries

The media image is the one-line route: everything, pinned, no network at run time.

```
docker build -f scripts/sandbox/media/Dockerfile -t trent-sandbox-media:1 scripts/sandbox/media
```

It builds whisper.cpp from a pinned tag, installs ffmpeg, PySceneDetect and MediaPipe, bundles
`ggml-base.en.bin` and the BlazeFace short-range model under `/opt/trent/models/`, removes apt
and pip afterwards, and runs as the non-root `sandbox` user. Measured 2026-09-20 on an arm64
host: 1.74 GB.

On the host instead:

| What | macOS | Debian / Ubuntu | Windows |
|---|---|---|---|
| ffmpeg and ffprobe | `brew install ffmpeg` | `sudo apt install ffmpeg` | `winget install Gyan.FFmpeg` |
| whisper.cpp (`whisper-cli`) | `brew install whisper-cpp` | build https://github.com/ggml-org/whisper.cpp, put `whisper-cli` on PATH | same |
| a whisper model | download `ggml-base.en.bin` from huggingface.co/ggerganov/whisper.cpp into `~/.trent/<profile>/models/`, or set `media.whisper_model` | same | same |
| faster-whisper (alternative engine) | `pip install faster-whisper` | same | same |
| PySceneDetect (optional) | `pip install "scenedetect[opencv]"` | same | same |
| MediaPipe face tracking (optional, for `crop: face`) | `pip install mediapipe`, plus `blaze_face_short_range.tflite` in `~/.trent/<profile>/models/` | same | same |

`trent doctor` has a Media Pipeline line that says which backend a call would take, which of the
five binaries are present, which whisper model was found, and the install line for what is
missing. Quick setup turns the toolset on only when a backend is present; Blank Slate writes it
off explicitly like every other toolset.

## Transcription, and the private-audio note

`media_transcribe` and the voice entry point (`voice/index.ts`, `transcribeVoice`) share one
backend (`tools/media/transcribe.ts`), which tries, in order: **whisper.cpp** (`whisper-cli` plus
a ggml model), **faster-whisper** (`python3` with the module), and only then the **hosted**
path. With no engine the call fails and names what to install; it never returns a transcript no
engine produced.

The hosted path sends the file's audio to the configured model provider (the Gemini key, on the
OpenAI-compatible `input_audio` part) and gets timestamps back from the model. That is **egress
of private audio**: a customer's call, a founder's voice note. So it is off until
`media.hosted_transcription: true` is written by hand; when it is on and no local engine
answers, the adapter asks for approval on every call (`requiresApproval`, with a `preview` that
says which file's audio would leave and to which provider), and `trent doctor` reports the
opt-in as a warning naming the egress. The cost of a hosted call is written to the spend ledger
as `surface: tool` with the provider, so `budget.daily_cap` sees it (gate G5). Inline audio is
capped at 20 MB; a longer recording needs a local engine.

## What the tests prove

`tools/media/media.test.ts`: each tool builds the exact argument array (`probeArgs`,
`audioExtractArgs`, `whisperArgs`, `sceneFilterArgs`, `clipArgs`, `thumbnailArgs`) and the fake
binary received it; a binary outside the allowlist is refused before spawning; an input outside
the workspace and an output outside it are refused; the docker backend is chosen when the image
exists (a fake `docker inspect`) and its `docker run` argv carries `--network none`,
`--cap-drop=ALL` and the workspace mount; hosted transcription is off by default, fails naming
the opt-in, sends nothing, and asks for approval once opted in.
