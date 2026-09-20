# The `media` toolset

Five tools that turn a long recording into clips a phone will play, run entirely on this
machine: `media_probe`, `media_transcribe`, `media_scenes`, `media_clip` and `media_thumbnail`;
and one that spends money, `media_image` ("Image generation" below). Implemented in
`packages/trent-core/src/tools/media/` and proved by `tools/media/media.test.ts`,
`tools/media/image.test.ts`, `voice/voice.test.ts` and `doctor/checks/media.test.ts`, every one
of them over fake binaries on a temporary PATH or a fake HTTP server on the loopback: the
standard tests spawn no ffmpeg, no whisper, no model and call no provider.

| Tool | Arguments | What it does |
|---|---|---|
| `media_probe` | `input` | `ffprobe`: container, duration, size, streams (codec, resolution, frame rate, sample rate). Read-only |
| `media_transcribe` | `input`, `language`, `output` | `ffmpeg` extracts 16 kHz mono audio, a local whisper engine transcribes it; saves `media-out/<name>.transcript.json` with timestamped segments |
| `media_scenes` | `input`, `threshold` | Cut points: PySceneDetect when installed, else ffmpeg's scene filter; saves `media-out/<name>.scenes.json` |
| `media_clip` | `input`, `start`, `end`, `output`, `crop`, `captions`, `transcript` | `ffmpeg` cut; `crop` `center` or `face` (MediaPipe, falling back to centre) makes a 9:16 window; `captions` burns the transcript segments inside the window as SubRip |
| `media_thumbnail` | `input`, `at`, `width`, `output` | One frame at a second, optionally scaled, as PNG. Image generation is `media_image` |
| `media_image` | `prompt` or `brief` + `variant`, `aspect`, `output` | One generated image from the configured provider, saved as `media-out/<content hash>.<ext>`; approved per call, charged to the spend ledger |

Every `input`, `output`, `transcript` and `brief` is a **path argument**: declared as one in the schema so
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
  image_provider: auto       # auto | google | openai | ollama | lmstudio | deepseek | groq
  image_model: ""            # empty: the shipped Gemini default; required for every other provider
  image_price_cents: 0       # integer cents per image; 0: the shipped Gemini table; required elsewhere
  image_auto_approve_under_cents: 0   # 0 asks every time; N lets an image cheaper than N cents run unasked
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

## Image generation

`media_image` renders one image from a prompt: a YouTube thumbnail (`aspect: "16:9"`, the
default), a feed post (`1:1` or `4:5`), a story or a short (`9:16`). Every call leaves the
machine and costs money (hosted transcription does too, but only as an opt-in fallback), so it
is built the other way round from the five above: the price is settled **before** the call, the
call asks **first**, and the charge is on the ledger.

```
media_image {"prompt": "A clean chart on a dark background ...", "aspect": "16:9"}
media_image {"brief": "thumbnails/retention.md", "variant": "B"}
```

The second form takes the file the `thumbnail-brief` skill writes
(`packages/trent-core/skills/thumbnail-brief/SKILL.md`, "Output format"): the tool reads the
"Generation prompt (for later)" paragraph under `## A:`, `## B:` or `## C:` and sends exactly
that. The brief is a path argument, confined to the workspace like every other. A brief with no
prompt under the variant fails and says so; the tool never invents a prompt.

### Providers and prices

| `image_provider` | Endpoint | Key | Model | Price per image |
|---|---|---|---|---|
| `google` (or `auto` when a Gemini key is set) | `POST {GEMINI_BASE_URL}/models/<model>:generateContent`, the key in the `x-goog-api-key` header, `generationConfig.responseModalities: ["IMAGE"]`, `imageConfig.aspectRatio`, `imageSize: "1K"`; the image comes back as `candidates[0].content.parts[].inlineData` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) in `<profile>/.env` | `gemini-3.1-flash-image` unless `image_model` says otherwise | shipped table below, or `image_price_cents` when set |
| `openai` (or `auto` with only an OpenAI key) | `POST {OPENAI_BASE_URL or https://api.openai.com/v1}/images/generations`, bearer key, `size` from the aspect (`1024x1024`, `1536x1024`, `1024x1536`), `response_format: "b64_json"` except on `gpt-image*` models, which always answer base64 | `OPENAI_API_KEY` | `image_model`, required | `image_price_cents`, required |
| `ollama`, `lmstudio`, `deepseek`, `groq` | the same images call on that alias's base URL and key from the alias table (`model-gateway/providers.ts`); the two local runtimes need no key and cost 0 | that alias's key variable | `image_model`, required | `image_price_cents`, required for the hosted two |

The shipped Gemini table, in **integer cents rounded up** from the list price at
https://ai.google.dev/gemini-api/docs/pricing on 2026-09-20 (output image tokens at the model's
image rate; a 1K image is 1120 tokens on the 3.x models and 1290 on 2.5):

