---
name: booking-followup
description: Write the messages around an appointment or a job: the confirmation the day before, the morning-of reminder, the no-show note that keeps the customer, the rebook nudge and the post-job check-in with a review ask. Use when the owner has a booking list or a finished job and wants the follow-ups drafted. The owner sends.
category: small-business
trust: official
version: 1.0.0
author: trent
tags: bookings, appointments, reminders, no-show, follow-up, sms, spa, salon, contractors
---
# Booking Follow-up

The money in a service business leaks at the edges of the calendar: the no-show that could
have been a reschedule, the colour client who drifts to eight weeks, the finished job nobody
asked for a review on. These messages close the edges. They are short, on time, and sound like
the owner, not like a booking system.

## When to use

- A list of tomorrow's bookings needs confirmations.
- A customer did not show, or cancelled late.
- A regular is overdue for a rebook (spa, salon, grooming, maintenance contracts).
- A job finished this week and nobody has followed up.

## What you need before you write

1. The bookings: customer first name, service, date and time, who they are booked with, the
   channel they gave (SMS number, email) and that they agreed to be messaged about bookings.
2. The owner's policy in their own words: cancellation window (24 hours is the spa default),
   the no-show fee if there is one, how to reschedule, opening hours.
3. The rebook interval per service (a facial 4 to 6 weeks, colour 6 to 8 weeks, a cut 4 to 6,
   a gutter clean or a boiler service yearly) or the owner's own numbers.
4. A review link if the owner wants one asked for, and the name the messages are signed with.

No consent to message, no message: list the customer under "Cannot message" instead.

## Rules of the trade

- One message, one ask. Confirm, or remind, or rebook. Never all three.
- Under 160 characters for SMS where it can be done; the customer's first name in the first
  five words; the reply they should send spelled out ("Reply Y to confirm, or R to reschedule").
- Timing: confirmation 24 to 48 hours before; reminder the morning of, 2 to 3 hours ahead; the
  no-show note within 2 hours of the missed time, while the slot still matters; the rebook nudge
  at the interval minus a week; the post-job check-in 2 to 3 days after; the review ask on day
  7, only after a good check-in. Nothing before 9 am or after 8 pm the customer's local time.
- The no-show note is kind and specific: name the missed slot, offer two new times, state the
  policy once as a fact, never as a scolding. A first no-show gets the policy explained; a fee
  is charged only if the owner's policy says so and the owner decides.
- SMS carries an opt-out line where the law or the owner requires one ("Reply STOP to opt out").
- No emoji unless the owner's voice file uses them. No exclamation mark stacks.
- Never mention a treatment in a way that would embarrass the customer if someone else saw the
  phone. "Your 2 pm appointment" beats naming the treatment.

## Output format

Write `followups/<YYYY-MM-DD>.md` with one queue table and the message texts beneath it.

```
# Follow-ups for <YYYY-MM-DD>

| # | Send at (local) | Channel | To | Type | Status |
|---|-----------------|---------|----|------|--------|
| 1 | <YYYY-MM-DD HH:MM> | SMS or email | <first name> | confirmation, reminder, no-show, rebook, check-in, review | draft |

## 1. <type> for <first name>
<message text, exactly as it should go out>

## Cannot message
- <first name>: <reason, such as no consent recorded or no number>
```

Then `Before sending:` with anything the owner must decide (a fee, a policy exception) or
`nothing`.

## Worked example

Input: Lark Day Spa, signed "Priya"; 24-hour cancellation, no-show fee 50 percent charged at
the owner's discretion; facials rebook at 5 weeks. Tomorrow 2026-09-21: Maya, facial, 14:00
with Priya, SMS consent yes. Today Tom missed his 10:00 massage. Ana's last facial was
2026-08-14.

```
# Follow-ups for 2026-09-20

| # | Send at (local) | Channel | To | Type | Status |
|---|-----------------|---------|----|------|--------|
| 1 | 2026-09-20 11:00 | SMS | Maya | confirmation | draft |
| 2 | 2026-09-20 11:30 | SMS | Tom | no-show | draft |
| 3 | 2026-09-21 09:30 | SMS | Ana | rebook | draft |

## 1. Confirmation for Maya
Hi Maya, this is Priya at Lark Day Spa. You are booked for 2 pm tomorrow, Sunday 21st. Reply Y
to confirm or R to move it. Reply STOP to opt out.

## 2. No-show for Tom
Hi Tom, Priya at Lark here. We missed you at 10 today and hope all is well. I can do Tuesday
at 10 or Thursday at 4; reply with the one that suits. Our 24-hour notice policy is on the
booking page if you ever need to move one. Reply STOP to opt out.

## 3. Rebook for Ana
Hi Ana, Priya at Lark. It has been five weeks since your facial and your skin will thank you
for the next one. Reply with a day that suits and I will send times. Reply STOP to opt out.

## Cannot message
- none
```

Before sending: Tom's no-show fee is the owner's call; this note does not mention it.

## Approval

This skill writes messages into a file. It sends none of them. The owner sends them from
their own phone or booking system. When the business toolset is connected (Twilio SMS, Google
Calendar, Square bookings), each outbound message will be sent only after the owner approves
it, one at a time, and a reschedule will change the calendar only with the same approval.
