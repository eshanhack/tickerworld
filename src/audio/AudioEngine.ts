import { Quaternion, Vector3, type Camera } from 'three';
import type { SurfaceKind, TickDirection } from '../types';
import {
  AMBIENT_KEY_DELAY_RANGE_SECONDS,
  AMBIENT_PAD_DELAY_RANGE_SECONDS,
  AMBIENT_PAD_VOICINGS,
  D_MAJOR_PENTATONIC_HZ,
  delayInRange,
  EMPTY_COLORED_NOISE_STATE,
  nextColoredNoiseSample,
  pickAmbientResponseIndex,
  pickNonRepeatingIndex,
} from './ambientMath';
import {
  ASSET_AUDIO_PROFILES,
  classifyMarketMove,
  clampUnit,
  MARKET_MOVE_THRESHOLDS,
  marketGestureFrequencies,
  marketMovePeakGain,
  marketMoveSeverity,
} from './audioMath';
import type {
  AudioEngineOptions,
  AudioEnvironment,
  AudioEngineState,
  AudioListenerInput,
  AudioListenerPose,
  AudioPosition,
  AudioStateListener,
  FootstepSoundOptions,
  JumpSoundKind,
  MonumentAudioSource,
  TickSoundOptions,
} from './types';

const VOLUME_KEY = 'tickerworld:audio:volume';
const MUTED_KEY = 'tickerworld:audio:muted';
const MUSIC_VOLUME_KEY = 'tickerworld:audio:music-volume';
const MUSIC_MUTED_KEY = 'tickerworld:audio:music-muted';
const SFX_VOLUME_KEY = 'tickerworld:audio:sfx-volume';
const SFX_MUTED_KEY = 'tickerworld:audio:sfx-muted';
const SFX_FULL_DEFAULT_MIGRATION_KEY = 'tickerworld:audio:sfx-full-default-v1';
const MAX_MONUMENT_SOURCES = 24;
const MAX_SCHEDULED_SOURCES = 48;
const DEFAULT_VOLUME = 0.72;
const DEFAULT_SFX_VOLUME = 1;
const MARKET_TICK_COOLDOWN_SECONDS = 0.18;
const MARKET_ACCENT_COOLDOWN_SECONDS = 1.8;
const MARKET_ACCENT_GLOBAL_COOLDOWN_SECONDS = 0.22;
const MARKET_ACCENT_UPGRADE_COOLDOWN_SECONDS = 0.38;
const MARKET_ACCENT_REARM_COOLDOWN_SECONDS = 0.65;
const MARKET_ACCENT_DIRECTION_CHANGE_COOLDOWN_SECONDS = 0.55;
const MARKET_ACCENT_REARM_RATIO = MARKET_MOVE_THRESHOLDS.medium * 0.7;

interface MonumentGraph {
  readonly descriptor: MonumentAudioSource;
  readonly input: GainNode;
  readonly panner: PannerNode;
}

interface AmbientPadVoice {
  readonly index: number;
  readonly gain: GainNode;
  readonly sources: readonly OscillatorNode[];
  readonly nodes: readonly AudioNode[];
}

interface LegacyAudioListener {
  setPosition?(x: number, y: number, z: number): void;
  setOrientation?(forwardX: number, forwardY: number, forwardZ: number, upX: number, upY: number, upZ: number): void;
}

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