| Model | List price | Ledger |
|---|---|---|
| `gemini-3.1-flash-image` (default) | $0.067 | 7 cents |
| `gemini-3.1-flash-lite-image` | $0.0336 | 4 cents |
| `gemini-3-pro-image` | $0.134 at 1K or 2K | 14 cents |
| `gemini-2.5-flash-image` | $0.039 | 4 cents |

A Gemini model outside the table needs `image_price_cents`; the tool refuses to guess, and the
request shape is the `generateContent` reference at https://ai.google.dev/api/generate-content.
For a non-Gemini provider both the model and the price come from the profile, because those
catalogues change faster than a shipped table would stay true; with either missing the call
fails with a typed configuration error (exit code 3) that names the key to set. With no key at
all the error names `GEMINI_API_KEY`, `<profile>/.env` and `media.image_provider`.

The app's own image router (`apps/web/lib/generation/image-router.ts`) is not wrapped: it will
not generate without a provisioned R2 bucket and a company row, which a standalone profile does
not have, and its roster prices are the app's, not the provider's list.

### The approval rule

Every image is metered external spend, so `media_image` goes through the per-call binding of
gate G2 (`governance/bound-approvals.ts`) with **the prompt and the price** as the preview:

- `requiresApproval` is true for the call, `preview` renders
  `generate one 16:9 image with google gemini-3.1-flash-image for 7 cents (typed prompt): <the prompt>`,
  and inside a seat turn `dryRun` puts that in front of the founder and stamps the bound row, so
  the step's yes covers the replay of exactly this call and nothing else. A changed prompt, a
  changed aspect or a second image is a new approval.
- Outside a seat turn (the REPL, a direct call) the call is parked as a pending row and the
  record says `trent approvals approve <id>`; the same call after the approval runs.
- `media.image_auto_approve_under_cents` is the one lift. It is `0` by default, which asks every
  time. Set to `10`, a 7-cent Gemini image runs unasked and a 14-cent `gemini-3-pro-image` still
  asks; the threshold is strict (`price < N`).
- Nothing is sent before the yes, and nothing is charged before the bytes are on disk. A provider
  refusal (an HTTP 429, a text-only answer, bytes that are not an image) is a `failed` record
  naming the status; no file is written and no row is charged.

The charge is one row on `spend.ndjson` (`surface: "tool"`, `tool: "media_image"`, the provider,
the model, the integer cents, `units: 1`, the run id inside a seat turn), so `budget.daily_cap`
counts images exactly as it counts model tokens (gate G5). When no ledger is open in the process
the summary says the cents were NOT recorded rather than implying they were.

The image lands under the workspace as `media-out/<first 16 hex of sha256>.<png|jpg|webp>`, or
at `output` when given (still under the workspace): the same bytes get the same name, and a
name never says what was asked for. The key is read at send time from the named variable and
travels in a header, never in a URL, a record, a preview or the doctor's details.

`trent doctor` adds one sentence to the Media Pipeline line: the provider, the model, the
price per image and the key variable it would use, and whether the call asks or runs unasked
under the threshold; or the configuration error that stops it.

## What the tests prove

`tools/media/media.test.ts`: each tool builds the exact argument array (`probeArgs`,
`audioExtractArgs`, `whisperArgs`, `sceneFilterArgs`, `clipArgs`, `thumbnailArgs`) and the fake
binary received it; a binary outside the allowlist is refused before spawning; an input outside
the workspace and an output outside it are refused; the docker backend is chosen when the image
exists (a fake `docker inspect`) and its `docker run` argv carries `--network none`,
`--cap-drop=ALL` and the workspace mount; hosted transcription is off by default, fails naming
the opt-in, sends nothing, and asks for approval once opted in.

`tools/media/image.test.ts`, over a `node:http` server on the loopback reached through
`GEMINI_BASE_URL` and `OPENAI_BASE_URL`: the call is parked with the prompt and the price as the
preview and nothing is sent; the approved row lets exactly that call run and a changed prompt asks
again; inside a seat turn the dry run stamps the row and the replay runs; the Gemini request is
the `generateContent` shape with the key in the header; the file is written under the workspace
under its content-hash name; the ledger row is integer cents with the provider and `units: 1`;
the threshold lifts the question only strictly below the price; a missing key is a typed
configuration error naming `GEMINI_API_KEY`, `<profile>/.env` and `media.image_provider`; the
thumbnail-brief file is accepted as the prompt one variant at a time and refused outside the
workspace; the OpenAI-compatible shape reaches `/images/generations` with the configured model
and price, and the alias table routes `deepseek` and `ollama`; a 429 is a failed record with no
file and no charge; and no fixture key appears in any record.

`tools/media/image.live.test.ts` (`TRENT_TEST_LIVE=1`, the key from `GEMINI_API_KEY` or
`<repo>/gem.env`, never printed): one small 1:1 image from the default Gemini model, the bytes
sniffed as an image, the ledger row at 7 cents.
