import { ASSET_SYMBOLS, MARKET_ROOM_MAX_CLIENTS } from '../../shared/src/index.js';
import type { AssetSymbol } from '../types';
import './portal.css';

export type WorldConnectionState = 'online' | 'connecting' | 'offline';
export type WorldChannelState = 'available' | 'busy' | 'full' | 'offline';

export interface WorldChannelSnapshot {
  /** Stable shard identifier used by matchmaking. Null delegates to auto-matchmaking. */
  readonly id: string | null;
  readonly label: string;
  readonly online: number | null;
  readonly capacity: number | null;
  readonly state: WorldChannelState;
}

export interface WorldPopulationSnapshot {
  readonly symbol: AssetSymbol;
  readonly online: number | null;
  readonly shards: number | null;
  readonly connection: WorldConnectionState;
  /** Exact room currently occupied when this is the active world. */
  readonly currentChannelId?: string | null;
  /** Exact channel data when the server exposes it; aggregate mode remains truthful without it. */
  readonly channels?: readonly WorldChannelSnapshot[];
}

export interface WorldChannelSelection {
  readonly symbol: AssetSymbol;
  readonly channelId: string | null;
}

export interface WorldChannelNavigatorOptions {
  readonly activeMarket: AssetSymbol;
  readonly onTravel: (selection: WorldChannelSelection) => boolean | void | Promise<boolean | void>;
  /** Return false when a transfer/recovery veil currently owns the UI. */
  readonly onOpenChange?: (open: boolean) => boolean | void;
  readonly canOpen?: () => boolean;
  readonly document?: Document;
}

export interface OnlinePopulationSnapshot {
  readonly totalOnline: number | null;
  /** Public launch admission ceiling across every tickerworld. */
  readonly totalCapacity?: number | null;
  readonly worldOnline: number | null;
  /** Sum of the advertised channel capacities in the active tickerworld. */
  readonly worldCapacity?: number | null;
  readonly world: AssetSymbol;
  readonly usernames: readonly string[];
  readonly connection: WorldConnectionState;
}

export interface OnlinePopulationBadgeOptions {
  readonly onBrowseWorlds?: () => void;
  readonly document?: Document;
}

const WORLD_GRID_COLUMNS = 4;
const MAX_VISIBLE_USERNAMES = 50;
const DEFAULT_GAME_CAPACITY = 400;

const WORLD_ACCENTS: Readonly<Record<AssetSymbol, string>> = {
  BTC: '#e7a869',
  ETH: '#aaa5d7',
  SOL: '#72b8aa',
  XRP: '#90b4cc',
  DOGE: '#ddba72',
  BNB: '#e3bd69',
  LINK: '#7e9ccb',
  AVAX: '#d9857d',
  WTI: '#8f927b',
  TEST: '#d68bd8',
  PUMP: '#e990b7',
  ANSEM: '#746b83',
  SHFL: '#75a9d6',
  SKHYNIX: '#b291d1',
  HYPE: '#69cfc0',
  XYZ100: '#70a9dc',
  SP500: '#91b99b',
  MU: '#8d83cf',
  SPACEX: '#aeb8c8',
  NVDA: '#84bd69',
  GOLD: '#e2c36d',
  AAPL: '#c9ced4',
  META: '#72a0df',
  GOOGL: '#da8a79',
};

function boundedCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function worldGridNavigationIndex(
  current: number,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  count: number,
  columns = WORLD_GRID_COLUMNS,
): number {
  const itemCount = Math.max(0, Math.floor(count));
  if (itemCount === 0) return -1;
  const width = Math.max(1, Math.floor(columns));
  const index = Math.min(itemCount - 1, Math.max(0, Math.floor(current)));
  if (key === 'ArrowLeft') return (index - 1 + itemCount) % itemCount;
  if (key === 'ArrowRight') return (index + 1) % itemCount;

  const rows = Math.ceil(itemCount / width);
  const column = index % width;
  let row = Math.floor(index / width);
  const direction = key === 'ArrowUp' ? -1 : 1;
  for (let attempt = 0; attempt < rows; attempt += 1) {
    row = (row + direction + rows) % rows;
    const candidate = row * width + column;
    if (candidate < itemCount) return candidate;
  }
  return index;
}

