/**
 * The media line of `trent doctor`: which backend the media toolset would use, which binaries
 * are present, how to install the rest, and whether hosted transcription (egress of private
 * audio) is opted in. Fake binaries on a temporary PATH; no daemon, no model, no network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { MEDIA_IMAGE } from "../../tools/media/backend.js";
import type { DoctorContext } from "../types.js";
import { checkMedia } from "./media.js";

function fake(bin: string, name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nPATH="$PATH:/bin:/usr/bin"\nd=$(dirname "$0")\n${body}\n`, { mode: 0o755 });
}

describe("checkMedia", () => {
  let root = "";
  let bin = "";
  let configManager: ConfigManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-media-"));
    bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    configManager = new ConfigManager({ baseDir: path.join(root, "home") });
    configManager.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function context(env: NodeJS.ProcessEnv): DoctorContext {
    return { baseDir: path.join(root, "home"), profile: "default", configManager, env, probeTimeoutMs: 2000 };
  }

  it("with nothing installed it warns, names the missing binaries and gives an install line per OS", async () => {
    const result = await checkMedia.run(context({ PATH: bin }));
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/no media backend/i);
    expect(result.fixHint).toContain("brew install ffmpeg");
    expect(result.fixHint).toContain("apt install ffmpeg");
    expect(result.fixHint).toContain(`docker build -f scripts/sandbox/media/Dockerfile -t ${MEDIA_IMAGE} scripts/sandbox/media`);
    expect(result.details).toMatchObject({ backend: "none", image: MEDIA_IMAGE, imagePresent: false });
  });

  it("with ffmpeg and ffprobe on PATH it reports the host backend, what is present and what is missing", async () => {
    fake(bin, "ffmpeg", "exit 0");
    fake(bin, "ffprobe", "exit 0");
    fake(bin, "docker", 'if [ "$1" = "inspect" ]; then echo "No such image" >&2; exit 1; fi\nexit 0');
    const result = await checkMedia.run(context({ PATH: bin }));
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/host backend/);
    expect(result.message).toMatch(/ffmpeg, ffprobe/);
    expect(result.message).toMatch(/whisper-cli/);
    expect(result.fixHint).toMatch(/whisper-cpp/);
    expect(result.details).toMatchObject({ backend: "host", present: ["ffmpeg", "ffprobe"], missing: expect.arrayContaining(["whisper-cli", "scenedetect"]), hostedTranscription: false });
  });

  it("names hosted transcription as egress of private audio when the profile opts in", async () => {
    fake(bin, "ffmpeg", "exit 0");
    fake(bin, "ffprobe", "exit 0");
    configManager.saveConfig({ ...configManager.loadConfig(), media: { backend: "auto", hosted_transcription: true, whisper_model: "" } });
    const result = await checkMedia.run(context({ PATH: bin }));
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/hosted transcription is ON/);
    expect(result.message).toMatch(/audio.*leaves this machine/i);
    expect(result.details).toMatchObject({ hostedTranscription: true });
  });

  it("prefers the docker backend when the media image exists", async () => {
    fake(bin, "docker", 'if [ "$1" = "inspect" ]; then echo "sha256:0123"; exit 0; fi\nexit 0');
    const result = await checkMedia.run(context({ PATH: bin }));
    expect(result.status).toBe("ok");
    expect(result.message).toContain(MEDIA_IMAGE);
    expect(result.details).toMatchObject({ backend: "docker", imagePresent: true });
  });
});
