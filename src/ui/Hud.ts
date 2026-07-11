import type { AssetSymbol, FeedMode } from '../types';
import { formatPrice } from '../monuments';
import {
  NewsOverlayView,
  type NewsOverlayViewState,
} from './NewsOverlayView';

export interface HudCallbacks {
  onEnter: () => void | Promise<void>;
  onMuteToggle: () => void;
  onVolumeChange: (value: number) => void;
  onMusicMuteToggle: () => void;
  onMusicVolumeChange: (value: number) => void;
  onSfxMuteToggle: () => void;
  onSfxVolumeChange: (value: number) => void;
  onCompassToggle: (enabled: boolean) => void;
  onReducedMotionToggle: (enabled: boolean) => void;
  onVirtualInput: (x: number, forward: number, sprint: boolean) => void;
  onJump: () => void;
  onGlideChange: (held: boolean) => void;
  onNewsDismiss?: (itemId: string) => void;
}

interface NearbyView {
  symbol: AssetSymbol;
  price: number | null;
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
  private readonly musicMuteButton: HTMLButtonElement;
  private readonly musicVolumeInput: HTMLInputElement;
  private readonly sfxMuteButton: HTMLButtonElement;
  private readonly sfxVolumeInput: HTMLInputElement;
  private readonly compassButton: HTMLButtonElement;
  private readonly motionButton: HTMLButtonElement;
  private readonly toast: HTMLElement;
  private readonly debug: HTMLElement;
  private readonly joystick: HTMLElement;
  private readonly joystickKnob: HTMLElement;
  private readonly jumpButton: HTMLButtonElement;
  private readonly newsOverlay: NewsOverlayView;
  private readonly activeJumpPointers = new Set<number>();
  private joystickPointer: number | null = null;
  private joystickCenter = { x: 0, y: 0 };
  private compassEnabled = true;
  private toastTimer: number | undefined;
  private pricePulseTimer: number | undefined;
  private displayedNearbyPrice = '';

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
          <div class="enter-controls"><kbd>WASD</kbd> roam <span>·</span> <kbd>Shift</kbd> run <span>·</span> hold <kbd>Space</kbd> to glide <span>·</span> drag to look</div>
        </div>
      </section>

      <section class="nearby-panel is-hidden" aria-live="polite" data-nearby>
        <div class="nearby-symbol" data-nearby-symbol>BTC</div>
        <div><div class="nearby-label">nearby market</div><div class="nearby-price" data-nearby-price>$—</div></div>
        <div class="market-mode connecting" data-nearby-mode>CONNECTING</div>
      </section>

      <button class="compass is-hidden" type="button" aria-label="Toggle monument compass" data-compass>
        <span class="compass-arrow" data-compass-arrow>↑</span>
        <span data-compass-label>ETH</span>
      </button>

      <div class="hud-toast" role="status" aria-live="polite" data-toast></div>

      <div class="hud-actions">
        <div class="audio-mixer" aria-label="Sound controls">
          <div class="audio-channel">
            <button class="channel-mute" type="button" aria-label="Mute music" data-music-mute><span>♪</span><strong>Music</strong></button>
            <label aria-label="Music volume"><input type="range" min="0" max="1" step="0.01" value="1" data-music-volume /></label>
          </div>
          <div class="audio-channel">
            <button class="channel-mute" type="button" aria-label="Mute sound effects" data-sfx-mute><span>✦</span><strong>FX</strong></button>
            <label aria-label="Sound effects volume"><input type="range" min="0" max="1" step="0.01" value="1" data-sfx-volume /></label>
          </div>
        </div>
        <button class="round-action" type="button" aria-label="Show controls" data-help>?</button>
      </div>

