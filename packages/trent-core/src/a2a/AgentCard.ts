import crypto from "node:crypto";

export interface AgentCard {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  capabilities: string[];
  endpoint: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  signature?: string;
  issuedAt: string;
}

export interface AgentCardParams {
  id: string;
  name: string;
  description: string;
  category: string;
  capabilities: string[];
  endpoint: string;
  version?: string;
}

export function computeCardDigest(card: Omit<AgentCard, "signature">): string {
  const content = JSON.stringify({
    id: card.id,
    name: card.name,
    description: card.description,
    category: card.category,
    version: card.version,
    capabilities: [...card.capabilities].sort(),
    endpoint: card.endpoint,
    issuedAt: card.issuedAt,
  });
  return content;
}

export function generateAgentCard(params: AgentCardParams, secret: string): AgentCard {
  const issuedAt = new Date().toISOString();
  const rawCard: Omit<AgentCard, "signature"> = {
    id: params.id,
    name: params.name,
    description: params.description,
    category: params.category,
    version: params.version || "1.0.0",
    capabilities: params.capabilities,
    endpoint: params.endpoint,
    issuedAt,
  };

  const digest = computeCardDigest(rawCard);
  const signature = crypto.createHmac("sha256", secret).update(digest).digest("hex");

  return {
    ...rawCard,
    signature,
  };
}

export function verifyAgentCardSignature(card: AgentCard, secret: string): boolean {
  if (!card.signature) return false;
  const { signature, ...rest } = card;
  const digest = computeCardDigest(rest);
  const expectedSig = crypto.createHmac("sha256", secret).update(digest).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedSig, "hex"));
}
