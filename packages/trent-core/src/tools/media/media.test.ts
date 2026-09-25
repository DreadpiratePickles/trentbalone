/**
 * The `media` toolset over fake binaries: small shell scripts on a temporary PATH that log their
 * argv next to themselves and produce the file a real tool would. Nothing here spawns ffmpeg,
 * whisper, scenedetect, a model or a hosted transcription service.
 *
 * What is proved: every tool builds the exact argument array it runs; a binary outside the
 * allowlist is refused before anything is spawned; a path outside the workspace is refused; the
 * docker backend is chosen when the media image exists and the host backend when it does not; and
 * hosted transcription is off unless the config opts in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEDIA_BINARIES, MEDIA_IMAGE, createHostMediaBackend, selectMediaBackend, type MediaBinary } from "./backend.js";
import { audioExtractArgs, clipArgs, probeArgs, sceneFilterArgs, thumbnailArgs, whisperArgs } from "./commands.js";
import { createMediaAdapter, MEDIA_ADAPTER_NAME, MEDIA_TOOL_SCHEMAS } from "./index.js";
import { resolveInputPath, resolveOutputPath } from "./paths.js";

const PROBE_JSON = JSON.stringify({
  format: { duration: "12.500000", format_name: "mov,mp4,m4a,3gp,3g2,mj2", size: "1024" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30/1" },
    { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
  ],
});

const WHISPER_JSON = JSON.stringify({
  transcription: [
    { timestamps: { from: "00:00:00,000", to: "00:00:01,500" }, offsets: { from: 0, to: 1500 }, text: " Hello there." },
    { timestamps: { from: "00:00:01,500", to: "00:00:03,000" }, offsets: { from: 1500, to: 3000 }, text: " Second line." },
  ],
});

/** A fake binary: logs its argv one per line to `<bin>/<name>.log`, then runs `body`. */
function fake(bin: string, name: string, body: string): void {
  // The fake PATH holds only the fakes; the scripts still need the system's own cat and cp.
  const script = `#!/bin/sh\nPATH="$PATH:/bin:/usr/bin"\nd=$(dirname "$0")\nprintf '%s\\n' "$@" >> "$d/${name}.log"\nprintf '%s\\n' "--" >> "$d/${name}.log"\n${body}\n`;
  fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
}

/** The argv of the last invocation of a fake. */
function lastArgv(bin: string, name: string): string[] {
  const text = fs.readFileSync(path.join(bin, `${name}.log`), "utf8");
  const calls = text.split("--\n").filter((c) => c.trim() !== "");
  return (calls[calls.length - 1] ?? "").split("\n").filter((line) => line !== "");
}

function calls(bin: string, name: string): number {
  if (!fs.existsSync(path.join(bin, `${name}.log`))) return 0;
  return fs.readFileSync(path.join(bin, `${name}.log`), "utf8").split("--\n").filter((c) => c.trim() !== "").length;
}