export function normalizeWorldChannels(
  population: WorldPopulationSnapshot,
): readonly WorldChannelSnapshot[] {
  const seen = new Set<string>();
  const exact = (population.channels ?? []).flatMap((channel) => {
    const idKey = channel.id ?? 'auto';
    if (!channel.label.trim() || seen.has(idKey)) return [];
    const online = boundedCount(channel.online);
    const capacity = boundedCount(channel.capacity);
    if (online !== null && capacity !== null && online > capacity) return [];
    seen.add(idKey);
    return [{
      id: channel.id,
      label: channel.label.trim().slice(0, 28),
      online,
      capacity,
      state: channel.state,
    } satisfies WorldChannelSnapshot];
  });
  const online = boundedCount(population.online);
  const shards = boundedCount(population.shards);
  const automatic = {
    id: null,
    label: exact.length > 0
      ? 'Open a new channel'
      : shards && shards > 1
        ? `Best of ${shards} channels`
        : 'Best channel',
    online: exact.length > 0 ? null : online,
    capacity: exact.length > 0
      ? null
      : shards && shards > 1 ? shards * MARKET_ROOM_MAX_CLIENTS : MARKET_ROOM_MAX_CLIENTS,
    state: population.connection === 'offline'
      ? 'offline'
      : population.connection === 'connecting'
        ? 'busy'
        : 'available',
  } satisfies WorldChannelSnapshot;
  if (exact.length > 0) {
    // Normal browsing stays concrete. If every advertised room filled between
    // refreshes, auto-matchmaking is still available to create an overflow
    // shard rather than trapping the player behind disabled rows.
    return exact.some(({ state }) => state !== 'full') ? exact : [...exact, automatic];
  }
  return [automatic];
}

export function worldPopulationLabel(population: WorldPopulationSnapshot): string {
  if (population.connection === 'connecting') return 'CONNECTING';
  const online = boundedCount(population.online);
  const shards = boundedCount(population.shards);
  const minimumShards = online === null
    ? 1
    : Math.max(1, Math.ceil(online / MARKET_ROOM_MAX_CLIENTS));
  const capacity = Math.max(minimumShards, shards ?? 1) * MARKET_ROOM_MAX_CLIENTS;
  if (population.connection === 'offline') return `— / ${capacity} PEOPLE INSIDE`;
  return `${online === null ? '—' : online.toLocaleString('en-US')} / ${capacity.toLocaleString('en-US')} PEOPLE INSIDE`;
}

export function populationBadgeLabels(snapshot: OnlinePopulationSnapshot): {
  readonly total: string;
  readonly world: string;
  readonly roster: readonly string[];
  readonly overflow: number;
} {
  const totalOnline = boundedCount(snapshot.totalOnline);
  const totalCapacity = boundedCount(snapshot.totalCapacity) ?? DEFAULT_GAME_CAPACITY;
  const worldOnline = boundedCount(snapshot.worldOnline);
  const worldCapacity = boundedCount(snapshot.worldCapacity) ?? MARKET_ROOM_MAX_CLIENTS;
  const unique = [...new Set(snapshot.usernames.map((name) => name.trim()).filter(Boolean))];
  const roster = unique.slice(0, MAX_VISIBLE_USERNAMES);
  return {
    total: `${totalOnline === null ? '—' : totalOnline.toLocaleString('en-US')} / ${totalCapacity.toLocaleString('en-US')} ONLINE`,
    world: `${worldOnline === null ? '—' : worldOnline.toLocaleString('en-US')} / ${worldCapacity.toLocaleString('en-US')} IN ${snapshot.world}`,
    roster,
    overflow: Math.max(0, unique.length - roster.length),
  };
}

