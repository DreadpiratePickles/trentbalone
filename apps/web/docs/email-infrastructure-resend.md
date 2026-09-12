# Resend Email Infrastructure

For future Codex: this is Trent's current email infrastructure plan for making the nine agents act through real platform-domain email instead of mocked send paths.

## Decision

Use Resend for platform-owned outbound and inbound email first.

- Outbound sends go through the real `Email` tool adapter in `lib/resend-email-adapter.ts`.
- Every send/reply/broadcast remains approval-gated before the adapter calls Resend.
- Inbound mail enters through signed Resend `email.received` webhooks.
- Webhooks must be verified from the raw request body with Svix headers before parsing JSON.
- Inbound evidence is written as `support_summary` episodic memory so CEO/support/sales can retrieve real customer messages.

## Required Env

```bash
RESEND_AUTH_TOKEN=
RESEND_FROM_EMAIL="Trent <hello@send.example.com>"
# Or set only the sending domain and Trent will use: Trent <hello@send.example.com>
RESEND_FROM_DOMAIN="send.example.com"
RESEND_WEBHOOK_SECRET=
RESEND_INBOUND_DOMAIN="inbound.example.com"
TRENT_WEBHOOK_BASE_URL="https://your-trent-host.example.com"
```

`RESEND_API_KEY` is accepted as an alias for `RESEND_AUTH_TOKEN`. `TRENT_EMAIL_FROM` / `EMAIL_FROM` are accepted as fallback sender env vars. `TRENT_PLATFORM_DOMAIN` / `BASE_DOMAIN` can also provide a sender domain when no explicit Resend sender is present.

Outbound is considered configured when Trent has a Resend token and either a sender email or sender domain. Inbound is considered configured only after `RESEND_WEBHOOK_SECRET` is set and the webhook is created in Resend.

## Domain Setup

Use separate subdomains:

- `send.example.com` for outbound sender reputation.
- `inbound.example.com` for catch-all inbound routing.

This follows Resend's guidance to verify a domain before sending/receiving and to prefer subdomains for sending reputation. For receiving, avoid putting Resend MX records on a root domain that already has real inbox MX records; use an inbound subdomain instead.

## Webhook Setup

Preferred endpoint:

```text
POST {TRENT_WEBHOOK_BASE_URL}/api/email/resend/webhook
```

Configure the Resend webhook for:

```text
email.received
```

Store the returned signing secret in:

```bash
RESEND_WEBHOOK_SECRET=
```

Fallback per-company endpoint, useful during manual testing:

```text
POST {TRENT_WEBHOOK_BASE_URL}/api/companies/{companyId}/email/resend/webhook
```

## Address Routing

The global webhook maps inbound recipients to companies using the configured inbound domain:

```text
support+{companySlug}@inbound.example.com
hello+{companySlug}@inbound.example.com
sales+{companySlug}@inbound.example.com
{companySlug}@inbound.example.com
```

The company key is resolved through `store.getCompany`, which already accepts company id or slug.

## Research Sources

- Resend send-email API: https://resend.com/docs/api-reference/emails/send-email
- Resend receiving email docs: https://resend.com/docs/dashboard/receiving/introduction
- Resend custom receiving domains: https://resend.com/docs/dashboard/receiving/custom-domains
- Resend webhook verification: https://resend.com/docs/webhooks/verify-webhooks-requests
- Resend webhook creation API: https://resend.com/docs/api-reference/webhooks/create-webhook