describe("media toolset over fake binaries", () => {
  let root = "";
  let bin = "";
  let workspace = "";
  let profileDir = "";
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-media-"));
    bin = path.join(root, "bin");
    workspace = path.join(root, "repo");
    profileDir = path.join(root, "profile");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(profileDir, "models"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "talk.mp4"), "not really a video");
    fs.writeFileSync(path.join(root, "outside.mp4"), "outside the workspace");
    fs.writeFileSync(path.join(profileDir, "models", "ggml-base.en.bin"), "fake model");
    fs.writeFileSync(path.join(bin, "ffprobe.json"), PROBE_JSON);
    fs.writeFileSync(path.join(bin, "whisper.json"), WHISPER_JSON);
    // ffmpeg creates its output file (the last argument) unless it is the null muxer's "-".
    fake(bin, "ffmpeg", 'for a in "$@"; do last="$a"; done\ncase "$last" in -) printf "[Parsed_showinfo_1 @ 0x1] n:0 pts:0 pts_time:0 pos:1\\n[Parsed_showinfo_1 @ 0x1] n:1 pts:120 pts_time:4.0 pos:2\\n" >&2 ;; *) : > "$last" ;; esac');
    fake(bin, "ffprobe", 'cat "$d/ffprobe.json"');
    fake(bin, "whisper-cli", 'prev=""; out=""\nfor a in "$@"; do if [ "$prev" = "-of" ]; then out="$a"; fi; prev="$a"; done\ncp "$d/whisper.json" "$out.json"');
    fake(bin, "docker", 'if [ "$1" = "inspect" ]; then if [ -f "$d/image-present" ]; then echo "sha256:0123"; exit 0; fi; echo "No such image" >&2; exit 1; fi\nexit 0');
    fake(bin, "curl", "exit 0");
    env = { PATH: bin, HOME: root };
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function adapter(overrides: { hostedTranscription?: boolean; backend?: "auto" | "host" | "docker" } = {}) {
    return createMediaAdapter(
      { workspace, profileDir, backend: "local" },
      {
        env,
        media: { backend: overrides.backend ?? "host", hosted_transcription: overrides.hostedTranscription ?? false, whisper_model: "" },
      },
    );
  }

  it("declares the six tools with every path argument named as a path", () => {
    const names = MEDIA_TOOL_SCHEMAS.map((s) => s.name);
    expect(names).toEqual(["media_probe", "media_transcribe", "media_scenes", "media_clip", "media_thumbnail", "media_image"]);
    for (const schema of MEDIA_TOOL_SCHEMAS) {
      const props = schema.parameters.properties as Record<string, { description?: string }>;
      // The clip tools read `input`; `media_image` reads a `brief` file. Both are declared as paths.
      expect((props.input ?? props.brief)?.description ?? "").toMatch(/path/i);
      expect(Object.keys(props).some((k) => /^(command|cmd|script|code|shell)$/i.test(k))).toBe(false);
    }
    const a = adapter();
    expect(a.name).toBe(MEDIA_ADAPTER_NAME);
    expect(a.scopes).toEqual(["media", ...names]);
  });

  it("media_probe runs ffprobe with the exact argument array and reports duration and streams", async () => {
    const rec = await adapter().execute('media_probe {"input":"talk.mp4"}', {});
    expect(rec.status, rec.summary).toBe("completed");
    expect(lastArgv(bin, "ffprobe")).toEqual(probeArgs("talk.mp4"));
    expect(probeArgs("talk.mp4")).toEqual(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "talk.mp4"]);
    expect(rec.summary).toContain("12.5");
    expect(rec.summary).toContain("h264");
    expect(rec.summary).toContain("1920x1080");
  });

  it("media_transcribe extracts 16 kHz mono audio with ffmpeg, runs whisper-cli on it and returns timestamped segments", async () => {
    const rec = await adapter().execute('media_transcribe {"input":"talk.mp4"}', {});
    expect(rec.status, rec.summary).toBe("completed");
    const wav = lastArgv(bin, "ffmpeg")[lastArgv(bin, "ffmpeg").length - 1]!;
    expect(lastArgv(bin, "ffmpeg")).toEqual(audioExtractArgs("talk.mp4", wav));
    expect(wav.startsWith("media-out/")).toBe(true);
    const model = path.join(profileDir, "models", "ggml-base.en.bin");
    const whisper = lastArgv(bin, "whisper-cli");
    expect(whisper).toEqual(whisperArgs({ model, audio: wav, outBase: whisper[whisper.indexOf("-of") + 1]! }));
    expect(rec.summary).toContain("[0.00 -> 1.50] Hello there.");
    expect(rec.summary).toContain("[1.50 -> 3.00] Second line.");
    expect(rec.summary).toMatch(/media-out\/talk\.transcript\.json/);
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, "media-out", "talk.transcript.json"), "utf8")) as { segments: unknown[]; engine: string };
    expect(saved.segments).toHaveLength(2);
    expect(saved.engine).toBe("whisper.cpp");
    // The intermediate wav is not left behind.
    expect(fs.existsSync(path.join(workspace, wav))).toBe(false);
  });

  it("media_scenes falls back to the ffmpeg scene filter when scenedetect is absent and parses the cut times", async () => {
    const rec = await adapter().execute('media_scenes {"input":"talk.mp4","threshold":0.4}', {});
    expect(rec.status, rec.summary).toBe("completed");
    expect(lastArgv(bin, "ffmpeg")).toEqual(sceneFilterArgs("talk.mp4", 0.4));
    expect(sceneFilterArgs("talk.mp4", 0.4)).toEqual(["-nostdin", "-v", "info", "-i", "talk.mp4", "-vf", "select='gt(scene,0.40)',showinfo", "-an", "-f", "null", "-"]);
    expect(rec.summary).toContain("4.00");
    expect(rec.summary).toContain("ffmpeg scene filter");
  });

  it("media_clip cuts with ffmpeg, crops 9:16 from the centre and burns captions from the saved transcript", async () => {
    const a = adapter();
    await a.execute('media_transcribe {"input":"talk.mp4"}', {});
    const rec = await a.execute('media_clip {"input":"talk.mp4","start":1,"end":3,"crop":"center","captions":true}', {});
    expect(rec.status, rec.summary).toBe("completed");
    const argv = lastArgv(bin, "ffmpeg");
    const output = argv[argv.length - 1]!;
    expect(output).toBe("media-out/talk.clip-1-3.mp4");
    const srt = "media-out/talk.clip-1-3.srt";
    // A 1920x1080 source: a 9:16 window keeping the full height is 608 wide, centred at x=656.
    expect(argv).toEqual(clipArgs({ input: "talk.mp4", start: 1, end: 3, output, crop: { width: 608, height: 1080, x: 656, y: 0 }, captions: srt }));
    expect(argv[argv.indexOf("-vf") + 1]).toBe("crop=608:1080:656:0,subtitles=media-out/talk.clip-1-3.srt");
    expect(fs.readFileSync(path.join(workspace, srt), "utf8")).toContain("00:00:00,500 --> 00:00:02,000");
    expect(fs.existsSync(path.join(workspace, output))).toBe(true);
  });

  it("media_thumbnail extracts one frame at the requested second", async () => {
    const rec = await adapter().execute('media_thumbnail {"input":"talk.mp4","at":2.5,"width":640}', {});
    expect(rec.status, rec.summary).toBe("completed");
    expect(lastArgv(bin, "ffmpeg")).toEqual(thumbnailArgs({ input: "talk.mp4", at: 2.5, output: "media-out/talk.thumb-2.5.png", width: 640 }));
    expect(lastArgv(bin, "ffmpeg")).toEqual(["-nostdin", "-y", "-v", "error", "-ss", "2.5", "-i", "talk.mp4", "-frames:v", "1", "-vf", "scale=640:-2", "media-out/talk.thumb-2.5.png"]);
  });

  it("refuses a binary outside the allowlist before spawning anything", async () => {
    const backend = createHostMediaBackend({ workspace, env });
    expect(MEDIA_BINARIES).not.toContain("curl");
    await expect(backend.run("curl" as MediaBinary, ["http://example.com"])).rejects.toThrow(/allowlist/);
    expect(calls(bin, "curl")).toBe(0);
  });

  it("refuses an input outside the workspace and an output outside it, and never spawns for either", async () => {
    const before = calls(bin, "ffprobe");
    const escaped = await adapter().execute(`media_probe {"input":"../outside.mp4"}`, {});
    expect(escaped.status).toBe("blocked");
    expect(escaped.summary).toMatch(/outside the workspace/);
    const absolute = await adapter().execute(`media_probe ${JSON.stringify({ input: path.join(root, "outside.mp4") })}`, {});
    expect(absolute.status).toBe("blocked");
    expect(calls(bin, "ffprobe")).toBe(before);
    const out = await adapter().execute('media_thumbnail {"input":"talk.mp4","at":1,"output":"../escape.png"}', {});
    expect(out.status).toBe("blocked");
    expect(resolveInputPath(workspace, "talk.mp4").ok).toBe(true);
    expect(resolveInputPath(workspace, "../outside.mp4").ok).toBe(false);
    expect(resolveOutputPath(workspace, "../x.png", "fallback.png").ok).toBe(false);
  });

  it("chooses the docker backend when the media image exists and the host backend when it does not", async () => {
    const host = await selectMediaBackend({ workspace, env, backend: "auto" });
    expect(host.kind).toBe("host");
    // Absent means inspect said no AND the image list said no (backend.test.ts has why both are asked).
    const probes = fs.readFileSync(path.join(bin, "docker.log"), "utf8").split("--\n").filter((c) => c.trim() !== "").slice(-2);
    expect(probes.map((c) => c.split("\n").filter((line) => line !== ""))).toEqual([
      ["inspect", "--type", "image", "--format", "{{.Id}}", MEDIA_IMAGE],
      ["image", "ls", "--filter", `reference=${MEDIA_IMAGE}`, "--format", "{{.ID}}"],
    ]);
    fs.writeFileSync(path.join(bin, "image-present"), "");
    try {
      const docker = await selectMediaBackend({ workspace, env, backend: "auto" });
      expect(docker.kind).toBe("docker");
      await docker.run("ffprobe", probeArgs("talk.mp4"));
      const argv = lastArgv(bin, "docker");
      expect(argv[0]).toBe("run");
      expect(argv).toContain("--network");
      expect(argv[argv.indexOf("--network") + 1]).toBe("none");
      expect(argv).toContain("--cap-drop=ALL");
      expect(argv).toContain(`${workspace}:/workspace`);
      expect(argv.slice(argv.indexOf(MEDIA_IMAGE))).toEqual([MEDIA_IMAGE, "ffprobe", ...probeArgs("talk.mp4")]);
      const forced = await selectMediaBackend({ workspace, env, backend: "host" });
      expect(forced.kind).toBe("host");
    } finally {
      fs.rmSync(path.join(bin, "image-present"));
    }
  });

  it("hosted transcription is off by default: with no local engine the call fails naming the opt-in, and no audio leaves", async () => {
    const noWhisper = path.join(root, "bin-nowhisper");
    fs.mkdirSync(noWhisper, { recursive: true });
    for (const name of ["ffmpeg", "ffprobe", "ffprobe.json"]) fs.copyFileSync(path.join(bin, name), path.join(noWhisper, name));
    fs.chmodSync(path.join(noWhisper, "ffmpeg"), 0o755);
    fs.chmodSync(path.join(noWhisper, "ffprobe"), 0o755);
    let gatewayCalls = 0;
    const gateway = {
      resolveRoute: () => ({ providers: ["google" as const], fallbackChain: [], modelTier: "haiku" as const, explicitModel: "m", modelForProvider: () => "m" }),
      complete: async () => {
        gatewayCalls += 1;
        return { text: "[]", provider: "google" as const, model: "m", modelTier: "haiku" as const, inputTokens: 0, outputTokens: 0, costCents: 0, estimated: true, priced_as_default: false, finishReason: "stop" };
      },
    };
    const a = createMediaAdapter(
      { workspace, profileDir, backend: "local" },
      { env: { PATH: noWhisper, HOME: root }, gateway, media: { backend: "host", hosted_transcription: false, whisper_model: "" } },
    );
    const rec = await a.execute('media_transcribe {"input":"talk.mp4"}', {});
    expect(rec.status).toBe("failed");
    expect(rec.summary).toMatch(/media\.hosted_transcription/);
    expect(rec.summary).toMatch(/whisper/i);
    expect(gatewayCalls).toBe(0);
    // Opted in, the hosted path is an approval: the adapter asks before any audio leaves.
    const opted = createMediaAdapter(
      { workspace, profileDir, backend: "local" },
      { env: { PATH: noWhisper, HOME: root }, gateway, media: { backend: "host", hosted_transcription: true, whisper_model: "" } },
    );
    expect(opted.requiresApproval('media_transcribe {"input":"talk.mp4"}')).toBe(true);
    expect(a.requiresApproval('media_transcribe {"input":"talk.mp4"}')).toBe(false);
    expect(a.requiresApproval('media_probe {"input":"talk.mp4"}')).toBe(false);
  });
});
