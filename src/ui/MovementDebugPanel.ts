import type { FoxMotionDebugSnapshot } from '../player/FoxPlayer';
import {
  DEFAULT_MOVEMENT_TUNING,
  clearPersistedMovementTuning,
  cloneMovementTuning,
  getMovementTuningBounds,
  movementTuningCode,
  persistMovementTuning,
  setMovementTuningValue,
  type MovementTuning,
  type MovementTuningPath,
} from '../player/MovementConfig';

export interface MovementDebugActions {
  readonly onShortJump?: () => void;
  readonly onFullChain?: () => void;
  readonly onSkid?: () => void;
  readonly onHeavyDrop?: () => void;
}

export function movementDebugSnapshotText(snapshot: FoxMotionDebugSnapshot): string {
  // Keep this developer-facing surface ASCII-only. It is frequently inspected
  // through terminals/proxies whose encoding is outside the game's control.
  return [
    `${snapshot.locomotionState} | ${snapshot.fixedSteps} fixed steps | alpha ${snapshot.interpolationAlpha.toFixed(2)}`,
    `speed ${snapshot.horizontalSpeed.toFixed(2)} | vy ${snapshot.verticalVelocity.toFixed(2)} | air ${snapshot.airtime.toFixed(2)}s`,
      `coyote ${snapshot.coyoteRemaining.toFixed(3)} | buffer ${snapshot.jumpBufferRemaining.toFixed(3)} | jumps ${snapshot.jumpsUsed} | bank ${snapshot.glideBank.toFixed(2)}`,
      `input ${snapshot.inputEnabled ? 'on' : 'off'} | held ${snapshot.jumpHeld ? 'yes' : 'no'} | edge ${snapshot.jumpEdgeQueued ? 'queued' : 'clear'} | requests ${snapshot.jumpRequestSequence} | clears ${snapshot.inputClearSequence}`,
      `jumps ${snapshot.jumpSequence}/${snapshot.doubleJumpSequence} | queued-double ${snapshot.bufferedDoubleSequence}/${snapshot.delayedDoubleSequence} | glides ${snapshot.glideSequence} | max-air ${snapshot.maxAirtimeObserved.toFixed(3)} | transitions ${snapshot.stateTransitionSequence}`,
      `fx ${snapshot.activeParticles} particles | ${snapshot.activeRings} rings | ${snapshot.activeTrailSegments} trail segments`,
  ].join('\n');
}

/** `?debug=1` movement lab. Every exposed value updates the live controller. */
export class MovementDebugPanel {
  readonly root: HTMLElement;
  private readonly tuning: MovementTuning;
  private readonly readout: HTMLElement;
  private readonly values = new Map<MovementTuningPath, HTMLOutputElement>();
  private readonly actions: MovementDebugActions;
  private disposed = false;

  constructor(root: HTMLElement, tuning: MovementTuning, actions: MovementDebugActions = {}) {
    this.root = root;
    this.tuning = tuning;
    this.actions = actions;
    this.root.classList.add('movement-debug-panel');
    const controls: string[] = [];
    for (const [section, entries] of Object.entries(tuning)) {
      controls.push(`<fieldset><legend>${section}</legend>`);
      for (const [key, value] of Object.entries(entries)) {
        const numericValue = Number(value);
        const path = `${section}.${key}` as MovementTuningPath;
        const range = getMovementTuningBounds(path);
        if (!range) throw new Error(`Movement tuning is missing bounds for ${path}.`);
        controls.push(`
          <label data-movement-row>
            <span>${key}</span>
            <input type="range" data-movement-path="${path}" min="${range.min}" max="${range.max}" step="${range.step}" value="${numericValue}">
            <output data-movement-value="${path}">${numericValue.toFixed(range.step >= 1 ? 0 : 3)}</output>
          </label>`);
      }
      controls.push('</fieldset>');
    }
    this.root.innerHTML = `
      <header><strong>MOVEMENT LAB</strong><button type="button" data-movement-toggle aria-label="Collapse movement lab">-</button></header>
      <pre data-movement-readout>waiting for player...</pre>
      <div class="movement-debug-actions">
        <button type="button" data-movement-scenario="short">SHORT JUMP</button>
        <button type="button" data-movement-scenario="chain">FULL CHAIN</button>
        <button type="button" data-movement-scenario="skid">SKID</button>
        <button type="button" data-movement-scenario="drop">HEAVY DROP</button>
        <button type="button" data-movement-reset>RESET</button>
        <button type="button" data-movement-export>EXPORT</button>
      </div>
      <div class="movement-debug-controls">${controls.join('')}</div>
    `;
    this.readout = this.root.querySelector<HTMLElement>('[data-movement-readout]')!;
    for (const output of this.root.querySelectorAll<HTMLOutputElement>('[data-movement-value]')) {
      this.values.set(output.dataset.movementValue as MovementTuningPath, output);
    }
    this.root.addEventListener('input', this.handleInput);
    this.root.addEventListener('click', this.handleClick);
  }

