---
name: brand-voice-capture
description: Turn samples of how the owner already writes and talks into a voice file every draft is checked against: three words and three nevers, do-and-don't pairs in their own sentences, vocabulary, punctuation and off-limits topics, with the owner's own published posts weighed by what people answered (social_insights_read). Use before the first batch of posts or whenever drafts "don't sound like me".
category: social
trust: official
version: 2.0.0
author: trent
tags: brand, voice, tone, style-guide, copywriting, social, bluesky
---
# Brand Voice Capture

The Voice captures how the owner already talks and keeps everyone in it. Every draft that
"doesn't sound like me" is a voice file that was never written: describe the owner's voice from
things they actually wrote, in rules a writer can apply, and have the owner confirm it once.

Who runs it: `content`, which carries the social toolset for the reads below. Every seat that
writes for the owner, `growth` included, then checks its drafts against the file.

## What you need
Five to ten samples the owner wrote (posts, replies, an email, a text to a regular; an agency's
website copy is not a sample), two samples they like from others and two they dislike, words they
hate and words only they use, off-limits topics, and what the samples show about emoji,
exclamation marks and capitals.

## Steps
1. For each published post the owner offers as a sample, read what it earned:
   `social_insights_read {"platform": "bluesky", "post_id": "at://did:plc:larkspa/app.bsky.feed.post/3kwthursday"}`.
   Replies and quotes say a voice landed; likes alone say little. This is a read and asks nothing.
   Other platforms' numbers are read the same way when connected; until then the owner's
   screenshots of them are samples like any other.
2. Describe the voice from evidence: every rule quotes a sample. "Warm" means nothing; "opens
   with the customer's name and one thing about them" is a rule. Lean on the samples people
   answered.
3. Write `brand/voice.md` (Output format) and end with five "which is more you?" pairs. The
   owner's answers settle what the samples left open.
4. Nothing here posts or sends. Until the owner confirms, every draft any seat writes carries
   "voice: unconfirmed" in its before-posting line.

## Output format
`brand/voice.md`:
```
# Voice: <business name>
Status: draft until the owner answers the five questions   Samples read: <n>, from <where>
## In three words      <word>: <the sample line that proves it>  (three times)
## Never               <never>: <why, from a sample or the owner>  (three times)
## Do and don't        | Do (owner's sentence) | Don't (the version to avoid) |
## Vocabulary          Keep: <words>   Avoid: <words>
## Punctuation and form  <sentence length, "we" or "I", emoji, exclamation marks, sign-off>
## Greeting and sign-off  <per channel, verbatim>
## Off-limits          <topics, as a list>
## What people answered  <the two or three samples with the most replies, and what they share>
## Five questions      1. Which is more you: "<a>" or "<b>"?  (five pairs)
```

## Rules of the trade
- Three words and three nevers. If it takes ten, it is not a voice yet.
- Do and don't pairs in the owner's own sentences, never invented ones.
- Punctuation is voice; so is whether they sign off. Off-limits topics are a list, no argument.
