/**
 * The six media tools as the seat sees them. Every argument that names a file is declared as a
 * path (`input`, `output`, `transcript`, `brief`) and described as one, so the hardline path
 * rules in `governance/autonomy-dispatch.ts` (`subjectsOfAction`) inspect it; no argument is
 * named `command`, `cmd`, `script`, `code` or `shell`, because nothing a model passes here is
 * ever run as one.
 */
import type { ToolSchema } from "../web/schemas.js";
import type { ToolSpec } from "../action.js";

export const MEDIA_ADAPTER_NAME = "media";
export const MEDIA_TOOL_NAMES = ["media_probe", "media_transcribe", "media_scenes", "media_clip", "media_thumbnail", "media_image"] as const;
export type MediaToolName = (typeof MEDIA_TOOL_NAMES)[number];

export const MEDIA_ROUTING_TEXT =
  "media video audio image: probe a video file, get its duration and streams, transcribe speech to text with timestamps, " +
  "detect scene changes and cut points, cut a clip, crop to 9:16 vertical for shorts and reels, burn captions, " +
  "extract a thumbnail frame from a video, generate an image from a prompt, render a thumbnail or a post image, run a thumbnail brief";

const INPUT = { type: "string", description: "Path of the media file, relative to the workspace root (or absolute under it). Files outside the workspace are refused." };
const OUTPUT_DESC = "Output path under the workspace. Defaults to media-out/<input name>.<suffix>.";

export const MEDIA_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "media_probe",
    description: "Read a media file's container, duration, size and streams (codec, resolution, frame rate, sample rate) with ffprobe. Read-only.",
    parameters: { type: "object", properties: { input: INPUT }, required: ["input"] },
  },
  {
    name: "media_transcribe",
    description:
      "Transcribe the speech in a media file to timestamped segments with a local whisper engine (whisper.cpp or faster-whisper). " +
      "Saves media-out/<name>.transcript.json for media_clip captions. With no local engine installed the call fails and names what to " +
      "install; sending the audio to the configured model provider instead is an explicit opt-in (media.hosted_transcription) that asks for approval.",
    parameters: {
      type: "object",
      properties: {
        input: INPUT,
        language: { type: "string", description: "Two-letter language code hint such as en or es. Default: auto-detect." },
        output: { type: "string", description: `${OUTPUT_DESC} The transcript JSON.` },
      },
      required: ["input"],
    },
  },
  {
    name: "media_scenes",
    description:
      "Find scene changes (cut points) in a video with PySceneDetect when installed, else ffmpeg's scene filter. Returns the cut times " +
      "in seconds and saves media-out/<name>.scenes.json. Use the cuts with media_transcribe to pick clip windows.",
    parameters: {
      type: "object",
      properties: {
        input: INPUT,
        threshold: { type: "number", description: "Scene-change sensitivity for the ffmpeg filter, 0 to 1 (default 0.3; lower finds more cuts)." },
      },
      required: ["input"],
    },
  },
  {
    name: "media_clip",
    description:
      "Cut a clip from a video between start and end seconds, optionally cropping to 9:16 vertical (crop center, or face to follow the " +
      "speaker with MediaPipe when installed) and burning captions from the saved transcript. Writes an MP4 under the workspace.",
    parameters: {
      type: "object",
      properties: {
        input: INPUT,
        start: { type: "number", description: "Start time in seconds." },
        end: { type: "number", description: "End time in seconds; must be after start." },
        output: { type: "string", description: `${OUTPUT_DESC} The MP4.` },
        crop: { type: "string", enum: ["none", "center", "face"], description: "none keeps the frame; center crops a centred 9:16 window; face centres the window on the detected face, falling back to center." },
        captions: { type: "boolean", description: "Burn the transcript segments inside the window as captions. Needs a transcript (media_transcribe first)." },
        transcript: { type: "string", description: "Path of the transcript JSON to caption from, under the workspace. Defaults to media-out/<input name>.transcript.json." },
      },
      required: ["input", "start", "end"],
    },
  },
  {
    name: "media_thumbnail",
    description: "Extract one frame of a video at a given second as a PNG under the workspace, optionally scaled to a width. Image generation is media_image.",
    parameters: {
      type: "object",
      properties: {
        input: INPUT,
        at: { type: "number", description: "The second to take the frame from. Default 0." },
        width: { type: "integer", description: "Scale the frame to this width in pixels, keeping the aspect ratio. Default: the source width." },
        output: { type: "string", description: `${OUTPUT_DESC} The PNG.` },
      },
      required: ["input"],
    },
  },
  {
    name: "media_image",
    description:
      "Generate one image (a thumbnail, a post image) from a prompt with the configured image provider (the Gemini image model on the " +
      "Gemini key, or an OpenAI-compatible images endpoint) and save it under the workspace as media-out/<content hash>.<ext>. " +
      "Each image costs money (about 4 to 14 cents on Gemini; the exact price is named before the call), is written to the spend " +
      "ledger, and asks for approval with the prompt and the price unless the profile's media.image_auto_approve_under_cents covers it. " +
      "Give a prompt, or a brief file the thumbnail-brief skill wrote and the variant to render.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to render, one paragraph. Never a real person's likeness other than the creator's own photo as input." },
        brief: { type: "string", description: "Path of a thumbnails/<slug>.md file the thumbnail-brief skill wrote, relative to the workspace root; its \"Generation prompt (for later)\" paragraph for the chosen variant is the prompt. Files outside the workspace are refused." },
        variant: { type: "string", enum: ["A", "B", "C"], description: "Which section of the brief to render. Default A." },
        aspect: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "4:5"], description: "Framing: 16:9 for a YouTube thumbnail (default), 1:1 or 4:5 for a feed post, 9:16 for a story or short." },
        output: { type: "string", description: `${OUTPUT_DESC} The image file; defaults to a content-hash name.` },
      },
      required: [],
    },
  },
];

export const MEDIA_SPECS: readonly ToolSpec[] = [
  { name: "media_probe", primary: "input", signature: ["input"] },
  { name: "media_transcribe", primary: "input", signature: ["input", "language"] },
  { name: "media_scenes", primary: "input", signature: ["input", "threshold"] },
  { name: "media_clip", primary: "input", signature: ["input", "start", "end"] },
  { name: "media_thumbnail", primary: "input", signature: ["input", "at"] },
  { name: "media_image", primary: "prompt", signature: ["prompt", "aspect"] },
];
