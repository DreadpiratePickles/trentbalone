import { createHmac, timingSafeEqual } from "node:crypto";

type StripeMetadata = Record<string, string>;
const WEBHOOK_TOLERANCE_SECONDS = 300;

export type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

type StripeCustomerCreateInput = {
  name?: string;
  metadata?: StripeMetadata;
};

type StripeSetupIntentCreateInput = {
  customer: string;
  usage: "off_session";
  payment_method_types: string[];
  metadata?: StripeMetadata;
};

type StripePaymentIntentCreateInput = {
  amount: number;
  currency: string;
  customer: string;
  payment_method: string;
  confirm: boolean;
  off_session: boolean;
  metadata?: StripeMetadata;
};

type StripePaymentIntent = {
  id: string;
  status: string;
  last_payment_error?: { code?: string | null } | null;
};

type StripeRequestOptions = {
  idempotencyKey?: string;
};

export type StripeClient = {
  customers: {
    create(input: StripeCustomerCreateInput): Promise<{ id: string }>;
  };
  setupIntents: {
    create(input: StripeSetupIntentCreateInput): Promise<{ client_secret: string | null }>;
  };
  paymentIntents: {
    create(input: StripePaymentIntentCreateInput, options?: StripeRequestOptions): Promise<StripePaymentIntent>;
  };
  webhooks: {
    constructEvent(rawBody: string, signature: string): StripeEvent;
  };
};

let cachedClient: StripeClient | null = null;

export function getStripeClient(): StripeClient {
  cachedClient ??= createStripeClient();
  return cachedClient;
}

function createStripeClient(): StripeClient {
  return {
    customers: {
      create: (input) => stripeRequest("/v1/customers", input) as Promise<{ id: string }>,
    },
    setupIntents: {
      create: (input) => stripeRequest("/v1/setup_intents", input) as Promise<{ client_secret: string | null }>,
    },
    paymentIntents: {
      create: (input, options) => stripeRequest("/v1/payment_intents", input, options) as Promise<StripePaymentIntent>,
    },
    webhooks: {
      constructEvent(rawBody, signature) {
        verifyStripeSignature(rawBody, signature);
        return JSON.parse(rawBody) as StripeEvent;
      },
    },
  };
}

async function stripeRequest(path: string, input: Record<string, unknown>, options: StripeRequestOptions = {}) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");

  const res = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
	    headers: {
	      Authorization: `Bearer ${secretKey}`,
	      "Content-Type": "application/x-www-form-urlencoded",
	      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
	    },
    body: encodeStripeForm(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stripe request failed with status ${res.status}`);
  }
  return body;
}

function encodeStripeForm(input: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, index) => params.set(`${key}[${index}]`, String(item)));
    } else if (typeof value === "object") {
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        params.set(`${key}[${nestedKey}]`, String(nestedValue));
      }
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}

export function verifyStripeSignature(rawBody: string, signature: string) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");

  const parts = signature.split(",").reduce<{ timestamp?: string; signatures: string[] }>((acc, part) => {
    const [key, value] = part.split("=");
    if (key === "t") acc.timestamp = value;
    if (key === "v1" && value) acc.signatures.push(value);
    return acc;
  }, { signatures: [] });
  const timestamp = parts.timestamp;
  if (!timestamp || parts.signatures.length === 0) throw new Error("Invalid Stripe signature header");
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) throw new Error("Invalid Stripe signature timestamp");
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) throw new Error("Stripe signature is stale");

  const payload = `${timestamp}.${rawBody}`;
  const actual = createHmac("sha256", webhookSecret).update(payload).digest("hex");
  const actualBuffer = Buffer.from(actual);
  const hasMatchingSignature = parts.signatures.some(expected => {
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  });
  if (!hasMatchingSignature) {
    throw new Error("Invalid Stripe signature");
  }
}
