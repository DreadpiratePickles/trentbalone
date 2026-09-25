/**
 * [P2-3] Voice notes at the gateway. The adapters carry an inbound audio attachment as a lazy
 * `open()`; `prepareVoiceNote` is the one call in `GatewayManager.handleInbound`, placed after the
 * pairing gate, that downloads it into `<profile>/inbox/<platform>/`, transcribes it with the media
 * toolset's engines, and hands the run `[voice note, <n>s] <transcript>`. The engine here is a fake
 * (the `VoiceEngine` seam), except in the test that drives `tools/media/transcribe.ts` through fake
 * `whisper-cli`/`ffmpeg` binaries on a temporary PATH, and the opt-in real whisper.cpp run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { findOnPath } from "../tools/media/backend.js";
import { GatewayManager } from "./GatewayManager.js";
import { MemoryGatewayStore } from "./store/GatewayStore.js";
import { FakeServer, json, waitFor } from "./testing/fakeServer.js";
import type { InboundAttachment, InboundMessage } from "./transport/types.js";
import { createMediaVoiceEngine, extensionForMime, saveVoiceNote, VoiceNoteTooLarge, type VoiceEngineFactory } from "./voice-notes.js";

const TOKEN = "777:telegram-token-for-voice-test";
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0]);

function fakeEngine(opts: { missing?: string; duration?: number; text?: string; fail?: string } = {}) {
  const calls = { factory: 0, missing: 0, duration: [] as string[], transcribe: [] as string[] };
  const factory: VoiceEngineFactory = () => {
    calls.factory += 1;
    return {
      async missing() { calls.missing += 1; return opts.missing; },
      async duration(file) { calls.duration.push(file); return opts.duration; },
      async transcribe(file) {
        calls.transcribe.push(file);
        return opts.fail ? { ok: false, reason: opts.fail } : { ok: true, text: opts.text ?? "book me for Tuesday", engine: "fake" };
      },
    };
  };
  return { factory, calls };
}

function audio(bytes: Uint8Array, extra: Partial<InboundAttachment> = {}) {
  let opened = 0;
  const attachment: InboundAttachment = { kind: "audio", mime: "audio/ogg", ...extra, open: async () => { opened += 1; return new Response(new Blob([bytes.slice()])); } };
  return { attachment, opened: () => opened };
}

const voiceMessage = (senderId: string, attachment: InboundAttachment, content = ""): InboundMessage => ({
  id: "42", platform: "telegram", channelId: senderId, senderId, content, timestamp: "2026-09-25T00:00:00.000Z", scope: "dm", attachments: [attachment],
});

describe("voice-notes: saving an inbound audio attachment", () => {
  let profileDir = "";
  beforeEach(() => { profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-voice-save-")); });
  afterEach(() => { fs.rmSync(profileDir, { recursive: true, force: true }); });

  it("writes the bytes to <profile>/inbox/<platform>/<message-id>.<ext>, private, with the id made safe", async () => {
    const { attachment } = audio(OGG);
    const file = await saveVoiceNote(attachment, { profileDir, platform: "telegram", messageId: "42", maxBytes: 1024 });
    expect(file).toBe(path.join(profileDir, "inbox", "telegram", "42.ogg"));
    expect(new Uint8Array(fs.readFileSync(file))).toEqual(OGG);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const odd = await saveVoiceNote(audio(OGG, { mime: "audio/mp4" }).attachment, { profileDir, platform: "whatsapp", messageId: "wamid.HB/../g+==", maxBytes: 1024 });
    expect(path.dirname(odd)).toBe(path.join(profileDir, "inbox", "whatsapp"));
    expect(path.basename(odd)).toMatch(/^[A-Za-z0-9_-]+\.m4a$/);
    const second = await saveVoiceNote(attachment, { profileDir, platform: "telegram", messageId: "42", index: 1, maxBytes: 1024 });
    expect(second).toBe(path.join(profileDir, "inbox", "telegram", "42-2.ogg"));
  });

  it("refuses a download past the byte cap and leaves no partial file", async () => {
    const big = new Uint8Array(4096).fill(7);
    await expect(saveVoiceNote(audio(big).attachment, { profileDir, platform: "discord", messageId: "M1", maxBytes: 1000 })).rejects.toBeInstanceOf(VoiceNoteTooLarge);
    const streamed: InboundAttachment = {
      kind: "audio", mime: "audio/ogg",
      open: async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(600)); } })),
    };
    await expect(saveVoiceNote(streamed, { profileDir, platform: "discord", messageId: "M2", maxBytes: 1000 })).rejects.toThrow(/1000/);
    const dir = path.join(profileDir, "inbox", "discord");
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it("maps the platforms' audio MIME types to file extensions", () => {
    expect(extensionForMime("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extensionForMime("audio/mpeg")).toBe("mp3");
    expect(extensionForMime("audio/mp4")).toBe("m4a");
    expect(extensionForMime("audio/aac")).toBe("aac");
    expect(extensionForMime("audio/webm")).toBe("webm");
    expect(extensionForMime("audio/x-wav")).toBe("wav");
    expect(extensionForMime("application/octet-stream")).toBe("audio");
  });
});

describe("voice-notes at the gateway dispatch point", () => {
  let tempDir = "";
  let server: FakeServer;
  let manager: GatewayManager | undefined;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-voice-gw-"));
    server = new FakeServer();
  });

  afterEach(async () => {
    await manager?.stopAll();
    await server.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function make(engine: VoiceEngineFactory, voiceNotes?: Record<string, unknown>, updates: unknown[][] = []) {
    let call = 0;
    server
      .on("POST", `/bot${TOKEN}/getMe`, (_r, res) => json(res, 200, { ok: true, result: { id: 1, is_bot: true, first_name: "T", username: "trent_bot" } }))
      .on("POST", `/bot${TOKEN}/getUpdates`, (_r, res) => json(res, 200, { ok: true, result: updates[call++] ?? [] }))
      .on("POST", `/bot${TOKEN}/sendMessage`, (_r, res) => json(res, 200, { ok: true, result: { message_id: 500 } }));
    await server.start();
    const config = new ConfigManager({ baseDir: tempDir });
    if (voiceNotes) {
      const loaded = config.loadConfig();
      config.saveConfig({ ...loaded, gateway: { ...loaded.gateway, voice_notes: voiceNotes } } as typeof loaded);
    }
    const seen: InboundMessage[] = [];
    manager = new GatewayManager(config, {
      store: new MemoryGatewayStore(),
      agentHandler: async (_agent, m) => { seen.push(m); return null; },
      adapterContext: { baseUrls: { telegram: server.baseUrl }, settings: { TELEGRAM_BOT_TOKEN: TOKEN } },
      drainIntervalMs: 20,
      voiceNotes: { engine },
    });
    return { m: manager, seen, profileDir: config.getProfileDir() };
  }

  const replies = () => server.find("POST", `/bot${TOKEN}/sendMessage`).map((r) => (r.json as { text: string }).text);

  it("transcribes a paired sender's voice note and runs `[voice note, <n>s] <transcript>`, keeping the file", async () => {
    const engine = fakeEngine();
    const { m, seen, profileDir } = await make(engine.factory);
    m.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "regular" });
    const { attachment, opened } = audio(OGG, { durationSeconds: 3.6 });
    await m.handleInbound(voiceMessage("555", attachment));
    expect(opened()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].content).toBe("[voice note, 4s] book me for Tuesday");
    const kept = path.join(profileDir, "inbox", "telegram", "42.ogg");
    expect(seen[0].attachments?.[0]).toEqual(expect.objectContaining({ kind: "audio", mime: "audio/ogg", path: kept, durationSeconds: 3.6 }));
    expect(new Uint8Array(fs.readFileSync(kept))).toEqual(OGG);
    expect(engine.calls.transcribe).toEqual([kept]);
    expect(engine.calls.duration).toEqual([]); // the platform declared it
    expect(replies()).toEqual([]);
  });

  it("never downloads or transcribes an unpaired sender's audio; the sender gets the pairing code", async () => {
    const engine = fakeEngine();
    const { m, seen, profileDir } = await make(engine.factory);
    const { attachment, opened } = audio(OGG, { durationSeconds: 2 });
    await m.handleInbound(voiceMessage("999", attachment));
    expect(opened()).toBe(0);
    expect(engine.calls.factory).toBe(0);
    expect(seen).toEqual([]);
    expect(fs.existsSync(path.join(profileDir, "inbox"))).toBe(false);
    await waitFor(() => replies().length === 1);
    expect(replies()[0]).toMatch(/Pairing code: [A-Z2-9]{8}/);
  });

  it("refuses a note over gateway.voice_notes.max_seconds before downloading it, naming the cap", async () => {
    const engine = fakeEngine();
    const { m, seen } = await make(engine.factory, { max_seconds: 60 });
    m.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "regular" });
    const { attachment, opened } = audio(OGG, { durationSeconds: 61 });
    await m.handleInbound(voiceMessage("555", attachment));
    expect(opened()).toBe(0);
    expect(seen).toEqual([]);
    await waitFor(() => replies().length === 1);
    expect(replies()[0]).toContain("61 s");
    expect(replies()[0]).toContain("60 s");
    expect(replies()[0]).toContain("gateway.voice_notes.max_seconds");
  });

  it("refuses a note whose probed length is over the cap and deletes the download", async () => {
    const engine = fakeEngine({ duration: 301 });
    const { m, seen, profileDir } = await make(engine.factory);
    m.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "regular" });
    const { attachment, opened } = audio(OGG);
    await m.handleInbound(voiceMessage("555", attachment));
    expect(opened()).toBe(1);
    expect(engine.calls.transcribe).toEqual([]);
    expect(seen).toEqual([]);
    expect(fs.readdirSync(path.join(profileDir, "inbox", "telegram"))).toEqual([]);
    await waitFor(() => replies().length === 1);
    expect(replies()[0]).toMatch(/301 s.*300 s.*gateway\.voice_notes\.max_seconds/s);
  });

  it("refuses a download over gateway.voice_notes.max_bytes, naming the cap", async () => {
    const engine = fakeEngine();
    const { m, seen, profileDir } = await make(engine.factory, { max_bytes: 8 });
    m.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "regular" });
    await m.handleInbound(voiceMessage("555", audio(OGG, { sizeBytes: 10 }).attachment));
    const streamed = audio(OGG);
    await m.handleInbound(voiceMessage("555", streamed.attachment));
    expect(streamed.opened()).toBe(1);
    expect(seen).toEqual([]);
    expect(engine.calls.transcribe).toEqual([]);
    expect(fs.readdirSync(path.join(profileDir, "inbox", "telegram"))).toEqual([]);
    await waitFor(() => replies().length === 2);
    for (const reply of replies()) expect(reply).toMatch(/8 bytes.*gateway\.voice_notes\.max_bytes/s);
  });

  it("with no local engine it replies with the doctor's whisper install hint and runs nothing", async () => {
    const engine = fakeEngine({ missing: "whisper.cpp: macOS `brew install whisper-cpp`" });
    const { m, seen } = await make(engine.factory);
    m.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "regular" });
    const { attachment, opened } = audio(OGG, { durationSeconds: 2 });
    await m.handleInbound(voiceMessage("555", attachment));
    expect(opened()).toBe(0);
    expect(seen).toEqual([]);
    await waitFor(() => replies().length === 1);
    expect(replies()[0]).toContain("brew install whisper-cpp");
    expect(replies()[0]).toMatch(/not run/i);
  });

  it("with gateway.voice_notes.enabled false it runs a caption alone, and otherwise says voice notes are off", async () => {
    const engine = fakeEngine();
    const { m, seen } = await make(engine.factory, { enabled: false });
    m.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "regular" });
    const captioned = audio(OGG, { durationSeconds: 2 });
    await m.handleInbound(voiceMessage("555", captioned.attachment, "see the note"));
    expect(seen.map((s) => s.content)).toEqual(["see the note"]);
    const bare = audio(OGG, { durationSeconds: 2 });
    await m.handleInbound(voiceMessage("555", bare.attachment));
    expect(captioned.opened() + bare.opened()).toBe(0);
    expect(engine.calls.factory).toBe(0);
    await waitFor(() => replies().length === 1);
    expect(replies()[0]).toContain("gateway.voice_notes.enabled");
  });

  it("carries a Telegram voice update from the wire to the run, and fetches the file only after pairing", async () => {
    const voiceUpdate = (id: number) => ({ update_id: id, message: { message_id: id, from: { id: 555, first_name: "Ada" }, chat: { id: 555, type: "private" }, date: 1_700_000_000, voice: { file_id: `VOICE${id}`, file_unique_id: `u${id}`, duration: 3, mime_type: "audio/ogg", file_size: OGG.length } } });
    server
      .on("POST", `/bot${TOKEN}/getFile`, (req, res) => json(res, 200, { ok: true, result: { file_id: (req.json as { file_id: string }).file_id, file_unique_id: "u", file_size: OGG.length, file_path: "voice/file_7.oga" } }))
      .on("GET", `/file/bot${TOKEN}/voice/file_7.oga`, (_r, res) => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(Buffer.from(OGG)); });
    const engine = fakeEngine({ text: "move the standup to ten" });
    const { m, seen, profileDir } = await make(engine.factory, undefined, [[voiceUpdate(1)]]);
    await m.startAllConfigured();
    await waitFor(() => replies().length === 1); // the pairing code
    expect(server.find("POST", `/bot${TOKEN}/getFile`)).toEqual([]);
    expect(server.find("GET", "/file/")).toEqual([]);
    const code = /Pairing code: ([A-Z2-9]{8})/.exec(replies()[0])![1];
    m.getPairing().pair("telegram", code, "regular");
    server.on("POST", `/bot${TOKEN}/getUpdates`, (() => { let sent = false; return (_r: unknown, res: import("node:http").ServerResponse) => json(res, 200, { ok: true, result: sent ? [] : (sent = true, [voiceUpdate(2)]) }); })());
    await waitFor(() => seen.length === 1);
    expect(seen[0].content).toBe("[voice note, 3s] move the standup to ten");
    expect(server.find("POST", `/bot${TOKEN}/getFile`).map((r) => r.json)).toEqual([{ file_id: "VOICE2" }]);
    expect(new Uint8Array(fs.readFileSync(path.join(profileDir, "inbox", "telegram", "2.ogg")))).toEqual(OGG);
  });

  it("runs the tools/media engines: fake whisper-cli and ffmpeg on PATH produce the transcript", async () => {
    const bin = path.join(tempDir, "bin");
    const models = path.join(tempDir, "models");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(models, { recursive: true });
    fs.writeFileSync(path.join(models, "ggml-tiny.en.bin"), "fake model");
    const whisperJson = JSON.stringify({ transcription: [{ offsets: { from: 0, to: 2500 }, text: " Ship it on Friday." }] });
    fs.writeFileSync(path.join(bin, "whisper.json"), whisperJson);
    const script = (body: string) => `#!/bin/sh\nPATH="$PATH:/bin:/usr/bin"\nd=$(dirname "$0")\n${body}\n`;
    fs.writeFileSync(path.join(bin, "ffmpeg"), script('for a in "$@"; do last="$a"; done\n: > "$last"'), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "whisper-cli"), script('prev=""; out=""\nfor a in "$@"; do if [ "$prev" = "-of" ]; then out="$a"; fi; prev="$a"; done\ncp "$d/whisper.json" "$out.json"'), { mode: 0o755 });
    const env = { PATH: bin, HOME: tempDir };
    const { m, seen } = await make((ctx) => createMediaVoiceEngine({ ...ctx, env }));
    m.getPairing().grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "regular" });
    await m.handleInbound(voiceMessage("555", audio(OGG).attachment));
    expect(seen.map((s) => s.content)).toEqual(["[voice note, 3s] Ship it on Friday."]);
    expect(await createMediaVoiceEngine({ profileDir: tempDir, workspace: tempDir, env: { PATH: path.join(tempDir, "nothing"), HOME: tempDir } }).missing()).toMatch(/brew install whisper-cpp/);
  });
});

/**
 * One real transcription, opt-in (TRENT_TEST_VOICE_REAL=1): macOS `say` speaks a sentence, ffmpeg
 * makes it a wav, and whisper.cpp transcribes it through the engine the gateway uses: the host's
 * `whisper-cli` when it is on PATH, else the `trent-sandbox-media` image (`--network none`), forced
 * with `media.backend: docker` because `docker inspect --type image` does not find a present image
 * on every daemon. Nothing leaves the machine.
 */
