---
name: local-business-post
description: The post a neighbourhood actually reads for a spa, salon, shop or trade: one thing, a local hook, a real way to book, alt text, and a version per platform. Publishes or queues each version with social_post or social_schedule where the social toolset reaches (Bluesky, and Facebook, X, LinkedIn or Threads through Buffer, text only; Instagram and Facebook directly when connected), each only after the owner approves that exact call. Use when the owner has an offer, an opening, a before-and-after or news.
category: small-business
trust: official
version: 2.0.0
author: trent
tags: social, local, posts, bluesky, buffer, facebook, instagram, google-business-profile, spa, salon, contractors
---
# Local Business Post

The Sign in the Window writes for the reader three streets away, half-decided, who wants two
answers: is this for me this week, and how do I book. Every post answers both.

Who runs it: `content`, the one seat in this pack with the social toolset. Prices and offers
come from `sales`; a before-and-after needs the consent `support` recorded.

## What you need
The one thing this post is about, the exact way to book (link, number or "walk in"), photos on
hand, the platforms, the voice file (`brand/voice.md`), and for a before-and-after the customer's
written consent to the photo.

## Steps
1. See what this install reaches: `social_platforms_list {}`. It names each platform's route
   (direct, Bluesky, or Buffer), what is connected and the limits the owner must hear.
2. Write the file (Output format): one version per platform, rewritten, not pasted.
3. Publish now, or queue for the best time; one call per platform, text only:
   `social_post {"platform": "bluesky", "text": "Elm Street: from Thu 1 Oct we're open until 8 pm on Thursdays. Facials, massage and the quiet room for people who can't get here before six. Book at larkdayspa.example/book"}`
   `social_schedule {"platform": "facebook", "text": "From Thursday 1 October, Lark Day Spa on Elm Street stays open until 8 pm. Same team, same prices, more evening left when you come out. Book at larkdayspa.example/book. Six or seven, which would you take?", "at": "2026-09-29T16:30:00Z"}`
4. Each post goes out only after the owner approves that exact call: the card shows the platform,
   the text and the time. A yes covers that one post; an edit is a new approval. A queued post
   publishes once when `trent cron start` (or `trent cron run <id>`) ticks past its time; `trent
   cron remove <id>` withdraws it. A Facebook Page goes through Buffer until Meta is connected.
5. Photos: the Bluesky path attaches no image and Buffer refuses a media URL, so a post with a
   photo is posted by the owner from the phone, or for Instagram sent directly
   when connected (`trent connect meta`, its App Review, a publicly hosted image). Say which.
6. Google Business Profile: no tool posts there yet; the owner pastes the version below.
7. A week on, the numbers: `social_insights_read {"platform": "bluesky", "post_id": "at://did:plc:larkspa/app.bsky.feed.post/3kx2late"}`.

## Output format
`posts/<YYYY-MM-DD>-<slug>.md`:
```
# Post: <the one thing>
Best time: <day and hour; default weekday 11:30 to 13:00 or 18:00 to 20:00 local>
## Image         Photo: <what to shoot>  Alt text: <one sentence>  Consent: <not needed, or date and how>
## Bluesky       <300 graphemes at most>
## Facebook      <a little longer, a question at the end, at most two hashtags>
## Instagram     <hook, short lines, the ask, three to five hashtags; needs the photo>
## Google Business Profile   <150 to 300 characters, a button: Book, Call or Learn more>
Status: <per platform: posted <id> | queued <job> | owner posts | not posted: why>
```
Then `Before posting:` with anything the owner must confirm, or `nothing`.

## Rules of the trade
- One post, one thing. The first line names the place or the season, never "Exciting news!".
- One call to action with the real mechanism. No fake urgency, no invented scarcity.
- Prices only if the owner gave them. Alt text on every image; say "AI-generated image" if one is.
