---
name: crosspost-adapt
description: Take one post and rewrite it for each platform it is going to, within that platform's limits and habits, instead of pasting the same text five times. Use when a post is approved for one platform and the owner wants it on others. The owner posts.
category: social
trust: official
version: 1.0.0
author: trent
tags: social, crosspost, instagram, linkedin, x, threads, bluesky, facebook, tiktok, youtube
---
# Crosspost Adapt

The same text on five platforms reads as an ad on four of them. One idea, five rewrites: each
in the length, shape and manners of the place it is going, with one link and one ask apiece.

## When to use

- A post is approved for its first platform and the owner wants it everywhere.
- A newsletter section, a blog post or a video description needs social versions.

## What you need before you write

1. The source post: text, any link, the image or clip it goes with (described).
2. The target platforms.
3. The voice file (`brand/voice.md`) if it exists; otherwise the owner's notes.
4. What the post is for (booking, reading, replying, watching), so each version can ask for
   the platform's version of it.

## Platform rules

Read `references/platform-limits.md` for the numbers. The short form:

- X: 280 characters, hook in the first line, no hashtag inside a sentence, a thread for anything
  longer than two ideas (first post stands alone), one link at the end or in a reply.
- LinkedIn: the first two lines show before "see more", so they carry the point; no external
  link in the body (put it in the first comment and say so); up to three hashtags at the end;
  paragraphs of one or two lines.
- Instagram: a hook line, a blank line, short lines, the ask, then up to five hashtags at the
  end; no clickable links in captions, so "link in bio" or a booking phrase; alt text required.
- Threads: 500 characters, conversational, a question works, at most one hashtag-style topic.
- Bluesky: 300 characters, no algorithmic feed to game, written to be replied to; links show as
  cards.
- Facebook: longer is fine, a question or invitation at the end, at most two hashtags, the
  link inline.
- TikTok caption: short, three to five hashtags, and a line of on-screen text for the video.
- YouTube Shorts: a title under 60 characters and a two-line description; hashtags in the
  description.

## Rules of the trade

- One link per version, and the platform's own way of carrying it.
- One ask per version, in the platform's idiom: "reply", "save this", "link in bio", "book".
- Never the identical first line on two platforms; the hook is rewritten each time.
- Keep the facts identical: a price, a date or a claim never changes between versions.
- Say what changed and why in one line per version, so the owner learns the platform's
  manners instead of trusting the tool.

## Output format

Write `posts/<YYYY-MM-DD>-<slug>-crosspost.md`:

```
# Crosspost: <the one thing>

Source: <platform the approved post came from>
Facts that must not change: <list>

## <Platform>
<the version, exactly as it should be posted>
Changed: <one line: what and why>
Ask: <the one call to action>
Link: <where it goes: body, first comment, bio, none>

## <Next platform> ...
```

Then `Before posting:` with anything to confirm, or `nothing`.

## Worked example

Input: the approved Instagram post "Thursdays until 8 pm from 2 October" (see the
`local-business-post` example), targets: Facebook, LinkedIn (the owner's personal profile),
Threads, Bluesky.

```
# Crosspost: Thursday evenings, open until 8 pm from 2 October

Source: Instagram
Facts that must not change: Thursday; until 8 pm; from 2 October; same prices;
larkdayspa.example/book

## Facebook
From Thursday 2 October, Lark Day Spa on Elm Street stays open until 8 pm. If your week never
leaves room for a facial or a massage before six, this is the evening for it. Same team, same
prices. Book at larkdayspa.example/book. Which time would you take, six or seven?
Changed: longer, link inline, ends with a question because Facebook rewards replies.
Ask: answer the question, or book
Link: body

## LinkedIn
I have run Lark Day Spa for six years and every October the same thing happens: bookings
before six dry up because nobody's week has room.

So from 2 October we are open until 8 pm on Thursdays. Same team, same prices.

If you are the person whose calendar never has a gap before six, this evening is for you.
Booking link in the first comment.

#smallbusiness #elmstreet #localbusiness
Changed: first person, the reason before the news, link moved to the comment, three hashtags.
Ask: book through the comment link
Link: first comment

## Threads
Thursdays until 8 pm at Lark Day Spa from 2 October. Same team, same prices. For the people
who cannot get here before six: which hour would you take, six or seven?
Changed: cut to 500 characters, conversational, one question.
Ask: reply with an hour
Link: none

## Bluesky
Lark Day Spa on Elm Street is open until 8 pm on Thursdays from 2 October. Same team, same
prices, more daylight when you come out. larkdayspa.example/book
Changed: under 300 characters, the link as a card, no hashtags.
Ask: book
Link: body (card)
```

Before posting: nothing.

## Approval

This skill writes versions into a file. It posts nothing. The owner posts each version; when
the social toolset lands, each version goes out only with the owner's approval, and the tool
will name what a platform needs first (a hosted image for Instagram, an audited app for a
public TikTok post).
