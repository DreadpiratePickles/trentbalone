export type CamofoxHealthStatus = "connected" | "needs_credentials";

export type CamofoxConfig = {
  baseUrl: string;
  accessKey?: string;
  defaultUserId: string;
};

export type CamofoxCreateTabInput = {
  userId?: string;
  sessionKey?: string;
  url?: string;
  groupId?: string;
};

export type CamofoxTab = {
  id: string;
  url?: string;
  title?: string;
};

export type CamofoxSnapshot = {
  snapshot: string;
  screenshot?: string;
  url?: string;
  title?: string;
  truncated?: boolean;
  nextOffset?: number;
};

export type CamofoxNavigateInput = {
  userId?: string;
  url?: string;
  macro?: string;
  query?: string;
};

export type CamofoxElementInput = {
  userId?: string;
  ref?: string;
  selector?: string;
};

export type CamofoxTypeInput = CamofoxElementInput & {
  text: string;
  pressEnter?: boolean;
};

export type CamofoxScrollInput = CamofoxUserInput & {
  direction: "up" | "down" | "left" | "right";
  amount?: number;
};

export type CamofoxSnapshotInput = {
  userId?: string;
  includeScreenshot?: boolean;
  offset?: number;
};

export type CamofoxUserInput = {
  userId?: string;
};

export type CamofoxJson = Record<string, unknown>;

const DEFAULT_CAMOFOX_BASE_URL = "http://localhost:9377";
const DEFAULT_CAMOFOX_USER_ID = "trent";

export function getCamofoxConfig(env: Partial<NodeJS.ProcessEnv> = process.env): CamofoxConfig {
  return {
    baseUrl: (env.CAMOFOX_BASE_URL ?? env.CAMOFOX_URL ?? DEFAULT_CAMOFOX_BASE_URL).replace(/\/+$/, ""),
    accessKey: env.CAMOFOX_ACCESS_KEY ?? env.CAMOFOX_API_KEY ?? undefined,
    defaultUserId: env.CAMOFOX_USER_ID ?? DEFAULT_CAMOFOX_USER_ID,
  };
}

export function buildCamofoxToolScopes() {
  return [
    "camofox:tab",
    "camofox:navigate",
    "camofox:snapshot",
    "camofox:click",
    "camofox:type",
    "camofox:scroll",
    "camofox:screenshot",
    "camofox:close",
  ];
}

function redactSecret(message: string, secret?: string) {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

function query(params: Record<string, string | number | boolean | undefined>) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const serialized = qs.toString();
  return serialized ? `?${serialized}` : "";
}

export class CamofoxBrowserClient {
  private readonly config: CamofoxConfig;

  constructor(config: CamofoxConfig = getCamofoxConfig()) {
    this.config = config;
  }

  async healthCheck(): Promise<CamofoxHealthStatus> {
    try {
      await this.requestJson<CamofoxJson>("/health", { method: "GET" });
      return "connected";
    } catch {
      return "needs_credentials";
    }
  }

  async createTab(input: CamofoxCreateTabInput): Promise<CamofoxTab> {
    const raw = await this.requestJson<CamofoxTab & { tabId?: string }>("/tabs", {
      body: this.withUser(input),
      method: "POST",
    });
    const id = raw.id ?? raw.tabId;
    if (!id) throw new Error("Camofox create tab response did not include id/tabId");
    return {
      id,
      url: raw.url,
      title: raw.title,
    };
  }

  async navigate(tabId: string, input: CamofoxNavigateInput): Promise<CamofoxJson> {
    return this.requestJson<CamofoxJson>(`/tabs/${encodeURIComponent(tabId)}/navigate`, {
      body: this.withUser(input),
      method: "POST",
    });
  }

  async snapshot(tabId: string, input: CamofoxSnapshotInput): Promise<CamofoxSnapshot> {
    return this.requestJson<CamofoxSnapshot>(
      `/tabs/${encodeURIComponent(tabId)}/snapshot${query({
        userId: input.userId ?? this.config.defaultUserId,
        includeScreenshot: input.includeScreenshot,
        offset: input.offset,
      })}`,
      { method: "GET" },
    );
  }

  async click(tabId: string, input: CamofoxElementInput): Promise<CamofoxJson> {
    return this.requestJson<CamofoxJson>(`/tabs/${encodeURIComponent(tabId)}/click`, {
      body: this.withUser(input),
      method: "POST",
    });
  }

  async type(tabId: string, input: CamofoxTypeInput): Promise<CamofoxJson> {
    return this.requestJson<CamofoxJson>(`/tabs/${encodeURIComponent(tabId)}/type`, {
      body: this.withUser(input),
      method: "POST",
    });
  }

  async scroll(tabId: string, input: CamofoxScrollInput): Promise<CamofoxJson> {
    return this.requestJson<CamofoxJson>(`/tabs/${encodeURIComponent(tabId)}/scroll`, {
      body: this.withUser(input),
      method: "POST",
    });
  }

  async screenshot(tabId: string, input: CamofoxUserInput): Promise<Buffer> {
    const response = await this.rawRequest(`/tabs/${encodeURIComponent(tabId)}/screenshot${query({
      userId: input.userId ?? this.config.defaultUserId,
    })}`, { method: "GET" });
    return Buffer.from(await response.arrayBuffer());
  }

  async closeTab(tabId: string, input: CamofoxUserInput): Promise<CamofoxJson> {
    return this.requestJson<CamofoxJson>(`/tabs/${encodeURIComponent(tabId)}${query({
      userId: input.userId ?? this.config.defaultUserId,
    })}`, { method: "DELETE" });
  }

  private withUser<T extends Record<string, unknown>>(input: T): T & { userId: string } {
    return {
      ...input,
      userId: typeof input.userId === "string" ? input.userId : this.config.defaultUserId,
    };
  }

  private async requestJson<T>(path: string, init: { method: string; body?: Record<string, unknown> }): Promise<T> {
    const response = await this.rawRequest(path, init);
    return response.json() as Promise<T>;
  }

  private async rawRequest(
    path: string,
    init: { method: string; body?: Record<string, unknown> },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.config.accessKey) headers.Authorization = `Bearer ${this.config.accessKey}`;
    if (init.body) headers["Content-Type"] = "application/json";

    const requestInit: RequestInit = {
      headers,
      method: init.method,
    };
    if (init.body) requestInit.body = JSON.stringify(init.body);

    const response = await fetch(`${this.config.baseUrl}${path}`, requestInit);

    if (!response.ok) {
      const detail = redactSecret(await response.text().catch(() => ""), this.config.accessKey);
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Camofox request failed: ${response.status}${suffix}`);
    }

    return response;
  }
}
