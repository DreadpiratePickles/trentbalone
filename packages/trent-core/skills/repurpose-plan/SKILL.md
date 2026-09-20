---
name: repurpose-plan
description: From one long-form transcript, name five to eight clip candidates with in and out timestamps, a hook and a platform each, plus the text derivatives (a thread, a LinkedIn post, a newsletter section) and a publishing order. Use when a long video or a podcast episode is done. Names the cuts; does not make them.
category: creator
trust: official
version: 1.0.0
author: trent
tags: creator, repurposing, clips, shorts, podcast, long-form, thread, newsletter
---
# Repurpose Plan

One hour of talking holds five to eight clips and three written pieces. The plan finds them,
names the exact seconds, and says what goes out first. It does not cut: until the media
toolset lands, the owner cuts in their editor from the timestamps here.

## When to use

- A long video, a podcast episode or a webinar recording is finished and transcribed.
- The owner wants a week of posts from one recording.

## What you need before you write

1. The transcript with timestamps (from the owner's editor or transcription tool).
2. The platforms in play and their cadence (from the calendar if one exists).
3. Which moments the creator already liked, if any.
4. The voice file and the hook rules (`brand/voice.md`, `hook-lab`).

## What makes a clip

- A complete idea in 20 to 60 seconds: setup, point, landing. No dependence on what came
  before ("as I said earlier" disqualifies it).
- A hookable first line, or one that can be shot as a cold open (see `hook-lab`).
- A change of energy: a laugh, a disagreement, a number, a demonstration.
- A visual moment if the recording has one (a screen, an object, a face reacting).
- Not: the intro, the sponsor read, the "let me know in the comments", anything that needs
  the guest's name to make sense unless the name is in the clip.

## Rules of the trade

- Timestamps to the second, in and out, from the transcript. If the out point lands
  mid-sentence, say which words end it.
- One platform per clip as the primary; a secondary only if the aspect and length fit.
- Aspect: 9:16 for Shorts, Reels and TikTok; note what the frame should hold (a face, a
  screen) so the reframe is obvious.
- On-screen text per clip: six words or fewer.
- Text derivatives come from the same transcript, in the creator's words: an X thread (five to
  eight posts, the first stands alone), a LinkedIn post (the story, not the summary), a
  newsletter section (300 words, one link).
- Publishing order: the strongest clip first on the platform where the creator has the most
  audience; never two clips from the same recording on the same platform on the same day; keep
  one clip back for the slow week.
- Say what needs the media toolset (cutting, reframing, burned captions) and what is ready
  now (the words).

## Output format

Write `repurpose/<slug>.md`:

```
# Repurpose: <recording title>, <length>

Source: <file or link the owner named>, transcript <file>

## Clips
| # | In | Out | Working title | Hook (spoken) | On-screen text | Primary | Secondary | Frame |
|---|----|-----|---------------|---------------|----------------|---------|-----------|-------|
| 1 | <m:ss> | <m:ss> | ... | ... | ... | Shorts | Reels | face, tight |

## Text derivatives
### X thread
1. <post>
2. ...

### LinkedIn post
<post>

### Newsletter section
<300 words>

## Order
| Day | Piece | Platform | Note |
|-----|-------|----------|------|
| 1 | clip 1 | ... | ... |

## Needs the media toolset
- <cutting, reframing, captions burned in: which clips>

## Ready now
- <the text pieces>
```

## Worked example

Input: a 42-minute podcast episode with a guest who runs a spa, transcript with timestamps;
platforms: Shorts (primary audience), Instagram, LinkedIn, newsletter.

```
# Repurpose: Running a spa on Elm Street, 42:10

Source: episode-14.mp4, transcript episode-14.txt

## Clips
| # | In | Out | Working title | Hook (spoken) | On-screen text | Primary | Secondary | Frame |
|---|----|-----|---------------|---------------|----------------|---------|-----------|-------|
| 1 | 6:12 | 6:51 | The no-show note | "I never charge the first no-show. Here is what I send instead." | First no-show: no fee | Shorts | Reels | guest, tight |
| 2 | 11:40 | 12:18 | Thursday nights | "Bookings before six dried up, so we moved the evening." | We moved the evening | Reels | Shorts | guest, medium |
| 3 | 19:05 | 19:58 | Reviews are for the next hundred | "A reply to a review is not for the reviewer." | It is for the next 100 | Shorts | LinkedIn video | guest and host |
| 4 | 24:30 | 25:02 | The voucher question | "Every October somebody asks for a voucher for two." | Vouchers for two | Reels | - | guest, tight |
| 5 | 31:15 | 31:59 | Quiet room economics | "The quiet room makes no money and pays for itself." | It pays for itself | Shorts | Reels | guest, medium |
| 6 | 37:48 | 38:20 | Hire for the desk | "I hire the front desk before the third therapist." | Desk before therapist | LinkedIn video | Shorts | guest, tight |

## Text derivatives
### X thread
1. A spa owner told me she never charges the first no-show. Her reason changed how I think
   about policies.
2. The note she sends instead: "We missed you at 10 and hope all is well. I can do Tuesday at
   10 or Thursday at 4."
3. Two offers, no scolding, the policy mentioned once as a fact.
4. Most of them rebook. The fee would have made them ghosts.
5. The second no-show is a different conversation, and she has it in private.
6. Full episode: <link>

### LinkedIn post
Six years ago Priya opened a spa on Elm Street with two rooms and one rule about no-shows
that most owners would call soft: the first one is free. ... (the story of the note, the
rebook rate she quoted at 11:52, and the one line about hiring the desk before the third
therapist; ends with the episode link in the first comment)

### Newsletter section
(300 words: the three decisions from the episode, no-shows, Thursday nights, the quiet room,
with the timestamps for each, one link to the episode)

## Order
| Day | Piece | Platform | Note |
|-----|-------|----------|------|
| 1 | clip 1 | Shorts | strongest, largest audience |
| 2 | X thread | X | the same idea, text |
| 3 | clip 2 | Reels | |
| 4 | LinkedIn post | LinkedIn | |
| 5 | clip 3 | Shorts | |
| 7 | newsletter | email | |
| 9 | clip 5 | Shorts | |
| held | clip 4, clip 6 | - | the slow week |

## Needs the media toolset
- Cutting and 9:16 reframing for clips 1 to 6; captions burned in from the transcript

## Ready now
- The thread, the LinkedIn post, the newsletter section
```

## Approval

A plan, in a file. Nothing is cut, uploaded or posted. The owner cuts from the timestamps in
their editor until the media toolset lands, and posts each piece; publishing keeps the owner's
approval per piece after it.