      <section class="help-panel is-hidden" aria-label="Controls and information" data-help-panel>
        <button type="button" class="close-help" aria-label="Close controls" data-close-help>×</button>
        <div class="help-mark">TW</div>
        <h2>Take your time</h2>
        <dl>
          <div><dt>Move</dt><dd>WASD or arrow keys</dd></div>
          <div><dt>Run</dt><dd>Hold Shift</dd></div>
          <div><dt>Jump</dt><dd>Space twice; hold to glide</dd></div>
          <div><dt>Look</dt><dd>Drag the world</dd></div>
          <div><dt>Zoom</dt><dd>Mouse wheel</dd></div>
        </dl>
        <button type="button" class="compass-setting" data-compass-setting><span>Monument whisper</span><strong>ON</strong></button>
        <button type="button" class="compass-setting motion-setting" data-motion-setting><span>Gentle motion</span><strong>OFF</strong></button>
        <p>Live prices use Hyperliquid perpetual market data. If the feed drops, the last genuine values pause while Tickerworld reconnects. For ambience, not financial advice.</p>
      </section>

      <div class="mobile-joystick" data-joystick aria-hidden="true"><div class="joystick-knob" data-joystick-knob></div></div>
      <button class="mobile-jump" type="button" aria-label="Jump; hold to glide and tap again in the air to double jump" data-jump><span>&#10022;</span><small>JUMP · HOLD</small></button>
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
    this.musicMuteButton = this.required<HTMLButtonElement>('[data-music-mute]');
    this.musicVolumeInput = this.required<HTMLInputElement>('[data-music-volume]');
    this.sfxMuteButton = this.required<HTMLButtonElement>('[data-sfx-mute]');
    this.sfxVolumeInput = this.required<HTMLInputElement>('[data-sfx-volume]');
    this.compassButton = this.required<HTMLButtonElement>('[data-compass-setting]');
    this.motionButton = this.required<HTMLButtonElement>('[data-motion-setting]');
    this.toast = this.required('[data-toast]');
    this.debug = this.required('[data-debug]');
    this.joystick = this.required('[data-joystick]');
    this.joystickKnob = this.required('[data-joystick-knob]');
    this.jumpButton = this.required<HTMLButtonElement>('[data-jump]');
    this.newsOverlay = new NewsOverlayView(this.root, {
      onDismiss: (itemId) => this.callbacks.onNewsDismiss?.(itemId),
    });

