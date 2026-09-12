import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { 
  verifyEVMWalletSignature, 
  getEVMNativeBalance, 
  getERC20Balance,
  SEPOLIA_CONFIG 
} from "./evm-connector";

// Public test fixtures on Sepolia:
const TEST_WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // Standard Sepolia USDC contract

describe("EVM Wallet Connector - Signature Verification", () => {
  it("successfully verifies valid signature for a dynamic challenge nonce", async () => {
    // 1. Generate an ephemeral wallet
    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address;
    const companyId = "c_test";
    const nonce = "test-nonce-12345";
    const message = `Sign this message to connect your wallet to Trent. Company: ${companyId} Nonce: ${nonce}`;
    
    // 2. Sign challenge message
    const signature = await wallet.signMessage(message);
    
    // 3. Verify on server-side
    const isValid = verifyEVMWalletSignature(address, signature, nonce, companyId);
    expect(isValid).toBe(true);
  });

  it("rejects signature verification when challenge inputs do not match", async () => {
    const wallet = ethers.Wallet.createRandom();
    const address = wallet.address;
    const message = `Sign this message to connect your wallet to Trent. Company: c_test Nonce: nonce_A`;
    const signature = await wallet.signMessage(message);

    // Verify with mismatched nonce
    const isValid = verifyEVMWalletSignature(address, signature, "nonce_B", "c_test");
    expect(isValid).toBe(false);
  });
});

describe("EVM Wallet Connector - Sepolia Balance Queries", () => {
  it("queries native ETH balance for vitalik.eth on Sepolia RPC", async () => {
    const balance = await getEVMNativeBalance(SEPOLIA_CONFIG.rpcUrl, TEST_WALLET);
    expect(typeof balance).toBe("bigint");
    expect(balance).toBeGreaterThanOrEqual(0n);
  });

  it("queries ERC-20 USDC balance on Sepolia RPC", async () => {
    const result = await getERC20Balance(SEPOLIA_CONFIG.rpcUrl, SEPOLIA_USDC, TEST_WALLET);
    expect(typeof result.balance).toBe("bigint");
    expect(result.decimals).toBe(6);
    expect(typeof result.formatted).toBe("string");
  });
});
