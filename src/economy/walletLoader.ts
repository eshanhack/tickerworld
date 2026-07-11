import type { WalletAdapterLoader, WalletClientAdapter } from './walletTypes';

/**
 * The literal dynamic import is intentional: anonymous visitors never request
 * the Solana client chunk, its RPC stack, or Wallet Standard discovery code.
 */
export const loadWalletAdapter: WalletAdapterLoader = async (cluster): Promise<WalletClientAdapter> => {
  const module = await import('./solanaWalletClient');
  return module.createSolanaWalletAdapter(cluster);
};
