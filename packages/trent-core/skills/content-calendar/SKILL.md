---
name: content-calendar
description: Plan four weeks of posts as a grid the owner can actually approve: pillars before posts, a cadence per platform, a status per slot, batching days and slack for the reactive post. Use when the owner asks what to post this month or the calendar is empty. A plan, not a publisher.
category: social
trust: official
version: 1.0.0
author: trent
tags: social, calendar, planning, pillars, cadence, instagram, linkedin, tiktok, x, bluesky
---
# Content Calendar

A calendar the owner cannot keep is worse than none: it becomes a wall of "missed". Plan to
the owner's real capacity, from pillars, with room for the thing that happens on Tuesday.

## When to use

- The start of a month or a campaign.
- The owner is posting at random and wants a rhythm.
- A launch, an event or a season needs a run-up.

## What you need before you write

1. Goals for the month, at most two ("book 30 consultations", "grow the newsletter").
2. Platforms and the honest cadence per platform the owner can sustain: posts per week they
   will approve, not aspire to.
3. Pillars: three to five recurring themes. If the owner has none, propose them from the
   business and ask.
4. Key dates: launches, holidays, local events, the owner's days off.
5. Assets in hand: photos, clips, testimonials, past posts that worked.
6. The voice file (`brand/voice.md`) if it exists.

## Rules of the trade

- Pillars before posts. Every slot belongs to a pillar; a post that fits no pillar is either a
  new pillar or not worth posting.
- The mix, unless the owner says otherwise: 40 percent useful (teach, answer, show how), 30
  percent proof (results, testimonials, before-and-after with consent), 20 percent behind the
  scenes (the team, the process, the place), 10 percent offers.
- Never schedule more than the approval capacity. Ten drafts a week the owner cannot read are
  zero posts.
- Leave one slot in five empty and labelled "reactive": the news, the customer story, the
  question that came in.
- Batch: name two creation days a week and put every draft on them. Posting days are separate.
- Every slot has a status: idea, draft, approved, posted. The calendar is the source of truth
  for status until the social toolset keeps it.
- Each platform gets its own row, not a copy: what goes on LinkedIn on Tuesday is not what goes
  on Instagram on Tuesday (see `crosspost-adapt`).
- Key dates get a run-up: three touches before a launch (tease, explain, open), one on the day,
  one after with the result.

## Output format

Write `calendar/<YYYY-MM>.md`:

```
# Content calendar: <month>

Goals: <one or two>
Pillars: <name: one line each>
Cadence: <platform: n per week>, creation days <days>, approval owner <name>

## Week 1 (<Mon date> to <Sun date>)
| Date | Platform | Pillar | Working title | Format | Asset needed | Status |
|------|----------|--------|---------------|--------|--------------|--------|
| <date> | <platform> | <pillar> | <title> | <post, carousel, short video, thread, story> | <have or need: what> | idea |
| <date> | reactive | - | (held open) | - | - | - |

## Week 2 ...
## Week 3 ...
## Week 4 ...

## Batching
<creation day>: <which slots get drafted>

## Needs from the owner
- <asset or fact needed, by when>
```

## Worked example

Input: Lark Day Spa; goal: 30 consultations booked in October; Instagram 3 per week, Facebook 2
per week; pillars proposed: Skin School (useful), Real Results (proof), Behind the Towel Warmer
(behind the scenes), Book This Week (offers); key date: Thursday late opening starts 2 October;
creation days Monday and Wednesday.

```
# Content calendar: October 2026

Goals: 30 consultations booked
Pillars: Skin School: one thing to know about skin, in a minute. Real Results: a client's
outcome, with consent. Behind the Towel Warmer: the team and the room. Book This Week: one
clear offer or opening.
Cadence: Instagram 3 per week, Facebook 2 per week; creation days Monday and Wednesday;
approval owner Priya

## Week 1 (28 Sep to 4 Oct)
| Date | Platform | Pillar | Working title | Format | Asset needed | Status |
|------|----------|--------|---------------|--------|--------------|--------|
| Tue 29 Sep | Instagram | Book This Week | Thursdays until 8 pm from 2 Oct | post | have: dusk room photo | draft |
| Tue 29 Sep | Facebook | Book This Week | Thursdays until 8 pm, which hour would you take | post | have: dusk room photo | draft |
| Thu 1 Oct | Instagram | Skin School | Why your skin is drier in October, in 3 lines | carousel | need: 3 plain slides | idea |
| Fri 2 Oct | Instagram | Behind the Towel Warmer | First late Thursday, the room at 7 pm | story or post | need: phone photo on the night | idea |
| Sat 3 Oct | Facebook | Real Results | Maya's five-week facial plan, her words | post | need: Maya's consent and quote | idea |
| Sun 4 Oct | reactive | - | (held open) | - | - | - |

## Week 2 (5 Oct to 11 Oct)
| Date | Platform | Pillar | Working title | Format | Asset needed | Status |
|------|----------|--------|---------------|--------|--------------|--------|
| Tue 6 Oct | Instagram | Skin School | The one ingredient to stop in the evening | post | need: product-free illustration | idea |
| Wed 7 Oct | Facebook | Behind the Towel Warmer | Meet Ana, our new therapist | post | need: Ana's photo and 3 questions | idea |
| Thu 8 Oct | Instagram | Book This Week | Two Thursday 7 pm slots left this week | post | have: room photo | idea |
| Sat 10 Oct | Instagram | Real Results | Before-and-after, hydration facial | post | need: client consent | idea |
| Sun 11 Oct | reactive | - | (held open) | - | - | - |

## Week 3 and Week 4
(same shape; the launch is over, so Book This Week drops to one slot a week and Skin School
takes two)

## Batching
Monday: Instagram Tue and Thu slots, Facebook Tue slot. Wednesday: weekend slots, next week's
first draft.

## Needs from the owner
- Maya's written consent and a two-line quote, by Wed 30 Sep
- Ana's photo and three questions answered, by Mon 5 Oct
```

## Approval

A calendar is a plan; nothing here publishes. Posting each slot is the owner's action until
the social toolset lands, and an approval per post after it.
