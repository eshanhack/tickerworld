import {
  autoDiscover,
  createClient,
  insertReferenceKey,
  toAddress,
  type SolanaClient,
  type WalletSession,
} from '@solana/client';
import type { PurchaseQuote } from '../../shared/src/index.js';
import type { ConnectedWallet, WalletClientAdapter, WalletChoice } from './walletTypes';

class SolanaConnectedWallet implements ConnectedWallet {
  readonly publicKey: string;
  private readonly disconnectListeners = new Set<() => void>();
  private readonly unsubscribeStore: () => void;
  private disconnected = false;

  constructor(
    private readonly client: SolanaClient,
    private readonly session: WalletSession,
    private readonly cluster: PurchaseQuote['cluster'],
  ) {
    this.publicKey = session.account.address.toString();
    this.unsubscribeStore = client.store.subscribe((state) => {
      if (state.wallet.status !== 'disconnected' || this.disconnected) return;
      this.disconnected = true;
      for (const listener of this.disconnectListeners) listener();
    });
  }

  signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.session.signMessage) {
      throw new Error('This wallet does not support secure message signing.');
    }
    return this.session.signMessage(message);
  }

  async payQuote(quote: PurchaseQuote): Promise<string> {
    if (Date.now() >= quote.expiresAt) throw new Error('This quote expired. Request a fresh one.');
    if (quote.cluster !== this.cluster) throw new Error('This quote belongs to a different Solana network.');
    const prepared = await this.client.solTransfer.prepareTransfer({
      amount: BigInt(quote.lamports),
      authority: this.session,
      destination: quote.recipient,
      commitment: 'confirmed',
    });
    const referenced = {
      ...prepared,
      message: insertReferenceKey(toAddress(quote.reference), prepared.message),
    };
    const signature = await this.client.solTransfer.sendPreparedTransfer(referenced, {
      commitment: 'confirmed',
      maxRetries: 3,
    });
    return signature.toString();
  }

  disconnect(): Promise<void> {
    this.unsubscribeStore();
    this.disconnectListeners.clear();
    this.disconnected = true;
    return this.client.actions.disconnectWallet();
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }
}

class SolanaWalletClientAdapter implements WalletClientAdapter {
  readonly choices: readonly WalletChoice[];

  constructor(
    private readonly client: SolanaClient,
    private readonly cluster: PurchaseQuote['cluster'],
  ) {
    this.choices = client.connectors.all
      .filter((connector) => connector.isSupported())
      .map((connector) => ({
        id: connector.id,
        name: connector.name,
        ...(connector.icon ? { icon: connector.icon } : {}),
      }));
  }

  async connect(id: string): Promise<ConnectedWallet> {
    const connector = this.client.connectors.get(id);
    if (!connector || !connector.isSupported()) throw new Error('That wallet is no longer available.');
    const session = await this.client.actions.connectWallet(id, { allowInteractiveFallback: true });
    if (!session.signMessage) {
      await session.disconnect();
      throw new Error('This wallet cannot sign the Tickerworld login message.');
    }
    return new SolanaConnectedWallet(this.client, session, this.cluster);
  }

  dispose(): void {
    this.client.destroy();
  }
}

export async function createSolanaWalletAdapter(
  cluster: 'devnet' | 'mainnet-beta',
): Promise<WalletClientAdapter> {
  const client = createClient({
    cluster: cluster === 'mainnet-beta' ? 'mainnet' : 'devnet',
    walletConnectors: autoDiscover(),
  });
  return new SolanaWalletClientAdapter(client, cluster);
}
