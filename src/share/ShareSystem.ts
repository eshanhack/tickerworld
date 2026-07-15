import type { AssetSymbol, GameSystem, MarketProvider } from '../types';
import type { PartyInvite, PartyJoinStatus } from './party';
import {
  isPartyShareCurrent,
  publicShareUrl,
  withPartyToken,
  type PartyShareBinding,
} from './party';
import { shareOrCopyLink, sharePostcard, type ShareCompletionMode } from './shareActions';
import { marketShareAttribution, marketShareDescription } from './marketAttribution';
import './share.css';

export type ShareOutput = 'market-link' | 'party-invite' | 'postcard';

export interface ShareMarketContext {
  readonly symbol: AssetSymbol;
  readonly price: number | null;
  readonly provider: MarketProvider;
  readonly url: string;
  readonly roomEpoch: number;
}

export interface SharePartyTransport {
  requestPartyInvite(): Promise<PartyInvite | null>;
}

export interface ShareSystemOptions {
  readonly root: HTMLElement;
  readonly context: () => ShareMarketContext;
  readonly party: SharePartyTransport;
  readonly capturePostcard: (partyUrl: string | null) => Promise<Blob>;
  /** Returns false when another modal interaction currently owns the canvas. */
  readonly onInteractionChange?: (active: boolean) => boolean | void;
  readonly onShareComplete?: (output: ShareOutput, mode: ShareCompletionMode) => void;
  readonly now?: () => number;
}

export class ShareSystem implements GameSystem {
  private readonly root: HTMLElement;
  private readonly options: ShareSystemOptions;
  private readonly toggle: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly marketButton: HTMLButtonElement;
  private readonly inviteButton: HTMLButtonElement;
  private readonly postcardButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly now: () => number;
  private partyUrl: string | null = null;
  private partyBinding: PartyShareBinding | null = null;
  private busy = false;
  private visible = true;
  private disposed = false;

  constructor(options: ShareSystemOptions) {
    this.options = options;
    this.root = options.root;
    this.now = options.now ?? (() => Date.now());
    this.root.classList.add('tickerworld-share');
    this.root.innerHTML = `
      <button class="share-toggle" type="button" aria-label="Share this market" data-share-toggle><span aria-hidden="true">↗</span><strong>Share</strong></button>
      <section class="share-panel is-hidden" aria-label="Share Tickerworld" data-share-panel>
        <header><div><small>SEND A LITTLE WORLD</small><strong>Share Tickerworld</strong></div><button type="button" aria-label="Close sharing" data-share-close>×</button></header>
        <button type="button" data-share-market><span>↗</span><div><strong>Market link</strong><small>Share or copy this market</small></div></button>
        <button type="button" data-share-invite><span>✦</span><div><strong>Invite to this shard</strong><small>Ask a friend to join this exact room</small></div></button>
        <button type="button" data-share-postcard><span>▣</span><div><strong>Capture postcard</strong><small>1200 × 675 PNG, private by default</small></div></button>
        <p role="status" aria-live="polite" data-share-status>Choose something to send.</p>
      </section>
    `;
    this.toggle = this.required('[data-share-toggle]');
    this.panel = this.required('[data-share-panel]');
    this.closeButton = this.required('[data-share-close]');
    this.marketButton = this.required('[data-share-market]');
    this.inviteButton = this.required('[data-share-invite]');
    this.postcardButton = this.required('[data-share-postcard]');
    this.status = this.required('[data-share-status]');
    this.toggle.addEventListener('click', this.togglePanel);
    this.closeButton.addEventListener('click', this.close);
    this.marketButton.addEventListener('click', this.shareMarket);
    this.inviteButton.addEventListener('click', this.shareInvite);
    this.postcardButton.addEventListener('click', this.capture);
    this.root.addEventListener('pointerdown', this.stopCanvasInput);
    this.root.addEventListener('pointermove', this.stopCanvasInput);
    this.root.addEventListener('pointerup', this.stopCanvasInput);
    this.root.addEventListener('wheel', this.stopCanvasInput);
  }

  get panelOpen(): boolean { return !this.panel.classList.contains('is-hidden'); }
  get currentPartyUrl(): string | null { return this.activePartyUrl(this.options.context()); }

  setPartyJoinStatus(result: PartyJoinStatus): void {
    if (result.status === 'joined') {
      this.status.textContent = 'Party room joined. New invites will point here.';
      return;
    }
    const reason = result.status === 'full'
      ? 'That party shard is full.'
      : result.status === 'expired'
        ? 'That party invite expired.'
        : 'That party invite is no longer valid.';
    this.status.textContent = `${reason} You joined a normal shard instead.`;
  }

  close = (): void => {
    if (!this.panelOpen) return;
    this.panel.classList.add('is-hidden');
    this.options.onInteractionChange?.(false);
  };

