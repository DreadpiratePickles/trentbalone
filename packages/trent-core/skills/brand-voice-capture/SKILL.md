---
name: brand-voice-capture
description: Turn samples of how the owner already writes and talks into a voice file every draft is checked against: three words and three nevers, do-and-don't pairs in their own sentences, vocabulary, punctuation habits and off-limits topics. Use before the first batch of posts or whenever drafts "don't sound like me".
category: social
trust: official
version: 1.0.0
author: trent
tags: brand, voice, tone, style-guide, copywriting, social
---
# Brand Voice Capture

Every draft that "doesn't sound like me" is a voice file that was never written. Capture the
owner's voice from things they actually wrote, describe it in rules a writer can apply, and get
the owner to confirm it once, so every seat writes the same person.

## When to use

- Before the first content calendar or the first batch of posts.
- The owner rejected drafts as "too corporate", "too salesy", "not me".
- A new writer (a seat or a person) joins.

## What you need before you write

1. Five to ten samples the owner wrote themselves: posts, replies to customers, an email, the
   "about" page, a text to a regular. More is better; a website an agency wrote is not a sample.
2. Two or three samples the owner likes from other businesses, and two they dislike.
3. Words and phrases the owner hates, and words they use that a stranger would not.
4. Topics that are off-limits (politics, a competitor by name, a client's health).
5. Emoji, exclamation marks, capital letters: what the samples actually show.

## Rules of the trade

- Describe the voice from evidence: every rule quotes a sample. "Warm" means nothing; "opens
  with the customer's name and one thing about them" is a rule.
- Three words and three nevers. If it takes ten, it is not a voice yet.
- Do and don't pairs in the owner's own sentences, not invented ones.
- Punctuation is voice: sentence length, exclamation marks, whether they use "we" or "I",
  whether they sign off, emoji or none.
- Vocabulary in two lists: words they use (keep), words they never use (avoid).
- Greeting and sign-off, verbatim, per channel.
- Off-limits topics as a list, no argument.
- A five-question confirmation at the end, each a pair of sentences: "Which is more you?"
  The owner's answers settle any rule the samples left ambiguous.

## Output format

Write `brand/voice.md`:

```
# Voice: <business name>

Status: draft until the owner confirms (see the five questions below)
Samples read: <n>, from <where>

## In three words
<word>: <the sample line that proves it>
<word>: <sample>
<word>: <sample>

## Never
- <never>: <the disliked sample or the owner's own words>
- ...

## How it sounds
Person: <"I" or "we", and when>
Sentences: <short or long; example>
Punctuation: <exclamation marks: never, rarely, often; emoji: none or which; capitals>
Greeting: <verbatim, per channel>
Sign-off: <verbatim>

## Do / don't
- Do: "<owner's sentence>"  Don't: "<the same idea the wrong way>"
- ...

## Words
Keep: <list>
Avoid: <list>

## Off limits
- <topic>

## Confirm with the owner
1. Which is more you: "<A>" or "<B>"?
2. ...
5. ...
```

Then one line to the owner: where the file is and that every draft from now on is checked
against it once they confirm.

## Worked example

Input: Priya, Lark Day Spa; samples: eight Instagram captions, six customer texts, the About
page she wrote. She dislikes "pamper yourself", "treat yourself", "glow up". No emoji in any
sample. Two exclamation marks in twenty posts. Signs texts "Priya". Uses "I" in texts, "we" in
posts.

```
# Voice: Lark Day Spa

Status: draft until the owner confirms
Samples read: 15, from Instagram captions, customer texts, the About page

## In three words
Plain: "Facials, massage and the quiet room until 8 pm."
Specific: "Your shoulder will feel it by Wednesday, that is the point of the hot stones."
Unhurried: "No rush, reply whenever suits and I will send times."

## Never
- Spa-brochure verbs: "pamper", "indulge", "treat yourself" (the owner named all three)
- Exclamation stacks: two in twenty posts, both single
- Claims about skin the treatment cannot back: "glow up", "erase", "reverse"

## How it sounds
Person: "we" in posts about the place, "I" in messages to a person
Sentences: short; the longest sample is 22 words
Punctuation: exclamation marks rarely, one at most; emoji none; no capitals for emphasis
Greeting: texts "Hi <name>, this is Priya at Lark"; posts open with the place or the season
Sign-off: texts "Priya"; posts none

## Do / don't
- Do: "It has been five weeks since your facial and your skin will thank you for the next one."
  Don't: "Time to treat yourself to some well-deserved me-time!"
- Do: "Same team, same prices, more daylight left when you come out."
  Don't: "Experience luxury like never before with our extended hours."

## Words
Keep: quiet room, the room, therapist, your skin, book, reply, Thursday
Avoid: pamper, indulge, treat yourself, glow up, luxury, experience (as a noun), journey

## Off limits
- A client's treatment, condition or appointment in public
- Other spas by name

## Confirm with the owner
1. Which is more you: "We are open late on Thursdays" or "Thursday nights just got better"?
2. Which is more you: "Book at larkdayspa.example/book" or "Grab your spot now"?
3. Which is more you: "Ana joined us this month" or "Say hello to Ana!"?
4. Which is more you: "Your skin is drier in October, here is why" or "October skin SOS"?
5. Which is more you: signing posts "Priya" or leaving them unsigned?
```

## Approval

A voice file is internal; nothing here is sent or posted. The owner confirms it by answering
the five questions; until then every draft carries "voice: unconfirmed" in its "Before
sending" line.
