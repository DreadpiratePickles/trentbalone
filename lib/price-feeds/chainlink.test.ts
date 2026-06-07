/**
 * lib/price-feeds/chainlink.test.ts
 *
 * TDD for ChainlinkPriceFeed adapter.
 * All unit tests use injected mock providers — no real RPC calls.
 * The live Sepolia integration test is skipped unless SEPOLIA_RPC_URL is set.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import {
  getLatestPrice,
  getUsdcPerEth,
  CHAINLINK_FEEDS,
  ChainlinkFeedStaleError,
  ChainlinkInvalidPriceError,
  ChainlinkFeedUninitializedError,
} from "./chainlink";

// ─── Mock provider factory ────────────────────────────────────────────────────
// Returns an ethers.Provider stand-in whose contract calls return controlled data.

function makeMockProvider(feeds: Record<string, { roundId: bigint; answer: bigint; updatedAt: number; decimals: number }>) {
  // We mock ethers.Contract at the module level so the chainlink adapter picks it up.
  return feeds;
}

// We'll intercept ethers.Contract via vi.mock so the adapter under test uses our data.

const mockFeedData: Record<string, { roundId: bigint; answer: bigint; updatedAt: bigint; decimals: number }> = {};

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  return {
    ...actual,
    Contract: vi.fn().mockImplementation((_address: string, _abi: unknown, _provider: unknown) => ({
      latestRoundData: vi.fn(async () => {
        const d = mockFeedData[_address as string];
        if (!d) throw new Error(`No mock data for feed ${_address}`);
        return [d.roundId, d.answer, 0n, d.updatedAt, d.roundId];
      }),
      decimals: vi.fn(async () => {
        const d = mockFeedData[_address as string];
        if (!d) throw new Error(`No mock data for feed ${_address}`);
        return d.decimals;
      }),
    })),
    JsonRpcProvider: actual.JsonRpcProvider,
  };
});

// Helper: produce a fresh updatedAt that is `ageSeconds` old
function updatedAtOffset(ageSeconds: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000) - ageSeconds);
}

const FAKE_PROVIDER = {} as ethers.Provider;
const ETH_USD_SEPOLIA = CHAINLINK_FEEDS["11155111"]!["ETH/USD"]!;
const USDC_USD_SEPOLIA = CHAINLINK_FEEDS["11155111"]!["USDC/USD"]!;

// ─── getLatestPrice ───────────────────────────────────────────────────────────

describe("getLatestPrice", () => {
  beforeEach(() => {
    // Clear mock state
    for (const key of Object.keys(mockFeedData)) delete mockFeedData[key];
    vi.clearAllMocks();
  });

  it("returns price, decimals, and updatedAt for a valid fresh feed", async () => {
    const now = updatedAtOffset(0);
    mockFeedData[ETH_USD_SEPOLIA] = { roundId: 1n, answer: 3000_00000000n /* 3000.00 * 1e8 */, updatedAt: now, decimals: 8 };

    const result = await getLatestPrice(FAKE_PROVIDER, ETH_USD_SEPOLIA);

    expect(result.price).toBe(3000_00000000n);
    expect(result.decimals).toBe(8);
    expect(result.updatedAt).toBe(Number(now));
  });

  it("throws ChainlinkFeedStaleError when feed is older than threshold", async () => {
    const staleAge = 7200; // 2 hours old
    mockFeedData[ETH_USD_SEPOLIA] = { roundId: 1n, answer: 3000_00000000n, updatedAt: updatedAtOffset(staleAge), decimals: 8 };

    await expect(
      getLatestPrice(FAKE_PROVIDER, ETH_USD_SEPOLIA, 3600)
    ).rejects.toThrow(ChainlinkFeedStaleError);
  });

  it("does not throw when feed age is exactly at the threshold boundary", async () => {
    // updatedAt = now - 3600 + 1 (just within threshold)
    mockFeedData[ETH_USD_SEPOLIA] = { roundId: 1n, answer: 3000_00000000n, updatedAt: updatedAtOffset(3599), decimals: 8 };

    await expect(
      getLatestPrice(FAKE_PROVIDER, ETH_USD_SEPOLIA, 3600)
    ).resolves.toBeDefined();
  });

  it("throws ChainlinkInvalidPriceError when answer is zero", async () => {
    mockFeedData[ETH_USD_SEPOLIA] = { roundId: 1n, answer: 0n, updatedAt: updatedAtOffset(0), decimals: 8 };

    await expect(
      getLatestPrice(FAKE_PROVIDER, ETH_USD_SEPOLIA)
    ).rejects.toThrow(ChainlinkInvalidPriceError);
  });

  it("throws ChainlinkInvalidPriceError when answer is negative", async () => {
    mockFeedData[ETH_USD_SEPOLIA] = { roundId: 1n, answer: -1n, updatedAt: updatedAtOffset(0), decimals: 8 };

    await expect(
      getLatestPrice(FAKE_PROVIDER, ETH_USD_SEPOLIA)
    ).rejects.toThrow(ChainlinkInvalidPriceError);
  });

  it("throws ChainlinkFeedUninitializedError when roundId is 0", async () => {
    mockFeedData[ETH_USD_SEPOLIA] = { roundId: 0n, answer: 3000_00000000n, updatedAt: updatedAtOffset(0), decimals: 8 };

    await expect(
      getLatestPrice(FAKE_PROVIDER, ETH_USD_SEPOLIA)
    ).rejects.toThrow(ChainlinkFeedUninitializedError);
  });
});

