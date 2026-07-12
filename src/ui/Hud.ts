import type { AnimalKind, EmoteKind } from '../../shared/src/index.js';
import type { AssetSymbol, FeedMode } from '../types';
import { formatPrice } from '../monuments';
import {
  entryFeedStatusLabel,
  entryRoomStatusLabel,
  entryShellForMarket,
  type EntryRoomStatus,
  type EntryShellModel,
} from './EntryShellModel';
import {
  NewsOverlayView,
  type NewsOverlayViewState,
} from './NewsOverlayView';
import {
  OnboardingJourney,
  type OnboardingAction,
  type OnboardingSnapshot,
} from './OnboardingJourney';
import { OverlayCoordinator, type OverlayOwner } from './OverlayCoordinator';
import type { UiInteractionOwner } from './UiInteractionLock';
import { WardrobeView } from './WardrobeView';

export type UiEmoteKind = EmoteKind;

export interface HudOptions {
  readonly activeMarket: AssetSymbol;
  readonly initialAnimal: AnimalKind;
}

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
  onAnimalSelect?: (animal: AnimalKind) => boolean | void;
  onEmoteRequest?: (kind: UiEmoteKind) => boolean | void;
  onUiInteractionChange?: (owner: UiInteractionOwner, active: boolean) => void;
  onLargeOverlayOpen?: (owner: UiInteractionOwner) => void;
  onContextRetry?: () => void;
  onNewsDismiss?: (itemId: string) => void;
  onNewsInteractionChange?: (active: boolean) => void;
}

interface NearbyView {
  symbol: AssetSymbol;
  price: number | null;
  mode: FeedMode;
  distance: number;
  ageMs?: number | null;
}

const EMOTES: readonly { kind: UiEmoteKind; icon: string; label: string }[] = [
  { kind: 'wave', icon: '\u2191', label: 'Wave' },
  { kind: 'sparkle-heart', icon: '\u2661', label: 'Sparkle heart' },
  { kind: 'cheer', icon: '\u2606', label: 'Cheer' },
  { kind: 'spin', icon: '\u21bb', label: 'Spin' },
  { kind: 'gasp', icon: '!', label: 'Gasp' },
  { kind: 'curl-nap', icon: 'Zz', label: 'Curl up' },
];

