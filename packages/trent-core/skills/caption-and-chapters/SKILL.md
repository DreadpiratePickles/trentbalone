---
name: caption-and-chapters
description: From a transcript with timestamps, write the YouTube chapters, the description whose first 150 characters carry the promise, three titles, the short-form caption, a pinned comment and subtitle cues cut to two lines. Use when a video is edited and needs its words. Needs a transcript; does not transcribe.
category: creator
trust: official
version: 1.0.0
author: trent
tags: creator, captions, chapters, youtube, subtitles, srt, descriptions, titles
---
# Caption and Chapters

The words around a video are read by two audiences: the viewer deciding whether to click, and
the search engine deciding whether to show it. Write for the viewer; the engine follows.

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

This skill does not transcribe. When the media toolset lands, transcription with word
timestamps will feed it; until then the owner supplies the transcript from their editor.

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

Text only. Nothing is uploaded or published; the owner pastes the words into the platform.
When the media toolset lands, the SRT can be burned into a cut; publishing stays with the
owner and the platform's own rules (a YouTube upload through the API is private until the
project is audited).
