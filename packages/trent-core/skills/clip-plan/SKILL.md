---
name: clip-plan
description: From one long-form recording, a ranked list of clip candidates with in and out timestamps, a hook, a caption and the exact media_clip call for each, cut in the workspace when the media backend is installed; thumbnails through media_thumbnail and, with the owner's approval of the cents, media_image. Use when a long video or a podcast episode needs its shorts. Cuts nothing without a backend; uploads nothing ever.
category: creator
trust: official
version: 1.2.0
author: trent
tags: creator, clips, shorts, reels, tiktok, long-form, podcast, media_clip, transcription, thumbnails
---
# Clip Plan

One long recording holds five to eight clips. This skill finds them, ranks them, names the
seconds, writes the hook and the caption for each, and, when the media backend is installed,
makes the cuts with `media_clip` so the owner reviews files instead of timestamps. The
`repurpose-plan` skill is the wider plan (text derivatives, publishing order); this one is
the cutting list.

Who runs it: `content`, cutting as the Cutter (`mkt-short-video-editing-coach`, a profile the
planner does not schedule on its own); every seat carries the media toolset.

## Which backend, and what that changes

Run `media_probe` first. If it fails saying no backend, say so, cite the Media Pipeline line
of `trent doctor` (it names what is installed and how to install the rest, or
`trent sandbox build --media`), and write the plan from a transcript the owner supplies:
every section below still applies, the `media_clip` calls are written into the plan for later,
and nothing is cut. When the media backend is installed, every step runs.

## What you need before you start

1. The recording, as a path under the workspace (`recordings/episode-14.mp4`). Files outside
   the workspace are refused by every media tool.
2. The platforms in play (Shorts, Reels, TikTok, LinkedIn video) and how many clips the owner
   wants this week.
3. The voice file (`brand/voice.md`) and the hook rules (`hook-lab`).
4. Moments the creator already liked, if any.

## Steps, in order

1. Probe: `media_probe` with `{"input": "recordings/episode-14.mp4"}`. Note the duration,
   the resolution and whether there is one video stream; a 9:16 crop of a 16:9 source loses
   the sides, so the frame column below says what must stay in the window.
2. Transcribe: `media_transcribe` with `{"input": "recordings/episode-14.mp4", "language": "en"}`.
   It saves `media-out/episode-14.transcript.json` (segments with `start`, `end`, `text` in
   seconds), which `media_clip` reads for captions. If the owner already has a transcript with
   timestamps, skip this and say so. If no local engine is installed the call fails and names
   what to install; hosted transcription is an opt-in the owner sets, never something this
   skill turns on.
3. Cut points: `media_scenes` with `{"input": "recordings/episode-14.mp4", "threshold": 0.3}`.
   It saves `media-out/episode-14.scenes.json`. A clip's out point that lands on a scene change
   looks cut on purpose; one that lands mid-shot needs the sentence to end it.
4. Choose candidates from the transcript: a complete idea in 20 to 60 seconds with setup,
   point and landing; a hookable first line; a change of energy; no "as I said earlier". Not
   the intro, the sponsor read or the outro.
5. Rank them. One score per candidate, 1 to 5, on each of: stands alone, first line hooks,
   ends on a landing, has a visual moment. Sum, then break ties by the shorter clip.
6. For each candidate write the hook (spoken, under 12 words, from `hook-lab`), the on-screen
   text (six words or fewer), the caption (a hook line, the ask, three to five hashtags) and
   the frame note (face tight, face medium, screen, two people).
7. Cut, top candidates first, one call per clip:
   `media_clip` with `{"input": "recordings/episode-14.mp4", "start": 372, "end": 411, "crop": "face", "captions": true}`.
   `crop` is `face` when one speaker is on screen (MediaPipe follows the face, centre is the
   fallback), `center` for a screen recording or a two-shot, `none` to keep 16:9 for LinkedIn.
   `captions` needs the transcript from step 2 (`"transcript"` names another file). The MP4
   lands at `media-out/episode-14.clip-372-411.mp4` unless `"output"` names a path under the
   workspace. Do not cut a window longer than an hour; do not cut before the plan is written.
8. Cover frames: `media_thumbnail` with `{"input": "media-out/episode-14.clip-372-411.mp4", "at": 1.5, "width": 1080}`
   for each cut clip, so the owner sees the first frame the platform will show. A generated
   cover instead of a frame is `media_image` with `{"prompt": "<one paragraph>", "aspect": "9:16"}`
   or `{"brief": "thumbnails/<slug>.md", "variant": "A", "aspect": "9:16"}` from a
   `thumbnail-brief` file. Each image costs cents and asks for approval with the prompt and the
   price unless the profile auto-approves under a threshold; say in the plan how many images
   the plan would render and the price the tool names, and render none until the owner says yes.
9. Review pass: open the plan, the clip paths and the frame paths in one file for the owner.

## Rules of the trade

- Timestamps to the second, from the transcript, and the words that end the clip when the out
  point is mid-sentence. `start` and `end` are seconds, `end` after `start`.
- One primary platform per clip; a secondary only if the aspect and length fit.
- Never two clips that make the same point. If two candidates overlap, keep the higher score.
- No predictions of views. The rank is about the clip, not the algorithm.
- Every path is under the workspace. If the owner names a file elsewhere, ask them to copy it in.
- Say plainly which steps ran and which were written for later because no backend answered.

## Output format

Write `clips/<slug>.md`:

