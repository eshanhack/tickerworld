import type { AnimalKind } from '../../shared/src/index.js';
import type { AssetSymbol } from '../types';

export interface ParkourRunHudState {
  readonly active: boolean;
  readonly elapsedSeconds: number;
  readonly checkpointIndex: number;
  readonly checkpointTotal: number;
}

export interface ParkourRunResult {
  readonly displayName: string;
  readonly elapsedSeconds: number;
  readonly market: AssetSymbol;
  readonly completedAt: number;
}

export interface ParkourHudViewOptions {
  readonly onQuit: () => void;
}

export interface ParkourRunResultInput {
  readonly username?: string | null;
  readonly animal: AnimalKind;
  readonly actorId: string;
  readonly elapsedSeconds: number;
  readonly market: AssetSymbol;
  readonly completedAt?: number;
}

const ANONYMOUS_ADJECTIVES = [
  'Mossy',
  'Comet',
  'Dewdrop',
  'Moonlit',
  'Petal',
  'Pebble',
  'Sunny',
  'Willow',
] as const;

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function titleAnimal(animal: AnimalKind): string {
  if (animal === 'saylor') return 'Michael Saylor';
  return animal.charAt(0).toUpperCase() + animal.slice(1);
}

export function parkourDisplayName(
  username: string | null | undefined,
  animal: AnimalKind,
  actorId: string,
): string {
  const trimmed = username?.trim();
  if (trimmed) return trimmed.slice(0, 24);
  const adjective = ANONYMOUS_ADJECTIVES[stableHash(actorId || animal) % ANONYMOUS_ADJECTIVES.length]
    ?? ANONYMOUS_ADJECTIVES[0];
  return `${adjective} ${titleAnimal(animal)}`;
}

export function formatParkourTime(seconds: number): string {
  const tenths = Math.max(0, Math.floor((Number.isFinite(seconds) ? seconds : 0) * 10 + 1e-6));
  const minutes = Math.floor(tenths / 600);
  const wholeSeconds = Math.floor(tenths / 10) % 60;
  return `${minutes}:${wholeSeconds.toString().padStart(2, '0')}.${tenths % 10}`;
}

export function rankParkourResults(
  results: readonly ParkourRunResult[],
  limit = 6,
): readonly ParkourRunResult[] {
  return results
    .filter(({ displayName, elapsedSeconds, completedAt }) => (
      displayName.trim().length > 0
      && Number.isFinite(elapsedSeconds)
      && elapsedSeconds >= 0
      && Number.isFinite(completedAt)
    ))
    .map((result) => ({ ...result, displayName: result.displayName.trim().slice(0, 24) }))
    .sort((left, right) => (
      left.elapsedSeconds - right.elapsedSeconds
      || left.completedAt - right.completedAt
    ))
    .slice(0, Math.max(0, Math.floor(limit)));
}

export function createParkourRunResult(input: ParkourRunResultInput): ParkourRunResult {
  return {
    displayName: parkourDisplayName(input.username, input.animal, input.actorId),
    elapsedSeconds: Math.max(0, Number.isFinite(input.elapsedSeconds) ? input.elapsedSeconds : 0),
    market: input.market,
    completedAt: Number.isFinite(input.completedAt) ? input.completedAt! : Date.now(),
  };
}

/** Compact non-modal run timer and in-memory session leaderboard. */
export class ParkourHudView {
  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly timerCard: HTMLElement;
  private readonly timerText: HTMLElement;
  private readonly checkpointText: HTMLElement;
  private readonly quitButton: HTMLButtonElement;
  private readonly resultsCard: HTMLElement;
  private readonly resultsList: HTMLOListElement;
  private readonly options: ParkourHudViewOptions;
  private readonly hudRoot: HTMLElement | null;
  private sessionResults: readonly ParkourRunResult[] = [];
  private renderKey = '';
  private disposed = false;

  public constructor(host: HTMLElement, options: ParkourHudViewOptions) {
    this.host = host;
    this.options = options;
    this.hudRoot = host.closest<HTMLElement>('.hud');
    this.host.innerHTML = `
      <section class="parkour-hud" aria-label="Parkour run">
        <div class="parkour-run-card is-hidden" data-parkour-run role="timer">
          <div><small>PARKOUR RUN</small><strong data-parkour-time>0:00.0</strong><span data-parkour-checkpoint>START</span></div>
          <button type="button" data-parkour-quit aria-label="Quit parkour run without moving your character">Quit</button>
        </div>
        <aside class="parkour-session-log is-hidden" data-parkour-results aria-label="Parkour session leaderboard" aria-live="polite">
          <header><small>THIS SESSION</small><strong>Parkour times</strong></header>
          <ol data-parkour-result-list></ol>
        </aside>
      </section>
    `;
    this.root = this.required('.parkour-hud');
    this.timerCard = this.required('[data-parkour-run]');
    this.timerText = this.required('[data-parkour-time]');
    this.checkpointText = this.required('[data-parkour-checkpoint]');
    this.quitButton = this.required<HTMLButtonElement>('[data-parkour-quit]');
    this.resultsCard = this.required('[data-parkour-results]');
    this.resultsList = this.required<HTMLOListElement>('[data-parkour-result-list]');
    this.quitButton.addEventListener('click', this.quit);
    this.quitButton.addEventListener('pointerdown', this.stopPointer);
  }

  public setRunState(state: ParkourRunHudState): void {
    if (this.disposed) return;
    const checkpointIndex = Math.max(0, Math.min(state.checkpointTotal, Math.floor(state.checkpointIndex)));
    const key = `${state.active}:${formatParkourTime(state.elapsedSeconds)}:${checkpointIndex}:${state.checkpointTotal}`;
    if (key === this.renderKey) return;
    this.renderKey = key;
    this.timerCard.classList.toggle('is-hidden', !state.active);
    this.root.classList.toggle('is-running', state.active);
    this.hudRoot?.classList.toggle('is-parkour-running', state.active);
    this.timerText.textContent = formatParkourTime(state.elapsedSeconds);
    this.checkpointText.textContent = checkpointIndex <= 0
      ? 'START'
      : `CHECKPOINT ${checkpointIndex} / ${Math.max(1, state.checkpointTotal)}`;
  }

  public addResult(result: ParkourRunResult): void {
    if (this.disposed) return;
    this.sessionResults = rankParkourResults([...this.sessionResults, result]);
    this.renderResults();
  }

  public get results(): readonly ParkourRunResult[] {
    return this.sessionResults.map((result) => ({ ...result }));
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.quitButton.removeEventListener('click', this.quit);
    this.quitButton.removeEventListener('pointerdown', this.stopPointer);
    this.hudRoot?.classList.remove('is-parkour-running');
    this.root.remove();
  }

  private renderResults(): void {
    this.resultsList.replaceChildren();
    this.sessionResults.forEach((result, index) => {
      const row = document.createElement('li');
      const rank = document.createElement('span');
      const name = document.createElement('strong');
      const market = document.createElement('small');
      const time = document.createElement('b');
      rank.textContent = String(index + 1);
      name.textContent = result.displayName;
      market.textContent = result.market;
      time.textContent = formatParkourTime(result.elapsedSeconds);
      row.append(rank, name, market, time);
      this.resultsList.append(row);
    });
    this.resultsCard.classList.toggle('is-hidden', this.sessionResults.length === 0);
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const element = this.host.querySelector<T>(selector);
    if (!element) throw new Error(`Parkour HUD is missing ${selector}`);
    return element;
  }

  private readonly quit = (): void => this.options.onQuit();

  private readonly stopPointer = (event: PointerEvent): void => event.stopPropagation();
}
