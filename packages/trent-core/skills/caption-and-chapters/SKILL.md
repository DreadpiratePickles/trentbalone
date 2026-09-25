---
name: caption-and-chapters
description: From a transcript with timestamps, write the YouTube chapters, the description whose first 150 characters carry the promise, three titles, the short-form caption, a pinned comment and subtitle cues cut to two lines. Use when a video is edited and needs its words. Needs a transcript with timestamps, from media_transcribe when the media backend is installed or from the owner's editor; burns the cues into a cut with media_clip.
category: creator
trust: official
version: 1.1.0
author: trent
tags: creator, captions, chapters, youtube, subtitles, srt, descriptions, titles
---
# Caption and Chapters

The words around a video are read by two audiences: the viewer deciding whether to click, and
the search engine deciding whether to show it. Write for the viewer; the engine follows.

Who runs it: `content`, the Wordsmith; every seat carries the media toolset, and
`mkt-video-optimization-specialist` orders the chapters as a profile the seat reads.

## When to use

- A video is edited and has a transcript with timestamps.
- A Short or a Reel is cut and needs its caption and title.
- Old videos need chapters added.

## What you need before you write

1. The transcript with timestamps. Without timestamps, chapters and cues cannot be written; say
   so and produce the description, titles and caption only.
2. The video length and platform.
3. The one promise of the video (what a viewer has at the end).
4. Two or three phrases the audience would search for, from the creator, not invented.
5. Any links the description should carry, from the creator.

## With the media tools

When the media backend is installed (the Media Pipeline line of `trent doctor` says so, and
names `trent sandbox build --media` or the binaries to install when it is not):

1. `media_probe` with `{"input": "videos/<file>.mp4"}` for the exact length; the last chapter
   and the description's length claim come from it, not from the owner's memory.
2. `media_transcribe` with `{"input": "videos/<file>.mp4", "language": "en"}` when there is no
   transcript with timestamps. It saves `media-out/<file>.transcript.json` with segments in
   seconds; chapters and cues are written from those segments.
3. To burn the cues into a Short: `media_clip` with
   `{"input": "videos/<file>.mp4", "start": <in>, "end": <out>, "crop": "face", "captions": true}`.
   The captions come from the saved transcript (`"transcript"` names another file); the MP4
   lands under `media-out/`. The SRT block in the output stays the source of truth for a
   platform upload, which the owner does.

Without a backend the owner supplies the transcript from their editor and the skill writes
the words only; say so in the file.

## Rules of the trade

Chapters (YouTube):
- The first chapter is `0:00`; at least three chapters; each at least ten seconds.
- Titles under 40 characters, a verb or a noun phrase that says what happens, never "Intro"
  and never a tease ("The secret").
- Chapter boundaries fall where the topic turns in the transcript, not at even intervals.

Description:
- The first 150 characters show before "more": they carry the promise, in a sentence a person
  would say.
- Then two or three short paragraphs: what is covered, who it is for, what to do next.
- Chapters block, links block (only links the creator gave), then hashtags (three to five).

Titles:
- Three options under 60 characters: one plain, one with a number, one with the tension. No
  capitals for emphasis, no exclamation marks, nothing the video does not deliver.

Short-form caption:
- A hook line (see `hook-lab`), the ask, three to five hashtags.

Subtitle cues:
- Sentence case; at most two lines of 32 characters; each cue on screen one to six seconds;
  cut at phrase boundaries; drop filler ("um", "like", "you know") unless it carries meaning;
  keep numbers as digits.

Pinned comment:
- One question or one resource, in the creator's voice.

## Output format

Write `captions/<slug>.md`:

```
# Words for: <working title>

Promise: <one sentence>

## Titles
1. <plain>
2. <with a number>
3. <with the tension>

## Description
<first 150 characters: the promise>

<paragraph>

<paragraph>

Chapters
0:00 <title>
<m:ss> <title>
...

<links block, if any>

<hashtags>

## Short-form caption
<hook line>
<ask>
<hashtags>

## Pinned comment
<one line>

## Subtitle cues (first 30 seconds, SRT)
1
00:00:00,000 --> 00:00:02,400
<line one>
<line two>

2
...
```

## Worked example

Input: a 6-minute YouTube video, transcript with timestamps, about fixing retention by cutting
the first two seconds of clips; promise: the viewer can find and fix their own first-second
drop today; search phrases: "youtube retention", "why people click away"; link: the creator's
free checklist at example.com/checklist.

```
# Words for: Cut the first two seconds

Promise: Find the two seconds that lose your viewers and cut them today.

## Titles
1. Why viewers leave in the first three seconds
2. The 2-second cut that fixed my retention
3. Your intro is losing viewers and it is not the algorithm

## Description
Most retention drops happen in the two seconds before your point. Here is how to find them
and cut them.

I show the retention graph of a real video, find the drop at second three, cut the dead air
before the point, and compare the graph after. It takes ten minutes in any editor.

For new creators who blame the algorithm. Try it on your last upload and reply with the
before and after.

Chapters
0:00 The graph that started this
0:42 Where the drop really is
1:55 Cutting the dead air
3:30 Before and after, side by side
4:50 The second drop nobody checks
5:35 Do this on your last upload

Free checklist: example.com/checklist

#youtuberetention #videoediting #contentcreator #youtubetips

## Short-form caption
Two seconds. That is what is killing your video.
Try it on your last upload and tell me what changed.
#youtuberetention #videoediting #shorts

## Pinned comment
What second do people leave your last video? Check the graph and tell me below.

## Subtitle cues (first 30 seconds, SRT)
1
00:00:00,000 --> 00:00:02,200
Two seconds.
That is what is killing your video.

2
00:00:02,400 --> 00:00:05,800
Not the algorithm,
not the thumbnail.

3
00:00:06,000 --> 00:00:09,500
The two seconds before
you get to the point.
```

## Approval

Nothing is uploaded or published; the owner pastes the words into the platform. The transcript
and a captioned cut are files under the workspace, made when the media backend is installed
and never sent anywhere; hosted transcription stays off unless the owner set it. Publishing
stays with the owner and the platform's own rules (a YouTube upload through the API is private
until the project is audited).
