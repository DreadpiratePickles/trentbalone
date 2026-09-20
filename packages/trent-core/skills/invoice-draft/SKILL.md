---
name: invoice-draft
description: Draft an invoice that matches the quote line for line, credits the deposit, dates every change order and foots to the cent. Use when a job or a visit is done and the owner needs to bill for it. The owner issues it; nothing here charges anyone.
category: small-business
trust: official
version: 1.0.0
author: trent
tags: invoices, billing, payments, contractors, spa, home-services
---
# Invoice Draft

An invoice is the quote, kept. Every line the customer agreed to appears in the same words, every
extra carries the date it was approved, and the deposit is subtracted before the balance is
asked for. A customer who can lay the invoice next to the quote and find no surprises pays
faster than one who has to phone first.

## When to use

- The job is finished, or a milestone in the payment schedule has been reached.
- A spa or salon visit, course or package needs a bill (or a receipt for a paid one).
- A recurring customer is billed monthly for the work that month.

Do not use it before the work is done unless the schedule in the quote says a milestone is due.
Do not use it to collect a deposit: that is the quote's "How to accept" line.

## What you need before you write

1. The quote or agreement: its lines, rates and totals; the deposit taken and the date.
2. What was done: the completed lines, any line not done (and why), every change order with
   the date the customer approved it and how (text, email, in person).
3. The owner's billing facts: legal business name and address, tax number if the owner prints
   one, the next invoice number, payment terms ("due on receipt" or "net 14"), how to pay
   (bank transfer details as the owner wrote them, card link, cheque), whether a late fee
   exists and its terms.
4. The customer's billing name and address as they should appear.

If the invoice number or a rate is unknown write `[NEEDED]` in its place and list it under
"Before sending". Never make one up: a wrong invoice number is a bookkeeping mess for a year.

## Rules of the trade

- Match the quote line for line, same order, same words. A line that was not done is shown
  with a quantity of 0 and a note, not silently removed.
- An extra is a change order: its own line, "Change order 1, approved 2026-09-24 by text".
  No approval date, no line: put it under "Not billed" and ask the owner.
- The deposit is a credit line with its date. The balance due is total minus deposits.
- Tax on its own line, at the rate the quote used. Do not change the rate between quote and
  invoice; if the law changed, say so on the invoice.
- Amounts to two decimals; lines sum to the subtotal; subtotal plus tax equals the total;
  total minus deposits equals the balance due. Check the arithmetic twice.
- Never write "PAID". The owner marks payment when the money is in the account.
- A late fee appears only if the owner's terms have one, in the terms line, not as a threat.
- One payment method block, exactly as the owner gave it. Never guess a bank detail.

## Output format

Write one file, `invoices/<invoice-number>-<customer-slug>.md`, in exactly this shape, and a
two-sentence cover message.

```
# Invoice <number>

<Business legal name>
<address line>
<tax number, if the owner prints one>

Bill to: <customer billing name>
<customer address>

Invoice date: <YYYY-MM-DD>   Due: <YYYY-MM-DD or "on receipt">   Ref: Quote <number>

| # | Item | Qty | Unit | Rate | Line total |
|---|------|-----|------|------|------------|
| 1 | <quote line, same words> | <n> | <unit> | <rate> | <qty x rate> |
| ... | ... | ... | ... | ... | ... |
| n | Change order 1: <what>, approved <date> by <how> | <n> | <unit> | <rate> | <amount> |

Subtotal: <sum of lines>
Tax (<rate> percent): <amount>
Total: <subtotal + tax>
Less deposit received <date>: -<amount>
Balance due: <total - deposit>

## How to pay
<the owner's payment block, verbatim>

## Terms
<the owner's terms line, verbatim; late fee only if the owner has one>

Thank you for your business.
```

After the file: `Before sending:` with every `[NEEDED]`, every extra without an approval date,
and every quote line changed, or the single word `nothing`.

## Worked example

Input: the quote from the `quote-estimate` example (total 1,726.33; deposit 517.90 received
2026-09-22), all lines done; on day one the plywood was soft in a two-foot square and the
customer approved a subfloor patch by text on 2026-10-06 at 1.5 hours of labour plus 41.20 in
materials; terms "due on receipt"; payment by bank transfer.

```
# Invoice 2026-041

Marsh Tile & Stone
14 Orchard Lane, Unit B
Tax no. 11-2233445

Bill to: Dana Okafor
9 Willow Court

Invoice date: 2026-10-08   Due: on receipt   Ref: Quote 2026-041

| # | Item | Qty | Unit | Rate | Line total |
|---|------|-----|------|------|------------|
| 1 | Remove existing tile and thinset, dispose | 3 | hour | 85.00 | 255.00 |
| 2 | Cement board, thinset, screws, tape | 1 | lot | 148.35 | 148.35 |
| 3 | Install cement board | 2 | hour | 85.00 | 170.00 |
| 4 | Tile allowance (customer's choice) | 44 | sq ft | 4.50 | 198.00 |
| 5 | Set tile, grout, seal | 9 | hour | 85.00 | 765.00 |
| 6 | Grout, sealer, spacers, wax ring | 1 | lot | 62.10 | 62.10 |
| 7 | Change order 1: subfloor patch 2 ft x 2 ft, approved 2026-10-06 by text | 1.5 | hour | 85.00 | 127.50 |
| 8 | Change order 1 materials: plywood, screws, adhesive | 1 | lot | 41.20 | 41.20 |

Subtotal: 1,767.15
Tax (8 percent): 141.37
Total: 1,908.52
Less deposit received 2026-09-22: -517.90
Balance due: 1,390.62

## How to pay
Bank transfer to Marsh Tile & Stone, sort 20-00-00, account 12345678, reference 2026-041.

## Terms
Due on receipt. Questions about this invoice: jo@marshtile.example or 555-0142.

Thank you for your business.
```

Cover message: "Hi Dana, the floor is done and the invoice is attached: 1,390.62 after your
deposit, including the subfloor patch you approved on the 6th. Bank details are on the invoice.
Thanks for having us. Jo"

Before sending: nothing.

## Approval

This skill writes a draft. It does not issue, send or collect anything, and it never marks an
invoice paid. The owner issues it from their own invoicing tool or sends the file. When the
business toolset is connected (Stripe invoices, Square invoices), the seat will be able to
create the invoice there as a draft; sending it and taking payment will need the owner's
approval every time.