    this.enterButton.addEventListener('click', this.enter);
    this.musicMuteButton.addEventListener('click', this.musicMute);
    this.musicVolumeInput.addEventListener('input', this.musicVolume);
    this.sfxMuteButton.addEventListener('click', this.sfxMute);
    this.sfxVolumeInput.addEventListener('input', this.sfxVolume);
    this.required('[data-help]').addEventListener('click', this.toggleHelp);
    this.required('[data-close-help]').addEventListener('click', this.closeHelp);
    this.compassButton.addEventListener('click', this.toggleCompass);
    this.motionButton.addEventListener('click', this.toggleMotion);
    this.compass.addEventListener('click', this.toggleCompass);
    this.joystick.addEventListener('pointerdown', this.joystickStart);
    this.joystick.addEventListener('pointermove', this.joystickMove);
    this.joystick.addEventListener('pointerup', this.joystickEnd);
    this.joystick.addEventListener('pointercancel', this.joystickEnd);
    this.jumpButton.addEventListener('pointerdown', this.jump);
    this.jumpButton.addEventListener('pointerup', this.jumpRelease);
    this.jumpButton.addEventListener('pointercancel', this.jumpRelease);
    this.jumpButton.addEventListener('lostpointercapture', this.jumpRelease);
    window.addEventListener('blur', this.releaseAllJumps);
    document.addEventListener('visibilitychange', this.releaseAllJumps);
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
    const nextPrice = formatPrice(view.price);
    if (nextPrice !== this.displayedNearbyPrice) {
      this.displayedNearbyPrice = nextPrice;
      this.nearbyPrice.textContent = nextPrice;
      this.nearbyPrice.classList.remove('is-ticking');
      void this.nearbyPrice.offsetWidth;
      this.nearbyPrice.classList.add('is-ticking');
      if (this.pricePulseTimer !== undefined) window.clearTimeout(this.pricePulseTimer);
      this.pricePulseTimer = window.setTimeout(() => this.nearbyPrice.classList.remove('is-ticking'), 420);
    }
    this.nearbyMode.textContent = view.mode === 'live'
      ? 'LIVE · HYPERLIQUID'
      : view.mode === 'connecting'
        ? 'CONNECTING'
        : view.mode === 'reconnecting'
          ? 'RECONNECTING'
          : 'SIMULATED · QA';
    this.nearbyMode.className = `market-mode ${view.mode}`;
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
    this.setMusicMuted(muted);
    this.setSfxMuted(muted);
  }

  setVolume(value: number): void {
    this.setMusicVolume(value);
    this.setSfxVolume(value);
  }

  setMusicMuted(muted: boolean): void {
    this.musicMuteButton.classList.toggle('is-active', muted);
    this.musicMuteButton.querySelector('span')!.textContent = muted ? '×' : '♪';
    this.musicMuteButton.setAttribute('aria-label', muted ? 'Unmute music' : 'Mute music');
  }

  setMusicVolume(value: number): void {
    this.musicVolumeInput.value = String(value);
  }

  setSfxMuted(muted: boolean): void {
    this.sfxMuteButton.classList.toggle('is-active', muted);
    this.sfxMuteButton.querySelector('span')!.textContent = muted ? '×' : '✦';
    this.sfxMuteButton.setAttribute('aria-label', muted ? 'Unmute sound effects' : 'Mute sound effects');
  }

  setSfxVolume(value: number): void {
    this.sfxVolumeInput.value = String(value);
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

  setNewsOverlay(state: NewsOverlayViewState | null): void {
    this.newsOverlay.setState(state);
  }

  dispose(): void {
    this.enterButton.removeEventListener('click', this.enter);
    this.musicMuteButton.removeEventListener('click', this.musicMute);
    this.musicVolumeInput.removeEventListener('input', this.musicVolume);
    this.sfxMuteButton.removeEventListener('click', this.sfxMute);
    this.sfxVolumeInput.removeEventListener('input', this.sfxVolume);
    this.joystick.removeEventListener('pointerdown', this.joystickStart);
    this.joystick.removeEventListener('pointermove', this.joystickMove);
    this.joystick.removeEventListener('pointerup', this.joystickEnd);
    this.joystick.removeEventListener('pointercancel', this.joystickEnd);
    this.jumpButton.removeEventListener('pointerdown', this.jump);
    this.jumpButton.removeEventListener('pointerup', this.jumpRelease);
    this.jumpButton.removeEventListener('pointercancel', this.jumpRelease);
    this.jumpButton.removeEventListener('lostpointercapture', this.jumpRelease);
    window.removeEventListener('blur', this.releaseAllJumps);
    document.removeEventListener('visibilitychange', this.releaseAllJumps);
    document.removeEventListener('keydown', this.keydown);
    this.releaseAllJumps();
    if (this.pricePulseTimer !== undefined) window.clearTimeout(this.pricePulseTimer);
    this.newsOverlay.dispose();
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

  private readonly musicMute = (): void => this.callbacks.onMusicMuteToggle();
  private readonly musicVolume = (): void => this.callbacks.onMusicVolumeChange(Number(this.musicVolumeInput.value));
  private readonly sfxMute = (): void => this.callbacks.onSfxMuteToggle();
  private readonly sfxVolume = (): void => this.callbacks.onSfxVolumeChange(Number(this.sfxVolumeInput.value));
  private readonly jump = (event: PointerEvent): void => {
    event.preventDefault();
    if (this.activeJumpPointers.has(event.pointerId)) return;
    this.activeJumpPointers.add(event.pointerId);
    this.jumpButton.setPointerCapture(event.pointerId);
    this.callbacks.onJump();
    this.callbacks.onGlideChange(true);
  };
  private readonly jumpRelease = (event: PointerEvent): void => {
    this.activeJumpPointers.delete(event.pointerId);
    this.callbacks.onGlideChange(this.activeJumpPointers.size > 0);
  };
  private readonly releaseAllJumps = (): void => {
    if (this.activeJumpPointers.size === 0) return;
    this.activeJumpPointers.clear();
    this.callbacks.onGlideChange(false);
  };
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
