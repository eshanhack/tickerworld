import {
  ANIMAL_KINDS,
  type AccountProfile,
  type AnimalKind,
  type EntitlementSku,
  type MarketSlug,
  type SkinId,
} from '../../shared/src/index.js';
import type { GameSystem } from '../types';
import { EconomyApi, EconomyApiError, type EconomyApiContract } from './EconomyApi';
import { PREMIUM_SKIN_CATALOG, USERNAME_CLAIM_USD_CENTS } from './catalog';
import { loadWalletAdapter } from './walletLoader';
import {
  pollPendingPurchase,
  readPendingPurchases,
  removePendingPurchase,
  upsertPendingPurchase,
  type PendingPurchaseRecord,
} from './paymentPolling';
import type { ConnectedWallet, WalletAdapterLoader, WalletClientAdapter } from './walletTypes';
import './economy.css';

export interface EconomySystemOptions {
  readonly root: HTMLElement;
  readonly actorId: string | (() => string);
  readonly anonymousAnimal: AnimalKind | (() => AnimalKind);
  readonly market: () => MarketSlug;
  readonly api?: EconomyApiContract;
  readonly anonymousToken?: () => string | null;
  readonly walletLoader?: WalletAdapterLoader;
  /** Persistent public transaction reference used to resume chain settlement. */
  readonly pendingPurchaseStorage?: Storage | null;
  readonly cluster?: 'devnet' | 'mainnet-beta';
  readonly onAppearanceChange?: (animal: AnimalKind, skin: SkinId) => void;
  readonly onAnonymousAppearance?: (animal: AnimalKind) => void;
  /** Awaited before paid/anonymous presentation is committed locally. */
  readonly onProfileChange?: (
    profile: AccountProfile | null,
    sessionToken: string | null,
  ) => boolean | Promise<boolean>;
  readonly onBlocksLoaded?: (actorIds: readonly string[]) => void;
  readonly onInteractionChange?: (active: boolean) => void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}