const HOST_WHISPER = findOnPath("whisper-cli", process.env) !== undefined;
const REAL = process.env.TRENT_TEST_VOICE_REAL === "1" && process.platform === "darwin"
  && findOnPath("say", process.env) !== undefined && findOnPath("ffmpeg", process.env) !== undefined
  && (HOST_WHISPER || findOnPath("docker", process.env) !== undefined);

describe.skipIf(!REAL)("voice-notes with a real local whisper.cpp (opt-in)", () => {
  it("transcribes a synthesised voice note", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-voice-real-")));
    try {
      execFileSync("say", ["-o", path.join(dir, "note.aiff"), "book me for Tuesday"]);
      execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", path.join(dir, "note.aiff"), "-ar", "16000", "-ac", "1", path.join(dir, "note.wav")]);
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, "note.wav")));
      const saved = await saveVoiceNote(audio(bytes, { mime: "audio/wav" }).attachment, { profileDir: dir, platform: "telegram", messageId: "real", maxBytes: 20 * 1024 * 1024 });
      const engine = createMediaVoiceEngine({ profileDir: dir, workspace: path.dirname(saved), media: { backend: HOST_WHISPER ? "host" : "docker" } });
      expect(await engine.missing()).toBeUndefined();
      const length = await engine.duration(saved);
      const result = await engine.transcribe(saved);
      console.log(`[P2-3 real transcript] backend=${HOST_WHISPER ? "host" : "docker"} ffprobe=${String(length)}s ${JSON.stringify(result)}`);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.text.toLowerCase()).toMatch(/tuesday/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