  setSnapshot(snapshot: FoxMotionDebugSnapshot): void {
    if (this.disposed) return;
    this.readout.textContent = movementDebugSnapshotText(snapshot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeEventListener('input', this.handleInput);
    this.root.removeEventListener('click', this.handleClick);
    this.root.remove();
  }

  private readonly handleInput = (event: Event): void => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const path = input?.dataset.movementPath as MovementTuningPath | undefined;
    if (!input || !path || !setMovementTuningValue(this.tuning, path, Number(input.value))) return;
    const step = Number(input.step);
    const output = this.values.get(path);
    if (output) output.value = Number(input.value).toFixed(step >= 1 ? 0 : 3);
    persistMovementTuning(this.tuning);
  };

  private readonly handleClick = (event: Event): void => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || !this.root.contains(button)) return;
    const scenario = button.dataset.movementScenario;
    if (scenario) {
      event.preventDefault();
      // A clicked button remains the KeyboardEvent target in browsers. Blurring
      // it before dispatch lets Game move focus back to the canvas immediately.
      button.blur();
      if (scenario === 'short') this.actions.onShortJump?.();
      else if (scenario === 'chain') this.actions.onFullChain?.();
      else if (scenario === 'skid') this.actions.onSkid?.();
      else if (scenario === 'drop') this.actions.onHeavyDrop?.();
      return;
    }
    if (button.hasAttribute('data-movement-toggle')) {
      const collapsed = this.root.classList.toggle('is-collapsed');
      button.textContent = collapsed ? '+' : '-';
      return;
    }
    if (button.hasAttribute('data-movement-reset')) {
      const defaults = cloneMovementTuning(DEFAULT_MOVEMENT_TUNING);
      for (const [section, entries] of Object.entries(defaults)) {
        for (const [key, value] of Object.entries(entries)) {
          setMovementTuningValue(this.tuning, `${section}.${key}` as MovementTuningPath, Number(value));
        }
      }
      clearPersistedMovementTuning();
      for (const input of this.root.querySelectorAll<HTMLInputElement>('[data-movement-path]')) {
        const path = input.dataset.movementPath as MovementTuningPath;
        const [section, key] = path.split('.', 2);
        const value = (this.tuning[section as keyof MovementTuning] as unknown as Record<string, number>)[key!]!;
        input.value = String(value);
        const output = this.values.get(path);
        if (output) output.value = value.toFixed(Number(input.step) >= 1 ? 0 : 3);
      }
      return;
    }
    if (button.hasAttribute('data-movement-export')) {
      const code = movementTuningCode(this.tuning);
      console.info(code);
      void navigator.clipboard?.writeText(code).catch(() => undefined);
      button.textContent = 'COPIED + LOGGED';
      window.setTimeout(() => { if (!this.disposed) button.textContent = 'EXPORT'; }, 1_400);
    }
  };
}
