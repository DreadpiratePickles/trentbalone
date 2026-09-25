---
name: invoice-draft
description: Bill a finished job or visit so the invoice foots to the quote to the cent, credits the deposit and dates every change order; then, when Stripe or Square is connected, draft it there (stripe_invoice_create or square_invoice_create) and send it (stripe_invoice_send or square_invoice_send), each only after the owner approves that exact call. Also the deposit link (stripe_payment_link_create). Never marks anything paid.
category: small-business
trust: official
version: 2.0.0
author: trent
tags: invoices, billing, payments, stripe, square, contractors, spa, home-services
---
# Invoice Draft

The Ledger counts twice, in cents. An invoice is the quote, kept: the same lines in the same
words, every extra dated with the customer's yes, the deposit subtracted before the balance.

Who runs it: `finance` makes the business calls. The finance seat has no file_ops, so `sales`
writes the invoice file; the wording of a payment nudge goes to `support`.

## What you need
The quote (lines, rates, the deposit and its date), what was done, every change order with the
date and way the customer approved it, the owner's terms and invoice number, and the customer's
Stripe id (`customer_search {"query": "dana@okafor.example"}`) or Square customer and location
ids (from the Square dashboard; no tool looks them up). A gap is `[NEEDED]`, never a guess.

## Steps
1. Deposit before the work, when the quote asks for one: a link the customer pays,
   `stripe_payment_link_create {"currency": "usd", "items": [{"description": "Deposit, Quote 2026-041 (30 percent)", "amount_cents": 51790, "quantity": 1}]}`.
2. Write the file (Output format) and foot it: lines to subtotal, plus tax, less deposits, to
   the balance. Quantities are whole numbers, so 1.5 hours is 3 half-hours at half the rate.
3. Draft it where the owner bills. Amounts are integer cents; tax is its own line. The tool takes
   no negative line, so with a deposit the provider copy is one balance line naming the quote,
   its total and the deposit, and the file keeps the line-for-line detail:
   ```
   stripe_invoice_create {"customer": "cus_Q2dana", "currency": "usd", "items": [{"description": "Balance, Invoice 2026-041: total 1,908.52 less deposit 517.90 received 2026-09-22", "amount_cents": 139062, "quantity": 1}], "days_until_due": 14, "memo": "Detail by line on the attached invoice. Change order 1 approved 2026-10-06 by text."}
   square_invoice_create {"location": "L8GQ2", "customer": "SQCUST7", "currency": "usd", "items": [{"name": "Balance, Invoice 2026-041", "amount_cents": 139062, "quantity": 1}], "due_date": "2026-10-22", "title": "Invoice 2026-041", "description": "Total 1,908.52 less deposit 517.90."}
   ```
   Both only draft: nothing reaches the customer yet. The due date follows the owner's terms (net 14 here).
4. Send it at the approved total, which the tool checks against the provider's before it emails:
   `stripe_invoice_send {"invoice": "in_1Q9ledger", "expected_total_cents": 139062, "currency": "usd"}`
   or `square_invoice_send {"invoice": "inv:0-ChB7", "expected_total_cents": 139062, "currency": "usd"}`.
5. Every call here moves money, so each waits for the owner's approval of that exact call: the
   card shows the customer, every line, the total and the due date or invoice id. A changed
   amount is a new approval; `<tool> cannot run: <reason>` means fix the argument. No provider
   connected (`trent connect stripe` or `trent connect square`), or a no: the file is the invoice.

## Output format
`invoices/<invoice-number>-<customer-slug>.md`:
```
# Invoice <number>          <business legal name, address, tax number if printed>
Bill to: <name, address>    Invoice date: <date>   Due: <date or "on receipt">   Ref: Quote <n>
| # | Item | Qty | Unit | Rate | Line total |      (quote lines in quote order, same words;
                                                   a line not done shows qty 0 and a note;
                                                   "Change order 1: <what>, approved <date> by <how>")
Subtotal / Tax (<rate> percent) / Total / Less deposit received <date> / Balance due
## How to pay     <the payment link or the owner's block, verbatim>
## Terms          <the owner's terms; a late fee only if the owner has one>
Provider: <Stripe or Square invoice id, total, status: drafted | sent | not created: why>
```
Then a two-sentence cover message and `Before sending:` with every `[NEEDED]`, every extra with
no approval date (billed nowhere until the owner decides), or `nothing`.

## Rules of the trade
- Never write "PAID"; the owner marks payment when the money is in the account.
- Same tax rate as the quote. One payment method, exactly as the owner gave it.
- Worked numbers: lines 1,767.15, tax 8 percent 141.37, total 1,908.52, deposit 517.90, balance 1,390.62.
