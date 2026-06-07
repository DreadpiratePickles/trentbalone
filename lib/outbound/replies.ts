export type ClassifiedReply = {
  messageId: string;
  threadKey: string;
  sentiment: "positive" | "neutral" | "negative";
  intent: "buying" | "unsubscribe" | "objection" | "unknown";
};

export function classifyReply(input: { messageId: string; inReplyTo?: string; body: string }): ClassifiedReply {
  const body = input.body.toLowerCase();
  const sentiment = /not interested|stop|unsubscribe|angry|never/.test(body)
    ? "negative"
    : /interested|book|yes|sounds good/.test(body)
      ? "positive"
      : "neutral";
  const intent = /stop|unsubscribe/.test(body)
    ? "unsubscribe"
    : /book|demo|yes|interested/.test(body)
      ? "buying"
      : /not interested|too expensive|later/.test(body)
        ? "objection"
        : "unknown";
  return {
    messageId: input.messageId,
    threadKey: input.inReplyTo ?? input.messageId,
    sentiment,
    intent,
  };
}

export function shouldPauseForHuman(reply: ClassifiedReply) {
  return reply.sentiment === "negative" || reply.intent === "buying" || reply.intent === "unsubscribe";
}
