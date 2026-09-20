---
name: local-business-post
description: Write the post a neighbourhood actually reads for a spa, salon, shop or trade: one thing per post, a local hook, a real way to book, an image brief with alt text, and a version per platform (Instagram, Facebook, Google Business Profile). Use when the owner has an offer, an opening, a before-and-after or news. The owner posts.
category: small-business
trust: official
version: 1.0.0
author: trent
tags: social, local, instagram, facebook, google-business-profile, posts, spa, salon, contractors
---
# Local Business Post

Local social is not brand marketing. The reader is three streets away, half-decided, and wants
to know two things: is this for me this week, and how do I book. Every post answers both.

## When to use

- An offer, a new service, a new hire, changed hours, a seasonal reminder (gutters before the
  rain, colour before the wedding season, boiler service before October).
- A finished job with a before-and-after the customer agreed to share.
- A slow week that needs filling.

## What you need before you write

1. The business: name, neighbourhood, how to book (the exact link, number or "walk in").
2. The one thing this post is about, in a sentence.
3. Photos on hand, described (or "none", which means an image brief for a phone photo).
4. Platforms: Instagram, Facebook, Google Business Profile, or all three.
5. Voice: the owner's notes or `brand/voice.md`; any words the owner never uses.
6. For a before-and-after: that the customer agreed, in writing, to the photo being posted.

## Rules of the trade

- One post, one thing. An offer and a new hire are two posts.
- The first line names the place or the season: "Two chairs open Saturday on Elm Street"
  beats "Exciting news!".
- One call to action, with the real mechanism: the link, the number, "reply BOOK", or the
  address and hours. A post without a way to book is a diary entry.
- No fake urgency, no invented scarcity, no "limited time" unless the end date is in the post.
- Prices only if the owner gave them and they are complete (with tax if that is how the owner
  prices).
- Hashtags: three to five, local and specific (`#elmstreet`, the town, the trade), at the end
  on Instagram, none on Google Business Profile, at most two on Facebook.
- Alt text for every image: what is in the photo, in one plain sentence. Say "AI-generated
  image" in the alt text and the caption if one is used; a real phone photo beats it anyway.
- Before-and-after: the customer's consent noted, no face unless they said yes to that too, no
  address, no clinical language.
- Google Business Profile posts: 150 to 300 characters, a button type (Book, Call, Learn more),
  the plain facts; they are read from search results by people about to phone.

## Output format

Write `posts/<YYYY-MM-DD>-<slug>.md`:

```
# Post: <the one thing>

Best time: <day and hour, from what the owner knows about their customers, or the default:
weekday 11:30 to 13:00 or 18:00 to 20:00 local>

## Image
Photo: <what to shoot or which existing photo, one sentence>
Alt text: <one plain sentence>
Consent: <not needed, or "customer agreed on <date> by <how>">

## Instagram
<caption: hook line, blank line, two to four short lines, blank line, CTA line, blank line,
3 to 5 hashtags>

## Facebook
<same idea, may be a little longer, a question or an invitation at the end, up to 2 hashtags>

## Google Business Profile
<150 to 300 characters, plain facts, button: Book | Call | Learn more, link>
```

Then `Before posting:` with anything to confirm (a price, a date, a consent) or `nothing`.

## Worked example

Input: Lark Day Spa on Elm Street; new Thursday late opening until 8 pm from 2026-10-02;
booking at larkdayspa.example/book; a photo exists of the treatment room lit warm at dusk;
voice: warm, plain, no exclamation marks.

```
# Post: Thursday evenings, open until 8 pm from 2 October

Best time: Tuesday 30 September, 18:30

## Image
Photo: the existing dusk photo of the treatment room, lamp on, towels folded
Alt text: A warmly lit spa treatment room at dusk with folded white towels on the bed.
Consent: not needed

## Instagram
Elm Street, we are open late on Thursdays from 2 October.

Facials, massage and the quiet room until 8 pm, for the people who cannot get here before
six. Same team, same prices, more daylight left when you come out.

Book at larkdayspa.example/book, link in bio.

#elmstreet #larkdayspa #thursdaylate #localspa #selfcareafterwork

## Facebook
From Thursday 2 October, Lark Day Spa on Elm Street stays open until 8 pm. If your week never
leaves room for a facial or a massage before six, this is the evening for it. Same team, same
prices. Book at larkdayspa.example/book. Which time would you take, six or seven?

#elmstreet #larkdayspa

## Google Business Profile
Open late on Thursdays from 2 October: facials, massage and the quiet room until 8 pm. Same
team, same prices. Button: Book, larkdayspa.example/book
```

Before posting: nothing.

## Approval

This skill writes captions and an image brief into a file. It posts nothing. The owner posts
from their own accounts. When the social toolset lands, publishing will go through the owner's
approval per post, and the tool will say what each platform requires (an Instagram post needs
a hosted image; a Facebook Page needs the app permissions).
