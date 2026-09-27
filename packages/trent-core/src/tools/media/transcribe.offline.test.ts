/**
 * [SEC-2 S2b-2 / O-07] Offline mode and the transcription engines. faster-whisper downloads its model
 * from Hugging Face on first use, over the network and outside the proxy, so offline refuses it unless
 * the model is already cached — naming the cache path. whisper.cpp with a local ggml model is allowed.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MediaBackend, MediaBinary } from "./backend.js";
import { planEngine, fasterWhisperCacheDir, fasterWhisperModelCached, FASTER_WHISPER_MODEL } from "./transcribe.js";

let profileDir: string;
let hfHome: string;

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-media-profile-")));
  hfHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-media-hf-")));
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.rmSync(hfHome, { recursive: true, force: true });
});

/** A host backend where python3+faster_whisper are present but whisper-cli is not (unless asked). */
function hostBackend(over: { whisperCli?: boolean } = {}): MediaBackend {
  const installed = {
    ffmpeg: true,
    ffprobe: true,
    "whisper-cli": over.whisperCli ?? false,
    scenedetect: false,
    python3: true,
  } as Record<MediaBinary, boolean>;
  return {
    kind: "host",
    async installed() {
      return installed;
    },
    async run(binary) {
      // The faster_whisper module probe: exit 0 = present.
      return { code: binary === "python3" ? 0 : 0, stdout: "", stderr: "" };
    },
    modelRef: (p) => ({ arg: p, mounts: [] }),
  };
}

const OFFLINE_ENV = (): NodeJS.ProcessEnv => ({ TRENT_OFFLINE: "1", HF_HOME: hfHome });

describe("planEngine — faster-whisper offline gate", () => {
  it("refuses faster-whisper offline when the model is not cached, naming the cache path", async () => {
    const plan = await planEngine({ backend: hostBackend(), profileDir, whisperModel: "", hostedAllowed: false, env: OFFLINE_ENV() });
    expect(plan.engine).toBe("none");
    if (plan.engine === "none") {
      expect(plan.reason).toContain(fasterWhisperCacheDir(OFFLINE_ENV()));
      expect(plan.reason.toLowerCase()).toContain("offline");
      expect(plan.reason).toContain(FASTER_WHISPER_MODEL);
    }
  });

  it("allows faster-whisper offline once the model is cached", async () => {
    fs.mkdirSync(path.join(hfHome, "hub", `models--Systran--faster-whisper-${FASTER_WHISPER_MODEL}`), { recursive: true });
    expect(fasterWhisperModelCached(FASTER_WHISPER_MODEL, OFFLINE_ENV())).toBe(true);
    const plan = await planEngine({ backend: hostBackend(), profileDir, whisperModel: "", hostedAllowed: false, env: OFFLINE_ENV() });
    expect(plan.engine).toBe("faster-whisper");
  });

  it("uses faster-whisper freely when offline is off", async () => {
    const plan = await planEngine({ backend: hostBackend(), profileDir, whisperModel: "", hostedAllowed: false, env: { HF_HOME: hfHome } });
    expect(plan.engine).toBe("faster-whisper");
  });

  it("allows whisper.cpp with a local ggml model even offline", async () => {
    fs.mkdirSync(path.join(profileDir, "models"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "models", "ggml-base.en.bin"), "x");
    const plan = await planEngine({ backend: hostBackend({ whisperCli: true }), profileDir, whisperModel: "", hostedAllowed: false, env: OFFLINE_ENV() });
    expect(plan.engine).toBe("whisper.cpp");
  });
});
