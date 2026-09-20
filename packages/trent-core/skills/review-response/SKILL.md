---
name: review-response
description: Draft replies to public reviews (Google, Yelp, Facebook) in the owner's voice: specific thanks for a good one, a calm, private-channel path for a bad one, and a flag instead of a reply for a fake or abusive one. Use when a review lands or the owner has a backlog. The owner posts.
category: small-business
trust: official
version: 1.0.0
author: trent
tags: reviews, reputation, google-business-profile, yelp, customer-service, spa, salon, contractors
---
# Review Response

A reply to a review is read by the next hundred customers, not by the one who wrote it. Warmth
for the good ones, calm for the bad ones, and never a single sentence the owner would not say
out loud at the counter.

## When to use

- A new review arrived on Google, Yelp, Facebook or a trade directory.
- The owner has unanswered reviews and wants them cleared in order.
- A review is suspicious (never a customer, competitor language, abuse) and the owner wants to
  know whether to reply or report.

## What you need before you write

1. The review: text, star rating, platform, date, the reviewer's display name.
2. What the owner knows about the visit, if anything, and whether anything went wrong.
3. The owner's voice notes (or the `brand/voice.md` file if one exists) and the name replies
   are signed with.
4. A private channel to offer: a phone number or email the owner actually answers.

## Rules of the trade

- Reply within 48 hours; a good review within 24 if possible.
- Use the reviewer's first name if the platform shows one; never a surname.
- Say one specific thing back. "Glad the hot stone add-on worked for your shoulder" beats
  "thanks for the kind words". If the review gives nothing specific, thank them for the visit
  and name the person who served them.
- Never confirm private facts. For a spa, salon or clinic, do not name the treatment, the
  condition or the appointment date in a reply; let the reviewer be the one who said it. For a
  contractor, do not name the address.
- Bad review: acknowledge the experience in their words, give one concrete thing that changes
  or that you would like to put right, and move it to a named person and a direct channel.
  Never argue the facts in public, never explain the staff member's side, never offer a refund
  or a freebie in public (it teaches the street that a one-star gets a discount).
- Never blame the customer, the weather or a supplier. Never use "we're sorry you feel that
  way". Never sign a reply as an assistant or an AI; the owner signs.
- Fake or abusive: do not reply. Write the report instead (platform, why it breaks their
  policy, the evidence) and give the owner the path to report it.
- Length: two to four sentences for a good review, four to six for a bad one.

## Output format

Write `reviews/<YYYY-MM-DD>-<platform>-<reviewer-slug>.md`:

```
# Review reply: <platform>, <stars> stars, <reviewer first name>, <date>

## The review
<verbatim>

## Read
<one line: what they are really saying; one line: anything the owner should check first>

## Draft A (warm)
<reply>

## Draft B (brief)
<reply>

## Draft C (formal)
<reply>

## Recommendation
<A, B or C and why, in one sentence>

## Do not say
- <the two or three things this particular reply must avoid>
```

For a suspicious review, replace the drafts with `## Report` (platform, policy line, evidence,
where to file it) and a one-line "no public reply" recommendation.

## Worked example

Input: Google, 2 stars, "Kelly R.", 2026-09-18: "Booked a 3pm and wasn't seen until 3:25. The
massage itself was fine but nobody said sorry for the wait." Owner's note: the 2 pm ran over
because a client arrived late; the front desk did not tell Kelly. Voice: warm, plain. Signed
"Priya, owner". Private channel: priya@larkdayspa.example.

```
# Review reply: Google, 2 stars, Kelly, 2026-09-18

## The review
Booked a 3pm and wasn't seen until 3:25. The massage itself was fine but nobody said sorry
for the wait.

## Read
The complaint is the silence, not the 25 minutes. Check: was Kelly offered anything at the
desk? Nothing in the notes says so.

## Draft A (warm)
Kelly, you are right, and I am sorry. A 25-minute wait is one thing; not being told what was
happening and not hearing an apology is the part I mind most. I have talked with the front desk
about telling every guest the moment we are running behind. I would like to put this right in
person: please email me at priya@larkdayspa.example and I will take care of it myself. Priya,
owner

## Draft B (brief)
Kelly, that wait should have come with an explanation and an apology, and it did not. I am
sorry. The desk now tells guests the moment we run behind. If you are willing, email me at
priya@larkdayspa.example and I will make your next visit right. Priya, owner

## Draft C (formal)
Thank you for telling us, Kelly. You were kept waiting 25 minutes without being informed or
offered an apology, and that falls short of how we want every guest treated. We have changed
how the front desk handles delays. I would welcome the chance to discuss your visit directly
at priya@larkdayspa.example. Priya, owner

## Recommendation
A: it names the real complaint (the silence), says what changed, and moves it to a person.

## Do not say
- Anything about the 2 pm client who arrived late
- "We're sorry you feel that way"
- A discount or a free treatment in public
```

## Approval

This skill drafts replies into a file. It posts nothing. The owner pastes the reply on the
platform. Google Business Profile replies through an API need Basic Access approval, which the
owner applies for; until then and after it, a reply goes out only when the owner approves it.
