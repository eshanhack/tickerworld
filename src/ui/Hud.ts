import type { AssetSymbol, FeedMode } from '../types';
import { formatPrice } from '../monuments';

export interface HudCallbacks {
  onEnter: () => void | Promise<void>;
  onMuteToggle: () => void;
  onVolumeChange: (value: number) => void;
  onCompassToggle: (enabled: boolean) => void;
  onReducedMotionToggle: (enabled: boolean) => void;
  onVirtualInput: (x: number, forward: number, sprint: boolean) => void;
}

interface NearbyView {
  symbol: AssetSymbol;
  price: number;
  mode: FeedMode;
  distance: number;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly callbacks: HudCallbacks;
  private readonly enterOverlay: HTMLElement;
  private readonly enterButton: HTMLButtonElement;
  private readonly nearbyPanel: HTMLElement;
  private readonly nearbySymbol: HTMLElement;
  private readonly nearbyPrice: HTMLElement;
  private readonly nearbyMode: HTMLElement;
  private readonly compass: HTMLElement;
  private readonly compassArrow: HTMLElement;
  private readonly compassLabel: HTMLElement;
  private readonly helpPanel: HTMLElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly volumeInput: HTMLInputElement;
  private readonly compassButton: HTMLButtonElement;
  private readonly motionButton: HTMLButtonElement;
  private readonly toast: HTMLElement;
  private readonly debug: HTMLElement;
  private readonly joystick: HTMLElement;
  private readonly joystickKnob: HTMLElement;
  private joystickPointer: number | null = null;
  private joystickCenter = { x: 0, y: 0 };
  private compassEnabled = true;
  private toastTimer: number | undefined;

