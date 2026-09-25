---
name: content-calendar
description: Plan four weeks of posts as a grid the owner can actually approve: pillars before posts, a cadence per platform the social toolset reaches (social_platforms_list), last month's numbers (social_insights_read), slack for the reactive post, and each approved slot queued with social_schedule only after the owner approves that exact post. Use when the owner asks what to post this month or the calendar is empty.
category: social
trust: official
version: 2.0.0
author: trent
tags: social, calendar, planning, pillars, cadence, bluesky, buffer, linkedin, x, threads
---
# Content Calendar

The Planner thinks in four-week grids and pillars, never in single posts, and never schedules
past what the owner has time to review. A calendar the owner cannot keep becomes a wall of
"missed"; plan to real capacity, with room for the thing that happens on Tuesday.

Who runs it: `growth` pulls the numbers and picks the bets; `content` writes the slots and makes
the queue calls; both seats carry the social toolset. `analyst` reads the month's results.

## What you need
At most two goals for the month, the posts per week per platform the owner will really approve,
three to five pillars (propose them and ask if there are none), key dates and days off, assets in
hand, and the voice file (`brand/voice.md`).

## Steps
1. Where posts can go: `social_platforms_list {}`. Plan only for platforms with a live route:
   Bluesky directly, and X, LinkedIn, Threads or a Facebook Page through Buffer (text only).
   Instagram, TikTok and YouTube go on the grid as "owner posts"; they join the queue
   when connected and their reviews pass. Say so in the header.
2. What worked last month, per post the owner names:
   `social_insights_read {"platform": "bluesky", "post_id": "at://did:plc:larkspa/app.bsky.feed.post/3kwq9faq"}`.
   Numbers pick the next bets; they never set the goal.
3. Write the grid (Output format). Mix unless the owner says otherwise: 40 percent useful,
   30 percent proof, 20 percent behind the scenes, 10 percent offers. One slot in five is held
   open as "reactive". Name two creation days; posting days are separate.
4. When the owner marks a slot approved and its text is final, queue it, one call per slot:
   `social_schedule {"platform": "linkedin", "text": "Three things we changed when evenings got busy: one desk, one waiting list, one text the day before. What would you add?", "at": "2026-10-06T13:00:00Z"}`
   Each queued post waits for the owner's approval of that exact platform, text and time; the
   yes covers that post only. It publishes once when `trent cron start` ticks past `at`
   (`trent cron run <id>` runs it now; `trent cron remove <id>` withdraws it). Nothing is
   queued for a slot still at idea or draft.
5. No account connected (`trent connect bluesky` or `trent connect buffer`): the grid is the plan
   and the owner posts each slot.

## Output format
`calendar/<YYYY-MM>.md`:
```
# Content calendar: <month>
Goals: <one or two>   Pillars: <name: one line each>
Cadence: <platform: n per week, route>   Creation days: <days>   Approver: <name>
Owner posts by hand: <platforms with no live route, and why>
## Week 1 (<Mon date> to <Sun date>)
| Date | Platform | Pillar | Working title | Format | Asset needed | Status |
| <date> | <platform> | <pillar> | <title> | <post, thread, carousel, short> | <have or need> | idea, draft, approved, queued <job>, posted |
| <date> | reactive | - | (held open) | - | - | - |
## Week 2 / Week 3 / Week 4
## Batching      <creation day: which slots get drafted>
## Needs from the owner   <consents, photos, answers, with dates>
```

## Rules of the trade
- Pillars before posts; a post that fits no pillar is a new pillar or not worth posting.
- Each platform gets its own row, not a copy (see `crosspost-adapt`).
- Key dates get a run-up: tease, explain, open, the day, the result.
