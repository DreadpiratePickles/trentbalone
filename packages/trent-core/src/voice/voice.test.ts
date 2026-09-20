/**
 * `transcribeVoice` is the media toolset's transcription backend on a byte buffer. It never
 * returns transcript-shaped text no engine produced: with no engine it throws a TrentError
 * naming what to install; with an engine (a fake `whisper-cli` and `ffmpeg` on a temporary
 * PATH here) it returns that engine's timestamped segments.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT, isTrentError } from "../errors/index.js";
import { transcribeVoice, VOICE_OPERATION } from "./index.js";

const WHISPER_JSON = JSON.stringify({
  transcription: [{ timestamps: { from: "00:00:00,000", to: "00:00:02,000" }, offsets: { from: 0, to: 2000 }, text: " Voice note." }],
});

function fake(bin: string, name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nPATH="$PATH:/bin:/usr/bin"\nd=$(dirname "$0")\nprintf '%s\\n' "$@" >> "$d/${name}.log"\n${body}\n`, { mode: 0o755 });
}

describe("transcribeVoice", () => {
  let root = "";
  let bin = "";
  let profileDir = "";

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-voice-"));
    bin = path.join(root, "bin");
    profileDir = path.join(root, "profile");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(profileDir, "models"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "models", "ggml-tiny.en.bin"), "fake model");
    fs.writeFileSync(path.join(bin, "whisper.json"), WHISPER_JSON);
    fake(bin, "ffmpeg", 'for a in "$@"; do last="$a"; done\n: > "$last"');
    fake(bin, "whisper-cli", 'prev=""; out=""\nfor a in "$@"; do if [ "$prev" = "-of" ]; then out="$a"; fi; prev="$a"; done\ncp "$d/whisper.json" "$out.json"');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("with no engine installed it throws a TrentError naming what to install, never transcript-shaped text", async () => {
    const empty = path.join(root, "empty-bin");
    fs.mkdirSync(empty, { recursive: true });
    let thrown: unknown;
    try {
      await transcribeVoice(new Uint8Array([1, 2, 3]), { profileDir, env: { PATH: empty, HOME: root } });
    } catch (err) {
      thrown = err;
    }
    expect(isTrentError(thrown)).toBe(true);
    if (!isTrentError(thrown)) return;
    expect(thrown.code).toBe(EXIT.CONFIG);
    expect(thrown.operation).toBe(VOICE_OPERATION);
    expect(thrown.message).toMatch(/whisper/i);
    expect(thrown.message).not.toMatch(/transcribed \d+ bytes/i);
  });

  it("with an engine on PATH it returns that engine's segments and leaves no temporary files behind", async () => {
    const transcript = await transcribeVoice(new Uint8Array([82, 73, 70, 70]), { profileDir, env: { PATH: bin, HOME: root } });
    expect(transcript.engine).toBe("whisper.cpp");
    expect(transcript.segments).toEqual([{ start: 0, end: 2, text: "Voice note." }]);
    const whisperArgv = fs.readFileSync(path.join(bin, "whisper-cli.log"), "utf8");
    expect(whisperArgv).toContain(path.join(profileDir, "models", "ggml-tiny.en.bin"));
    expect(fs.readdirSync(path.join(profileDir, "cache", "voice"))).toEqual([]);
  });
});
