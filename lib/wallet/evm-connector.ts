import { ethers } from "ethers";

export interface EVMNetworkConfig {
  chainId: string;
  chainName: string;
  rpcUrl: string;
  blockExplorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

export const SEPOLIA_CONFIG: EVMNetworkConfig = {
  chainId: "0xaa36a7", // 11155111
  chainName: "Sepolia Test Network",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  blockExplorerUrl: "https://sepolia.etherscan.io",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }
};

export class MetaMaskNotInstalledError extends Error {
  constructor() {
    super("MetaMask is not installed or not available in the window context.");
    this.name = "MetaMaskNotInstalledError";
  }
}

export class ChainSwitchError extends Error {
  constructor(message: string) {
    super(`Failed to switch active network: ${message}`);
    this.name = "ChainSwitchError";
  }
}

// ─── Client-Side MetaMask Helpers (Browser-Only) ─────────────────────────────

export function isMetaMaskInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return typeof (window as any).ethereum !== "undefined";
}

export async function connectEVMWallet(): Promise<string> {
  if (!isMetaMaskInstalled()) throw new MetaMaskNotInstalledError();
  const accounts = await (window as any).ethereum.request({ method: "eth_requestAccounts" });
  if (!accounts || accounts.length === 0) {
    throw new Error("No EVM accounts connected.");
  }
  return accounts[0]!;
}

export async function switchEVMChain(config: EVMNetworkConfig): Promise<void> {
  if (!isMetaMaskInstalled()) throw new MetaMaskNotInstalledError();
  try {
    await (window as any).ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: config.chainId }],
    });
  } catch (switchError: any) {
    // 4902 error code indicates that the chain has not been added to MetaMask
    if (switchError.code === 4902) {
      try {
        await (window as any).ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: config.chainId,
              chainName: config.chainName,
              rpcUrls: [config.rpcUrl],
              blockExplorerUrls: [config.blockExplorerUrl],
              nativeCurrency: config.nativeCurrency,
            },
          ],
        });
      } catch (addError: any) {
        throw new ChainSwitchError(addError.message || "Failed to add network.");
      }
    } else {
      throw new ChainSwitchError(switchError.message || "Failed to switch network.");
    }
  }
}

export async function signEVMChallenge(address: string, challengeMessage: string): Promise<string> {
  if (!isMetaMaskInstalled()) throw new MetaMaskNotInstalledError();
  const hexMessage = `0x${Buffer.from(challengeMessage, "utf8").toString("hex")}`;
  const signature = await (window as any).ethereum.request({
    method: "personal_sign",
    params: [hexMessage, address],
  });
  return signature;
}

export function registerMetaMaskListeners(
  onAccountChange: (account: string | null) => void,
  onChainChange: (chainId: string) => void
): () => void {
  if (!isMetaMaskInstalled()) return () => {};

  const handleAccounts = (accounts: string[]) => {
    onAccountChange(accounts[0] || null);
  };

  const handleChain = (chainId: string) => {
    onChainChange(chainId);
  };

  const eth = (window as any).ethereum;
  eth.on("accountsChanged", handleAccounts);
  eth.on("chainChanged", handleChain);

  return () => {
    eth.removeListener("accountsChanged", handleAccounts);
    eth.removeListener("chainChanged", handleChain);
  };
}

// ─── Server-Side RPC & Verification Helpers ───────────────────────────────

export function verifyEVMWalletSignature(
  address: string,
  signature: string,
  nonce: string,
  companyId: string
): boolean {
  try {
    const message = `Sign this message to connect your wallet to Trent. Company: ${companyId} Nonce: ${nonce}`;
    const signerAddress = ethers.verifyMessage(message, signature);
    return signerAddress.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}

export async function getEVMNativeBalance(
  rpcUrl: string,
  walletAddress: string
): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const balance = await provider.getBalance(walletAddress);
  return balance;
}

export async function getERC20Balance(
  rpcUrl: string,
  tokenAddress: string,
  walletAddress: string
): Promise<{ balance: bigint; decimals: number; formatted: string }> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(
    tokenAddress,
    [
      "function balanceOf(address owner) view returns (uint256)",
      "function decimals() view returns (uint8)"
    ],
    provider
  );

  const [rawBalance, rawDecimals] = await Promise.all([
    contract.balanceOf(walletAddress) as Promise<bigint>,
    contract.decimals() as Promise<bigint | number>
  ]);

  const decimals = Number(rawDecimals);

  const formatted = ethers.formatUnits(rawBalance, decimals);

  return {
    balance: rawBalance,
    decimals,
    formatted
  };
}

