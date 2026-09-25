---
name: crosspost-adapt
description: Take one approved post and rewrite it for each platform it is going to, within that platform's limits and habits, instead of pasting the same text five times; then publish or queue each version with social_post or social_schedule where the social toolset reaches (Bluesky directly, with up to four images or one clip from the workspace; X, LinkedIn, Threads or a Facebook Page through Buffer, with media only from a hosted URL; Instagram, TikTok and YouTube when connected), each only after the owner approves that exact version.
category: social
trust: official
version: 2.1.0
author: trent
tags: social, crosspost, bluesky, buffer, linkedin, x, threads, facebook, instagram, tiktok, youtube
---
# Crosspost Adapt

The Maker turns one idea into the post itself, three variants before one; the Voice keeps each
version in the owner's words. The same text on five platforms reads as an ad on four of them:
one idea, rewritten in the length, shape and manners of each place, one link and one ask apiece.

Who runs it: `content` writes the versions and makes the calls; `growth` says what each version
is for. Both seats carry the social toolset.

## What you need
The source post (text, link, the image or clip it goes with), the target platforms, the voice
file (`brand/voice.md`), and what the post is for: booking, reading, replying, watching.

## Steps
1. What each platform can take here: `social_platforms_list {}` (route, connection, limits).
   The numbers and manners per platform are in `references/platform-limits.md`.
2. Write every version into the file (Output format), then say in one line per version what
   changed and why, so the owner learns the platform instead of trusting the tool.
3. After the owner approves the versions, one call each:
   `social_post {"platform": "bluesky", "text": "We moved the evening. Thursdays at Lark now run to 8 pm, for everyone who can't get here before six. What would you book first?"}`
   `social_schedule {"platform": "x", "text": "Thursdays at Lark Day Spa now run to 8 pm. Same team, same prices, more evening left. Book: larkdayspa.example/book", "at": "2026-10-01T16:00:00Z"}`
   `social_schedule {"platform": "linkedin", "text": "Our quietest hour was 4 pm; our longest waiting list was after six. So from 1 October, Thursdays run to 8 pm. The link to book is in the first comment.", "at": "2026-10-01T13:30:00Z"}`
4. Each version goes out only after the owner approves that exact platform, text and time; a
   changed word is a new approval. Buffer publishes at the channel's next slot and says so. A
   queued version publishes once while `trent cron start` runs.
5. Versions with media. Bluesky uploads the files from the workspace: up to four images of at
   most 2,000,000 bytes each, or one MP4 clip, each with alt text (the call is refused without
   it). The approval card names each file, its size and its alt text; a file changed after the
   yes is not sent.
   `social_post {"platform": "bluesky", "text": "Thursdays at Lark now run to 8 pm.", "media": [{"path": "photos/lark-evening.jpg", "alt": "The Lark Day Spa front desk at dusk, lamps on"}]}`
   Buffer has no upload endpoint: it fetches media from a public URL when the post goes out, so
   an X, LinkedIn, Threads or Facebook version carries media only when the owner has hosted the
   file at a stable https link (pass it as media_url). Instagram goes direct only when connected
   (Meta, its App Review, a hosted image); TikTok and YouTube have no public publish path here.
   Anything else with media: mark it "owner posts" in the file and say why.

## Output format
`posts/<YYYY-MM-DD>-<slug>-crosspost.md`:
```
# Crosspost: <the one thing>
Source: <platform the approved post came from>   Facts that must not change: <price, date, claim>
## <Platform>
<the version, exactly as it should go out>
Changed: <what and why, one line>   Ask: <the one call to action>
Status: <posted <id> | queued <job> | owner posts | not posted: why>
```
Then `Before posting:` with anything to confirm, or `nothing`.

## Rules of the trade
- One link and one ask per version, in the platform's own way ("link in bio", "reply", "book").
- Never the identical first line on two platforms. Facts never change between versions.
- Bluesky 300 graphemes, X 280 characters, Threads 500; LinkedIn's first two lines carry the point.
