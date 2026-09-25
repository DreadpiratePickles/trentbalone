---
name: hook-lab
description: Ten opening lines for a short video, across five patterns, each speakable in three seconds and paired with on-screen text, then the three to shoot and the re-hook for the middle. Use when a clip, a short or a video needs its first three seconds. When the media backend is installed the three shortlisted openings are cut with media_clip for review and their first frames checked with media_thumbnail; no views are predicted.
category: creator
trust: official
version: 1.1.0
author: trent
tags: creator, hooks, shorts, reels, tiktok, youtube, retention, scripting
---
# Hook Lab

The first three seconds decide whether the other fifty-seven happen. A hook states the payoff
or the tension before anything else: no greeting, no "in this video", no logo. Ten of them,
five patterns, then pick three and shoot.

## When to use

- A clip has been chosen (see `repurpose-plan`) and needs its opening.
- A script is written and the owner suspects the first line is weak.
- A video is losing viewers in the first five seconds and needs a new cold open.

## What you need before you write

1. The one takeaway of the clip, in a sentence. If there are two, it is two clips.
2. The audience: who they are and what they already believe about the topic.
3. The platform (Shorts, Reels, TikTok, LinkedIn video) and the length.
4. The transcript or the moment the clip is cut from, so the hook is honest about what follows.
5. The creator's voice: how they actually talk (a transcript beats a description).

## With the media tools

Who runs it: `content`; every seat carries the media toolset. `mkt-short-video-editing-coach`
and the other specialists are profiles the planner does not schedule on their own.

These steps run when the media backend is installed (the Media Pipeline line of `trent doctor`
says whether it is, and how to install one or run `trent sandbox build --media`). Without a
backend, skip them and work from the transcript the owner supplies; say which you did.

1. `media_probe` with `{"input": "recordings/<file>.mp4"}` to confirm the file, its duration
   and its frame size; a hook for a 45-second Short cannot open a 4-minute window.
2. When the owner gave a recording and no transcript: `media_transcribe` with
   `{"input": "recordings/<file>.mp4", "language": "en"}`; it saves
   `media-out/<file>.transcript.json`, and the hooks quote it, not a paraphrase.
3. Cut the opening of each of the three shortlisted hooks for review with `media_clip` and
   `{"input": "recordings/<file>.mp4", "start": <in>, "end": <in + 8>, "crop": "face", "captions": true}`
   so the spoken hook is heard against the frame it opens on. The MP4 lands at
   `media-out/<file>.clip-<in>-<in + 8>.mp4`. The on-screen text is not burned in by the tool;
   it is written in the table for the editor.
4. Check each cut's first frame: `media_thumbnail` with `{"input": "media-out/<file>.clip-<in>-<in + 8>.mp4", "at": 0, "width": 640}`.
   The rule says the first frame shows the subject, not a title card; look before writing
   "First frame" in the table. This is the docs/media.md order: probe, transcribe, clip, frame.

## The first-three-seconds rule

- Spoken hook under 12 words: three seconds at talking pace.
- The payoff or the tension is in the hook, not after it.
- On-screen text of six words or fewer, saying something the audio does not.
- The first frame shows the subject, not a title card.
- Banned openers: "hey guys", "welcome back", "in this video", "so today", "let me tell you".

## The five patterns

1. Contrarian: the thing everyone does, and why it is wrong.
2. Specific number: a figure that makes the claim concrete ("three settings", "40 seconds").
3. The question they already ask: the exact words the viewer would type.
4. Before and after: the state now, the state after, nothing in between yet.
5. The mistake you are making: name it, imply the fix is coming.

Two hooks per pattern. Then a retention re-hook: one line for the 20 to 30 percent mark that
restates the stakes ("and the second one is the one most people skip").

## Rules of the trade

- A hook must be paid off by the clip. If the clip does not deliver the number, the number is
  not the hook.
- No predictions of views, virality or "this will blow up". Nobody knows.
- Match the creator's register: a hook they would not say out loud is not a hook.
- Rank the top three by one criterion each: the most honest, the most specific, the most
  surprising.

## Output format

Write `hooks/<slug>.md`:

```
# Hooks: <clip title>

Takeaway: <one sentence>
Audience: <one line>
Platform and length: <platform, seconds>

| # | Pattern | Spoken hook (under 12 words) | On-screen text (6 words or fewer) | First frame |
|---|---------|------------------------------|-----------------------------------|-------------|
| 1 | contrarian | ... | ... | ... |
| 2 | contrarian | ... | ... | ... |
| 3 | number | ... | ... | ... |
| ... | ... | ... | ... | ... |
| 10 | mistake | ... | ... | ... |

## Shoot these three
1. #<n>: <why, in one line>
2. #<n>: <why>
3. #<n>: <why>

## Re-hook (20 to 30 percent mark)
<one spoken line>
```

## Worked example

Input: a 45-second Short cut from a 20-minute video about editing; takeaway: cutting the first
two seconds of every clip fixes most retention problems; audience: new creators who blame the
algorithm; the creator talks fast and plain.

```
# Hooks: Cut the first two seconds

Takeaway: Most retention drops come from the two seconds before the point, and cutting them
is free.
Audience: new creators who think the algorithm is the problem
Platform and length: Shorts, 45 seconds

| # | Pattern | Spoken hook | On-screen text | First frame |
|---|---------|-------------|----------------|-------------|
| 1 | contrarian | The algorithm is not why they left. | It is not the algorithm | the creator, mid-sentence, timeline behind |
| 2 | contrarian | Your intro is the problem, not your content. | Your intro is the problem | the creator pointing at a timeline |
| 3 | number | Two seconds. That is what is killing your video. | 2 seconds | a timeline with a 2-second region highlighted |
| 4 | number | Cut two seconds and watch the graph change. | Cut 2 seconds | the retention graph |
| 5 | question | Why do people leave at second three? | Why second three? | the retention graph with a dip at 3 |
| 6 | question | Where does everyone click away? Here. | Here | the timeline cursor at the drop |
| 7 | before-after | This is the graph before. This is after one cut. | Before / After | two graphs side by side |
| 8 | before-after | Same video, one cut, half the drop-off. | One cut | two graphs side by side |
| 9 | mistake | You are starting every clip two seconds too early. | Two seconds too early | the creator, timeline behind |
| 10 | mistake | The mistake is in your first two seconds. | Check your first 2 seconds | the timeline |

## Shoot these three
1. #3: the most specific; the number is the payoff and the clip delivers it.
2. #7: the most honest; the graphs are real and the cut is shown.
3. #1: the most surprising for this audience; it contradicts what they believe.

## Re-hook (20 to 30 percent mark)
And the second place people leave is one you have never looked at.
```

## Approval

Nothing is posted or uploaded. The probe, the transcript, the frame and the review cut read
and write files under the workspace only, when the media backend is installed; without one the
skill is text and the owner cuts in their editor. Publishing stays with the owner.