function getDefaultContextFactory(): (() => AudioContext) | undefined {
  const audioGlobal = globalThis as typeof globalThis & {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const Constructor = audioGlobal.AudioContext ?? audioGlobal.webkitAudioContext;
  return Constructor ? () => new Constructor({ latencyHint: 'interactive' }) : undefined;
}

function getDefaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readStoredVolume(storage: Storage | null): number {
  if (!storage) return DEFAULT_VOLUME;
  try {
    const value = Number.parseFloat(storage.getItem(VOLUME_KEY) ?? '');
    return Number.isFinite(value) ? clampUnit(value) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function readStoredMute(storage: Storage | null): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(MUTED_KEY) === 'true';
  } catch {
    return false;
  }
}

function readStoredChannelVolume(storage: Storage | null, key: string, fallback: number): number {
  if (!storage) return fallback;
  try {
    const stored = storage.getItem(key);
    if (stored === null) return fallback;
    const value = Number.parseFloat(stored);
    return Number.isFinite(value) ? clampUnit(value) : fallback;
  } catch {
    return fallback;
  }
}

function readStoredChannelMute(storage: Storage | null, key: string, fallback: boolean): boolean {
  if (!storage) return fallback;
  try {
    const stored = storage.getItem(key);
    return stored === null ? fallback : stored === 'true';
  } catch {
    return fallback;
  }
}

function hasStoredPreference(storage: Storage | null, key: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function shouldUpgradeMaterialisedSfxDefault(storage: Storage | null): boolean {
  if (!storage) return false;
  try {
    if (storage.getItem(SFX_FULL_DEFAULT_MIGRATION_KEY) === 'true') return false;
    const legacyRaw = storage.getItem(VOLUME_KEY);
    const legacy = Number.parseFloat(legacyRaw ?? '');
    const music = Number.parseFloat(storage.getItem(MUSIC_VOLUME_KEY) ?? '');
    const sfx = Number.parseFloat(storage.getItem(SFX_VOLUME_KEY) ?? '');
    const isOldDefault = (value: number): boolean => (
      Number.isFinite(value) && Math.abs(value - DEFAULT_VOLUME) < 0.000001
    );
    return (legacyRaw === null || isOldDefault(legacy))
      && isOldDefault(music)
      && isOldDefault(sfx);
  } catch {
    return false;
  }
}

function safeDisconnect(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // Nodes may already be detached during context shutdown.
  }
}

function safeStop(node: AudioScheduledSourceNode): void {
  try {
    node.stop();
  } catch {
    // A source can only be stopped once.
  }
}

function isThreeCamera(value: AudioListenerInput): value is Camera {
  return 'isCamera' in value && value.isCamera === true;
}

export class AudioEngine {
  private readonly contextFactory?: () => AudioContext;
  private readonly storage: Storage | null;
  private readonly random: () => number;
  private readonly listeners = new Set<AudioStateListener>();
  private readonly desiredSources = new Map<string, MonumentAudioSource>();
  private readonly monumentGraphs = new Map<string, MonumentGraph>();
  private readonly scheduledSources = new Set<AudioScheduledSourceNode>();
  private readonly finiteNodes = new Set<AudioNode>();
  private readonly ambientSources = new Set<AudioScheduledSourceNode>();
  private readonly ambientNodes = new Set<AudioNode>();
  private readonly tempPosition = new Vector3();
  private readonly tempForward = new Vector3();
  private readonly tempUp = new Vector3();
  private readonly tempQuaternion = new Quaternion();

  private context: AudioContext | null = null;
  private masterBus: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private outputCompressor: DynamicsCompressorNode | null = null;
  private transientNoiseBuffer: AudioBuffer | null = null;
  private atmosphereNoiseBuffer: AudioBuffer | null = null;
  private padToneFilter: BiquadFilterNode | null = null;
  private atmosphereLowpass: BiquadFilterNode | null = null;
  private atmosphereGain: GainNode | null = null;
  private ambientEchoInput: DelayNode | null = null;
  private currentPadVoice: AmbientPadVoice | null = null;
  private ambientStarted = false;
  private keyTimer: ReturnType<typeof setTimeout> | null = null;
  private padTimer: ReturnType<typeof setTimeout> | null = null;
  private lastKeyIndex = -1;
  private lastPadIndex = -1;
  private nightFactor = 0;
  private unlockAttempt: Promise<boolean> | null = null;
  private visible = true;
  private disposed = false;
  private volumeValue: number;
  private mutedValue: boolean;
  private musicVolumeValue: number;
  private musicMutedValue: boolean;
  private sfxVolumeValue: number;
  private sfxMutedValue: boolean;
  private readonly lastMarketTickAt = new Map<string, number>();
  private readonly marketAccentState = new Map<string, {
    tier: 'large' | 'exceptional';
    direction: 'up' | 'down';
    magnitude: number;
    at: number;
    armed: boolean;
  }>();
  private lastGlobalMarketAccentAt = Number.NEGATIVE_INFINITY;
  private statusValue: AudioEngineState['status'];
  private reasonValue: string | undefined;
  private cachedListenerPose: AudioListenerPose = {
    position: { x: 0, y: 2, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  };

  public constructor(options: AudioEngineOptions = {}) {
    this.contextFactory = options.contextFactory ?? getDefaultContextFactory();
    this.storage = options.storage === undefined ? getDefaultStorage() : options.storage;
    this.random = options.random ?? Math.random;
    this.volumeValue = readStoredVolume(this.storage);
    this.mutedValue = readStoredMute(this.storage);
    this.musicVolumeValue = readStoredChannelVolume(this.storage, MUSIC_VOLUME_KEY, this.volumeValue);
    this.musicMutedValue = readStoredChannelMute(this.storage, MUSIC_MUTED_KEY, this.mutedValue);
    const sfxFallback = hasStoredPreference(this.storage, VOLUME_KEY)
      ? this.volumeValue
      : DEFAULT_SFX_VOLUME;
    this.sfxVolumeValue = readStoredChannelVolume(this.storage, SFX_VOLUME_KEY, sfxFallback);
    if (shouldUpgradeMaterialisedSfxDefault(this.storage)) {
      this.sfxVolumeValue = DEFAULT_SFX_VOLUME;
    }
    this.sfxMutedValue = readStoredChannelMute(this.storage, SFX_MUTED_KEY, this.mutedValue);
    // Materialise split preferences on first run so subsequent channel edits
    // never fall back to an unrelated legacy master value.
    this.persist(MUSIC_VOLUME_KEY, String(this.musicVolumeValue));
    this.persist(MUSIC_MUTED_KEY, String(this.musicMutedValue));
    this.persist(SFX_VOLUME_KEY, String(this.sfxVolumeValue));
    this.persist(SFX_MUTED_KEY, String(this.sfxMutedValue));
    this.persist(SFX_FULL_DEFAULT_MIGRATION_KEY, 'true');
    this.mutedValue = this.musicMutedValue && this.sfxMutedValue;
    this.statusValue = this.contextFactory ? 'locked' : 'unavailable';
    this.reasonValue = this.contextFactory ? undefined : 'Web Audio is not available in this browser.';
  }

  public get state(): AudioEngineState {
    return {
      status: this.statusValue,
      available: this.statusValue !== 'unavailable' && this.statusValue !== 'disposed',
      unlocked: this.statusValue === 'ready' || this.statusValue === 'suspended',
      volume: this.volumeValue,
      muted: this.mutedValue,
      musicVolume: this.musicVolumeValue,
      musicMuted: this.musicMutedValue,
      sfxVolume: this.sfxVolumeValue,
      sfxMuted: this.sfxMutedValue,
      ...(this.reasonValue ? { reason: this.reasonValue } : {}),
    };
  }

  public get volume(): number {
    return this.volumeValue;
  }

  public get muted(): boolean {
    return this.mutedValue;
  }

  public get musicVolume(): number {
    return this.musicVolumeValue;
  }

  public get musicMuted(): boolean {
    return this.musicMutedValue;
  }

  public get sfxVolume(): number {
    return this.sfxVolumeValue;
  }

  public get sfxMuted(): boolean {
    return this.sfxMutedValue;
  }

  public subscribe(listener: AudioStateListener): () => void {
    if (this.disposed) {
      listener(this.state);
      return () => undefined;
    }
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /**
   * Call directly inside the pointer/keyboard Enter gesture. Context construction
   * and resume() invocation both happen before this method yields its Promise.
   */
  public unlock(): Promise<boolean> {
    if (this.disposed || !this.contextFactory) return Promise.resolve(false);
    if (this.context?.state === 'running') {
      this.startAmbient();
      this.setStatus(this.visible ? 'ready' : 'suspended');
      return Promise.resolve(true);
    }
    if (this.unlockAttempt) return this.unlockAttempt;

    if (!this.context) {
      try {
        this.context = this.contextFactory();
        this.buildGraph(this.context);
        this.syncMonumentGraphs();
        this.applyListenerPose(this.cachedListenerPose);
      } catch (error) {
        this.setStatus('unavailable', this.errorMessage(error, 'Web Audio could not be started.'));
        return Promise.resolve(false);
      }
    }

    const context = this.context;
    this.setStatus('unlocking');
    let resumeResult: Promise<void>;
    try {
      // Deliberately invoked synchronously while the user activation is live.
      resumeResult = context.resume();
      this.startAmbient();
    } catch (error) {
      this.stopAmbient();
      this.setStatus('resume-failed', this.errorMessage(error, 'Audio permission was not granted.'));
      return Promise.resolve(false);
    }

    this.unlockAttempt = resumeResult
      .then(() => {
        if (this.disposed) return false;
        if (context.state !== 'running') {
          this.stopAmbient();
          this.setStatus('resume-failed', 'The browser kept audio suspended. Tap Enter again to retry.');
          return false;
        }
        this.setStatus(this.visible ? 'ready' : 'suspended');
        if (!this.visible) void this.suspendContext();
        return true;
      })
      .catch((error: unknown) => {
        if (!this.disposed) {
          this.stopAmbient();
          this.setStatus('resume-failed', this.errorMessage(error, 'Audio permission was not granted.'));
        }
        return false;
      })
      .finally(() => {
        this.unlockAttempt = null;
      });
    return this.unlockAttempt;
  }

  public setMonumentSources(sources: readonly MonumentAudioSource[]): void {
    if (this.disposed) return;
    this.desiredSources.clear();
    for (const source of sources.slice(0, MAX_MONUMENT_SOURCES)) {
      if (!source.id || this.desiredSources.has(source.id)) continue;
      this.desiredSources.set(source.id, {
        id: source.id,
        symbol: source.symbol,
        position: { x: source.position.x, y: source.position.y, z: source.position.z },
        gain: clampUnit(source.gain ?? 1),
      });
    }
    this.syncMonumentGraphs();
  }

  public updateListener(camera: AudioListenerInput): void {
    if (this.disposed) return;
    if (isThreeCamera(camera)) {
      camera.updateMatrixWorld();
      camera.getWorldPosition(this.tempPosition);
      camera.getWorldDirection(this.tempForward).normalize();
      camera.getWorldQuaternion(this.tempQuaternion);
      this.tempUp.copy(camera.up).applyQuaternion(this.tempQuaternion).normalize();
      this.cachedListenerPose = {
        position: this.copyPosition(this.tempPosition),
        forward: this.copyPosition(this.tempForward),
        up: this.copyPosition(this.tempUp),
      };
    } else {
      this.cachedListenerPose = {
        position: this.copyPosition(camera.position),
        forward: this.normalisedPosition(camera.forward, { x: 0, y: 0, z: -1 }),
        up: this.normalisedPosition(camera.up ?? { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }),
      };
    }
    this.applyListenerPose(this.cachedListenerPose);
  }

  public playTick(sourceId: string, options: TickSoundOptions): void;
  public playTick(sourceId: string, direction: TickDirection, moveRatio?: number): void;
  public playTick(
    sourceId: string,
    optionsOrDirection: TickSoundOptions | TickDirection,
    legacyMoveRatio = 0,
  ): void {
    const direction = typeof optionsOrDirection === 'string' ? optionsOrDirection : optionsOrDirection.direction;
    const moveRatio = typeof optionsOrDirection === 'string'
      ? legacyMoveRatio
      : (optionsOrDirection.moveRatio ?? 0);
    if (direction === 'flat' || !this.canPlaySfx()) return;
    const graph = this.monumentGraphs.get(sourceId);
    if (!graph || !this.context) return;

    const profile = ASSET_AUDIO_PROFILES[graph.descriptor.symbol];
    const magnitude = Math.abs(Number.isFinite(moveRatio) ? moveRatio : 0);
    const moveClass = classifyMarketMove(moveRatio);
    const accentTier = moveClass === 'large' || moveClass === 'exceptional' ? moveClass : null;
    // Game dispatches the same asset event to its grand shrine and any loaded
    // echoes. Reserve the one special gesture for the source the player can
    // actually hear best, independent of iteration order, and save its voices.
    if (accentTier && this.nearestMonumentSourceId(graph.descriptor.symbol) !== sourceId) return;

    const now = this.context.currentTime;
    const lastTick = this.lastMarketTickAt.get(sourceId) ?? Number.NEGATIVE_INFINITY;
    if (now - lastTick < MARKET_TICK_COOLDOWN_SECONDS) return;
    this.lastMarketTickAt.set(sourceId, now);

    if (Math.abs(moveRatio) < MARKET_ACCENT_REARM_RATIO) {
      const accent = this.marketAccentState.get(graph.descriptor.symbol);
      if (accent && !accent.armed) {
        this.marketAccentState.set(graph.descriptor.symbol, { ...accent, armed: true });
      }
    }

    const exceptional = accentTier === 'exceptional';
    const accentVoiceCount = direction === 'up'
      ? (exceptional ? 6 : 5)
      : (exceptional ? 5 : 4);
    const hasAccentCapacity = this.scheduledSources.size <= MAX_SCHEDULED_SOURCES - accentVoiceCount;
    if (
      accentTier
      && hasAccentCapacity
      && this.shouldPlayMarketAccent(graph.descriptor.symbol, direction, accentTier, magnitude, now)
    ) {
      if (direction === 'up') {
        this.playMarketCelebration(graph.input, now, profile.frequency, moveRatio, exceptional);
      } else {
        this.playMarketWarning(graph.input, now, profile.frequency, moveRatio, exceptional);
      }
      return;
    }

    const [first, second] = marketGestureFrequencies(profile.frequency, direction);
    const peak = marketMovePeakGain(moveRatio);
    const spacing = moveClass === 'small' ? 0.12 : 0.095;
    this.playGentleNote(graph.input, now, first, 0.3, peak * 0.62, profile.accent);
    this.playGentleNote(graph.input, now + spacing, second, 0.48, peak * 0.86, profile.accent);
    if (moveClass === 'medium') {
      const answer = direction === 'up' ? second * 1.12246 : second * 0.94387;
      this.playGentleNote(
        graph.input,
        now + spacing * 2,
        Math.min(740, Math.max(196, answer)),
        0.58,
        peak,
        profile.accent * 0.5,
      );
    }
  }

  public playCandleClose(sourceId: string, intensity = 0.5): void {
    if (!this.canPlaySfx() || !this.context) return;
    const graph = this.monumentGraphs.get(sourceId);
    if (!graph) return;
    const now = this.context.currentTime;
    const amount = clampUnit(intensity);
    this.playDampedResonator(graph.input, now, 196, 0.22, 0.025 + amount * 0.02);
    this.playDampedResonator(graph.input, now + 0.025, 293.66, 0.31, 0.012 + amount * 0.008);
    this.playNoiseBurst(graph.input, now, 0.07, 'lowpass', 520, 0.006 + amount * 0.004);
  }

  public playFootstep(options: FootstepSoundOptions): void;
  public playFootstep(surface: SurfaceKind, sprinting?: boolean): void;
  public playFootstep(
    optionsOrSurface: FootstepSoundOptions | SurfaceKind,
    legacySprinting = false,
  ): void {
    if (!this.canPlaySfx() || !this.context || !this.sfxBus) return;
    const surface = typeof optionsOrSurface === 'string' ? optionsOrSurface : optionsOrSurface.surface;
    const sprinting = typeof optionsOrSurface === 'string'
      ? legacySprinting
      : (optionsOrSurface.sprinting ?? false);
    const side = typeof optionsOrSurface === 'string' ? undefined : optionsOrSurface.side;
    const now = this.context.currentTime;
    const settings = this.footstepSettings(surface);
    const sideVariation = side === 'left' ? -0.035 : side === 'right' ? 0.035 : 0;
    this.playNoiseBurst(
      this.sfxBus,
      now,
      settings.duration,
      settings.filter,
      settings.frequency * (1 + sideVariation),
      settings.gain * (sprinting ? 1.18 : 1),
    );
    this.playFootThump(this.sfxBus, now, settings.thumpFrequency, sprinting ? 0.03 : 0.022);
    if (sprinting) {
      this.playNoiseBurst(this.sfxBus, now + 0.035, 0.13, 'bandpass', settings.frequency * 0.72, 0.011);
    }
  }

  /** A bright lift for the first jump and a higher magical flourish for the air jump. */
  public playJump(kind: JumpSoundKind): void {
    if (!this.canPlaySfx() || !this.context || !this.sfxBus) return;
    const now = this.context.currentTime;
    if (kind === 'double-jump') {
      this.playMagicalSweep(this.sfxBus, now, 523.25, 880, 0.52, 0.036);
      this.playGentleNote(this.sfxBus, now + 0.12, 987.77, 0.66, 0.018, 1.5);
      this.playNoiseBurst(this.sfxBus, now, 0.11, 'bandpass', 920, 0.0065);
      return;
    }
    this.playMagicalSweep(this.sfxBus, now, 369.99, 587.33, 0.42, 0.029);
    this.playNoiseBurst(this.sfxBus, now, 0.09, 'bandpass', 720, 0.0055);
  }

  /** A surface-aware soft puff with a small, friendly settling chime. */
  public playLanding(surface: SurfaceKind, intensity = 0.5): void {
    if (!this.canPlaySfx() || !this.context || !this.sfxBus) return;
    const amount = clampUnit(intensity);
    const now = this.context.currentTime;
    const settings = this.footstepSettings(surface);
    this.playNoiseBurst(
      this.sfxBus,
      now,
      settings.duration * (0.8 + amount * 0.55),
      settings.filter,
      settings.frequency * 0.9,
      settings.gain * (0.36 + amount * 0.5),
    );
    this.playFootThump(this.sfxBus, now, settings.thumpFrequency * 1.12, 0.009 + amount * 0.018);
    this.playGentleNote(this.sfxBus, now + 0.035, 587.33, 0.3, 0.005 + amount * 0.006, -1.5);
  }

  public setEnvironment(environment: AudioEnvironment): void {
    if (this.disposed) return;
    const next = clampUnit(environment.nightFactor);
    if (Math.abs(next - this.nightFactor) < 0.005) return;
    this.nightFactor = next;
    this.applyEnvironmentMix();
  }

  public setVolume(volume: number): void {
    if (this.disposed) return;
    const next = clampUnit(volume);
    if (
      next === this.volumeValue
      && next === this.musicVolumeValue
      && next === this.sfxVolumeValue
    ) return;
    this.volumeValue = next;
    this.musicVolumeValue = next;
    this.sfxVolumeValue = next;
    this.persist(VOLUME_KEY, String(next));
    this.persist(MUSIC_VOLUME_KEY, String(next));
    this.persist(SFX_VOLUME_KEY, String(next));
    this.applyChannelGains();
    this.emit();
  }

  public toggleMute(force?: boolean): boolean {
    if (this.disposed) return this.mutedValue;
    this.mutedValue = force ?? !this.mutedValue;
    this.musicMutedValue = this.mutedValue;
    this.sfxMutedValue = this.mutedValue;
    this.persist(MUTED_KEY, String(this.mutedValue));
    this.persist(MUSIC_MUTED_KEY, String(this.musicMutedValue));
    this.persist(SFX_MUTED_KEY, String(this.sfxMutedValue));
    this.applyChannelGains();
    this.emit();
    return this.mutedValue;
  }

  public setMusicVolume(volume: number): void {
    if (this.disposed) return;
    const next = clampUnit(volume);
    if (next === this.musicVolumeValue) return;
    this.musicVolumeValue = next;
    this.volumeValue = (this.musicVolumeValue + this.sfxVolumeValue) * 0.5;
    this.persist(MUSIC_VOLUME_KEY, String(next));
    this.persist(VOLUME_KEY, String(this.volumeValue));
    this.applyChannelGains();
    this.emit();
  }

  public setSfxVolume(volume: number): void {
    if (this.disposed) return;
    const next = clampUnit(volume);
    if (next === this.sfxVolumeValue) return;
    this.sfxVolumeValue = next;
    this.volumeValue = (this.musicVolumeValue + this.sfxVolumeValue) * 0.5;
    this.persist(SFX_VOLUME_KEY, String(next));
    this.persist(VOLUME_KEY, String(this.volumeValue));
    this.applyChannelGains();
    this.emit();
  }

  public toggleMusicMuted(force?: boolean): boolean {
    if (this.disposed) return this.musicMutedValue;
    this.musicMutedValue = force ?? !this.musicMutedValue;
    this.mutedValue = this.musicMutedValue && this.sfxMutedValue;
    this.persist(MUSIC_MUTED_KEY, String(this.musicMutedValue));
    this.persist(MUTED_KEY, String(this.mutedValue));
    this.applyChannelGains();
    this.emit();
    return this.musicMutedValue;
  }

  public toggleSfxMuted(force?: boolean): boolean {
    if (this.disposed) return this.sfxMutedValue;
    this.sfxMutedValue = force ?? !this.sfxMutedValue;
    this.mutedValue = this.musicMutedValue && this.sfxMutedValue;
    this.persist(SFX_MUTED_KEY, String(this.sfxMutedValue));
    this.persist(MUTED_KEY, String(this.mutedValue));
    this.applyChannelGains();
    this.emit();
    return this.sfxMutedValue;
  }

  public setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.clearAmbientTimers();
      if (this.context) {
        this.setStatus('suspended');
        void this.suspendContext();
      }
      return;
    }
    if (!this.context) return;
    let resume: Promise<void>;
    try {
      resume = this.context.resume();
    } catch (error) {
      this.setStatus('resume-failed', this.errorMessage(error, 'Audio could not resume. Tap to retry.'));
      return;
    }
    void resume
      .then(() => {
        if (this.disposed || !this.visible) return;
        this.startAmbient();
        this.scheduleNextKey();
        this.scheduleNextPad();
        this.setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!this.disposed) {
          this.setStatus('resume-failed', this.errorMessage(error, 'Audio could not resume. Tap to retry.'));
        }
      });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAmbientTimers();
    this.stopAmbient();
    for (const source of this.scheduledSources) safeStop(source);
    for (const node of this.finiteNodes) safeDisconnect(node);
    this.scheduledSources.clear();
    this.finiteNodes.clear();
    for (const graph of this.monumentGraphs.values()) this.disposeMonumentGraph(graph);
    this.monumentGraphs.clear();
    this.desiredSources.clear();
    this.lastMarketTickAt.clear();
    this.marketAccentState.clear();
    for (const node of [this.ambientBus, this.sfxBus, this.masterBus, this.outputCompressor]) {
      if (node) safeDisconnect(node);
    }
    const context = this.context;
    this.context = null;
    this.masterBus = null;
    this.ambientBus = null;
    this.sfxBus = null;
    this.outputCompressor = null;
    this.transientNoiseBuffer = null;
    this.atmosphereNoiseBuffer = null;
    this.padToneFilter = null;
    this.atmosphereLowpass = null;
    this.atmosphereGain = null;
    this.ambientEchoInput = null;
    this.currentPadVoice = null;
    this.statusValue = 'disposed';
    this.reasonValue = undefined;
    this.emit();
    this.listeners.clear();
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }

  private buildGraph(context: AudioContext): void {
    const master = context.createGain();
    const ambient = context.createGain();
    const sfx = context.createGain();
    const compressor = context.createDynamicsCompressor();
    ambient.gain.value = 0.4;
    sfx.gain.value = 1;
    compressor.threshold.value = -15;
    compressor.knee.value = 18;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.22;
    ambient.connect(master);
    sfx.connect(master);
    master.connect(compressor);
    compressor.connect(context.destination);
    this.masterBus = master;
    this.ambientBus = ambient;
    this.sfxBus = sfx;
    this.outputCompressor = compressor;
    this.applyMasterGain();
    this.applyEnvironmentMix();
    this.applyChannelGains();
  }

  private applyMasterGain(): void {
    if (!this.masterBus || !this.context) return;
    const now = this.context.currentTime;
    this.masterBus.gain.cancelScheduledValues(now);
    // The legacy master API maps onto the two visible channels. Keeping this
    // bus neutral prevents a hidden pre-migration mute from silencing them.
    this.masterBus.gain.setTargetAtTime(1, now, 0.025);
  }

  private applyEnvironmentMix(): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    this.padToneFilter?.frequency.setTargetAtTime(1900 - this.nightFactor * 120, now, 1.4);
    this.atmosphereLowpass?.frequency.setTargetAtTime(780 - this.nightFactor * 90, now, 1.8);
    this.atmosphereGain?.gain.setTargetAtTime(0.0018 + this.nightFactor * 0.00025, now, 1.8);
    this.applyChannelGains();
  }

  private applyChannelGains(): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    const musicLevel = this.musicMutedValue ? 0 : Math.pow(this.musicVolumeValue, 1.45);
    const sfxLevel = this.sfxMutedValue ? 0 : Math.pow(this.sfxVolumeValue, 1.35);
    this.ambientBus?.gain.setTargetAtTime((0.4 + this.nightFactor * 0.012) * musicLevel, now, 0.04);
    this.sfxBus?.gain.setTargetAtTime(sfxLevel, now, 0.025);
  }

  private nearestMonumentSourceId(symbol: MonumentAudioSource['symbol']): string | null {
    const listener = this.cachedListenerPose.position;
    let nearestId: string | null = null;
    let nearestDistanceSquared = Number.POSITIVE_INFINITY;
    for (const [id, graph] of this.monumentGraphs) {
      if (graph.descriptor.symbol !== symbol || (graph.descriptor.gain ?? 1) <= 0.001) continue;
      const dx = graph.descriptor.position.x - listener.x;
      const dy = graph.descriptor.position.y - listener.y;
      const dz = graph.descriptor.position.z - listener.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (
        distanceSquared < nearestDistanceSquared
        || (distanceSquared === nearestDistanceSquared && (nearestId === null || id < nearestId))
      ) {
        nearestId = id;
        nearestDistanceSquared = distanceSquared;
      }
    }
    return nearestId;
  }

  private syncMonumentGraphs(): void {
    if (!this.context || !this.sfxBus) return;
    for (const [id, graph] of this.monumentGraphs) {
      if (!this.desiredSources.has(id)) {
        this.disposeMonumentGraph(graph);
        this.monumentGraphs.delete(id);
        this.lastMarketTickAt.delete(id);
      }
    }
    for (const descriptor of this.desiredSources.values()) {
      const existing = this.monumentGraphs.get(descriptor.id);
      if (existing && existing.descriptor.symbol === descriptor.symbol) {
        const updated: MonumentGraph = { ...existing, descriptor };
        this.monumentGraphs.set(descriptor.id, updated);
        this.positionMonumentGraph(updated);
        continue;
      }
      if (existing) this.disposeMonumentGraph(existing);
      const input = this.context.createGain();
      const panner = this.context.createPanner();
      input.gain.value = descriptor.gain ?? 1;
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'exponential';
      panner.refDistance = 13;
      panner.maxDistance = 96;
      panner.rolloffFactor = 1.12;
      input.connect(panner);
      panner.connect(this.sfxBus);
      const graph = { descriptor, input, panner };
      this.monumentGraphs.set(descriptor.id, graph);
      this.positionMonumentGraph(graph);
    }
  }

  private positionMonumentGraph(graph: MonumentGraph): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    const { x, y, z } = graph.descriptor.position;
    graph.input.gain.setTargetAtTime(graph.descriptor.gain ?? 1, now, 0.04);
    graph.panner.positionX.setTargetAtTime(x, now, 0.035);
    graph.panner.positionY.setTargetAtTime(y, now, 0.035);
    graph.panner.positionZ.setTargetAtTime(z, now, 0.035);
  }

  private disposeMonumentGraph(graph: MonumentGraph): void {
    safeDisconnect(graph.input);
    safeDisconnect(graph.panner);
  }

  private applyListenerPose(pose: AudioListenerPose): void {
    if (!this.context) return;
    const listener = this.context.listener;
    const now = this.context.currentTime;
    if ('positionX' in listener) {
      listener.positionX.setValueAtTime(pose.position.x, now);
      listener.positionY.setValueAtTime(pose.position.y, now);
      listener.positionZ.setValueAtTime(pose.position.z, now);
      listener.forwardX.setValueAtTime(pose.forward.x, now);
      listener.forwardY.setValueAtTime(pose.forward.y, now);
      listener.forwardZ.setValueAtTime(pose.forward.z, now);
      listener.upX.setValueAtTime(pose.up?.x ?? 0, now);
      listener.upY.setValueAtTime(pose.up?.y ?? 1, now);
      listener.upZ.setValueAtTime(pose.up?.z ?? 0, now);
      return;
    }
    const legacy = listener as unknown as LegacyAudioListener;
    legacy.setPosition?.(pose.position.x, pose.position.y, pose.position.z);
    legacy.setOrientation?.(
      pose.forward.x,
      pose.forward.y,
      pose.forward.z,
      pose.up?.x ?? 0,
      pose.up?.y ?? 1,
      pose.up?.z ?? 0,
    );
  }

  private startAmbient(): void {
    if (this.ambientStarted || !this.context || !this.ambientBus || this.disposed) return;
    const context = this.context;
    const now = context.currentTime;
    this.ambientStarted = true;

    const padFilter = context.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 1900 - this.nightFactor * 120;
    padFilter.Q.value = 0.22;
    padFilter.connect(this.ambientBus);
    this.padToneFilter = padFilter;
    this.ambientNodes.add(padFilter);

    const filterLfo = context.createOscillator();
    const filterDepth = context.createGain();
    filterLfo.type = 'sine';
    filterLfo.frequency.value = 0.013;
    filterDepth.gain.value = 65;
    filterLfo.connect(filterDepth);
    filterDepth.connect(padFilter.frequency);
    filterLfo.start(now);
    this.ambientSources.add(filterLfo);
    this.ambientNodes.add(filterLfo);
    this.ambientNodes.add(filterDepth);

    const echo = context.createDelay(0.5);
    const echoFeedback = context.createGain();
    const echoWet = context.createGain();
    echo.delayTime.value = 0.245;
    echoFeedback.gain.value = 0.14;
    echoWet.gain.value = 0.11;
    echo.connect(echoFeedback);
    echoFeedback.connect(echo);
    echo.connect(echoWet);
    echoWet.connect(this.ambientBus);
    this.ambientEchoInput = echo;
    for (const node of [echo, echoFeedback, echoWet]) this.ambientNodes.add(node);

    const atmosphere = context.createBufferSource();
    const atmosphereHighpass = context.createBiquadFilter();
    const atmosphereLowpass = context.createBiquadFilter();
    const atmosphereGain = context.createGain();
    const atmosphereLfo = context.createOscillator();
    const atmosphereLfoDepth = context.createGain();
    const atmosphereFilterLfo = context.createOscillator();
    const atmosphereFilterDepth = context.createGain();
    atmosphere.buffer = this.getAtmosphereNoiseBuffer();
    atmosphere.loop = true;
    atmosphereHighpass.type = 'highpass';
    atmosphereHighpass.frequency.value = 160;
    atmosphereHighpass.Q.value = 0.3;
    atmosphereLowpass.type = 'lowpass';
    atmosphereLowpass.frequency.value = 780 - this.nightFactor * 90;
    atmosphereLowpass.Q.value = 0.25;
    atmosphereGain.gain.setValueAtTime(0.0001, now);
    atmosphereGain.gain.exponentialRampToValueAtTime(0.0018 + this.nightFactor * 0.00025, now + 3.2);
    atmosphereLfo.type = 'sine';
    atmosphereLfo.frequency.value = 0.021;
    atmosphereLfoDepth.gain.value = 0.00035;
    atmosphereFilterLfo.type = 'sine';
    atmosphereFilterLfo.frequency.value = 0.009;
    atmosphereFilterDepth.gain.value = 42;
    atmosphere.connect(atmosphereHighpass);
    atmosphereHighpass.connect(atmosphereLowpass);
    atmosphereLowpass.connect(atmosphereGain);
    atmosphereGain.connect(this.ambientBus);
    atmosphereLfo.connect(atmosphereLfoDepth);
    atmosphereLfoDepth.connect(atmosphereGain.gain);
    atmosphereFilterLfo.connect(atmosphereFilterDepth);
    atmosphereFilterDepth.connect(atmosphereLowpass.frequency);
    atmosphere.start(now, this.random() * 6);
    atmosphereLfo.start(now);
    atmosphereFilterLfo.start(now);
    this.ambientSources.add(atmosphere);
    this.ambientSources.add(atmosphereLfo);
    this.ambientSources.add(atmosphereFilterLfo);
    for (const node of [
      atmosphere,
      atmosphereHighpass,
      atmosphereLowpass,
      atmosphereGain,
      atmosphereLfo,
      atmosphereLfoDepth,
      atmosphereFilterLfo,
      atmosphereFilterDepth,
    ]) this.ambientNodes.add(node);
    this.atmosphereLowpass = atmosphereLowpass;
    this.atmosphereGain = atmosphereGain;

    this.transitionPad(true);
    this.scheduleNextKey();
    this.scheduleNextPad();
  }

  private stopAmbient(): void {
    this.clearAmbientTimers();
    for (const source of this.ambientSources) safeStop(source);
    for (const node of this.ambientNodes) safeDisconnect(node);
    this.ambientSources.clear();
    this.ambientNodes.clear();
    this.padToneFilter = null;
    this.atmosphereLowpass = null;
    this.atmosphereGain = null;
    this.ambientEchoInput = null;
    this.currentPadVoice = null;
    this.lastKeyIndex = -1;
    this.lastPadIndex = -1;
    this.ambientStarted = false;
  }

  private scheduleNextKey(
    delaySeconds = delayInRange(this.random(), AMBIENT_KEY_DELAY_RANGE_SECONDS),
  ): void {
    if (this.keyTimer !== null) clearTimeout(this.keyTimer);
    if (!this.visible || !this.ambientStarted || this.disposed) return;
    this.keyTimer = setTimeout(() => {
      this.keyTimer = null;
      this.playAmbientKey();
      this.scheduleNextKey();
    }, delaySeconds * 1000);
  }

  private scheduleNextPad(
    delaySeconds = delayInRange(this.random(), AMBIENT_PAD_DELAY_RANGE_SECONDS),
  ): void {
    if (this.padTimer !== null) clearTimeout(this.padTimer);
    if (!this.visible || !this.ambientStarted || this.disposed) return;
    this.padTimer = setTimeout(() => {
      this.padTimer = null;
      this.transitionPad(false);
      this.scheduleNextPad();
    }, delaySeconds * 1000);
  }

  private clearAmbientTimers(): void {
    if (this.keyTimer !== null) clearTimeout(this.keyTimer);
    if (this.padTimer !== null) clearTimeout(this.padTimer);
    this.keyTimer = null;
    this.padTimer = null;
  }

  private transitionPad(initial: boolean): void {
    if (!this.context || !this.padToneFilter || !this.ambientStarted) return;
    const now = this.context.currentTime;
    const fadeSeconds = initial ? 2.5 : 4.8;
    const index = pickNonRepeatingIndex(this.random(), this.lastPadIndex, AMBIENT_PAD_VOICINGS.length);
    const previous = this.currentPadVoice;
    const voice = this.createPadVoice(index, now, fadeSeconds);
    this.currentPadVoice = voice;
    this.lastPadIndex = index;
    if (previous) this.releasePadVoice(previous, now, fadeSeconds);
  }

  private createPadVoice(index: number, at: number, fadeSeconds: number): AmbientPadVoice {
    if (!this.context || !this.padToneFilter) throw new Error('Ambient graph is not ready.');
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.0075, at + fadeSeconds);
    gain.connect(this.padToneFilter);
    const sources: OscillatorNode[] = [];
    const nodes: AudioNode[] = [gain];
    const voicing = AMBIENT_PAD_VOICINGS[index] ?? AMBIENT_PAD_VOICINGS[0];
    voicing.forEach((frequency, noteIndex) => {
      const oscillator = this.context?.createOscillator();
      if (!oscillator) return;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      oscillator.detune.value = (noteIndex - 1.5) * 2.5;
      oscillator.connect(gain);
      oscillator.start(at);
      sources.push(oscillator);
      nodes.push(oscillator);
      this.ambientSources.add(oscillator);
      this.ambientNodes.add(oscillator);
    });
    this.ambientNodes.add(gain);
    return { index, gain, sources, nodes };
  }

  private releasePadVoice(voice: AmbientPadVoice, at: number, fadeSeconds: number): void {
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), at);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, at + fadeSeconds);
    let remaining = voice.sources.length;
    const clean = (): void => {
      remaining -= 1;
      if (remaining > 0) return;
      for (const source of voice.sources) this.ambientSources.delete(source);
      for (const node of voice.nodes) {
        this.ambientNodes.delete(node);
        safeDisconnect(node);
      }
    };
    for (const source of voice.sources) {
      source.addEventListener('ended', clean, { once: true });
      try {
        source.stop(at + fadeSeconds + 0.06);
      } catch {
        clean();
      }
    }
  }

  private playAmbientKey(): void {
    if (!this.canPlayEffect() || !this.context || !this.ambientBus) return;
    const index = pickNonRepeatingIndex(this.random(), this.lastKeyIndex, D_MAJOR_PENTATONIC_HZ.length);
    this.lastKeyIndex = index;
    const frequency = D_MAJOR_PENTATONIC_HZ[index] ?? 440;
    const now = this.context.currentTime;
    this.playAmbientPiano(now, frequency, 0.035);
    if (this.random() < 0.62) {
      const responseIndex = pickAmbientResponseIndex(index, this.random());
      const responseFrequency = D_MAJOR_PENTATONIC_HZ[responseIndex] ?? frequency;
      this.playAmbientPiano(now + 0.7 + this.random() * 0.35, responseFrequency, 0.022);
    }
  }

  private playAmbientPiano(at: number, frequency: number, peakGain: number): void {
    if (
      !this.context
      || !this.ambientBus
      || this.scheduledSources.size > MAX_SCHEDULED_SOURCES - 3
    ) return;
    const filter = this.context.createBiquadFilter();
    const envelope = this.context.createGain();
    filter.type = 'lowpass';
    filter.frequency.value = 3300 - this.nightFactor * 180;
    filter.Q.value = 0.42;
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(peakGain, at + 0.028);
    envelope.gain.exponentialRampToValueAtTime(peakGain * 0.34, at + 0.42);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 3.15);
    filter.connect(envelope);
    envelope.connect(this.ambientBus);
    if (this.ambientEchoInput) envelope.connect(this.ambientEchoInput);

    const sources: OscillatorNode[] = [];
    const nodes: AudioNode[] = [filter, envelope];
    const partials = [
      { ratio: 1, gain: 0.74, type: 'sine' as OscillatorType },
      { ratio: 2, gain: 0.19, type: 'triangle' as OscillatorType },
      { ratio: 3, gain: 0.07, type: 'sine' as OscillatorType },
    ];
    for (const partial of partials) {
      const oscillator = this.context.createOscillator();
      const partialGain = this.context.createGain();
      oscillator.type = partial.type;
      oscillator.frequency.setValueAtTime(frequency * partial.ratio, at);
      oscillator.detune.value = (this.random() - 0.5) * 2.4;
      partialGain.gain.value = partial.gain;
      oscillator.connect(partialGain);
      partialGain.connect(filter);
      oscillator.start(at);
      oscillator.stop(at + 3.2);
      sources.push(oscillator);
      nodes.push(oscillator, partialGain);
    }
    this.trackFiniteVoice(sources, nodes);
  }

  private shouldPlayMarketAccent(
    symbol: string,
    direction: 'up' | 'down',
    tier: 'large' | 'exceptional',
    magnitude: number,
    now: number,
  ): boolean {
    const previous = this.marketAccentState.get(symbol);
    const isUpgrade = tier === 'exceptional'
      && previous?.tier === 'large'
      && now - previous.at >= MARKET_ACCENT_UPGRADE_COOLDOWN_SECONDS;
    const isDirectionChange = previous
      && previous.direction !== direction
      && now - previous.at >= MARKET_ACCENT_DIRECTION_CHANGE_COOLDOWN_SECONDS;
    const isMeaningfulEscalation = previous
      && previous.tier === tier
      && magnitude >= previous.magnitude * 1.5
      && now - previous.at >= MARKET_ACCENT_COOLDOWN_SECONDS;
    const isRearmed = !previous
      || (previous.armed && now - previous.at >= MARKET_ACCENT_REARM_COOLDOWN_SECONDS);
    if (
      (!isUpgrade && !isDirectionChange && !isMeaningfulEscalation && !isRearmed)
      || now - this.lastGlobalMarketAccentAt < MARKET_ACCENT_GLOBAL_COOLDOWN_SECONDS
    ) {
      return false;
    }
    this.marketAccentState.set(symbol, { direction, tier, magnitude, at: now, armed: false });
    this.lastGlobalMarketAccentAt = now;
    return true;
  }

  /** A short original rising fanfare for statistically unusual upward moves. */
  private playMarketCelebration(
    destination: AudioNode,
    at: number,
    baseFrequency: number,
    moveRatio: number,
    exceptional: boolean,
  ): void {
    if (!this.context || this.scheduledSources.size > MAX_SCHEDULED_SOURCES - (exceptional ? 6 : 5)) return;
    const root = Math.min(523.25, Math.max(246.94, baseFrequency));
    const severity = marketMoveSeverity(moveRatio);
    const peak = marketMovePeakGain(moveRatio);
    this.playGentleNote(destination, at, root, 0.72, peak * 0.74, -2);
    this.playGentleNote(destination, at + 0.09, root * 1.2599, 0.9, peak * 0.88, 2);
    this.playGentleNote(destination, at + 0.19, root * 1.4983, 1.16, peak, 0);
    this.playMagicalSweep(destination, at + 0.03, root * 0.75, root * 1.68, 0.86, peak * 0.68);
    this.playNoiseBurst(destination, at + 0.12, 0.2, 'bandpass', 1700, 0.014 + severity * 0.012);
    if (exceptional) {
      this.playGentleNote(destination, at + 0.34, Math.min(1046.5, root * 2), 1.5, peak * 1.08, 3);
    }
  }

  /** A rounded descending warning gesture: noticeable, positional, and never alarm-level. */
  private playMarketWarning(
    destination: AudioNode,
    at: number,
    baseFrequency: number,
    moveRatio: number,
    exceptional: boolean,
  ): void {
    if (!this.context || this.scheduledSources.size > MAX_SCHEDULED_SOURCES - (exceptional ? 5 : 4)) return;
    const upper = Math.min(587.33, Math.max(329.63, baseFrequency * 1.26));
    const severity = marketMoveSeverity(moveRatio);
    const peak = marketMovePeakGain(moveRatio);
    this.playMarketSiren(destination, at, upper, upper * 0.56, 1.08, peak);
    this.playMagicalSweep(destination, at + 0.28, upper * 0.9, upper * 0.5, 0.92, peak * 0.82);
    this.playDampedResonator(destination, at + 0.05, 146.83, 0.58, peak * 0.74);
    this.playNoiseBurst(destination, at, 0.23, 'lowpass', 520, 0.012 + severity * 0.012);
    if (exceptional) {
      this.playMarketSiren(destination, at + 0.54, upper * 0.82, upper * 0.43, 1.22, peak * 0.8);
    }
  }

  /** A rounded, musical warning sweep with one return pulse rather than a harsh alarm. */
  private playMarketSiren(
    destination: AudioNode,
    at: number,
    upperFrequency: number,
    lowerFrequency: number,
    duration: number,
    peakGain: number,
  ): void {
    if (!this.context || this.scheduledSources.size >= MAX_SCHEDULED_SOURCES) return;
    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(upperFrequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(lowerFrequency, at + duration * 0.34);
    oscillator.frequency.exponentialRampToValueAtTime(upperFrequency * 0.88, at + duration * 0.62);
    oscillator.frequency.exponentialRampToValueAtTime(lowerFrequency * 0.92, at + duration * 0.92);
    filter.type = 'lowpass';
    filter.frequency.value = 1300;
    filter.Q.value = 0.6;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peakGain, at + 0.025);
    gain.gain.exponentialRampToValueAtTime(peakGain * 0.58, at + duration * 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.025);
    this.trackFiniteSource(oscillator, [oscillator, filter, gain]);
  }

  private playGentleNote(
    destination: AudioNode,
    at: number,
    frequency: number,
    duration: number,
    peakGain: number,
    detune: number,
  ): void {
    if (!this.context || this.scheduledSources.size >= MAX_SCHEDULED_SOURCES) return;
    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.detune.value = detune;
    filter.type = 'lowpass';
    filter.frequency.value = 840;
    filter.Q.value = 0.32;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peakGain, at + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.025);
    this.trackFiniteSource(oscillator, [oscillator, filter, gain]);
  }

  private playMagicalSweep(
    destination: AudioNode,
    at: number,
    fromFrequency: number,
    toFrequency: number,
    duration: number,
    peakGain: number,
  ): void {
    if (!this.context || this.scheduledSources.size >= MAX_SCHEDULED_SOURCES) return;
    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(fromFrequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(toFrequency, at + duration * 0.72);
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    filter.Q.value = 0.45;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peakGain, at + 0.024);
    gain.gain.exponentialRampToValueAtTime(peakGain * 0.42, at + duration * 0.42);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.025);
    this.trackFiniteSource(oscillator, [oscillator, filter, gain]);
  }

  private playDampedResonator(
    destination: AudioNode,
    at: number,
    frequency: number,
    duration: number,
    peakGain: number,
  ): void {
    if (!this.context || this.scheduledSources.size >= MAX_SCHEDULED_SOURCES) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.68, at + duration * 0.72);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peakGain, at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.02);
    this.trackFiniteSource(oscillator, [oscillator, gain]);
  }

  private playNoiseBurst(
    destination: AudioNode,
    at: number,
    duration: number,
    filterType: BiquadFilterType,
    frequency: number,
    peakGain: number,
  ): void {
    if (!this.context || this.scheduledSources.size >= MAX_SCHEDULED_SOURCES) return;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = this.getTransientNoiseBuffer();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = filterType === 'bandpass' ? 0.8 : 0.4;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peakGain, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    const maxOffset = Math.max(0, this.getTransientNoiseBuffer().duration - duration - 0.01);
    source.start(at, this.random() * maxOffset, duration + 0.01);
    this.trackFiniteSource(source, [source, filter, gain]);
  }

  private playFootThump(destination: AudioNode, at: number, frequency: number, peakGain: number): void {
    if (!this.context || this.scheduledSources.size >= MAX_SCHEDULED_SOURCES) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.62, at + 0.09);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peakGain, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(at);
    oscillator.stop(at + 0.11);
    this.trackFiniteSource(oscillator, [oscillator, gain]);
  }

  private getTransientNoiseBuffer(): AudioBuffer {
    if (this.transientNoiseBuffer) return this.transientNoiseBuffer;
    if (!this.context) throw new Error('Audio context is not ready.');
    const length = Math.max(1, Math.floor(this.context.sampleRate * 1.25));
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    let state = EMPTY_COLORED_NOISE_STATE;
    for (let index = 0; index < channel.length; index += 1) {
      const white = this.random() * 2 - 1;
      const step = nextColoredNoiseSample(white, state);
      state = step.state;
      channel[index] = step.sample * 0.78;
    }
    this.transientNoiseBuffer = buffer;
    return buffer;
  }

  private getAtmosphereNoiseBuffer(): AudioBuffer {
    if (this.atmosphereNoiseBuffer) return this.atmosphereNoiseBuffer;
    if (!this.context) throw new Error('Audio context is not ready.');
    const length = Math.max(1, Math.floor(this.context.sampleRate * 8));
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    let state = EMPTY_COLORED_NOISE_STATE;
    for (let index = 0; index < channel.length; index += 1) {
      const step = nextColoredNoiseSample(this.random() * 2 - 1, state);
      state = step.state;
      channel[index] = step.sample * 0.55;
    }
    this.atmosphereNoiseBuffer = buffer;
    return buffer;
  }

  private trackFiniteSource(source: AudioScheduledSourceNode, nodes: readonly AudioNode[]): void {
    this.scheduledSources.add(source);
    for (const node of nodes) this.finiteNodes.add(node);
    source.addEventListener('ended', () => {
      this.scheduledSources.delete(source);
      for (const node of nodes) {
        this.finiteNodes.delete(node);
        safeDisconnect(node);
      }
    }, { once: true });
  }

  private trackFiniteVoice(
    sources: readonly AudioScheduledSourceNode[],
    nodes: readonly AudioNode[],
  ): void {
    for (const source of sources) this.scheduledSources.add(source);
    for (const node of nodes) this.finiteNodes.add(node);
    let remaining = sources.length;
    const release = (): void => {
      remaining -= 1;
      if (remaining > 0) return;
      for (const source of sources) this.scheduledSources.delete(source);
      for (const node of nodes) {
        this.finiteNodes.delete(node);
        safeDisconnect(node);
      }
    };
    for (const source of sources) source.addEventListener('ended', release, { once: true });
  }

  private canPlayEffect(): boolean {
    return !this.disposed
      && this.visible
      && this.context?.state === 'running'
      && this.scheduledSources.size < MAX_SCHEDULED_SOURCES;
  }

  private canPlaySfx(): boolean {
    return !this.sfxMutedValue
      && this.sfxVolumeValue > 0.001
      && this.canPlayEffect();
  }

  private footstepSettings(surface: SurfaceKind): {
    duration: number;
    filter: BiquadFilterType;
    frequency: number;
    gain: number;
    thumpFrequency: number;
  } {
    switch (surface) {
      case 'sand':
        return { duration: 0.14, filter: 'bandpass', frequency: 430, gain: 0.03, thumpFrequency: 88 };
      case 'stone':
        return { duration: 0.075, filter: 'bandpass', frequency: 680, gain: 0.026, thumpFrequency: 126 };
      case 'grass':
        return { duration: 0.11, filter: 'lowpass', frequency: 520, gain: 0.027, thumpFrequency: 98 };
    }
  }

  private async suspendContext(): Promise<void> {
    if (!this.context || this.context.state !== 'running') return;
    try {
      await this.context.suspend();
    } catch {
      // Visibility suspension is a power-saving best effort.
    }
  }

  private copyPosition(position: AudioPosition): AudioPosition {
    return { x: position.x, y: position.y, z: position.z };
  }

  private normalisedPosition(position: AudioPosition, fallback: AudioPosition): AudioPosition {
    const length = Math.hypot(position.x, position.y, position.z);
    if (length < 0.0001 || !Number.isFinite(length)) return this.copyPosition(fallback);
    return { x: position.x / length, y: position.y / length, z: position.z / length };
  }

  private persist(key: string, value: string): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(key, value);
    } catch {
      // Private browsing and embedded contexts may reject storage writes.
    }
  }

  private setStatus(status: AudioEngineState['status'], reason?: string): void {
    if (this.disposed && status !== 'disposed') return;
    if (this.statusValue === status && this.reasonValue === reason) return;
    this.statusValue = status;
    this.reasonValue = reason;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.state;
    for (const listener of this.listeners) listener(snapshot);
  }

  private errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? `${fallback} ${error.message}` : fallback;
  }
}
