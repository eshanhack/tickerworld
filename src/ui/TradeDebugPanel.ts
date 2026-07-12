export type TradeDebugSide = 'buy' | 'sell';
export type TradeDebugTier = 'minor' | 'notable' | 'big' | 'whale';

export interface TradeDebugSnapshot {
  readonly mode: string;
  readonly sources: readonly string[];
  readonly buy1s: number;
  readonly sell1s: number;
  readonly buy10s: number;
  readonly sell10s: number;
  readonly buy60s: number;
  readonly sell60s: number;
  readonly tierRates: Readonly<Partial<Record<TradeDebugTier, number>>>;
}

export interface TradeDebugPanelCallbacks {
  readonly onOrder: (side: TradeDebugSide, tier: TradeDebugTier) => void;
  readonly onSurge: (side: TradeDebugSide) => void;
}

function compactUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1,
  }).format(value);
}

/** Local/preview-only controls for deterministic trade-tape tuning. */
export class TradeDebugPanel {
  readonly root: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly callbacks: TradeDebugPanelCallbacks;
  private disposed = false;

  constructor(root: HTMLElement, callbacks: TradeDebugPanelCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.root.classList.add('trade-debug-panel');
    this.root.innerHTML = `
      <header><strong>TRADE TAPE LAB</strong><span data-trade-debug-mode>idle</span><button type="button" data-trade-debug-toggle aria-label="Collapse trade tape debug panel">−</button></header>
      <div class="trade-debug-grid" role="group" aria-label="Fake aggregated trade controls">
        ${(['minor', 'notable', 'big', 'whale'] as const).map((tier) => `
          <button type="button" data-trade-side="buy" data-trade-tier="${tier}">BUY ${tier}</button>
          <button type="button" data-trade-side="sell" data-trade-tier="${tier}">SELL ${tier}</button>
        `).join('')}
      </div>
      <div class="trade-debug-surges" role="group" aria-label="Atmosphere surge controls">
        <button type="button" data-surge-side="buy">GREEN SURGE</button>
        <button type="button" data-surge-side="sell">RED SURGE</button>
      </div>
      <pre data-trade-debug-readout>waiting for tape…</pre>
    `;
    this.readout = this.root.querySelector<HTMLElement>('[data-trade-debug-readout]')!;
    this.root.addEventListener('click', this.handleClick);
  }

  setSnapshot(snapshot: TradeDebugSnapshot): void {
    if (this.disposed) return;
    const mode = this.root.querySelector<HTMLElement>('[data-trade-debug-mode]');
    if (mode) mode.textContent = `${snapshot.mode} · ${snapshot.sources.join('+') || 'no venue'}`;
    const rates = (['minor', 'notable', 'big', 'whale'] as const)
      .map((tier) => `${tier[0]} ${snapshot.tierRates[tier] ?? 0}/m`).join(' · ');
    this.readout.textContent = [
      `1s   ${compactUsd(snapshot.buy1s)} buy / ${compactUsd(snapshot.sell1s)} sell`,
      `10s  ${compactUsd(snapshot.buy10s)} buy / ${compactUsd(snapshot.sell10s)} sell`,
      `1m   ${compactUsd(snapshot.buy60s)} buy / ${compactUsd(snapshot.sell60s)} sell`,
      rates,
    ].join('\n');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeEventListener('click', this.handleClick);
    this.root.remove();
  }

  private readonly handleClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!target || !this.root.contains(target)) return;
    if (target.hasAttribute('data-trade-debug-toggle')) {
      const collapsed = this.root.classList.toggle('is-collapsed');
      target.textContent = collapsed ? '+' : '−';
      target.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} trade tape debug panel`);
      return;
    }
    const side = target.dataset.tradeSide as TradeDebugSide | undefined;
    const tier = target.dataset.tradeTier as TradeDebugTier | undefined;
    if (side && tier) return this.callbacks.onOrder(side, tier);
    const surgeSide = target.dataset.surgeSide as TradeDebugSide | undefined;
    if (surgeSide) this.callbacks.onSurge(surgeSide);
  };
}