  constructor(container: HTMLElement, callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.root = document.createElement('div');
    this.root.className = 'hud is-awaiting-entry';
    this.root.innerHTML = `
      <section class="enter-overlay" aria-labelledby="game-title">
        <div class="enter-sky-speck speck-one"></div>
        <div class="enter-sky-speck speck-two"></div>
        <div class="enter-card">
          <div class="title-kicker"><span></span> A living little market world</div>
          <h1 id="game-title">Tickerworld</h1>
          <p>Follow the paths. Listen for the markets.<br />There is nowhere you need to be.</p>
          <button class="enter-button" type="button" data-enter>
            <span>Enter the world</span><small>sound on</small>
          </button>
          <div class="enter-controls"><kbd>WASD</kbd> roam <span>·</span> <kbd>Shift</kbd> run <span>·</span> drag to look</div>
        </div>
      </section>

      <section class="nearby-panel is-hidden" aria-live="polite" data-nearby>
        <div class="nearby-symbol" data-nearby-symbol>BTC</div>
        <div><div class="nearby-label">nearby market</div><div class="nearby-price" data-nearby-price>$0</div></div>
        <div class="market-mode simulated" data-nearby-mode>SIMULATED</div>
      </section>

      <button class="compass is-hidden" type="button" aria-label="Toggle monument compass" data-compass>
        <span class="compass-arrow" data-compass-arrow>↑</span>
        <span data-compass-label>ETH</span>
      </button>

      <div class="hud-toast" role="status" aria-live="polite" data-toast></div>

      <div class="hud-actions">
        <button class="round-action" type="button" aria-label="Mute sound" data-mute>♪</button>
        <label class="volume-control" aria-label="Master volume"><input type="range" min="0" max="1" step="0.01" value="0.55" data-volume /></label>
        <button class="round-action" type="button" aria-label="Show controls" data-help>?</button>
      </div>

      <section class="help-panel is-hidden" aria-label="Controls and information" data-help-panel>
        <button type="button" class="close-help" aria-label="Close controls" data-close-help>×</button>
        <div class="help-mark">TW</div>
        <h2>Take your time</h2>
        <dl>
          <div><dt>Move</dt><dd>WASD or arrow keys</dd></div>
          <div><dt>Run</dt><dd>Hold Shift</dd></div>
          <div><dt>Look</dt><dd>Drag the world</dd></div>
          <div><dt>Zoom</dt><dd>Mouse wheel</dd></div>
        </dl>
        <button type="button" class="compass-setting" data-compass-setting><span>Monument whisper</span><strong>ON</strong></button>
        <button type="button" class="compass-setting motion-setting" data-motion-setting><span>Gentle motion</span><strong>OFF</strong></button>
        <p>Live prices use Binance USDT market data. Simulated mode keeps the world moving when the feed is unavailable. For ambience, not financial advice.</p>
      </section>

      <div class="mobile-joystick" data-joystick aria-hidden="true"><div class="joystick-knob" data-joystick-knob></div></div>
      <div class="rotate-device"><span>↻</span><strong>Turn your phone sideways</strong><small>Tickerworld likes a wider view.</small></div>
      <pre class="debug-panel is-hidden" data-debug></pre>
    `;
    container.append(this.root);

    this.enterOverlay = this.required('.enter-overlay');
    this.enterButton = this.required<HTMLButtonElement>('[data-enter]');
    this.nearbyPanel = this.required('[data-nearby]');
    this.nearbySymbol = this.required('[data-nearby-symbol]');
    this.nearbyPrice = this.required('[data-nearby-price]');
    this.nearbyMode = this.required('[data-nearby-mode]');
    this.compass = this.required('[data-compass]');
    this.compassArrow = this.required('[data-compass-arrow]');
    this.compassLabel = this.required('[data-compass-label]');
    this.helpPanel = this.required('[data-help-panel]');
    this.muteButton = this.required<HTMLButtonElement>('[data-mute]');
    this.volumeInput = this.required<HTMLInputElement>('[data-volume]');
    this.compassButton = this.required<HTMLButtonElement>('[data-compass-setting]');
    this.motionButton = this.required<HTMLButtonElement>('[data-motion-setting]');
    this.toast = this.required('[data-toast]');
    this.debug = this.required('[data-debug]');
    this.joystick = this.required('[data-joystick]');
    this.joystickKnob = this.required('[data-joystick-knob]');

    this.enterButton.addEventListener('click', this.enter);
    this.muteButton.addEventListener('click', this.mute);
    this.volumeInput.addEventListener('input', this.volume);
    this.required('[data-help]').addEventListener('click', this.toggleHelp);
    this.required('[data-close-help]').addEventListener('click', this.closeHelp);
    this.compassButton.addEventListener('click', this.toggleCompass);
    this.motionButton.addEventListener('click', this.toggleMotion);
    this.compass.addEventListener('click', this.toggleCompass);
    this.joystick.addEventListener('pointerdown', this.joystickStart);
    this.joystick.addEventListener('pointermove', this.joystickMove);
    this.joystick.addEventListener('pointerup', this.joystickEnd);
    this.joystick.addEventListener('pointercancel', this.joystickEnd);
    document.addEventListener('keydown', this.keydown);
  }

  setEnterReady(ready: boolean): void {
    this.enterButton.disabled = !ready;
    this.enterButton.querySelector('span')!.textContent = ready ? 'Enter the world' : 'Growing the world…';
  }

  setEntered(): void {
    this.root.classList.remove('is-awaiting-entry');
    this.enterOverlay.classList.add('is-entered');
    window.setTimeout(() => this.enterOverlay.remove(), 900);
  }

  setNearby(view: NearbyView | null): void {
    this.nearbyPanel.classList.toggle('is-hidden', !view);
    if (!view) return;
    this.nearbySymbol.textContent = view.symbol;
    this.nearbyPrice.textContent = formatPrice(view.price);
    const live = view.mode === 'live';
    this.nearbyMode.textContent = live ? 'LIVE · BINANCE' : view.mode === 'reconnecting' ? 'RECONNECTING' : 'SIMULATED';
    this.nearbyMode.className = `market-mode ${live ? 'live' : 'simulated'}`;
    this.nearbyPanel.style.setProperty('--nearby-distance', `${Math.min(1, view.distance / 80)}`);
  }

  setCompass(angle: number, symbol: AssetSymbol | null): void {
    const visible = this.compassEnabled && symbol !== null;
    this.compass.classList.toggle('is-hidden', !visible);
    if (!symbol) return;
    this.compassArrow.style.transform = `rotate(${angle}rad)`;
    this.compassLabel.textContent = symbol;
  }

