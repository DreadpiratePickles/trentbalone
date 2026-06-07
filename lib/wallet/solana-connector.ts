import tweetnacl from "tweetnacl";
import bs58 from "bs58";

const nacl = (tweetnacl as any).default || tweetnacl;

export interface SolanaNetworkConfig {
  network: "mainnet-beta" | "devnet";
  rpcUrl: string;
}

export const SOLANA_DEVNET_CONFIG: SolanaNetworkConfig = {
  network: "devnet",
  rpcUrl: "https://api.devnet.solana.com"
};

export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export class SolanaWalletNotInstalledError extends Error {
  constructor(provider: string) {
    super(`${provider} wallet is not installed or not available in the window context.`);
    this.name = "SolanaWalletNotInstalledError";
  }
}

// ─── Client-Side Solana Helpers (Browser-Only) ───────────────────────────────

export function isSolanaWalletInstalled(provider: "phantom" | "solflare"): boolean {
  if (typeof window === "undefined") return false;
  const ethWindow = window as any;
  if (provider === "phantom") {
    return typeof ethWindow.solana !== "undefined" && ethWindow.solana.isPhantom;
  } else {
    return typeof ethWindow.solflare !== "undefined";
  }
}

export async function connectSolanaWallet(provider: "phantom" | "solflare"): Promise<string> {
  if (!isSolanaWalletInstalled(provider)) {
    throw new SolanaWalletNotInstalledError(provider);
  }
  const ethWindow = window as any;
  const wallet = provider === "phantom" ? ethWindow.solana : ethWindow.solflare;
  
  const response = await wallet.connect();
  const pubKey = response.publicKey ? response.publicKey.toString() : wallet.publicKey?.toString();
  if (!pubKey) {
    throw new Error(`Failed to resolve public key from ${provider} wallet.`);
  }
  return pubKey;
}

export async function signSolanaChallenge(
  provider: "phantom" | "solflare",
  address: string,
  challengeMessage: string
): Promise<string> {
  if (!isSolanaWalletInstalled(provider)) {
    throw new SolanaWalletNotInstalledError(provider);
  }
  const ethWindow = window as any;
  const wallet = provider === "phantom" ? ethWindow.solana : ethWindow.solflare;
  
  const encodedMessage = new TextEncoder().encode(challengeMessage);
  const result = await wallet.signMessage(encodedMessage, "utf8");
  
  const signatureBytes = result.signature || result;
  if (!signatureBytes) {
    throw new Error(`Failed to extract signature from ${provider} signing result.`);
  }
  
  return bs58.encode(signatureBytes);
}

// ─── Server-Side RPC & Verification Helpers ───────────────────────────────────

export function verifySolanaWalletSignature(
  publicKey: string,
  signature: string,
  nonce: string,
  companyId: string
): boolean {
  try {
    const message = `Sign this message to connect your wallet to Trent. Company: ${companyId} Nonce: ${nonce}`;
    const messageBytes = new TextEncoder().encode(message);
    const publicKeyBytes = bs58.decode(publicKey);
    const signatureBytes = bs58.decode(signature);

    if (signatureBytes.length !== 64) return false;
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

async function postJsonRpc(rpcUrl: string, method: string, params: any[]): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });
  
  if (!res.ok) {
    throw new Error(`Solana RPC fetch failed with HTTP status ${res.status}`);
  }
  
  const body = await res.json();
  if (body.error) {
    throw new Error(`Solana RPC error: ${body.error.message || JSON.stringify(body.error)}`);
  }
  
  return body.result;
}

export async function getSolanaNativeBalance(
  rpcUrl: string,
  publicKey: string
): Promise<bigint> {
  const result = await postJsonRpc(rpcUrl, "getBalance", [publicKey]);
  if (!result || typeof result.value === "undefined") {
    throw new Error("Invalid balance response from Solana RPC.");
  }
  return BigInt(result.value);
}

export async function getSPLTokenBalance(
  rpcUrl: string,
  mintAddress: string,
  publicKey: string
): Promise<{ balance: bigint; decimals: number; formatted: string }> {
  const result = await postJsonRpc(rpcUrl, "getTokenAccountsByOwner", [
    publicKey,
    { mint: mintAddress },
    { encoding: "jsonParsed" }
  ]);

  if (!result || !Array.isArray(result.value) || result.value.length === 0) {
    return {
      balance: 0n,
      decimals: 6,
      formatted: "0.0"
    };
  }

  const accountInfo = result.value[0]?.account?.data?.parsed?.info?.tokenAmount;
  if (!accountInfo) {
    return {
      balance: 0n,
      decimals: 6,
      formatted: "0.0"
    };
  }

  return {
    balance: BigInt(accountInfo.amount || 0),
    decimals: Number(accountInfo.decimals || 6),
    formatted: accountInfo.uiAmountString || "0.0"
  };
}