function title(value: string): string {
  if (value === 'saylor') return 'Michael Saylor';
  return value.split('-').map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isTerminalPaymentError(error: unknown): boolean {
  return error instanceof EconomyApiError && [
    'payment_invalid',
    'quote_expired',
    'quote_consumed',
    'quote_not_found',
    'signature_reused',
  ].includes(error.code);
}

export class EconomySystem implements GameSystem {
  private readonly root: HTMLElement;
  private readonly options: EconomySystemOptions;
  private readonly api: EconomyApiContract;
  private readonly walletLoader: WalletAdapterLoader;
  private readonly pendingPurchaseStorage: Storage | null;
  private readonly cluster: 'devnet' | 'mainnet-beta';
  private readonly toggle: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly connection: HTMLElement;
  private readonly walletSelect: HTMLSelectElement;
  private readonly connectButton: HTMLButtonElement;
  private readonly disconnectButton: HTMLButtonElement;
  private readonly animalGrid: HTMLElement;
  private readonly skinGrid: HTMLElement;
  private readonly usernameForm: HTMLFormElement;
  private readonly usernameInput: HTMLInputElement;
  private readonly usernameButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private profile: AccountProfile | null = null;
  private walletAdapter: WalletClientAdapter | null = null;
  private wallet: ConnectedWallet | null = null;
  private removeWalletDisconnectListener: (() => void) | null = null;
  private busy = false;
  private visible = true;
  private disposed = false;
  private pendingLastMarket: MarketSlug | null = null;
  private syncingLastMarket = false;

  private get actorId(): string {
    return typeof this.options.actorId === 'function' ? this.options.actorId() : this.options.actorId;
  }

  private get anonymousAnimal(): AnimalKind {
    return typeof this.options.anonymousAnimal === 'function'
      ? this.options.anonymousAnimal()
      : this.options.anonymousAnimal;
  }

  constructor(options: EconomySystemOptions) {
    this.options = options;
    this.root = options.root;
    this.api = options.api ?? new EconomyApi({ anonymousToken: options.anonymousToken });
    this.walletLoader = options.walletLoader ?? loadWalletAdapter;
    this.pendingPurchaseStorage = options.pendingPurchaseStorage === undefined
      ? safeLocalStorage()
      : options.pendingPurchaseStorage;
    this.cluster = options.cluster ?? (import.meta.env.PROD ? 'mainnet-beta' : 'devnet');
    this.root.classList.add('tickerworld-economy');
    this.root.innerHTML = `
      <button class="economy-toggle" type="button" aria-label="Open identity and wardrobe" data-economy-toggle><span>◇</span><strong>You</strong></button>
      <section class="economy-panel is-hidden" aria-label="Identity and wardrobe" data-economy-panel>
        <header><div><small>YOUR LITTLE SELF</small><h2>Identity & wardrobe</h2></div><button type="button" aria-label="Close wardrobe" data-economy-close>×</button></header>
        <div class="economy-connection">
          <div><strong data-economy-connection>Wandering anonymously</strong><small>Wallets are optional. Markets and chat stay free.</small></div>
          <select class="is-hidden" aria-label="Choose wallet" data-wallet-select></select>
          <button type="button" data-wallet-connect>Connect wallet</button>
          <button class="is-hidden" type="button" data-wallet-disconnect>Disconnect</button>
        </div>
        <section><h3>Choose an animal <small>free with wallet</small></h3><div class="economy-animal-grid" data-animal-grid></div></section>
        <section><h3>Magical palettes <small>$6 · yours forever</small></h3><div class="economy-skin-grid" data-skin-grid></div></section>
        <form class="economy-username" data-username-form>
          <h3>Your name <small>$${(USERNAME_CLAIM_USD_CENTS / 100).toFixed(0)} · one-time</small></h3>
          <div><input type="text" pattern="[A-Za-z0-9_]{3,16}" minlength="3" maxlength="16" autocomplete="off" placeholder="3–16 letters, numbers, _" data-username-input /><button type="submit" data-username-button>Claim name</button></div>
        </form>
        <p class="economy-status" role="status" aria-live="polite" data-economy-status></p>
        <footer>Expression only · no gameplay advantage · SOL settlement</footer>
      </section>
    `;
    this.toggle = this.required<HTMLButtonElement>('[data-economy-toggle]');
    this.panel = this.required('[data-economy-panel]');
    this.closeButton = this.required<HTMLButtonElement>('[data-economy-close]');
    this.connection = this.required('[data-economy-connection]');
    this.walletSelect = this.required<HTMLSelectElement>('[data-wallet-select]');
    this.connectButton = this.required<HTMLButtonElement>('[data-wallet-connect]');
    this.disconnectButton = this.required<HTMLButtonElement>('[data-wallet-disconnect]');
    this.animalGrid = this.required('[data-animal-grid]');
    this.skinGrid = this.required('[data-skin-grid]');
    this.usernameForm = this.required<HTMLFormElement>('[data-username-form]');
    this.usernameInput = this.required<HTMLInputElement>('[data-username-input]');
    this.usernameButton = this.required<HTMLButtonElement>('[data-username-button]');
    this.status = this.required('[data-economy-status]');
    this.renderCatalogs();
    this.renderProfile();

    this.toggle.addEventListener('click', this.togglePanel);
    this.closeButton.addEventListener('click', this.closePanel);
    this.connectButton.addEventListener('click', this.connectWallet);
    this.disconnectButton.addEventListener('click', this.disconnectWallet);
    this.walletSelect.addEventListener('change', this.updateConnectLabel);
    this.animalGrid.addEventListener('click', this.chooseAnimal);
    this.skinGrid.addEventListener('click', this.chooseOrPurchaseSkin);
    this.usernameForm.addEventListener('submit', this.claimUsername);
    this.root.addEventListener('pointerdown', this.stopCanvasInput);
    this.root.addEventListener('pointermove', this.stopCanvasInput);
    this.root.addEventListener('pointerup', this.stopCanvasInput);
    this.root.addEventListener('wheel', this.stopCanvasInput);
    void this.restoreSession();
  }

  get accountProfile(): AccountProfile | null {
    return this.profile;
  }

  get sessionToken(): string | null {
    return this.api.sessionToken;
  }

  async persistBlock(actorId: string, blocked: boolean): Promise<void> {
    if (!this.profile) return;
    await this.api.setBlock(actorId, blocked);
  }

  /** Coalesces rapid portal travel and never disturbs the active appearance. */
  syncLastMarket(market: MarketSlug): void {
    if (this.disposed || !this.profile || !this.api.sessionToken) return;
    if (this.profile.lastMarket === market && this.pendingLastMarket === null) return;
    this.pendingLastMarket = market;
    void this.flushLastMarket();
  }

  update(): void {
    // UI and wallet flows are event-driven.
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.classList.toggle('is-hidden', !visible);
    if (!visible) this.closePanel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.toggle.removeEventListener('click', this.togglePanel);
    this.closeButton.removeEventListener('click', this.closePanel);
    this.connectButton.removeEventListener('click', this.connectWallet);
    this.disconnectButton.removeEventListener('click', this.disconnectWallet);
    this.walletSelect.removeEventListener('change', this.updateConnectLabel);
    this.animalGrid.removeEventListener('click', this.chooseAnimal);
    this.skinGrid.removeEventListener('click', this.chooseOrPurchaseSkin);
    this.usernameForm.removeEventListener('submit', this.claimUsername);
    this.root.removeEventListener('pointerdown', this.stopCanvasInput);
    this.root.removeEventListener('pointermove', this.stopCanvasInput);
    this.root.removeEventListener('pointerup', this.stopCanvasInput);
    this.root.removeEventListener('wheel', this.stopCanvasInput);
    void this.wallet?.disconnect().catch(() => undefined);
    this.removeWalletDisconnectListener?.();
    this.removeWalletDisconnectListener = null;
    this.walletAdapter?.dispose();
    this.wallet = null;
    this.walletAdapter = null;
    this.pendingLastMarket = null;
    this.options.onInteractionChange?.(false);
    this.root.replaceChildren();
    this.root.classList.remove('tickerworld-economy');
  }

  private async restoreSession(): Promise<void> {
    if (!this.api.sessionToken) return;
    try {
      const [profile, blocks] = await Promise.all([this.api.getProfile(), this.api.getBlocks()]);
      if (this.disposed) return;
      if (!await this.applyProfile(profile)) {
        throw new Error('The restored account could not safely join this room.');
      }
      this.options.onBlocksLoaded?.(blocks);
      this.setStatus('Account restored. Connect the same wallet to make changes.');
      await this.resumePendingPurchase();
    } catch {
      this.api.setSessionToken(null);
      if (!this.disposed && !await this.applyProfile(null).catch(() => false)) this.commitProfile(null);
    }
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const result = this.root.querySelector<T>(selector);
    if (!result) throw new Error(`Tickerworld economy UI is missing ${selector}`);
    return result;
  }

  private renderCatalogs(): void {
    for (const animal of ANIMAL_KINDS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.animal = animal;
      button.innerHTML = `<span class="animal-sigil ${animal}" aria-hidden="true"></span><strong>${title(animal)}</strong>`;
      this.animalGrid.append(button);
    }
    for (const skin of PREMIUM_SKIN_CATALOG) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.skin = skin.id;
      button.style.setProperty('--skin-a', `#${skin.colors[0].toString(16).padStart(6, '0')}`);
      button.style.setProperty('--skin-b', `#${skin.colors[1].toString(16).padStart(6, '0')}`);
      button.style.setProperty('--skin-c', `#${skin.colors[2].toString(16).padStart(6, '0')}`);
      button.innerHTML = `<span class="skin-swatch" aria-hidden="true"></span><strong>${skin.name}</strong><small data-skin-state>$6</small>`;
      this.skinGrid.append(button);
    }
  }

  private renderProfile(): void {
    const connected = this.profile !== null;
    this.connection.textContent = connected
      ? this.profile!.username ?? `Connected ${title(this.profile!.selectedAnimal)}`
      : 'Wandering anonymously';
    this.disconnectButton.classList.toggle('is-hidden', !connected);
    this.connectButton.classList.toggle('is-hidden', connected && this.wallet !== null);
    for (const button of this.animalGrid.querySelectorAll<HTMLButtonElement>('[data-animal]')) {
      button.disabled = !connected || this.busy;
      button.classList.toggle('is-selected', this.profile?.selectedAnimal === button.dataset.animal);
    }
    const owned = new Set(this.profile?.entitlements ?? []);
    for (const button of this.skinGrid.querySelectorAll<HTMLButtonElement>('[data-skin]')) {
      const skin = button.dataset.skin as SkinId;
      const isOwned = owned.has(skin as EntitlementSku);
      button.disabled = !connected || this.busy;
      button.classList.toggle('is-selected', this.profile?.selectedSkin === skin);
      button.querySelector('[data-skin-state]')!.textContent = isOwned ? 'OWNED' : '$6';
    }
    const hasName = Boolean(this.profile?.username);
    const hasNameCredit = this.profile?.usernameCreditAvailable === true;
    this.usernameInput.disabled = !connected || hasName || this.busy;
    this.usernameButton.disabled = !connected || hasName || this.busy;
    this.usernameInput.value = this.profile?.username ?? '';
    this.usernameButton.textContent = hasName
      ? 'Name owned'
      : hasNameCredit
        ? 'Use name credit'
        : 'Claim name';
  }

  private async applyProfile(profile: AccountProfile | null): Promise<boolean> {
    const accepted = await this.options.onProfileChange?.(profile, this.api.sessionToken);
    if (accepted === false || this.disposed) return false;
    this.commitProfile(profile);
    return true;
  }

  private commitProfile(profile: AccountProfile | null): void {
    this.profile = profile;
    this.renderProfile();
    if (profile) {
      this.options.onAppearanceChange?.(profile.selectedAnimal, profile.selectedSkin);
      this.syncLastMarket(this.options.market());
    } else {
      this.options.onAnonymousAppearance?.(this.anonymousAnimal);
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.connectButton.disabled = busy;
    this.disconnectButton.disabled = busy;
    this.renderProfile();
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }

  private readonly togglePanel = (): void => {
    if (!this.visible) return;
    const opening = this.panel.classList.contains('is-hidden');
    this.panel.classList.toggle('is-hidden', !opening);
    this.options.onInteractionChange?.(opening);
  };
  private readonly closePanel = (): void => {
    this.panel.classList.add('is-hidden');
    this.options.onInteractionChange?.(false);
  };
  private readonly stopCanvasInput = (event: Event): void => event.stopPropagation();

  private readonly updateConnectLabel = (): void => {
    const choice = this.walletAdapter?.choices.find((wallet) => wallet.id === this.walletSelect.value);
    this.connectButton.textContent = choice ? `Connect ${choice.name}` : 'Connect wallet';
  };

  private readonly connectWallet = async (): Promise<void> => {
    if (this.busy || this.wallet) return;
    this.setBusy(true);
    let pendingWallet: ConnectedWallet | null = null;
    try {
      if (!this.walletAdapter) {
        this.setStatus('Looking for Wallet Standard apps…');
        this.walletAdapter = await this.walletLoader(this.cluster);
        this.walletSelect.replaceChildren();
        for (const choice of this.walletAdapter.choices) {
          const option = document.createElement('option');
          option.value = choice.id;
          option.textContent = choice.name;
          this.walletSelect.append(option);
        }
        if (this.walletAdapter.choices.length === 0) {
          throw new Error('No compatible Solana wallet was found.');
        }
        this.walletSelect.classList.toggle('is-hidden', this.walletAdapter.choices.length < 2);
        this.updateConnectLabel();
      }
      const firstChoice = this.walletAdapter.choices[0];
      if (!firstChoice) throw new Error('No compatible Solana wallet was found.');
      const choiceId = this.walletSelect.value || firstChoice.id;
      pendingWallet = await this.walletAdapter.connect(choiceId);
      // Bind challenge and verification to one observed actor even if another
      // async room operation completes while the wallet prompt is open.
      const challengedActorId = this.actorId;
      const challenge = await this.api.challenge(pendingWallet.publicKey, challengedActorId);
      const signature = await pendingWallet.signMessage(new TextEncoder().encode(challenge.message));
      const session = await this.api.verify(
        challenge.id,
        pendingWallet.publicKey,
        bytesToBase64(signature),
        challengedActorId,
      );
      if (this.disposed) {
        await pendingWallet.disconnect();
        return;
      }
      if (!await this.applyProfile(session.profile)) {
        await this.api.logout().catch(() => undefined);
        throw new Error('Your account could not safely enter this room. Please try again.');
      }
      const connectedWallet = pendingWallet;
      this.wallet = connectedWallet;
      this.removeWalletDisconnectListener?.();
      this.removeWalletDisconnectListener = connectedWallet.onDisconnect?.(
        () => void this.handleExternalWalletDisconnect(connectedWallet),
      ) ?? null;
      pendingWallet = null;
      this.options.onBlocksLoaded?.(session.blocks);
      this.setStatus('Wallet connected. Your address stays private in the world.');
      await this.resumePendingPurchase();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Wallet connection failed safely.');
      this.removeWalletDisconnectListener?.();
      this.removeWalletDisconnectListener = null;
      await pendingWallet?.disconnect().catch(() => undefined);
      await this.wallet?.disconnect().catch(() => undefined);
      this.wallet = null;
    } finally {
      this.setBusy(false);
    }
  };

  private readonly disconnectWallet = async (): Promise<void> => {
    if (this.busy) return;
    this.setBusy(true);
    const wallet = this.wallet;
    this.wallet = null;
    this.removeWalletDisconnectListener?.();
    this.removeWalletDisconnectListener = null;
    try {
      await Promise.allSettled([wallet?.disconnect(), this.api.logout()]);
    } finally {
      if (!await this.applyProfile(null).catch(() => false)) this.commitProfile(null);
      this.setStatus('Wallet disconnected. Paid identity is hidden, not lost.');
      this.setBusy(false);
    }
  };

  private async handleExternalWalletDisconnect(wallet: ConnectedWallet): Promise<void> {
    if (this.disposed || this.wallet !== wallet) return;
    this.wallet = null;
    this.removeWalletDisconnectListener?.();
    this.removeWalletDisconnectListener = null;
    await this.api.logout().catch(() => undefined);
    if (this.disposed) return;
    if (!await this.applyProfile(null).catch(() => false)) this.commitProfile(null);
    this.setStatus('Wallet disconnected. Paid identity is hidden, not lost.');
  }

  private readonly chooseAnimal = async (event: Event): Promise<void> => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-animal]');
    const animal = ANIMAL_KINDS.find((value) => value === button?.dataset.animal);
    if (!button || !animal || !this.profile || this.busy) return;
    await this.updateAppearance(animal, 'base');
  };

  private readonly chooseOrPurchaseSkin = async (event: Event): Promise<void> => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-skin]');
    const skin = PREMIUM_SKIN_CATALOG.find((value) => value.id === button?.dataset.skin);
    if (!button || !skin || !this.profile || this.busy) return;
    if (this.profile.entitlements.includes(skin.id)) {
      await this.updateAppearance(skin.animal, skin.id);
      return;
    }
    await this.purchase(skin.id);
  };

  private readonly claimUsername = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!this.profile || this.busy) return;
    const username = this.usernameInput.value.normalize('NFKC').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
      this.setStatus('Use 3–16 letters, numbers, or underscores.');
      return;
    }
    if (this.profile.usernameCreditAvailable) {
      this.setBusy(true);
      try {
        const profile = await this.api.claimUsername(username);
        if (!await this.applyProfile(profile)) throw new Error('The room could not refresh your profile.');
        this.setStatus(`${username} is now yours.`);
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : 'Could not use the username credit.');
      } finally {
        this.setBusy(false);
      }
      return;
    }
    await this.purchase('username-claim', username);
  };

  private async updateAppearance(animal: AnimalKind, skin: SkinId): Promise<void> {
    this.setBusy(true);
    try {
      const profile = await this.api.updateProfile(animal, skin, this.options.market());
      if (!await this.applyProfile(profile)) throw new Error('The room could not refresh your appearance.');
      this.setStatus(`${title(animal)} is now your active shape.`);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Could not change appearance.');
    } finally {
      this.setBusy(false);
    }
  }

  private async purchase(sku: EntitlementSku, username?: string): Promise<void> {
    const wallet = this.wallet;
    if (!wallet) {
      this.setStatus('Reconnect your wallet to make a purchase.');
      return;
    }
    this.setBusy(true);
    let pending: PendingPurchaseRecord | null = null;
    try {
      this.setStatus('Creating a two-minute SOL quote…');
      const quote = await this.api.createQuote(sku, username ? { username } : undefined);
      if (Date.now() >= quote.expiresAt) throw new Error('The quote expired before signing.');
      this.setStatus('Approve the referenced SOL payment in your wallet.');
      const signature = await wallet.payQuote(quote);
      pending = {
        accountId: quote.accountId,
        quoteId: quote.id,
        signature,
        pollUntil: Math.max(quote.expiresAt, Date.now() + 150_000),
        recoverUntil: Date.now() + 7 * 24 * 60 * 60_000,
      };
      upsertPendingPurchase(this.pendingPurchaseStorage, pending);
      if (this.disposed || this.wallet !== wallet) return;
      let confirmation = await this.api.confirmPurchase(quote.id, signature);
      if (this.disposed || this.wallet !== wallet) return;
      if (confirmation.status === 'pending') {
        this.setStatus('Payment sent. Waiting for on-chain confirmation…');
        confirmation = await pollPendingPurchase(confirmation, {
          // The submitted signature remains durably claimed by the server.
          // Keep checking through a bounded late-confirmation window when the
          // wallet signed near the end of the original two-minute quote.
          expiresAt: pending.pollUntil,
          confirm: () => this.api.confirmPurchase(quote.id, signature),
        });
        if (this.disposed || this.wallet !== wallet) return;
      }
      if (!confirmation.profile) {
        this.setStatus('Payment sent. Confirmation is still settling; reconnect later to refresh ownership.');
        return;
      }
      removePendingPurchase(this.pendingPurchaseStorage, pending.accountId, pending.quoteId);
      if (this.disposed || this.wallet !== wallet) return;
      if (!await this.applyProfile(confirmation.profile)) {
        throw new Error('Payment is safe, but the room could not refresh your profile yet.');
      }
      this.setStatus(confirmation.status === 'credited'
        ? 'Payment confirmed. Your reusable name credit is safe—choose another available name.'
        : 'It is yours. Thank you for supporting Tickerworld.');
    } catch (error) {
      if (pending && isTerminalPaymentError(error)) {
        removePendingPurchase(this.pendingPurchaseStorage, pending.accountId, pending.quoteId);
      }
      this.setStatus(error instanceof Error ? error.message : 'Purchase stopped safely. Nothing was granted.');
    } finally {
      this.setBusy(false);
    }
  }

  private async resumePendingPurchase(): Promise<void> {
    if (!this.profile || !this.api.sessionToken || this.disposed) return;
    const accountId = this.profile.id;
    const records = readPendingPurchases(this.pendingPurchaseStorage, accountId);
    if (records.length === 0) return;
    const inheritedBusy = this.busy;
    if (!inheritedBusy) this.setBusy(true);
    try {
      for (const pending of records) {
        try {
          this.setStatus('Resuming your pending on-chain confirmation…');
          let confirmation = await this.api.confirmPurchase(pending.quoteId, pending.signature);
          if (confirmation.status === 'pending' && Date.now() < pending.pollUntil) {
            confirmation = await pollPendingPurchase(confirmation, {
              expiresAt: pending.pollUntil,
              confirm: () => this.api.confirmPurchase(pending.quoteId, pending.signature),
            });
          }
          if (this.disposed) return;
          if (!confirmation.profile) {
            this.setStatus('Payment is still settling. Tickerworld will reconcile it after your next sign-in.');
            continue;
          }
          removePendingPurchase(this.pendingPurchaseStorage, pending.accountId, pending.quoteId);
          if (!await this.applyProfile(confirmation.profile)) {
            throw new Error('Payment is safe, but the room could not refresh your profile yet.');
          }
          this.setStatus(confirmation.status === 'credited'
            ? 'Payment confirmed. Your reusable name credit is ready.'
            : 'Payment confirmed and your item is ready.');
        } catch (error) {
          if (isTerminalPaymentError(error)) {
            removePendingPurchase(this.pendingPurchaseStorage, pending.accountId, pending.quoteId);
          }
          if (!this.disposed) {
            this.setStatus(error instanceof Error
              ? `Pending payment: ${error.message}`
              : 'Pending payment will retry after your next sign-in.');
          }
        }
      }
    } finally {
      if (!inheritedBusy && !this.disposed) this.setBusy(false);
    }
  }

  private async flushLastMarket(): Promise<void> {
    if (this.syncingLastMarket) return;
    this.syncingLastMarket = true;
    try {
      while (this.pendingLastMarket && this.profile && this.api.sessionToken) {
        const market = this.pendingLastMarket;
        const sessionToken = this.api.sessionToken;
        this.pendingLastMarket = null;
        try {
          const updated = await this.api.updateLastMarket(market);
          if (this.disposed || !this.profile || this.api.sessionToken !== sessionToken) return;
          // Only accept the routing field. A concurrent purchase/name response
          // remains authoritative for identity, entitlements, and appearance.
          this.profile = { ...this.profile, lastMarket: updated.lastMarket };
        } catch {
          // Routing remains locally functional; account sync is best effort.
        }
      }
    } finally {
      this.syncingLastMarket = false;
      if (this.pendingLastMarket && this.profile && this.api.sessionToken) {
        void this.flushLastMarket();
      }
    }
  }
}