  setCompassEnabled(enabled: boolean): void {
    this.compassEnabled = enabled;
    this.compassButton.querySelector('strong')!.textContent = enabled ? 'ON' : 'OFF';
    if (!enabled) this.compass.classList.add('is-hidden');
  }

  setReducedMotion(enabled: boolean): void {
    this.motionButton.dataset.enabled = String(enabled);
    this.motionButton.querySelector('strong')!.textContent = enabled ? 'ON' : 'OFF';
  }

  setMuted(muted: boolean): void {
    this.muteButton.textContent = muted ? '×' : '♪';
    this.muteButton.classList.toggle('is-active', muted);
    this.muteButton.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
  }

  setVolume(value: number): void {
    this.volumeInput.value = String(value);
  }

  showToast(message: string): void {
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    this.toast.textContent = message;
    this.toast.classList.add('is-visible');
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('is-visible'), 3200);
  }

  setDebug(text: string | null): void {
    this.debug.classList.toggle('is-hidden', text === null);
    if (text !== null) this.debug.textContent = text;
  }

  dispose(): void {
    this.enterButton.removeEventListener('click', this.enter);
    this.muteButton.removeEventListener('click', this.mute);
    this.volumeInput.removeEventListener('input', this.volume);
    this.joystick.removeEventListener('pointerdown', this.joystickStart);
    this.joystick.removeEventListener('pointermove', this.joystickMove);
    this.joystick.removeEventListener('pointerup', this.joystickEnd);
    this.joystick.removeEventListener('pointercancel', this.joystickEnd);
    document.removeEventListener('keydown', this.keydown);
    this.root.remove();
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Tickerworld HUD is missing ${selector}`);
    return element;
  }

  private readonly enter = (): void => {
    this.enterButton.disabled = true;
    void Promise.resolve(this.callbacks.onEnter()).finally(() => {
      this.enterButton.disabled = false;
    });
  };

  private readonly mute = (): void => this.callbacks.onMuteToggle();
  private readonly volume = (): void => this.callbacks.onVolumeChange(Number(this.volumeInput.value));
  private readonly toggleHelp = (): void => {
    this.helpPanel.classList.toggle('is-hidden');
  };
  private readonly closeHelp = (): void => this.helpPanel.classList.add('is-hidden');
  private readonly toggleCompass = (): void => {
    this.compassEnabled = !this.compassEnabled;
    this.compassButton.querySelector('strong')!.textContent = this.compassEnabled ? 'ON' : 'OFF';
    this.compass.classList.toggle('is-hidden', !this.compassEnabled);
    this.callbacks.onCompassToggle(this.compassEnabled);
  };
  private readonly toggleMotion = (): void => {
    const enabled = this.motionButton.dataset.enabled !== 'true';
    this.setReducedMotion(enabled);
    this.callbacks.onReducedMotionToggle(enabled);
  };
  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.helpPanel.classList.add('is-hidden');
  };

  private readonly joystickStart = (event: PointerEvent): void => {
    this.joystickPointer = event.pointerId;
    const rect = this.joystick.getBoundingClientRect();
    this.joystickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    this.joystick.setPointerCapture(event.pointerId);
    this.updateJoystick(event);
  };
  private readonly joystickMove = (event: PointerEvent): void => {
    if (event.pointerId === this.joystickPointer) this.updateJoystick(event);
  };
  private readonly joystickEnd = (event: PointerEvent): void => {
    if (event.pointerId !== this.joystickPointer) return;
    this.joystickPointer = null;
    this.joystickKnob.style.transform = 'translate(0, 0)';
    this.callbacks.onVirtualInput(0, 0, false);
  };
  private updateJoystick(event: PointerEvent): void {
    const radius = Math.max(32, this.joystick.clientWidth * 0.34);
    const rawX = event.clientX - this.joystickCenter.x;
    const rawY = event.clientY - this.joystickCenter.y;
    const length = Math.hypot(rawX, rawY);
    const scale = length > radius ? radius / length : 1;
    const x = rawX * scale;
    const y = rawY * scale;
    const magnitude = Math.min(1, length / radius);
    this.joystickKnob.style.transform = `translate(${x}px, ${y}px)`;
    this.callbacks.onVirtualInput(x / radius, -y / radius, magnitude > 0.92);
  }
}