function emptyPopulation(symbol: AssetSymbol): WorldPopulationSnapshot {
  return { symbol, online: null, shards: null, connection: 'connecting' };
}

function channelStatus(channel: WorldChannelSnapshot): string {
  const capacity = channel.capacity ?? MARKET_ROOM_MAX_CLIENTS;
  if (channel.state === 'offline') return `— / ${capacity} PEOPLE INSIDE`;
  if (channel.state === 'full') return 'FULL';
  if (channel.online === null) return channel.state === 'busy' ? 'CONNECTING' : 'OPEN';
  return `${channel.online} / ${capacity} PEOPLE INSIDE`;
}

/**
 * A compact, original channel-select surface inspired by cozy 2D MMO world menus.
 * It is intentionally transport-agnostic: Game supplies populations and the travel callback.
 */
export class WorldChannelNavigatorView {
  public readonly root: HTMLDivElement;

  private readonly documentRef: Document;
  private readonly options: WorldChannelNavigatorOptions;
  private readonly worldGrid: HTMLDivElement;
  private readonly channelGrid: HTMLDivElement;
  private readonly channelTitle: HTMLElement;
  private readonly destinationLabel: HTMLElement;
  private readonly travelButton: HTMLButtonElement;
  private readonly liveRegion: HTMLElement;
  private readonly populations = new Map<AssetSymbol, WorldPopulationSnapshot>();
  private selectedWorldIndex = 0;
  private selectedChannelId: string | null = null;
  private activeMarket: AssetSymbol;
  private enabled = true;
  private openState = false;
  private travelPending = false;
  private disposed = false;

