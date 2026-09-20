---
name: thumbnail-brief
description: Three thumbnail briefs for one video: composition, three words or fewer of text, the emotion on the face, the colours by name from the creator's palette, a shoot list for a real photo and a prompt for later image generation. Use when a video needs its thumbnail. Pulls the real frame with media_thumbnail and, after the owner approves the cents, renders one variant with media_image when the media backend and an image key are configured.
category: creator
trust: official
version: 1.0.0
author: trent
tags: creator, thumbnails, youtube, design, image-brief, testing
---
# Thumbnail Brief

A thumbnail is read at 120 pixels wide on a phone, in under a second, next to eleven others.
One idea, three words at most, a face that feels what the title promises, and contrast that
survives being tiny. Three briefs, so the creator can test rather than guess.

## When to use

- A video is edited and titled (see `caption-and-chapters`) and needs its thumbnail.
- A published video is under-clicking and the creator wants variants to test.

## What you need before you write

1. The title and the hook the video opens with. The thumbnail must not repeat the title's
   words; it adds the picture the title lacks.
2. What the creator can shoot: their face, a screen, an object, a location; whether a photo
   from the video exists. When the media backend is installed, pull the candidate frames
   yourself (below) instead of asking.
3. The creator's palette, by name, from `brand/voice.md` or the creator's own description. If
   there is none, describe colours in words; do not invent a palette.
4. Two or three competitor thumbnails the creator has seen for the same topic, described, so
   the brief can look different from them.

## With the media tools

1. Frames from the video, when the media backend is installed (the Media Pipeline line of
   `trent doctor` says so, and names `trent sandbox build --media` when it is not):
   `media_thumbnail` with `{"input": "videos/<file>.mp4", "at": 12.5, "width": 1280}` for
   each second the brief points at (the reaction, the object, the graph). It writes
   `media-out/<file>.thumb-12.5.png`; name that path in the variant's shoot list so the creator
   can use the real frame instead of a reshoot.
2. Rendering, after the brief is written and the owner approves the spend: `media_image` with
   `{"brief": "thumbnails/<slug>.md", "variant": "A", "aspect": "16:9"}` (`9:16` for a Short's
   cover, `1:1` or `4:5` for a feed post). It reads the variant's "Generation prompt (for
   later)" paragraph, costs cents per image (the tool names the price before the call), writes
   the spend to the ledger and asks for approval with the prompt and the price unless the
   profile auto-approves under a threshold. The doctor's Media Pipeline line says which image
   provider and key are configured; with none, the tool says so and the prompt stays in the
   brief for the creator to paste elsewhere. The file lands under `media-out/`.
3. Render one variant, not three, unless the owner asks: the test plan compares real
   thumbnails, and each one is a charge.

## Rules of the trade

- One idea per thumbnail. If it needs an arrow and a circle and three words, it is two ideas.
- Text: three words or fewer (four at most on YouTube), never the title, readable at 120 px:
  heavy weight, high contrast, never over the face.
- The face carries the emotion the hook promises: surprise for a contrarian hook, focus for a
  how-to, relief for a before-and-after. No stock expressions; the shoot list says what to
  think about, not what to do with the eyebrows.
- Composition: subject on a third, one point of contrast, background simpler than the subject,
  brand colour as an accent, not the background.
- Truth: the image shows nothing the video does not deliver. No fake graphs, no invented
  numbers, no results the creator did not get.
- Three variants: A face plus text, B the object or the result, C the before-and-after or the
  contrast. Then a test plan: which two to compare first and what would decide it.
- Alt text for each: one plain sentence.
- The generation prompt is what `media_image` renders from the brief (its "Generation prompt
  (for later)" line under the variant heading) once the owner approves the cents; it is written
  so the creator can also paste it into any tool, and it never asks for a real person's
  likeness other than the creator's own photo as input.

## Output format

Write `thumbnails/<slug>.md`:

```
# Thumbnails: <video title>

Hook: <the spoken hook>
Emotion to carry: <one word>
Palette: <names, from the creator's file, or "none given: colours described in words">
Avoid looking like: <competitor thumbnails, described>

## A: face plus text
Composition: <subject placement, background, the one point of contrast>
Text: <three words or fewer>
Face: <what the creator is thinking in the shot>
Colours: <by name>
Alt text: <one sentence>
Shoot list: <what to set up, in three lines>
Generation prompt (for later): <one paragraph, the creator's own photo as the only likeness>

## B: the object or the result
...

## C: before and after, or the contrast
...

## Test plan
First compare: <A or B or C> against <the other>; keep the one with the higher click-through
after <n> days or <n> thousand impressions, whichever is first. Then test the winner against
the third.
```

## Worked example

Input: video "Why viewers leave in the first three seconds", hook "Two seconds. That is what is
killing your video."; the creator can shoot their face and has a screenshot of the retention
graph with a dip at second three; palette from the voice file: "ink" (dark background),
"signal" (bright accent), "paper" (light text); competitor thumbnails seen: red arrows on
graphs, faces with open mouths.

```
# Thumbnails: Why viewers leave in the first three seconds

Hook: Two seconds. That is what is killing your video.
Emotion to carry: recognition (the "oh, that is my graph" face)
Palette: ink background, signal accent, paper text
Avoid looking like: red arrows on a graph; an open-mouth shock face

## A: face plus text
Composition: creator on the right third, looking at a large retention graph on the left
two-thirds; the dip at second three is the one point of contrast, drawn in signal; ink
background.
Text: "2 SECONDS" in paper, heavy, bottom left, not over the face.
Face: the moment you notice your own mistake: a small wince, eyes on the graph.
Colours: ink, signal for the dip only, paper for the text.
Alt text: A creator looks at a large retention graph that drops sharply near the start, with
the text "2 seconds".
Shoot list: window light from the left; hold the phone at eye level; look at a point to the
left, slightly down, and think "there it is".
Generation prompt (for later): A clean chart on a dark background showing a viewer retention
curve that drops sharply at the three-second mark, the drop highlighted in one bright accent
colour, large flat text "2 SECONDS" bottom left in a light heavy typeface, space on the right
third left empty for a photo of the creator to be composited in. No faces, no logos.

## B: the object or the result
Composition: the retention graph alone, full frame, the first three seconds zoomed so the dip
fills the height; a thin signal line marks second two; ink background.
Text: "HERE"
Face: none.
Colours: ink, signal, paper.
Alt text: A close-up of a retention graph with a sharp early drop, marked with the word "here".
Shoot list: export the graph at full size; crop to the first ten seconds.
Generation prompt (for later): (as A, without the empty third and without any text but "HERE"
next to the marked drop)

## C: before and after
Composition: two small graphs stacked, top with the dip, bottom without; a signal bar between
them; the creator's face small in the bottom right corner, calm.
Text: "ONE CUT"
Face: quiet satisfaction; think "that was easy".
Colours: ink, signal, paper.
Alt text: Two retention graphs stacked, the top one dropping early and the bottom one holding,
with the text "one cut".
Shoot list: same light as A; a straight look at the lens, no smile yet, then a half one.
Generation prompt (for later): (two stacked charts as described, the accent bar between them,
text "ONE CUT" left, empty bottom-right corner for the creator's photo)

## Test plan
First compare: A against C; keep the one with the higher click-through after 7 days or 5,000
impressions, whichever is first. Then test the winner against B.
```

## Approval

Frames from the video are extracted without asking when the media backend is installed; they
are files under the workspace. A `media_image` render costs money and asks for approval per
image with the prompt and the price; none is rendered until the owner says yes. Nothing is
uploaded: the creator chooses the thumbnail and sets it on the platform.
