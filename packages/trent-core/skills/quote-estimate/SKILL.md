---
name: quote-estimate
description: Turn a site visit, a phone call or a consultation into a written quote a customer can say yes to, in the owner's numbers and never invented ones; then, when Stripe is connected, the finalized Stripe quote through customer_search and stripe_quote_create, created only after the owner approves that exact call. Use when a customer asks what a job or a package will cost.
category: small-business
trust: official
version: 2.0.0
author: trent
tags: quotes, estimates, pricing, stripe, contractors, spa, home-services
---
# Quote and Estimate

The Closer Who Never Pushes prices the job in the customer's own words, names what is not in the
price before the total, and asks once. Every rate is the owner's; a gap is `[RATE NEEDED]`.

Who runs it: `sales`, which carries the business toolset. An accepted quote goes to `finance`
for the deposit link (`stripe_payment_link_create`, see invoice-draft) and the invoice.

## What you need
1. The owner's rates (labour per hour or day, materials markup, minimum call-out), tax rate,
   deposit percent, validity (14 days is the trade default), what is never quoted fixed.
2. The customer's name and email, and the job in their words: measurements, counts, site
   conditions, the date they want. Ask for what is missing; never fill a gap with a guess.

## Steps
1. Write the file (Output format): quantity times rate on every line, labour and materials apart,
   every allowance named as one, the exclusions, and the change-order sentence from
   `references/change-order-language.md`. Check the arithmetic twice.
2. Find the customer: `customer_search {"query": "dana@okafor.example"}`. No match or two: stop
   and ask the owner; the tool never creates a customer.
3. Make the quote in Stripe. Amounts are integer cents of the unit price in a lowercase currency;
   the tool takes no tax argument, so tax is its own line and the Stripe total equals the file's:
   ```
   stripe_quote_create {"customer": "cus_Q2dana", "currency": "usd", "items": [{"description": "Remove existing tile and thinset, dispose (hour)", "amount_cents": 8500, "quantity": 3}, {"description": "Cement board, thinset, screws, tape", "amount_cents": 14835, "quantity": 1}, {"description": "Install cement board (hour)", "amount_cents": 8500, "quantity": 2}, {"description": "Tile ALLOWANCE, customer's choice (sq ft)", "amount_cents": 450, "quantity": 44}, {"description": "Set tile, grout, seal (hour)", "amount_cents": 8500, "quantity": 9}, {"description": "Grout, sealer, spacers, wax ring", "amount_cents": 6210, "quantity": 1}, {"description": "Tax (8 percent)", "amount_cents": 12788, "quantity": 1}], "expires_in_days": 14, "memo": "30 percent deposit books the dates. Work outside this scope is priced in writing before it starts."}
   ```
4. The owner's approval card shows the customer, every line, the total (1,726.33 USD here) and
   the expiry. Nothing is created until the owner approves that exact call; a changed line is a
   new approval. A card that reads `stripe_quote_create cannot run: <reason>` is a bad argument:
   fix it and call again, do not ask for a yes.
5. The result names the quote id. Stripe does not email it: the owner sends its PDF from the
   Stripe dashboard with the cover message below. Stripe not connected (`trent connect stripe`;
   the Business Providers line of `trent doctor` says) or the owner says no: the file is the quote.

## Output format
`quotes/<YYYY-MM-DD>-<customer-slug>.md`:
```
# Quote <number or draft>: <job in six words>
<Business> | <phone> | <email>   For: <customer>, <site>   Date: <date>   Valid until: <date>
## Scope            <three to six sentences: what, in what order, how many days, who supplies what>
## Price            | # | Item | Qty | Unit | Rate | Line total |, then Subtotal, Tax, Total, Deposit
## Not included     <every exclusion>
## Assumptions      <access, site conditions the price relies on>
## Changes          Work outside this scope is priced separately in writing before it starts.
## How to accept    <pay the deposit link, or say yes to the owner>
Stripe: <quote id and total, or "not created: <why>">
```
Then a three-line cover message the owner can paste, and `Before sending:` with every
`[RATE NEEDED]` and assumption to confirm, or `nothing`.

## Rules of the trade
- A customer can check a line; they cannot check a lump. Exclusions are the most-read section.
- One validity date, one deposit figure, one total. Never a discount the owner did not give.
- Worked numbers above: subtotal 1,598.45, tax 127.88, total 1,726.33, deposit 517.90.