function onboardingCopy(snapshot: OnboardingSnapshot): {
  title: string;
  body: string;
  cta: string | null;
} {
  switch (snapshot.currentStep) {
    case 'identity':
      return { title: 'Choose your creature', body: 'All eight launch animals are free.', cta: 'Open wardrobe' };
    case 'move-jump': {
      const moved = snapshot.completedActions.has('move');
      const jumped = snapshot.completedActions.has('jump');
      return {
        title: moved ? 'Now take flight' : jumped ? 'Now roam a little' : 'Find your footing',
        body: moved
          ? 'Press Space or use the jump button.'
          : jumped
            ? 'Use WASD, arrows, or the joystick.'
            : 'Move around, then jump once.',
        cta: null,
      };
    }
    case 'glide':
      return { title: 'Catch the air', body: 'Jump, then hold Space or hold Jump to glide.', cta: null };
    case 'emote':
      return { title: 'Say hello', body: 'Try an emote when another wanderer appears.', cta: 'Choose emote' };
    case 'portal-share':
      return { title: 'Make the world yours', body: 'Take a portal to another market or share a moment.', cta: null };
    case null:
      return { title: 'You are ready', body: 'The paths are yours now.', cta: null };
  }
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly callbacks: HudCallbacks;
  private entryModel: EntryShellModel;
  private readonly enterOverlay: HTMLElement;
  private readonly enterButton: HTMLButtonElement;
  private readonly entryKicker: HTMLElement;
  private readonly entryTitle: HTMLElement;
  private readonly entryDescription: HTMLElement;
  private readonly entryFeedStatus: HTMLElement;
  private readonly entryRoomStatus: HTMLElement;
  private readonly nearbyPanel: HTMLElement;
  private readonly nearbySymbol: HTMLElement;
  private readonly nearbyPrice: HTMLElement;
  private readonly nearbyMode: HTMLElement;
  private readonly compass: HTMLElement;
  private readonly compassArrow: HTMLElement;
  private readonly compassLabel: HTMLElement;
  private readonly helpPanel: HTMLElement;
  private readonly helpButton: HTMLButtonElement;
  private readonly closeHelpButton: HTMLButtonElement;
  private readonly wardrobeButton: HTMLButtonElement;
  private readonly settingsWardrobeButton: HTMLButtonElement;
  private readonly emoteButton: HTMLButtonElement;
  private readonly emotePicker: HTMLElement;
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
  private readonly onboardingHint: HTMLElement;
  private readonly onboardingTitle: HTMLElement;
  private readonly onboardingBody: HTMLElement;
  private readonly onboardingProgress: HTMLElement;
  private readonly onboardingCta: HTMLButtonElement;
  private readonly contextLossOverlay: HTMLElement;
  private readonly contextRetryButton: HTMLButtonElement;
  private readonly newsOverlay: NewsOverlayView;
  private readonly wardrobe: WardrobeView;
  private readonly onboarding = new OnboardingJourney();
  private readonly overlays = new OverlayCoordinator();
  private readonly extensionLayers = new Set<HTMLElement>();
  private readonly activeJumpPointers = new Set<number>();
  private readonly stopOnboardingSubscription: () => void;
  private pendingNewsState: NewsOverlayViewState | null = null;
  private joystickPointer: number | null = null;
  private joystickCenter = { x: 0, y: 0 };
  private compassEnabled = true;
  private toastTimer: number | undefined;
  private pricePulseTimer: number | undefined;
  private displayedNearbyPrice = '';
  private entered = false;

  public constructor(container: HTMLElement, callbacks: HudCallbacks, options: HudOptions) {
    this.callbacks = callbacks;
    this.entryModel = entryShellForMarket(options.activeMarket);
    this.root = document.createElement('div');
    this.root.className = 'hud is-awaiting-entry';
    this.root.innerHTML = `
      <section class="enter-overlay" aria-labelledby="game-title">
        <div class="enter-sky-speck speck-one"></div>
        <div class="enter-sky-speck speck-two"></div>
        <div class="enter-card">
          <div class="title-kicker" data-entry-kicker><span></span>${this.entryModel.kicker}</div>
          <h1 id="game-title" data-entry-title>${this.entryModel.title}</h1>
          <p data-entry-description>${this.entryModel.description}</p>
          <div class="entry-status" aria-live="polite">
            <span class="is-connecting" data-entry-feed>Market connecting</span>
            <span class="is-connecting" data-entry-room>Finding wanderers</span>
          </div>
          <button class="enter-button" type="button" data-enter>
            <span>${this.entryModel.enterLabel}</span><small>sound on</small>
          </button>
          <div class="enter-controls"><kbd>WASD</kbd> roam <span>&middot;</span> <kbd>Shift</kbd> run <span>&middot;</span> hold <kbd>Space</kbd> to glide <span>&middot;</span> drag to look</div>
          <div class="entry-promise">No signup &middot; no wallet &middot; sound starts after tap</div>
          <nav class="entry-links" aria-label="Tickerworld information"><a href="/community">Community</a><a href="/status">Status</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
        </div>
      </section>

      <section class="nearby-panel is-hidden" aria-live="polite" data-nearby>
        <div class="nearby-symbol" data-nearby-symbol>BTC</div>
        <div><div class="nearby-label">nearby market</div><div class="nearby-price" data-nearby-price>$&mdash;</div></div>
        <div class="market-mode connecting" data-nearby-mode>CONNECTING</div>
      </section>

      <button class="compass is-hidden" type="button" aria-label="Toggle monument compass" data-compass>
        <span class="compass-arrow" data-compass-arrow>&uarr;</span><span data-compass-label>ETH</span>
      </button>

      <section class="onboarding-hint is-hidden" aria-live="polite" data-onboarding>
        <div class="onboarding-orb" aria-hidden="true">&#10022;</div>
        <div><small data-onboarding-progress>1 / 5</small><strong data-onboarding-title>Choose your creature</strong><p data-onboarding-body>All eight launch animals are free.</p></div>
        <button type="button" data-onboarding-cta>Open wardrobe</button>
      </section>

      <div class="hud-toast" role="status" aria-live="polite" data-toast></div>

      <div class="hud-actions">
        <button class="round-action wardrobe-action" type="button" aria-label="Choose your creature" data-wardrobe>YOU</button>
        <button class="round-action emote-action" type="button" aria-label="Choose an emote" data-emote>&#10022;</button>
        <button class="round-action" type="button" aria-label="Show settings and controls" data-help>?</button>
      </div>

      <section class="emote-picker is-hidden" aria-label="Emotes" data-emote-picker>
        ${EMOTES.map(({ kind, icon, label }) => `<button type="button" data-emote-kind="${kind}" aria-label="${label}"><span>${icon}</span><small>${label}</small></button>`).join('')}
      </section>

      <section class="help-panel is-hidden" aria-label="Settings and controls" data-help-panel>
        <button type="button" class="close-help" aria-label="Close settings" data-close-help>&times;</button>
        <div class="help-mark">TW</div>
        <h2>Take your time</h2>
        <dl><div><dt>Move</dt><dd>WASD or arrow keys</dd></div><div><dt>Run</dt><dd>Hold Shift</dd></div><div><dt>Jump</dt><dd>Space twice; hold to glide</dd></div><div><dt>Look</dt><dd>Drag the world</dd></div><div><dt>Zoom</dt><dd>Mouse wheel</dd></div></dl>
        <div class="audio-mixer settings-audio-mixer" aria-label="Sound controls">
          <div class="audio-channel"><button class="channel-mute" type="button" aria-label="Mute music" data-music-mute><span>&#9834;</span><strong>Music</strong></button><label aria-label="Music volume"><input type="range" min="0" max="1" step="0.01" value="1" data-music-volume /></label></div>
          <div class="audio-channel"><button class="channel-mute" type="button" aria-label="Mute sound effects" data-sfx-mute><span>&#10022;</span><strong>FX</strong></button><label aria-label="Sound effects volume"><input type="range" min="0" max="1" step="0.01" value="1" data-sfx-volume /></label></div>
        </div>
        <button type="button" class="compass-setting wardrobe-setting" data-settings-wardrobe><span>Creature wardrobe</span><strong>8 FREE</strong></button>
        <button type="button" class="compass-setting" data-compass-setting><span>Monument whisper</span><strong>ON</strong></button>
        <button type="button" class="compass-setting motion-setting" data-motion-setting><span>Gentle motion</span><strong>OFF</strong></button>
        <p>Live prices use Hyperliquid perpetual market data. If the feed drops, genuine values pause while Tickerworld reconnects. For ambience, not financial advice.</p>
        <nav class="settings-links" aria-label="Tickerworld help and policies"><a href="/support">Support</a><a href="/community">Community</a><a href="/status">Status</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
      </section>

      <div class="mobile-joystick" data-joystick aria-hidden="true"><div class="joystick-knob" data-joystick-knob></div></div>
      <button class="mobile-jump" type="button" aria-label="Jump; hold to glide and tap again in the air to double jump" data-jump><span>&#10022;</span><small>JUMP &middot; HOLD</small></button>
      <section class="context-loss-overlay is-hidden" role="alertdialog" aria-modal="true" aria-labelledby="context-loss-title" data-context-loss><div><span aria-hidden="true">TW</span><h2 id="context-loss-title">The world went quiet</h2><p>Your browser paused the 3D canvas. Your route is safe; retry to grow the scene again.</p><button type="button" data-context-retry>Retry Tickerworld</button></div></section>
      <pre class="debug-panel is-hidden" data-debug></pre>
    `;
    container.append(this.root);

    this.enterOverlay = this.required('.enter-overlay');
    this.enterButton = this.required<HTMLButtonElement>('[data-enter]');
    this.entryKicker = this.required('[data-entry-kicker]');
    this.entryTitle = this.required('[data-entry-title]');
    this.entryDescription = this.required('[data-entry-description]');
    this.entryFeedStatus = this.required('[data-entry-feed]');
    this.entryRoomStatus = this.required('[data-entry-room]');
    this.nearbyPanel = this.required('[data-nearby]');
    this.nearbySymbol = this.required('[data-nearby-symbol]');
    this.nearbyPrice = this.required('[data-nearby-price]');
    this.nearbyMode = this.required('[data-nearby-mode]');
    this.compass = this.required('[data-compass]');
    this.compassArrow = this.required('[data-compass-arrow]');
    this.compassLabel = this.required('[data-compass-label]');
    this.helpPanel = this.required('[data-help-panel]');
    this.helpButton = this.required<HTMLButtonElement>('[data-help]');
    this.closeHelpButton = this.required<HTMLButtonElement>('[data-close-help]');
    this.wardrobeButton = this.required<HTMLButtonElement>('[data-wardrobe]');
    this.settingsWardrobeButton = this.required<HTMLButtonElement>('[data-settings-wardrobe]');
    this.emoteButton = this.required<HTMLButtonElement>('[data-emote]');
    this.emotePicker = this.required('[data-emote-picker]');
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
    this.onboardingHint = this.required('[data-onboarding]');
    this.onboardingTitle = this.required('[data-onboarding-title]');
    this.onboardingBody = this.required('[data-onboarding-body]');
    this.onboardingProgress = this.required('[data-onboarding-progress]');
    this.onboardingCta = this.required<HTMLButtonElement>('[data-onboarding-cta]');
    this.contextLossOverlay = this.required('[data-context-loss]');
    this.contextRetryButton = this.required<HTMLButtonElement>('[data-context-retry]');
    this.newsOverlay = new NewsOverlayView(this.root, {
      onDismiss: (itemId) => this.callbacks.onNewsDismiss?.(itemId),
      onInteractionChange: (active) => this.callbacks.onNewsInteractionChange?.(active),
    });
    this.wardrobe = new WardrobeView(this.root, {
      selected: options.initialAnimal,
      onClose: () => this.setOwnedOverlay('wardrobe', false),
      onSelect: (animal) => {
        if (this.callbacks.onAnimalSelect?.(animal) === false) return;
        this.wardrobeButton.textContent = animal.slice(0, 3).toUpperCase();
        this.recordOnboardingAction('identity');
      },
    });

    this.enterButton.addEventListener('click', this.enter);
    this.musicMuteButton.addEventListener('click', this.musicMute);
    this.musicVolumeInput.addEventListener('input', this.musicVolume);
    this.sfxMuteButton.addEventListener('click', this.sfxMute);
    this.sfxVolumeInput.addEventListener('input', this.sfxVolume);
    this.helpButton.addEventListener('click', this.toggleHelp);
    this.closeHelpButton.addEventListener('click', this.closeHelp);
    this.wardrobeButton.addEventListener('click', this.toggleWardrobe);
    this.settingsWardrobeButton.addEventListener('click', this.openWardrobeFromSettings);
    this.emoteButton.addEventListener('click', this.toggleEmotes);
    this.emotePicker.addEventListener('click', this.pickEmote);
    this.onboardingCta.addEventListener('click', this.activateOnboardingCta);
    this.contextRetryButton.addEventListener('click', this.retryContext);
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
    this.stopOnboardingSubscription = this.onboarding.subscribe((snapshot) => this.renderOnboarding(snapshot));
  }

  public setEnterReady(ready: boolean): void {
    this.enterButton.disabled = !ready;
    this.enterButton.querySelector('span')!.textContent = ready
      ? this.entryModel.enterLabel
      : `Growing ${this.entryModel.symbol}...`;
  }

  public setActiveMarket(symbol: AssetSymbol): void {
    this.entryModel = entryShellForMarket(symbol);
    // Preserve the status dot that is the first child of the kicker.
    const dot = this.entryKicker.querySelector('span');
    this.entryKicker.replaceChildren(...(dot ? [dot] : []), this.entryModel.kicker);
    this.entryTitle.textContent = this.entryModel.title;
    this.entryDescription.textContent = this.entryModel.description;
    this.enterButton.querySelector('span')!.textContent = this.entryModel.enterLabel;
  }

  public setEntryStatus(feed: FeedMode, room: EntryRoomStatus): void {
    this.entryFeedStatus.textContent = entryFeedStatusLabel(feed);
    this.entryRoomStatus.textContent = entryRoomStatusLabel(room);
    this.entryFeedStatus.className = `is-${feed}`;
    this.entryRoomStatus.className = `is-${room}`;
  }

  public setEntered(): void {
    this.entered = true;
    this.root.classList.remove('is-awaiting-entry');
    this.onboardingHint.classList.remove('is-hidden');
    this.enterOverlay.classList.add('is-entered');
    window.setTimeout(() => this.enterOverlay.remove(), 900);
  }

  public recordOnboardingAction(action: OnboardingAction): void {
    const wasComplete = this.onboarding.snapshot.completed;
    const changed = this.onboarding.record(action);
    if (changed && !wasComplete && this.onboarding.snapshot.completed) {
      this.showToast('You found your rhythm. The whole world is open.');
    }
  }

  public setSelectedAnimal(animal: AnimalKind): void {
    this.wardrobe.setSelected(animal);
    this.wardrobeButton.textContent = animal.slice(0, 3).toUpperCase();
  }

  public setChartFocused(focused: boolean): void {
    this.root.classList.toggle('is-chart-focused', focused);
  }

  public setContextLost(lost: boolean): void {
    this.contextLossOverlay.classList.toggle('is-hidden', !lost);
    if (lost) this.setOwnedOverlay('context', true);
    else this.setOwnedOverlay('context', false);
  }

  /** Allows chat/share/player systems to participate in the one-overlay rule. */
  public setExternalOverlayOpen(owner: UiInteractionOwner, active: boolean): void {
    const transition = this.overlays.set(owner, active);
    if (active) {
      if (transition.displaced) this.closeOwnedOverlayElement(transition.displaced, true);
      this.closeOwnedOverlays(owner);
      if (transition.displaced === 'news') this.newsOverlay.setState(null);
    }
    this.syncOverlayState();
  }

  public setNearby(view: NearbyView | null): void {
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
    const reconnectingAge = view.mode === 'reconnecting'
      && view.price !== null
      && view.ageMs !== null
      && view.ageMs !== undefined
      && Number.isFinite(view.ageMs)
      ? `${Math.max(0, Math.round(view.ageMs / 1_000))}s old`
      : null;
    this.nearbyMode.textContent = view.mode === 'live'
      ? 'LIVE · HYPERLIQUID'
      : view.mode === 'connecting'
        ? 'CONNECTING'
        : view.mode === 'reconnecting'
          ? view.price === null
            ? 'CONNECTING · —'
            : reconnectingAge
              ? `RECONNECTING · ${reconnectingAge}`
              : 'RECONNECTING'
          : 'SIMULATED · QA';
    this.nearbyMode.className = `market-mode ${view.mode === 'reconnecting' && view.price === null ? 'connecting' : view.mode}`;
    this.nearbyPanel.style.setProperty('--nearby-distance', `${Math.min(1, view.distance / 80)}`);
  }

  public setCompass(angle: number, symbol: AssetSymbol | null): void {
    const visible = this.compassEnabled && symbol !== null;
    this.compass.classList.toggle('is-hidden', !visible);
    if (!symbol) return;
    this.compassArrow.style.transform = `rotate(${angle}rad)`;
    this.compassLabel.textContent = symbol;
  }

  public setCompassEnabled(enabled: boolean): void {
    this.compassEnabled = enabled;
    this.compassButton.querySelector('strong')!.textContent = enabled ? 'ON' : 'OFF';
    if (!enabled) this.compass.classList.add('is-hidden');
  }

  public setReducedMotion(enabled: boolean): void {
    this.motionButton.dataset.enabled = String(enabled);
    this.motionButton.querySelector('strong')!.textContent = enabled ? 'ON' : 'OFF';
  }

  public setMuted(muted: boolean): void {
    this.setMusicMuted(muted);
    this.setSfxMuted(muted);
  }

  public setVolume(value: number): void {
    this.setMusicVolume(value);
    this.setSfxVolume(value);
  }

  public setMusicMuted(muted: boolean): void {
    this.musicMuteButton.classList.toggle('is-active', muted);
    this.musicMuteButton.querySelector('span')!.textContent = muted ? '\u00d7' : '\u266a';
    this.musicMuteButton.setAttribute('aria-label', muted ? 'Unmute music' : 'Mute music');
  }

  public setMusicVolume(value: number): void {
    this.musicVolumeInput.value = String(value);
  }

  public setSfxMuted(muted: boolean): void {
    this.sfxMuteButton.classList.toggle('is-active', muted);
    this.sfxMuteButton.querySelector('span')!.textContent = muted ? '\u00d7' : '\u2726';
    this.sfxMuteButton.setAttribute('aria-label', muted ? 'Unmute sound effects' : 'Mute sound effects');
  }

  public setSfxVolume(value: number): void {
    this.sfxVolumeInput.value = String(value);
  }

  public showToast(message: string): void {
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    this.toast.textContent = message;
    this.toast.classList.add('is-visible');
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('is-visible'), 3200);
  }

  public setDebug(text: string | null): void {
    this.debug.classList.toggle('is-hidden', text === null);
    if (text !== null) this.debug.textContent = text;
  }

  public setNewsOverlay(state: NewsOverlayViewState | null): void {
    this.pendingNewsState = state;
    if (state && !state.dismissed && this.overlays.has('emote')) {
      this.overlays.set('emote', false);
      this.setOwnedOverlayElement('emote', false);
      this.callbacks.onUiInteractionChange?.('emote', false);
    }
    if (!state || state.dismissed) this.overlays.set('news', false);
    this.syncOverlayState();
  }

  /** Mounts an independently-owned HUD layer inside the existing safe UI root. */
  public mountLayer(className: string): HTMLDivElement {
    const layer = document.createElement('div');
    layer.className = `hud-extension ${className}`.trim();
    this.root.append(layer);
    this.extensionLayers.add(layer);
    return layer;
  }

  public unmountLayer(layer: HTMLElement): void {
    if (!this.extensionLayers.delete(layer)) return;
    layer.remove();
  }

  public dispose(): void {
    this.enterButton.removeEventListener('click', this.enter);
    this.musicMuteButton.removeEventListener('click', this.musicMute);
    this.musicVolumeInput.removeEventListener('input', this.musicVolume);
    this.sfxMuteButton.removeEventListener('click', this.sfxMute);
    this.sfxVolumeInput.removeEventListener('input', this.sfxVolume);
    this.helpButton.removeEventListener('click', this.toggleHelp);
    this.closeHelpButton.removeEventListener('click', this.closeHelp);
    this.wardrobeButton.removeEventListener('click', this.toggleWardrobe);
    this.settingsWardrobeButton.removeEventListener('click', this.openWardrobeFromSettings);
    this.emoteButton.removeEventListener('click', this.toggleEmotes);
    this.emotePicker.removeEventListener('click', this.pickEmote);
    this.onboardingCta.removeEventListener('click', this.activateOnboardingCta);
    this.contextRetryButton.removeEventListener('click', this.retryContext);
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
    this.stopOnboardingSubscription();
    if (this.pricePulseTimer !== undefined) window.clearTimeout(this.pricePulseTimer);
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    for (const layer of this.extensionLayers) layer.remove();
    this.extensionLayers.clear();
    this.overlays.clear();
    this.newsOverlay.dispose();
    this.wardrobe.dispose();
    this.root.remove();
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Tickerworld HUD is missing ${selector}`);
    return element;
  }

  private renderOnboarding(snapshot: OnboardingSnapshot): void {
    const copy = onboardingCopy(snapshot);
    this.onboardingTitle.textContent = copy.title;
    this.onboardingBody.textContent = copy.body;
    this.onboardingProgress.textContent = snapshot.completed
      ? 'READY'
      : `${Math.round(snapshot.progress * 5) + 1} / 5`;
    this.onboardingCta.textContent = copy.cta ?? '';
    this.onboardingCta.classList.toggle('is-hidden', copy.cta === null);
    this.onboardingHint.classList.toggle('is-complete', snapshot.completed);
    this.onboardingHint.classList.toggle('is-hidden', snapshot.completed || !this.entered);
  }

  private setOwnedOverlay(owner: 'settings' | 'wardrobe' | 'emote' | 'context', open: boolean): void {
    if (open) {
      const transition = this.overlays.set(owner, true);
      if (transition.opened !== owner) return;
      if (transition.displaced) this.closeOwnedOverlayElement(transition.displaced, true);
      this.closeOwnedOverlays(owner);
      if (owner !== 'emote') this.callbacks.onLargeOverlayOpen?.(owner);
    } else {
      this.overlays.set(owner, false);
    }
    this.setOwnedOverlayElement(owner, open);
    this.callbacks.onUiInteractionChange?.(owner, open);
    this.syncOverlayState();
  }

  private closeOwnedOverlays(except: OverlayOwner): void {
    for (const owner of ['settings', 'wardrobe', 'emote'] as const) {
      if (owner !== except && this.overlays.has(owner)) {
        this.overlays.set(owner, false);
        this.setOwnedOverlayElement(owner, false);
        this.callbacks.onUiInteractionChange?.(owner, false);
      }
    }
  }

  private closeOwnedOverlayElement(owner: OverlayOwner, notify: boolean): void {
    if (owner !== 'settings' && owner !== 'wardrobe' && owner !== 'emote' && owner !== 'context') return;
    this.setOwnedOverlayElement(owner, false);
    if (notify) this.callbacks.onUiInteractionChange?.(owner, false);
  }

  private setOwnedOverlayElement(owner: 'settings' | 'wardrobe' | 'emote' | 'context', open: boolean): void {
    if (owner === 'settings') {
      this.helpPanel.classList.toggle('is-hidden', !open);
      this.helpButton.classList.toggle('is-active', open);
    } else if (owner === 'wardrobe') {
      this.wardrobe.setOpen(open);
      this.wardrobeButton.classList.toggle('is-active', open);
    } else if (owner === 'emote') {
      this.emotePicker.classList.toggle('is-hidden', !open);
      this.emoteButton.classList.toggle('is-active', open);
    } else {
      this.contextLossOverlay.classList.toggle('is-hidden', !open);
    }
  }

  private syncOverlayState(): void {
    const hasNews = this.pendingNewsState !== null && !this.pendingNewsState.dismissed;
    const largeOwner = this.overlays.largeOwner;
    if (hasNews && (largeOwner === null || largeOwner === 'news')) {
      this.overlays.set('news', true);
      this.newsOverlay.setState(this.pendingNewsState);
    } else {
      this.newsOverlay.setState(null);
    }
    this.root.dataset.largeOverlay = this.overlays.largeOwner ?? '';
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
  private readonly retryContext = (): void => this.callbacks.onContextRetry?.();

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

  private readonly toggleHelp = (): void => this.setOwnedOverlay('settings', !this.overlays.has('settings'));
  private readonly closeHelp = (): void => this.setOwnedOverlay('settings', false);
  private readonly toggleWardrobe = (): void => this.setOwnedOverlay('wardrobe', !this.overlays.has('wardrobe'));
  private readonly openWardrobeFromSettings = (): void => this.setOwnedOverlay('wardrobe', true);
  private readonly toggleEmotes = (): void => this.setOwnedOverlay('emote', !this.overlays.has('emote'));

  private readonly pickEmote = (event: Event): void => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('[data-emote-kind]')
      : null;
    if (!target) return;
    const kind = target.dataset.emoteKind as UiEmoteKind;
    if (!EMOTES.some((emote) => emote.kind === kind)) return;
    if (this.callbacks.onEmoteRequest?.(kind) === false) return;
    this.recordOnboardingAction('emote');
    this.setOwnedOverlay('emote', false);
    this.showToast(`${EMOTES.find((emote) => emote.kind === kind)!.label}!`);
  };

  private readonly activateOnboardingCta = (): void => {
    const step = this.onboarding.snapshot.currentStep;
    if (step === 'identity') this.setOwnedOverlay('wardrobe', true);
    else if (step === 'emote') this.setOwnedOverlay('emote', true);
  };

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
    if (event.key !== 'Escape') return;
    if (this.overlays.has('emote')) this.setOwnedOverlay('emote', false);
    else if (this.overlays.has('wardrobe')) this.setOwnedOverlay('wardrobe', false);
    else if (this.overlays.has('settings')) this.setOwnedOverlay('settings', false);
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
