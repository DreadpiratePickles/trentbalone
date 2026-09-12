import { Contract } from "ethers";
import type { Provider } from "ethers";

export const CHAINLINK_FEEDS: Record<string, Record<string, string>> = {
  // Sepolia (11155111)
  "11155111": {
    "ETH/USD": "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    "USDC/USD": "0xA2F78ab2355fe2f91B2853f1766C8E660022d2d1",
  },
  // Ethereum Mainnet (1)
  "1": {
    "ETH/USD": "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    "USDC/USD": "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
  },
};

export const CHAINLINK_AGGREGATOR_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
];

export class ChainlinkFeedStaleError extends Error {
  constructor(public feedAddress: string, public updatedAt: number, public threshold: number) {
    super(`Chainlink feed ${feedAddress} is stale. Last updated: ${new Date(updatedAt * 1000).toISOString()} (threshold: ${threshold}s)`);
    this.name = "ChainlinkFeedStaleError";
  }
}

export class ChainlinkInvalidPriceError extends Error {
  constructor(public feedAddress: string, public answer: bigint) {
    super(`Chainlink feed ${feedAddress} returned invalid price: ${answer.toString()}`);
    this.name = "ChainlinkInvalidPriceError";
  }
}

export class ChainlinkFeedUninitializedError extends Error {
  constructor(public feedAddress: string) {
    super(`Chainlink feed ${feedAddress} is uninitialized`);
    this.name = "ChainlinkFeedUninitializedError";
  }
}

export async function getLatestPrice(
  provider: Provider,
  feedAddress: string,
  stalenessThresholdSeconds = 3600
): Promise<{ price: bigint; decimals: number; updatedAt: number }> {
  const contract = new Contract(feedAddress, CHAINLINK_AGGREGATOR_ABI, provider);

  const [decimals, roundData] = await Promise.all([
    contract.decimals() as Promise<bigint | number>,
    contract.latestRoundData() as Promise<[bigint, bigint, bigint, bigint, bigint]>
  ]);

  const [roundId, answer, , updatedAtBig, ] = roundData;
  const updatedAt = Number(updatedAtBig);

  if (roundId === 0n) {
    throw new ChainlinkFeedUninitializedError(feedAddress);
  }

  if (answer <= 0n) {
    throw new ChainlinkInvalidPriceError(feedAddress, answer);
  }

  const now = Math.floor(Date.now() / 1000);
  if (updatedAt < now - stalenessThresholdSeconds) {
    throw new ChainlinkFeedStaleError(feedAddress, updatedAt, stalenessThresholdSeconds);
  }

  return {
    price: answer,
    decimals: Number(decimals),
    updatedAt
  };
}

export async function getUsdcPerEth(
  provider: Provider,
  chainId: string,
  stalenessThresholdSeconds = 3600
): Promise<number> {
  const chainFeeds = CHAINLINK_FEEDS[chainId];
  if (!chainFeeds) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  const ethAddress = chainFeeds["ETH/USD"];
  const usdcAddress = chainFeeds["USDC/USD"];
  if (!ethAddress || !usdcAddress) {
    throw new Error(`Chain ${chainId} is missing required ETH/USD or USDC/USD feeds`);
  }

  const [ethFeed, usdcFeed] = await Promise.all([
    getLatestPrice(provider, ethAddress, stalenessThresholdSeconds),
    getLatestPrice(provider, usdcAddress, stalenessThresholdSeconds)
  ]);

  const exponent = 6 + usdcFeed.decimals - ethFeed.decimals;
  let target: bigint;
  if (exponent >= 0) {
    target = ethFeed.price * (10n ** BigInt(exponent));
  } else {
    target = ethFeed.price / (10n ** BigInt(-exponent));
  }

  const rateBig = target / usdcFeed.price;
  return Number(rateBig) / 1_000_000;
}
