import { afterEach, describe, it, expect, vi } from "vitest";
import tweetnacl from "tweetnacl";
import bs58 from "bs58";
import { 
  verifySolanaWalletSignature, 
  getSolanaNativeBalance, 
  getSPLTokenBalance,
  SOLANA_DEVNET_CONFIG,
  DEVNET_USDC_MINT
} from "./solana-connector";

const nacl = (tweetnacl as any).default || tweetnacl;

// Public test fixtures:
// Use a well-known active address or standard devnet account
const TEST_WALLET = "SRMuAp5y6mCBMWd2LTVJgS1tRRkhA45UNk6MEdTirMM";

describe("Solana Wallet Connector - Signature Verification", () => {
  it("successfully verifies valid Ed25519 signature for a dynamic challenge nonce", async () => {
    // 1. Generate an ephemeral Solana wallet
    const keypair = nacl.sign.keyPair();
    const publicKey = bs58.encode(keypair.publicKey);
    
    const companyId = "c_test";
    const nonce = "test-nonce-solana";
    const message = `Sign this message to connect your wallet to Trent. Company: ${companyId} Nonce: ${nonce}`;
    
    // 2. Sign challenge message
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
    const signature = bs58.encode(signatureBytes);
    
    // 3. Verify on server-side
    const isValid = verifySolanaWalletSignature(publicKey, signature, nonce, companyId);
    expect(isValid).toBe(true);
  });

  it("rejects signature verification when challenge inputs do not match", async () => {
    const keypair = nacl.sign.keyPair();
    const publicKey = bs58.encode(keypair.publicKey);
    const message = `Sign this message to connect your wallet to Trent. Company: c_test Nonce: nonce_A`;
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
    const signature = bs58.encode(signatureBytes);

    // Verify with mismatched nonce
    const isValid = verifySolanaWalletSignature(publicKey, signature, "nonce_B", "c_test");
    expect(isValid).toBe(false);
  });
});

describe("Solana Wallet Connector - Devnet Balance Queries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries native SOL balance for account on Devnet RPC", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { value: 123456789 } }),
    } as Response);

    const balance = await getSolanaNativeBalance(SOLANA_DEVNET_CONFIG.rpcUrl, TEST_WALLET);
    expect(typeof balance).toBe("bigint");
    expect(balance).toBe(123456789n);
  });

  it("queries SPL token balance on Devnet RPC", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          value: [
            {
              account: {
                data: {
                  parsed: {
                    info: {
                      tokenAmount: {
                        amount: "2500000",
                        decimals: 6,
                        uiAmountString: "2.5",
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      }),
    } as Response);

    const result = await getSPLTokenBalance(SOLANA_DEVNET_CONFIG.rpcUrl, DEVNET_USDC_MINT, TEST_WALLET);
    expect(result.balance).toBe(2500000n);
    expect(result.decimals).toBe(6);
    expect(result.formatted).toBe("2.5");
  });
});