  public constructor(parent: HTMLElement, options: WorldChannelNavigatorOptions) {
    this.options = options;
    this.documentRef = options.document ?? document;
    this.activeMarket = options.activeMarket;
    this.selectedWorldIndex = ASSET_SYMBOLS.indexOf(options.activeMarket);
    for (const symbol of ASSET_SYMBOLS) this.populations.set(symbol, emptyPopulation(symbol));

    this.root = this.documentRef.createElement('div');
    this.root.className = 'tickerworld-world-navigator is-hidden';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'tickerworld-world-navigator-title');
    this.root.setAttribute('aria-describedby', 'tickerworld-world-navigator-help');
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = `
      <div class="world-navigator-backdrop" data-world-nav-close></div>
      <section class="world-navigator-book">
        <header class="world-navigator-header">
          <div class="world-navigator-mark" aria-hidden="true">TW</div>
          <div><small>WORLD GUIDE</small><h2 id="tickerworld-world-navigator-title">Choose a tickerworld</h2></div>
          <button type="button" class="world-navigator-close" aria-label="Close world guide" data-world-nav-close>&times;</button>
        </header>
        <p id="tickerworld-world-navigator-help" class="world-navigator-help">Use arrow keys to browse, then press Enter to travel.</p>
        <div class="world-navigator-layout">
          <div class="world-navigator-worlds" role="listbox" aria-label="Tickerworlds" data-world-nav-worlds></div>
          <aside class="world-navigator-channels">
            <div class="world-navigator-channel-heading"><small>DESTINATION</small><strong data-world-nav-destination></strong></div>
            <h3 data-world-nav-channel-title>Channels</h3>
            <div role="radiogroup" aria-label="Available channels" data-world-nav-channels></div>
            <p>Choose a channel, or let Tickerworld find the fullest open one.</p>
            <button type="button" class="world-navigator-travel" data-world-nav-travel>Travel to BTC</button>
          </aside>
        </div>
        <footer><span><kbd>&larr;</kbd><kbd>&uarr;</kbd><kbd>&darr;</kbd><kbd>&rarr;</kbd> Browse</span><span><kbd>Enter</kbd> Travel</span><span><kbd>Esc</kbd> Close</span></footer>
        <div class="sr-only" role="status" aria-live="polite" data-world-nav-live></div>
      </section>
    `;
    this.worldGrid = this.required('[data-world-nav-worlds]');
    this.channelGrid = this.required('[data-world-nav-channels]');
    this.channelTitle = this.required('[data-world-nav-channel-title]');
    this.destinationLabel = this.required('[data-world-nav-destination]');
    this.travelButton = this.required<HTMLButtonElement>('[data-world-nav-travel]');
    this.liveRegion = this.required('[data-world-nav-live]');
    this.required<HTMLButtonElement>('button[data-world-nav-close]');
    this.root.addEventListener('click', this.clicked);
    this.root.addEventListener('pointerdown', this.stopCanvasInput);
    this.root.addEventListener('pointermove', this.stopCanvasInput);
    this.root.addEventListener('pointerup', this.stopCanvasInput);
    this.root.addEventListener('wheel', this.stopCanvasInput);
    // Capture gives the world guide precedence over the default-open chat and
    // prevents arrow navigation from leaking into other DOM keyboard handlers.
    this.documentRef.addEventListener('keydown', this.keydown, true);
    parent.append(this.root);
    this.render();
  }

  public get isOpen(): boolean {
    return this.openState;
  }

  public get selection(): WorldChannelSelection {
    return { symbol: ASSET_SYMBOLS[this.selectedWorldIndex]!, channelId: this.selectedChannelId };
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.close();
  }

  public setActiveMarket(symbol: AssetSymbol): void {
    this.activeMarket = symbol;
    if (!this.openState) {
      this.selectedWorldIndex = ASSET_SYMBOLS.indexOf(symbol);
      this.selectedChannelId = this.populations.get(symbol)?.currentChannelId ?? null;
    }
    this.render();
  }

  public setPopulations(populations: Iterable<WorldPopulationSnapshot>): void {
    for (const population of populations) {
      if (!ASSET_SYMBOLS.includes(population.symbol)) continue;
      this.populations.set(population.symbol, population);
    }
    this.ensureChannelSelection();
    this.render();
  }

  public setWorldChannels(symbol: AssetSymbol, channels: readonly WorldChannelSnapshot[]): void {
    const current = this.populations.get(symbol) ?? emptyPopulation(symbol);
    this.populations.set(symbol, { ...current, channels });
    this.ensureChannelSelection();
    this.render();
  }

  public open(): boolean {
    if (this.disposed || this.openState || !this.enabled || this.options.canOpen?.() === false) return false;
    if (this.options.onOpenChange?.(true) === false) return false;
    this.openState = true;
    this.selectedWorldIndex = ASSET_SYMBOLS.indexOf(this.activeMarket);
    this.selectedChannelId = this.populations.get(this.activeMarket)?.currentChannelId ?? null;
    this.ensureChannelSelection();
    this.root.classList.remove('is-hidden');
    this.root.setAttribute('aria-hidden', 'false');
    this.render();
    this.focusSelectedWorld();
    return true;
  }

  public close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.travelPending = false;
    this.root.classList.add('is-hidden');
    this.root.setAttribute('aria-hidden', 'true');
    this.options.onOpenChange?.(false);
  }

  public toggle(): void {
    if (this.openState) this.close();
    else this.open();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.openState) this.options.onOpenChange?.(false);
    this.root.removeEventListener('click', this.clicked);
    this.root.removeEventListener('pointerdown', this.stopCanvasInput);
    this.root.removeEventListener('pointermove', this.stopCanvasInput);
    this.root.removeEventListener('pointerup', this.stopCanvasInput);
    this.root.removeEventListener('wheel', this.stopCanvasInput);
    this.documentRef.removeEventListener('keydown', this.keydown, true);
    this.root.remove();
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Tickerworld world navigator is missing ${selector}`);
    return element;
  }

  private selectWorld(index: number, focus = false): void {
    this.selectedWorldIndex = Math.min(ASSET_SYMBOLS.length - 1, Math.max(0, index));
    const symbol = ASSET_SYMBOLS[this.selectedWorldIndex]!;
    this.selectedChannelId = this.populations.get(symbol)?.currentChannelId ?? null;
    this.ensureChannelSelection();
    this.render();
    if (focus) this.focusSelectedWorld();
    const population = this.populations.get(this.selection.symbol)!;
    this.liveRegion.textContent = `${this.selection.symbol} selected, ${worldPopulationLabel(population)}`;
  }

  private selectChannel(id: string | null): void {
    const channels = normalizeWorldChannels(this.populations.get(this.selection.symbol)!);
    const channel = channels.find((candidate) => candidate.id === id && candidate.state !== 'full');
    if (!channel) return;
    this.selectedChannelId = channel.id;
    this.renderChannels();
    this.liveRegion.textContent = `${channel.label}, ${channelStatus(channel)}`;
  }

  private ensureChannelSelection(): void {
    const population = this.populations.get(ASSET_SYMBOLS[this.selectedWorldIndex]!)!;
    const channels = normalizeWorldChannels(population);
    const currentId = population.currentChannelId ?? null;
    const selected = channels.find((channel) => channel.id === this.selectedChannelId
      && (channel.state !== 'full' || channel.id === currentId));
    if (!selected) {
      this.selectedChannelId = channels.find((channel) => channel.id === currentId)?.id
        ?? channels.find((channel) => channel.state !== 'full')?.id
        ?? null;
    }
  }

  private render(): void {
    this.renderWorlds();
    this.renderChannels();
  }

  private renderWorlds(): void {
    const fragment = this.documentRef.createDocumentFragment();
    ASSET_SYMBOLS.forEach((symbol, index) => {
      const population = this.populations.get(symbol)!;
      const button = this.documentRef.createElement('button');
      button.type = 'button';
      button.className = 'world-navigator-world';
      button.dataset.world = symbol;
      button.dataset.selected = String(index === this.selectedWorldIndex);
      button.dataset.active = String(symbol === this.activeMarket);
      button.style.setProperty('--world-accent', WORLD_ACCENTS[symbol]);
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === this.selectedWorldIndex));
      button.tabIndex = index === this.selectedWorldIndex ? 0 : -1;
      button.innerHTML = `<span class="world-navigator-world-orb" aria-hidden="true">${symbol.slice(0, 2)}</span><span><strong>${symbol}</strong><small></small></span><i></i>`;
      button.querySelector('small')!.textContent = worldPopulationLabel(population);
      const state = button.querySelector('i')!;
      state.className = `is-${population.connection}`;
      if (symbol === this.activeMarket) button.setAttribute('aria-current', 'page');
      fragment.append(button);
    });
    this.worldGrid.replaceChildren(fragment);
  }

  private renderChannels(): void {
    const symbol = ASSET_SYMBOLS[this.selectedWorldIndex]!;
    const population = this.populations.get(symbol)!;
    const channels = normalizeWorldChannels(population);
    this.destinationLabel.textContent = symbol === this.activeMarket ? `${symbol} · CURRENT WORLD` : `${symbol} WORLD`;
    this.channelTitle.textContent = population.shards && population.shards > 1
      ? `${population.shards} live channels`
      : 'Choose a channel';
    const fragment = this.documentRef.createDocumentFragment();
    for (const channel of channels) {
      const current = channel.id !== null && channel.id === population.currentChannelId;
      const button = this.documentRef.createElement('button');
      button.type = 'button';
      button.className = 'world-navigator-channel';
      button.dataset.channel = channel.id ?? '';
      button.dataset.state = channel.state;
      button.dataset.current = String(current);
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(channel.id === this.selectedChannelId));
      button.disabled = channel.state === 'full' && !current;
      button.innerHTML = '<span aria-hidden="true"></span><strong></strong><small></small>';
      button.querySelector('strong')!.textContent = current ? `${channel.label} · Current` : channel.label;
      button.querySelector('small')!.textContent = channelStatus(channel);
      fragment.append(button);
    }
    this.channelGrid.replaceChildren(fragment);
    const selected = channels.find(({ id }) => id === this.selectedChannelId);
    this.travelButton.textContent = selected
      ? `Travel to ${symbol} · ${selected.label}`
      : `Travel to ${symbol}`;
    this.travelButton.disabled = this.travelPending || (selected?.state === 'full'
      && selected.id !== population.currentChannelId);
  }

  private focusSelectedWorld(): void {
    const symbol = ASSET_SYMBOLS[this.selectedWorldIndex]!;
    this.worldGrid.querySelector<HTMLButtonElement>(`[data-world="${symbol}"]`)?.focus({ preventScroll: true });
  }

  private async travel(): Promise<void> {
    if (this.travelPending) return;
    const population = this.populations.get(this.selection.symbol)!;
    const channel = normalizeWorldChannels(population).find(({ id }) => id === this.selectedChannelId);
    if (channel?.state === 'full' && channel.id !== population.currentChannelId) {
      this.liveRegion.textContent = `${channel.label} is full. Choose another channel.`;
      return;
    }
    this.travelPending = true;
    this.root.dataset.loading = 'true';
    this.travelButton.disabled = true;
    this.liveRegion.textContent = `Travelling to ${this.selection.symbol}`;
    try {
      const result = await this.options.onTravel(this.selection);
      if (result !== false) this.close();
    } finally {
      this.travelPending = false;
      delete this.root.dataset.loading;
      this.renderChannels();
    }
  }

  private readonly clicked = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-world-nav-close]')) {
      this.close();
      return;
    }
    if (target?.closest('[data-world-nav-travel]')) {
      void this.travel();
      return;
    }
    const worldButton = target?.closest<HTMLButtonElement>('[data-world]');
    if (worldButton) {
      const index = ASSET_SYMBOLS.indexOf(worldButton.dataset.world as AssetSymbol);
      if (index >= 0) this.selectWorld(index, true);
      return;
    }
    const channelButton = target?.closest<HTMLButtonElement>('[data-channel]');
    if (channelButton) {
      this.selectChannel(channelButton.dataset.channel || null);
      return;
    }
  };

  private readonly keydown = (event: KeyboardEvent): void => {
    if (this.disposed || event.defaultPrevented) return;
    if (!this.openState) {
      if (event.key !== 'Escape') return;
      if (this.open()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.travel();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next = worldGridNavigationIndex(
      this.selectedWorldIndex,
      event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
      ASSET_SYMBOLS.length,
    );
    this.selectWorld(next, true);
  };

  private readonly stopCanvasInput = (event: Event): void => event.stopPropagation();
}

/** Always-visible compact population summary with a privacy-safe room roster. */
export class OnlinePopulationBadgeView {
  public readonly root: HTMLElement;

  private readonly options: OnlinePopulationBadgeOptions;
  private readonly total: HTMLElement;
  private readonly world: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly list: HTMLElement;
  private readonly browse: HTMLButtonElement;
  private snapshot: OnlinePopulationSnapshot = {
    totalOnline: null,
    worldOnline: null,
    world: 'BTC',
    usernames: [],
    connection: 'connecting',
  };
  private pinned = false;
  private disposed = false;

  public constructor(parent: HTMLElement, options: OnlinePopulationBadgeOptions = {}) {
    this.options = options;
    const documentRef = options.document ?? document;
    this.root = documentRef.createElement('section');
    this.root.className = 'tickerworld-online-badge';
    this.root.innerHTML = `
      <button type="button" class="online-badge-summary" aria-expanded="false" aria-controls="tickerworld-online-roster" data-online-toggle>
        <span aria-hidden="true"></span><div><strong data-online-total>— / ${DEFAULT_GAME_CAPACITY} ONLINE</strong><small data-online-world>— / ${MARKET_ROOM_MAX_CLIENTS} IN BTC</small></div><i aria-hidden="true">›</i>
      </button>
      <div class="online-badge-roster" id="tickerworld-online-roster" data-online-roster>
        <header><strong>In this channel</strong><small>VISIBLE HERE</small></header>
        <div class="online-badge-names" data-online-names></div>
        <button type="button" class="online-badge-browse" data-online-browse>Browse worlds &amp; channels</button>
      </div>
    `;
    this.toggle = this.required<HTMLButtonElement>('[data-online-toggle]');
    this.total = this.required('[data-online-total]');
    this.world = this.required('[data-online-world]');
    this.panel = this.required('[data-online-roster]');
    this.list = this.required('[data-online-names]');
    this.browse = this.required<HTMLButtonElement>('[data-online-browse]');
    this.toggle.addEventListener('click', this.togglePinned);
    this.browse.addEventListener('click', this.browseWorlds);
    this.root.addEventListener('pointerenter', this.hoverIn);
    this.root.addEventListener('pointerleave', this.hoverOut);
    this.root.addEventListener('focusin', this.focusIn);
    this.root.addEventListener('focusout', this.focusOut);
    this.root.addEventListener('keydown', this.keydown);
    this.root.addEventListener('pointerdown', this.stopCanvasInput);
    this.root.addEventListener('wheel', this.stopCanvasInput);
    parent.append(this.root);
    this.render();
  }

  public setSnapshot(snapshot: OnlinePopulationSnapshot): void {
    this.snapshot = snapshot;
    this.render();
  }

  public collapse(): void {
    this.pinned = false;
    this.setExpanded(false);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.toggle.removeEventListener('click', this.togglePinned);
    this.browse.removeEventListener('click', this.browseWorlds);
    this.root.removeEventListener('pointerenter', this.hoverIn);
    this.root.removeEventListener('pointerleave', this.hoverOut);
    this.root.removeEventListener('focusin', this.focusIn);
    this.root.removeEventListener('focusout', this.focusOut);
    this.root.removeEventListener('keydown', this.keydown);
    this.root.removeEventListener('pointerdown', this.stopCanvasInput);
    this.root.removeEventListener('wheel', this.stopCanvasInput);
    this.root.remove();
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Tickerworld population badge is missing ${selector}`);
    return element;
  }

  private setExpanded(expanded: boolean): void {
    this.root.dataset.expanded = String(expanded);
    this.toggle.setAttribute('aria-expanded', String(expanded));
    this.panel.setAttribute('aria-hidden', String(!expanded));
  }

  private render(): void {
    const labels = populationBadgeLabels(this.snapshot);
    this.total.textContent = labels.total;
    this.world.textContent = labels.world;
    const fragment = this.root.ownerDocument.createDocumentFragment();
    if (labels.roster.length === 0) {
      const empty = this.root.ownerDocument.createElement('p');
      empty.textContent = this.snapshot.connection === 'online'
        ? 'No public names in this channel yet.'
        : 'Room roster unavailable while reconnecting.';
      fragment.append(empty);
    } else {
      for (const username of labels.roster) {
        const item = this.root.ownerDocument.createElement('span');
        item.textContent = username;
        fragment.append(item);
      }
      if (labels.overflow > 0) {
        const more = this.root.ownerDocument.createElement('p');
        more.textContent = `+${labels.overflow} more`;
        fragment.append(more);
      }
    }
    this.list.replaceChildren(fragment);
  }

  private readonly togglePinned = (): void => {
    this.pinned = !this.pinned;
    this.setExpanded(this.pinned);
  };
  private readonly browseWorlds = (): void => {
    this.collapse();
    this.options.onBrowseWorlds?.();
  };
  private readonly hoverIn = (): void => this.setExpanded(true);
  private readonly hoverOut = (): void => { if (!this.pinned) this.setExpanded(false); };
  private readonly focusIn = (): void => this.setExpanded(true);
  private readonly focusOut = (event: FocusEvent): void => {
    if (!this.pinned && !this.root.contains(event.relatedTarget as Node | null)) this.setExpanded(false);
  };
  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.collapse();
    this.toggle.focus();
  };
  private readonly stopCanvasInput = (event: Event): void => event.stopPropagation();
}