```
# Clip plan: <recording title>, <duration from media_probe>

Source: <path>  Probe: <resolution>, <duration>, <streams>
Transcript: <media-out/<name>.transcript.json, or the owner's file>  Scenes: <media-out/<name>.scenes.json, or "not run">
Backend: <docker | host | none: which steps ran>

## Ranked candidates
| Rank | In | Out | Score | Working title | Hook (spoken) | On-screen text | Caption | Primary | Crop | Frame |
|------|----|-----|-------|---------------|---------------|----------------|---------|---------|------|-------|
| 1 | 6:12 (372) | 6:51 (411) | 18 | ... | ... | ... | ... | Shorts | face | guest, tight |

## Cuts
| Rank | media_clip call | Output | Status |
|------|-----------------|--------|--------|
| 1 | {"input": "...", "start": 372, "end": 411, "crop": "face", "captions": true} | media-out/<name>.clip-372-411.mp4 | cut | written for later |

## Cover frames
| Rank | media_thumbnail call | Output | Status |
|------|----------------------|--------|--------|

## Generated covers (needs approval)
<n> images at <price the tool names> cents each; none rendered until the owner approves.
| Rank | media_image call | Output | Status |
|------|------------------|--------|--------|

## Held back
- <candidates below the line, and why>
```

## Worked example

Input: `recordings/episode-14.mp4`, a 42-minute podcast episode with a spa owner as the guest;
platforms Shorts (largest audience) and Reels; four clips wanted; the media backend is docker.

```
# Clip plan: Running a spa on Elm Street, 42:10

Source: recordings/episode-14.mp4  Probe: 1920x1080, 42:10, 1 video + 1 audio stream
Transcript: media-out/episode-14.transcript.json (whisper.cpp, en, 611 segments)  Scenes: media-out/episode-14.scenes.json (38 cuts)
Backend: docker; probe, transcribe, scenes and four cuts ran; covers: frames extracted, no image rendered

## Ranked candidates
| Rank | In | Out | Score | Working title | Hook (spoken) | On-screen text | Caption | Primary | Crop | Frame |
|------|----|-----|-------|---------------|---------------|----------------|---------|---------|------|-------|
| 1 | 6:12 (372) | 6:51 (411) | 19 | The no-show note | I never charge the first no-show. Here is what I send instead. | First no-show: no fee | The note that keeps a customer who missed you. What do you send? #spaowner #smallbusiness #noshow | Shorts | face | guest, tight |
| 2 | 19:05 (1145) | 19:58 (1198) | 17 | Reviews are for the next hundred | A reply to a review is not for the reviewer. | It is for the next 100 | Who is your review reply really for? #reviews #smallbusiness #spa | Shorts | face | guest and host |
| 3 | 11:40 (700) | 12:18 (738) | 16 | Thursday nights | Bookings before six dried up, so we moved the evening. | We moved the evening | When did your quiet hours move? #spa #bookings #smallbusiness | Reels | face | guest, medium |
| 4 | 31:15 (1875) | 31:59 (1919) | 15 | Quiet room economics | The quiet room makes no money and pays for itself. | It pays for itself | The room that earns nothing and keeps everyone. #spa #smallbusiness | Reels | face | guest, medium |

## Cuts
| Rank | media_clip call | Output | Status |
|------|-----------------|--------|--------|
| 1 | {"input": "recordings/episode-14.mp4", "start": 372, "end": 411, "crop": "face", "captions": true} | media-out/episode-14.clip-372-411.mp4 | cut |
| 2 | {"input": "recordings/episode-14.mp4", "start": 1145, "end": 1198, "crop": "center", "captions": true} | media-out/episode-14.clip-1145-1198.mp4 | cut (two-shot, centre crop) |
| 3 | {"input": "recordings/episode-14.mp4", "start": 700, "end": 738, "crop": "face", "captions": true} | media-out/episode-14.clip-700-738.mp4 | cut |
| 4 | {"input": "recordings/episode-14.mp4", "start": 1875, "end": 1919, "crop": "face", "captions": true} | media-out/episode-14.clip-1875-1919.mp4 | cut |

## Cover frames
| Rank | media_thumbnail call | Output | Status |
|------|----------------------|--------|--------|
| 1 | {"input": "media-out/episode-14.clip-372-411.mp4", "at": 1.5, "width": 1080} | media-out/episode-14.clip-372-411.thumb-1.5.png | extracted |
| 2 | {"input": "media-out/episode-14.clip-1145-1198.mp4", "at": 2, "width": 1080} | media-out/episode-14.clip-1145-1198.thumb-2.png | extracted |

## Generated covers (needs approval)
2 images at 4 cents each (the price media_image named); none rendered until the owner approves.
| Rank | media_image call | Output | Status |
|------|------------------|--------|--------|
| 1 | {"brief": "thumbnails/no-show-note.md", "variant": "A", "aspect": "9:16"} | media-out/<hash>.png | waiting for approval |
| 2 | {"brief": "thumbnails/reviews-next-hundred.md", "variant": "B", "aspect": "9:16"} | media-out/<hash>.png | waiting for approval |

## Held back
- 24:30 to 25:02, the voucher question: needs the host's setup to land; score 11.
- 37:48 to 38:20, hire for the desk: better as a LinkedIn post than a clip; score 12.
```

## Approval

Cutting, transcribing and extracting frames run without asking when the media backend is
installed: they read and write files under the workspace and nothing leaves the machine. A
`media_image` render costs money and asks for approval per image with the prompt and the price.
Hosted transcription is off unless the owner set it. Nothing is uploaded or published by this
skill. A cut clip can go to Bluesky from media-out/ as its own approved post where the social
toolset is on and Bluesky is connected (one MP4 of at most 300,000,000 bytes, with alt text);
Buffer takes a clip only from a public URL, and Instagram, TikTok and YouTube have no upload path
here, so there the owner posts each clip.
