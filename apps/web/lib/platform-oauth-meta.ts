export type MetaOAuthSecretConfig = {
  clientIdEnv: string;
  clientSecretEnv?: string;
};

export type MetaOAuthResolvedAccount = {
  externalAccountId: string;
  accessToken?: string;
  externalHandle?: string;
  displayName?: string;
  externalBusinessId?: string;
  currency?: string;
};

type MetaPageAccountsResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    access_token?: string;
    instagram_business_account?: {
      id?: string;
      username?: string;
    };
  }>;
};

type MetaAdAccountsResponse = {
  data?: Array<{
    id?: string;
    account_id?: string;
    name?: string;
    currency?: string;
    account_status?: number;
    business?: {
      id?: string;
      name?: string;
    };
  }>;
};

export async function discoverMetaSocialAccount(input: {
  platform: "facebook" | "instagram";
  accessToken: string;
  config: MetaOAuthSecretConfig;
  fetchImpl: typeof fetch;
}): Promise<MetaOAuthResolvedAccount> {
  const json = await fetchMetaJson<MetaPageAccountsResponse>({
    path: "me/accounts",
    fields: "id,name,access_token,instagram_business_account{id,username}",
    accessToken: input.accessToken,
    config: input.config,
    fetchImpl: input.fetchImpl,
    label: "Meta account discovery",
  });
  const pages = Array.isArray(json.data) ? json.data : [];
  if (input.platform === "facebook") {
    const page = pages.find((item) => typeof item.id === "string" && item.id.trim());
    if (!page?.id) {
      throw new Error("OAuth callback could not determine Facebook Page externalAccountId; grant pages_show_list or provide externalAccountId at start.");
    }
    return {
      externalAccountId: page.id.trim(),
      accessToken: optionalText(page.access_token) ?? input.accessToken,
      displayName: optionalText(page.name),
    };
  }

  const page = pages.find((item) => typeof item.instagram_business_account?.id === "string" && item.instagram_business_account.id.trim());
  const instagram = page?.instagram_business_account;
  if (!instagram?.id) {
    throw new Error("OAuth callback could not determine Instagram business account; connect a Facebook Page with instagram_business_account or provide externalAccountId at start.");
  }
  return {
    externalAccountId: instagram.id.trim(),
    accessToken: optionalText(page?.access_token) ?? input.accessToken,
    externalHandle: optionalText(instagram.username),
    displayName: optionalText(page?.name),
  };
}

export async function discoverMetaAdAccount(input: {
  accessToken: string;
  config: MetaOAuthSecretConfig;
  fetchImpl: typeof fetch;
}): Promise<MetaOAuthResolvedAccount> {
  const json = await fetchMetaJson<MetaAdAccountsResponse>({
    path: "me/adaccounts",
    fields: "id,account_id,name,currency,account_status,business{id,name}",
    accessToken: input.accessToken,
    config: input.config,
    fetchImpl: input.fetchImpl,
    label: "Meta ad account discovery",
  });
  const accounts = Array.isArray(json.data) ? json.data : [];
  const account = accounts.find((item) => Boolean(optionalText(item.id) ?? optionalText(item.account_id)));
  const rawId = optionalText(account?.id) ?? optionalText(account?.account_id);
  if (!rawId) {
    throw new Error("OAuth callback could not determine Meta ad account externalAccountId; grant ads_read or provide externalAccountId at start.");
  }
  return {
    externalAccountId: normalizeMetaAdAccountId(rawId),
    accessToken: input.accessToken,
    displayName: optionalText(account?.name),
    externalBusinessId: optionalText(account?.business?.id),
    currency: optionalText(account?.currency)?.toUpperCase(),
  };
}

async function fetchMetaJson<T>(input: {
  path: string;
  fields: string;
  accessToken: string;
  config: MetaOAuthSecretConfig;
  fetchImpl: typeof fetch;
  label: string;
}): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${metaGraphVersion()}/${input.path}`);
  url.searchParams.set("fields", input.fields);
  const response = await input.fetchImpl(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${input.label} failed (${response.status}): ${scrubProviderSecrets(text, input.config, [input.accessToken])}`);
  }
  return await response.json() as T;
}

function normalizeMetaAdAccountId(value: string) {
  const id = value.trim();
  return id.startsWith("act_") ? id : `act_${id}`;
}

function metaGraphVersion() {
  return (process.env.META_GRAPH_VERSION ?? "v20.0").replace(/^\/+|\/+$/g, "");
}

function scrubProviderSecrets(text: string, config: MetaOAuthSecretConfig, extraSecrets: string[] = []) {
  let scrubbed = text;
  for (const key of [config.clientIdEnv, config.clientSecretEnv].filter((item): item is string => Boolean(item))) {
    const value = process.env[key];
    if (value && value.length >= 8) scrubbed = scrubbed.split(value).join("[REDACTED]");
  }
  for (const value of extraSecrets) {
    if (value.length >= 8) scrubbed = scrubbed.split(value).join("[REDACTED]");
  }
  return scrubbed;
}

function optionalText(value: string | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