  update(): void { /* Event-driven DOM system. */ }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.classList.toggle('is-hidden', !visible);
    if (!visible) this.close();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.toggle.removeEventListener('click', this.togglePanel);
    this.closeButton.removeEventListener('click', this.close);
    this.marketButton.removeEventListener('click', this.shareMarket);
    this.inviteButton.removeEventListener('click', this.shareInvite);
    this.postcardButton.removeEventListener('click', this.capture);
    this.root.removeEventListener('pointerdown', this.stopCanvasInput);
    this.root.removeEventListener('pointermove', this.stopCanvasInput);
    this.root.removeEventListener('pointerup', this.stopCanvasInput);
    this.root.removeEventListener('wheel', this.stopCanvasInput);
    if (this.panelOpen) this.options.onInteractionChange?.(false);
    this.root.replaceChildren();
    this.root.classList.remove('tickerworld-share');
  }

  private required<T extends Element = HTMLButtonElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Tickerworld sharing UI is missing ${selector}`);
    return element;
  }

  private readonly togglePanel = (): void => {
    if (!this.visible || this.busy) return;
    if (this.panelOpen) {
      this.close();
      return;
    }
    if (this.options.onInteractionChange?.(true) === false) {
      this.status.textContent = 'Close the other panel before sharing.';
      return;
    }
    this.panel.classList.remove('is-hidden');
  };

  private readonly shareMarket = async (): Promise<void> => {
    if (this.busy) return;
    const context = this.options.context();
    const marketUrl = publicShareUrl(context.url);
    const attribution = marketShareAttribution(context.symbol, context.provider);
    await this.perform('market-link', 'Sharing market…', () => shareOrCopyLink({
      url: marketUrl,
      title: `${attribution.displayName} in Tickerworld`,
      text: `Meet me at the ${attribution.displayName} shrine in Tickerworld. ${marketShareDescription(context.symbol, context.provider)}`,
    }));
  };

  private readonly shareInvite = async (): Promise<void> => {
    if (this.busy) return;
    await this.perform('party-invite', 'Making a same-room invite…', async () => {
      const invite = await this.options.party.requestPartyInvite();
      if (!invite || invite.expiresAt <= this.now()) throw new Error('A same-room invite is unavailable right now.');
      const context = this.options.context();
      const attribution = marketShareAttribution(context.symbol, context.provider);
      const candidateUrl = withPartyToken(publicShareUrl(context.url), invite.token);
      const result = await shareOrCopyLink({
        url: candidateUrl,
        title: `Join my ${attribution.displayName} Tickerworld room`,
        text: 'This invite requests my exact shard. If it fills up, Tickerworld will keep you playing in another room.',
      });
      if (result.completed) {
        this.partyUrl = candidateUrl;
        this.partyBinding = {
          market: context.symbol,
          roomEpoch: context.roomEpoch,
          expiresAt: invite.expiresAt,
        };
      }
      return result;
    });
  };

  private readonly capture = async (): Promise<void> => {
    if (this.busy) return;
    await this.perform('postcard', 'Painting a private postcard…', async () => {
      const context = this.options.context();
      const attribution = marketShareAttribution(context.symbol, context.provider);
      const partyUrl = this.activePartyUrl(context);
      const png = await this.options.capturePostcard(partyUrl);
      const stamp = new Date(this.now()).toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
      return sharePostcard({
        png,
        filename: `tickerworld-${context.symbol.toLowerCase()}-${stamp}.png`,
        url: partyUrl ?? publicShareUrl(context.url),
        title: `${attribution.displayName} Tickerworld postcard`,
        text: marketShareDescription(context.symbol, context.provider),
      });
    });
  };

  private async perform(
    output: ShareOutput,
    pending: string,
    action: () => Promise<{ mode: ShareCompletionMode; completed: boolean; linkCopied?: boolean }>,
  ): Promise<void> {
    this.setBusy(true);
    this.status.textContent = pending;
    try {
      const result = await action();
      this.status.textContent = result.completed
        ? result.mode === 'native'
          ? 'Share sheet opened.'
          : result.mode === 'download'
            ? result.linkCopied
              ? 'Postcard downloaded and link copied.'
              : 'Postcard downloaded. The link could not be copied.'
            : 'Link copied.'
        : result.mode === 'cancelled' ? 'Sharing cancelled.' : 'Sharing is unavailable in this browser.';
      if (result.completed) this.options.onShareComplete?.(output, result.mode);
    } catch (error) {
      this.status.textContent = error instanceof Error ? error.message : 'Sharing stopped safely.';
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this.marketButton.disabled = value;
    this.inviteButton.disabled = value;
    this.postcardButton.disabled = value;
  }

  private activePartyUrl(context: ShareMarketContext): string | null {
    if (!this.partyUrl || !isPartyShareCurrent(
      this.partyBinding,
      context.symbol,
      context.roomEpoch,
      this.now(),
    )) {
      this.partyUrl = null;
      this.partyBinding = null;
      return null;
    }
    return this.partyUrl;
  }

  private readonly stopCanvasInput = (event: Event): void => event.stopPropagation();
}
