export type SteelHealthStatus = "connected" | "needs_credentials";

export type SteelConfig = {
  baseUrl: string;
  apiKey?: string;
  defaultUserId: string;
};

export type SteelScreenshotInput = {
  url: string;
  fullPage?: boolean;
  delayMs?: number;
};

export type SteelScrapeInput = {
  url: string;
  format?: Array<"html" | "cleaned_html" | "markdown" | "readability">;
  screenshot?: boolean;
  pdf?: boolean;
  delayMs?: number;
};

export type SteelPdfInput = {
  url: string;
  delayMs?: number;
};

export type SteelJson = Record<string, unknown>;

const DEFAULT_STEEL_BASE_URL = "https://api.steel.dev/v1";
const DEFAULT_STEEL_USER_ID = "trent";

export function getSteelConfig(env: Partial<NodeJS.ProcessEnv> = process.env): SteelConfig {
  return {
    baseUrl: (env.STEEL_BASE_URL ?? DEFAULT_STEEL_BASE_URL).replace(/\/+$/, ""),
    apiKey: env.STEEL_API_KEY ?? undefined,
    defaultUserId: env.STEEL_USER_ID ?? DEFAULT_STEEL_USER_ID,
  };
}

export function buildSteelToolScopes() {
  return [
    "steel:scrape",
    "steel:screenshot",
    "steel:pdf",
    "steel:sessions",
  ];
}

export class SteelBrowserClient {
  private readonly config: SteelConfig;

  constructor(config: SteelConfig = getSteelConfig()) {
    this.config = config;
  }

  async healthCheck(): Promise<SteelHealthStatus> {
    return this.config.apiKey ? "connected" : "needs_credentials";
  }

  async screenshot(input: SteelScreenshotInput): Promise<Buffer> {
    const result = await this.requestJson<SteelJson>("/screenshot", {
      url: input.url,
      fullPage: input.fullPage ?? false,
      delay: input.delayMs ?? 1000,
    });
    const hostedUrl = steelHostedUrl(result, ["url", "screenshot"]);
    if (!hostedUrl) throw new Error("Steel screenshot response did not include a hosted image URL.");
    return this.downloadHostedFile(hostedUrl, "screenshot");
  }

  async scrape(input: SteelScrapeInput): Promise<SteelJson> {
    return this.requestJson<SteelJson>("/scrape", {
      url: input.url,
      format: input.format ?? ["markdown"],
      screenshot: input.screenshot,
      pdf: input.pdf,
      delay: input.delayMs,
    });
  }

  async pdf(input: SteelPdfInput): Promise<Buffer> {
    const result = await this.requestJson<SteelJson>("/pdf", {
      url: input.url,
      delay: input.delayMs,
    });
    const hostedUrl = steelHostedUrl(result, ["url", "pdf"]);
    if (!hostedUrl) throw new Error("Steel PDF response did not include a hosted PDF URL.");
    return this.downloadHostedFile(hostedUrl, "PDF");
  }

  private async requestJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.config.apiKey) throw new Error("Steel API key is not configured.");
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "steel-api-key": this.config.apiKey,
      },
      body: JSON.stringify(removeUndefined(body)),
    });

    if (!response.ok) {
      const detail = redactSecret(await response.text().catch(() => ""), this.config.apiKey);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Steel request failed: ${response.status}${suffix}`);
    }

    return response.json() as Promise<T>;
  }

  private async downloadHostedFile(url: string, label: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Steel ${label} download failed: ${response.status}${suffix}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

function steelHostedUrl(result: SteelJson, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = result[key];
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "url" in value && typeof (value as { url?: unknown }).url === "string") {
      return (value as { url: string }).url;
    }
  }
  return undefined;
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function redactSecret(message: string, secret?: string) {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}
