---
name: quote-estimate
description: Turn a site visit, a phone call or a consultation into a written quote a customer can say yes to. Line items, allowances, exclusions, a validity window and change-order language, in the owner's numbers, never invented ones. Use when a customer asks what a job or a package will cost.
category: small-business
trust: official
version: 1.0.0
author: trent
tags: quotes, estimates, pricing, contractors, spa, home-services
---
# Quote and Estimate

A quote is a promise about money. It is the document the customer forwards to their partner,
compares against the other two quotes on the kitchen table, and holds up when the job runs
long. Write it so that every number can be defended and every surprise is already named.

## When to use

- A customer asked "what would it cost to..." and the owner has the facts of the job.
- A spa or salon needs a package price for a group, an event or a course of treatments.
- A contractor came back from a site visit with measurements and photos.
- The owner wants a rough figure for a lead before a site visit: produce an ESTIMATE, labelled
  as one, with the range and the three things that would move it.

Do not use it to re-price a job that is already under way. That is a change order (below).

## What you need before you write

Ask for what is missing. Never fill a gap with a plausible number.

1. The business: trade, name, the owner's usual rates (labour per hour or per day, markup on
   materials, minimum call-out, travel radius), tax rate and whether prices are shown with tax.
2. The customer: name, site address or the room, how they want to receive it.
3. The job: what was asked for, in the customer's own words; measurements, counts, photos
   described; access and site conditions; the date they want it done.
4. Policy: deposit percentage, payment schedule, validity window (14 days is the trade default),
   what the owner never quotes fixed (subfloor repair, hidden plumbing, electrical behind walls).

If a rate is not known, write `[RATE NEEDED]` in the line and list it under "Before sending".

## Rules of the trade

- Quantity times unit rate, every line. A customer can check a line; they cannot check a lump.
- Labour and materials on separate lines. It is how disputes are settled later.
- An allowance is a line the customer controls ("tile allowance 4.50 per sq ft; tile chosen
  above that is billed at cost plus 15 percent"). Name every allowance as one.
- Exclusions are not fine print. They are the most-read section after the total. List what is
  not in the price: permits, disposal beyond the skip, painting, plumbing rework, anything
  discovered after demolition.
- Change-order language, always, in these words or the owner's: "Work outside this scope is
  priced separately in writing before it starts. Nothing is added to the invoice that was not
  signed off." A spa version: "Add-on treatments are offered on the day and charged only if
  chosen."
- One validity date. One deposit figure. One total. Tax on its own line.
- Amounts to two decimals; the lines must add up to the subtotal and the subtotal plus tax must
  equal the total. Check the arithmetic twice; a quote that does not add up loses the job.
- Plain words. "Remove and dispose of existing floor tile" beats "demolition phase".

## Output format

Write one file, `quotes/<YYYY-MM-DD>-<customer-slug>.md`, in exactly this shape, then a
three-line cover message the owner can paste into a text or an email.

```
# Quote <number or draft>: <job in six words>

<Business name> | <phone> | <email>
For: <customer name>, <site or room>
Date: <YYYY-MM-DD>   Valid until: <YYYY-MM-DD>   Prepared by: <owner name>

## Scope
<Three to six sentences: what will be done, in what order, over how many days,
what the customer supplies, what the business supplies.>

## Price
| # | Item | Qty | Unit | Rate | Line total |
|---|------|-----|------|------|------------|
| 1 | <labour line> | <n> | hour or day | <rate> | <qty x rate> |
| 2 | <materials line> | <n> | <unit> | <rate> | <qty x rate> |
| 3 | <allowance line, marked ALLOWANCE> | ... | ... | ... | ... |

Subtotal: <sum of lines>
Tax (<rate> percent): <amount>
Total: <subtotal + tax>

Deposit to book: <amount> (<percent> percent), balance due <when>.

## Included
- <bullet per thing the price covers that a customer might wonder about>

## Not included
- <bullet per exclusion>

## Assumptions
- <what the price relies on: access, site power, existing conditions>

## Changes
Work outside this scope is priced separately in writing before it starts. Nothing is added
to the invoice that was not signed off.

## How to accept
Reply "yes" to this message or pay the deposit; the date is held for <n> days.
```

After the file: `Before sending:` with every `[RATE NEEDED]` and every assumption the owner
should confirm, or the single word `nothing`.

## Worked example

Input: a tiling contractor, labour 85.00 per hour, materials at cost plus 15 percent, 8 percent
tax, 30 percent deposit, 14-day validity. Site visit: bathroom floor 5 ft by 8 ft (40 sq ft),
existing ceramic tile to come up, plywood subfloor looked sound, customer has not chosen tile.

```
# Quote draft: Bathroom floor re-tile, 40 sq ft

Marsh Tile & Stone | 555-0142 | jo@marshtile.example
For: Dana Okafor, main bathroom
Date: 2026-09-20   Valid until: 2026-10-04   Prepared by: Jo Marsh

## Scope
Remove the existing ceramic floor tile and thinset, inspect the plywood subfloor, install
cement board, lay the customer's chosen tile with a standard offset pattern, grout, seal the
grout and re-set the toilet. Two working days. Marsh Tile supplies all setting materials;
the customer chooses and pays for the tile through the allowance below.

## Price
| # | Item | Qty | Unit | Rate | Line total |
|---|------|-----|------|------|------------|
| 1 | Remove existing tile and thinset, dispose | 3 | hour | 85.00 | 255.00 |
| 2 | Cement board, thinset, screws, tape | 1 | lot | 148.35 | 148.35 |
| 3 | Install cement board | 2 | hour | 85.00 | 170.00 |
| 4 | Tile ALLOWANCE (customer's choice) | 44 | sq ft | 4.50 | 198.00 |
| 5 | Set tile, grout, seal | 9 | hour | 85.00 | 765.00 |
| 6 | Grout, sealer, spacers, wax ring | 1 | lot | 62.10 | 62.10 |

Subtotal: 1,598.45
Tax (8 percent): 127.88
Total: 1,726.33

Deposit to book: 517.90 (30 percent), balance due on completion.

## Included
- Disposal of old tile in our trailer
- 10 percent extra tile in the allowance for cuts and waste (44 sq ft for a 40 sq ft floor)
- Re-setting the existing toilet with a new wax ring

## Not included
- Tile above 4.50 per sq ft: the difference is billed at cost plus 15 percent
- Subfloor repair if the plywood is soft once the tile is up (priced on the day, in writing)
- Baseboard removal, painting, plumbing changes, a new toilet

## Assumptions
- Water can be off for up to four hours on day two
- The subfloor is sound, as it appeared on 2026-09-19

## Changes
Work outside this scope is priced separately in writing before it starts. Nothing is added
to the invoice that was not signed off.

## How to accept
Reply "yes" to this message or pay the 517.90 deposit; the dates are held for 14 days.
```

Cover message: "Hi Dana, here is the quote for the bathroom floor: 1,726.33 all in, with a
4.50 per sq ft tile allowance so you can pick what you like. Say yes here or send the deposit
and I will hold the first week of October for you. Jo"

Before sending: nothing.

## Approval

This skill writes a draft. It does not send it, book anything or take a deposit. The owner
reads the file, changes what they like and sends it from their own phone or email. When the
business toolset is connected (Stripe quotes, Square invoices), the seat will be able to create
the quote there as a draft, and sending it to the customer will still need the owner's approval
each time.