// ─── getUsdcPerEth ────────────────────────────────────────────────────────────

describe("getUsdcPerEth", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockFeedData)) delete mockFeedData[key];
    vi.clearAllMocks();
  });

  it("correctly computes USDC per ETH from ETH/USD ÷ USDC/USD", async () => {
    // ETH/USD = 3000.00 (8 decimals)
    // USDC/USD = 1.0001 (8 decimals) — USDC trades at a slight premium
    // Expected: 3000 / 1.0001 ≈ 2999.7 USDC per ETH
    mockFeedData[ETH_USD_SEPOLIA] = { roundId: 1n, answer: 3000_00000000n, updatedAt: updatedAtOffset(0), decimals: 8 };
    mockFeedData[USDC_USD_SEPOLIA] = { roundId: 1n, answer: 1_00010000n, updatedAt: updatedAtOffset(0), decimals: 8 };

    const usdcPerEth = await getUsdcPerEth(FAKE_PROVIDER, "11155111");

    // Should be approximately 2999.7 with 6-decimal precision
    expect(usdcPerEth).toBeGreaterThan(2999);
    expect(usdcPerEth).toBeLessThan(3001);
  });

  it("throws when ETH/USD feed is stale (propagates ChainlinkFeedStaleError)", async () => {
    mockFeedData[ETH_USD_SEPOLIA] = { roundId: 1n, answer: 3000_00000000n, updatedAt: updatedAtOffset(7200), decimals: 8 };
    mockFeedData[USDC_USD_SEPOLIA] = { roundId: 1n, answer: 1_00000000n, updatedAt: updatedAtOffset(0), decimals: 8 };

    await expect(
      getUsdcPerEth(FAKE_PROVIDER, "11155111", 3600)
    ).rejects.toThrow(ChainlinkFeedStaleError);
  });

  it("throws when USDC/USD feed is stale (propagates ChainlinkFeedStaleError)", async () => {
    mockFeedData[ETH_USD_SEPOLIA] = { roundId: 1n, answer: 3000_00000000n, updatedAt: updatedAtOffset(0), decimals: 8 };
    mockFeedData[USDC_USD_SEPOLIA] = { roundId: 1n, answer: 1_00000000n, updatedAt: updatedAtOffset(7200), decimals: 8 };

    await expect(
      getUsdcPerEth(FAKE_PROVIDER, "11155111", 3600)
    ).rejects.toThrow(ChainlinkFeedStaleError);
  });

  it("throws for an unsupported chainId", async () => {
    await expect(
      getUsdcPerEth(FAKE_PROVIDER, "999999")
    ).rejects.toThrow(/unsupported chain/i);
  });
});

// ─── Live Sepolia integration test ────────────────────────────────────────────
// Skipped unless SEPOLIA_RPC_URL env var is set.

describe.skipIf(!process.env.SEPOLIA_RPC_URL)("Chainlink — Sepolia live integration", () => {
  it("reads a fresh ETH/USD price from Sepolia RPC", async () => {
    const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const result = await getLatestPrice(provider, ETH_USD_SEPOLIA, 7200);

    expect(result.price).toBeGreaterThan(0n);
    expect(result.decimals).toBe(8);
    // updatedAt should be within the last 2 hours
    const ageSeconds = Math.floor(Date.now() / 1000) - result.updatedAt;
    expect(ageSeconds).toBeLessThan(7200);
  });

  it("derives a sensible USDC/ETH rate on Sepolia", async () => {
    const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const rate = await getUsdcPerEth(provider, "11155111", 7200);

    // ETH price should be somewhere between $500 and $50,000 for this test to be meaningful
    expect(rate).toBeGreaterThan(500);
    expect(rate).toBeLessThan(50000);
  });
});
