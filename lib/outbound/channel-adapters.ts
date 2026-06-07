export function planSmsSend(input: {
  to: string;
  body: string;
  a2pRegistered: boolean;
  optedIn: boolean;
}) {
  if (!input.a2pRegistered) throw new Error("Twilio A2P 10DLC registration is required");
  if (!input.optedIn) throw new Error("SMS opt-in is required");
  return { provider: "twilio" as const, channel: "sms" as const, to: input.to, body: input.body };
}

export function handleSmsKeyword(keyword: string) {
  const normalized = keyword.trim().toUpperCase();
  if (normalized === "STOP") return { status: "opted_out" as const, reply: "You have been unsubscribed." };
  if (normalized === "HELP") return { status: "help" as const, reply: "Help: reply STOP to opt out or contact support." };
  return { status: "ignored" as const, reply: undefined };
}

export function planWhatsAppSend(input: {
  sessionOpen: boolean;
  templateApproved: boolean;
  body: string;
}) {
  if (input.sessionOpen) return { provider: "whatsapp_business" as const, kind: "session" as const, body: input.body };
  if (!input.templateApproved) throw new Error("WhatsApp template approval is required outside a session window");
  return { provider: "whatsapp_business" as const, kind: "template" as const, body: input.body };
}

export function planVoiceCall(input: { direction: "outbound" | "inbound"; needsIvr: boolean }) {
  if (input.needsIvr || input.direction === "inbound") return { provider: "retell" as const, supportsIvr: true };
  return { provider: "vapi" as const, supportsIvr: false };
}
