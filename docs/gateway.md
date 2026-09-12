# Messaging Gateway & Approval Bridge

The Trent Messaging Gateway allows your cofounder fleet to communicate with you across your existing messaging channels.

---

## Supported Platforms

Trent includes native adapters for 8 platforms:

1. **Telegram**: Real-time bot messaging with inline keyboard approval buttons.
2. **Discord**: Discord bot with channel and thread mapping per agent seat.
3. **Slack**: Enterprise Slack App supporting slash commands and modal approval gates.
4. **WhatsApp**: Business API integration with end-to-end encrypted alerts.
5. **Signal**: Secure messaging via Signal-CLI bridge.
6. **Email**: Inbound and outbound email threads via Resend or SMTP/IMAP.
7. **Microsoft Teams**: Webhook and Bot Framework connector for team channels.
8. **Home Assistant**: Smart home automation triggers and status dashboard updates.

---

## Designated Agent Routing

Each platform can be assigned a default cofounder agent. For example:
- `telegram` -> `support`
- `slack` -> `engineer`
- `discord` -> `growth`

Incoming messages on that channel are automatically dispatched to the designated agent's context.

---

## The Remote Approval Bridge

When an agent needs human sign-off for a sensitive action (e.g. running a bash command or applying a financial charge), the Gateway dispatches an interactive card to your active messaging channel:

```
┌─ ⚠ APPROVAL REQUIRED ─────────────────────────────────────────┐
│  Agent wants to: Deploy production migration
│  Agent: Lead Engineer
│
│  Command: npx prisma migrate deploy
│  Cost: $0.00 · Risk: Medium
│  Reply [YES] or click [Approve] to proceed
└───────────────────────────────────────────────────────────────┘
```

You can approve directly from your phone on Telegram, Slack, or Discord without opening your terminal.

---

## Checking Gateway Status

```bash
trent gateway status
```
Outputs connection state and designated cofounder for each platform.
