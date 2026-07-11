import type { PurchaseQuote } from '../../shared/src/index.js';

export interface WalletChoice {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
}

export interface ConnectedWallet {
  readonly publicKey: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  payQuote(quote: PurchaseQuote): Promise<string>;
  disconnect(): Promise<void>;
  onDisconnect?(listener: () => void): () => void;
}

export interface WalletClientAdapter {
  readonly choices: readonly WalletChoice[];
  connect(id: string): Promise<ConnectedWallet>;
  dispose(): void;
}

export type WalletAdapterLoader = (
  cluster: 'devnet' | 'mainnet-beta',
) => Promise<WalletClientAdapter>;
