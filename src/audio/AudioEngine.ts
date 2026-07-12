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
  MARKET_AUDIO_MAX_RADIUS,
  marketBassFrequency,
  marketGestureFrequencies,
  marketMovePeakGain,
  marketMoveSeverity,
  marketSourceProximityGain,
} from './audioMath';
import type {
  AudioEngineOptions,
  AudioEnvironment,
  AudioEngineState,
  AudioListenerInput,
  AudioListenerPose,
  AudioPosition,
  AudioStateListener,
  AudioSubmixKind,
  FootstepSoundOptions,
  JumpSoundKind,
  MarketAccentSoundOptions,
  MonumentAudioSource,
  TradePulseSoundOptions,
  VegetationSoundOptions,
  VegetationSoundKind,
} from './types';

const VOLUME_KEY = 'tickerworld:audio:volume';
const MUTED_KEY = 'tickerworld:audio:muted';
const MUSIC_VOLUME_KEY = 'tickerworld:audio:music-volume';
const MUSIC_MUTED_KEY = 'tickerworld:audio:music-muted';
const SFX_VOLUME_KEY = 'tickerworld:audio:sfx-volume';
const SFX_MUTED_KEY = 'tickerworld:audio:sfx-muted';
const MARKET_VOLUME_KEY = 'tickerworld:audio:market-volume';
const MARKET_MUTED_KEY = 'tickerworld:audio:market-muted';
const WEATHER_VOLUME_KEY = 'tickerworld:audio:weather-volume';
const WEATHER_MUTED_KEY = 'tickerworld:audio:weather-muted';
const MOVEMENT_VOLUME_KEY = 'tickerworld:audio:movement-volume';
const MOVEMENT_MUTED_KEY = 'tickerworld:audio:movement-muted';
const SFX_FULL_DEFAULT_MIGRATION_KEY = 'tickerworld:audio:sfx-full-default-v1';
const MAX_MONUMENT_SOURCES = 24;
const MAX_SCHEDULED_SOURCES = 48;
const MARKET_ALERT_RESERVED_VOICES = 12;
const DEFAULT_VOLUME = 0.72;
const DEFAULT_SFX_VOLUME = 1;
const NEWS_ALERT_COOLDOWN_SECONDS = 1.4;
const NEWS_ALERT_VOICE_COUNT = 3;

interface MonumentGraph {
  readonly descriptor: MonumentAudioSource;
  readonly input: GainNode;
  readonly panner: PannerNode;
  proximityGain: number;
}

interface AmbientPadVoice {
  readonly index: number;
  readonly gain: GainNode;
  readonly sources: readonly OscillatorNode[];
  readonly nodes: readonly AudioNode[];
}

interface RainAmbienceGraph {
  readonly source: AudioBufferSourceNode;
  readonly highpass: BiquadFilterNode;
  readonly lowpass: BiquadFilterNode;
  readonly gain: GainNode;
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
  private readonly rainGraphs = new Set<RainAmbienceGraph>();
  private readonly tempPosition = new Vector3();
  private readonly tempForward = new Vector3();
  private readonly tempUp = new Vector3();
  private readonly tempQuaternion = new Quaternion();

  private context: AudioContext | null = null;
  private masterBus: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private marketBus: GainNode | null = null;
  private weatherBus: GainNode | null = null;
  private movementBus: GainNode | null = null;
  private outputCompressor: DynamicsCompressorNode | null = null;
  private transientNoiseBuffer: AudioBuffer | null = null;
  private atmosphereNoiseBuffer: AudioBuffer | null = null;
  private padToneFilter: BiquadFilterNode | null = null;
  private atmosphereLowpass: BiquadFilterNode | null = null;
  private atmosphereGain: GainNode | null = null;
  private ambientEchoInput: DelayNode | null = null;
  private currentPadVoice: AmbientPadVoice | null = null;
  private ambientStarted = false;
  private activeRainGraph: RainAmbienceGraph | null = null;
  private rainIntensity = 0;
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
  private marketVolumeValue: number;
  private marketMutedValue: boolean;
  private weatherVolumeValue: number;
  private weatherMutedValue: boolean;
  private movementVolumeValue: number;
  private movementMutedValue: boolean;
  private lastNewsAlertAt = Number.NEGATIVE_INFINITY;
  private lastThunderAt = Number.NEGATIVE_INFINITY;
  private lastVegetationAt = Number.NEGATIVE_INFINITY;
  private statusValue: AudioEngineState['status'];
  private reasonValue: string | undefined;
  private cachedListenerPose: AudioListenerPose = {
    position: { x: 0, y: 2, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  };
  private proximityPosition: AudioPosition = { x: 0, y: 0, z: 0 };
  private proximityPositionExplicit = false;

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
    this.marketVolumeValue = readStoredChannelVolume(this.storage, MARKET_VOLUME_KEY, 1);
    this.marketMutedValue = readStoredChannelMute(this.storage, MARKET_MUTED_KEY, false);
    this.weatherVolumeValue = readStoredChannelVolume(this.storage, WEATHER_VOLUME_KEY, 1);
    this.weatherMutedValue = readStoredChannelMute(this.storage, WEATHER_MUTED_KEY, false);
    this.movementVolumeValue = readStoredChannelVolume(this.storage, MOVEMENT_VOLUME_KEY, 1);
    this.movementMutedValue = readStoredChannelMute(this.storage, MOVEMENT_MUTED_KEY, false);
    // Materialise split preferences on first run so subsequent channel edits
    // never fall back to an unrelated legacy master value.
    this.persist(MUSIC_VOLUME_KEY, String(this.musicVolumeValue));
    this.persist(MUSIC_MUTED_KEY, String(this.musicMutedValue));
    this.persist(SFX_VOLUME_KEY, String(this.sfxVolumeValue));
    this.persist(SFX_MUTED_KEY, String(this.sfxMutedValue));
    this.persist(MARKET_VOLUME_KEY, String(this.marketVolumeValue));
    this.persist(MARKET_MUTED_KEY, String(this.marketMutedValue));
    this.persist(WEATHER_VOLUME_KEY, String(this.weatherVolumeValue));
    this.persist(WEATHER_MUTED_KEY, String(this.weatherMutedValue));
    this.persist(MOVEMENT_VOLUME_KEY, String(this.movementVolumeValue));
    this.persist(MOVEMENT_MUTED_KEY, String(this.movementMutedValue));
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
      marketVolume: this.marketVolumeValue,
      marketMuted: this.marketMutedValue,
      weatherVolume: this.weatherVolumeValue,
      weatherMuted: this.weatherMutedValue,
      movementVolume: this.movementVolumeValue,
      movementMuted: this.movementMutedValue,
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

  public get marketVolume(): number {
    return this.marketVolumeValue;
  }

  public get marketMuted(): boolean {
    return this.marketMutedValue;
  }

  public get weatherVolume(): number {
    return this.weatherVolumeValue;
  }

  public get weatherMuted(): boolean {
    return this.weatherMutedValue;
  }

  public get movementVolume(): number {
    return this.movementVolumeValue;
  }

  public get movementMuted(): boolean {
    return this.movementMutedValue;
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
      this.syncRainAmbience();
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
        this.syncRainAmbience();
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
    if (!this.proximityPositionExplicit) {
      this.proximityPosition = this.copyPosition(this.cachedListenerPose.position);
      this.updateMonumentProximityGains();
    }
    this.applyListenerPose(this.cachedListenerPose);
  }

  /**
   * Updates the fox position used to gate market sounds. Keep calling
   * updateListener(camera) for HRTF direction; this position deliberately does
   * not follow the orbiting camera.
   */
  public updateProximityPosition(position: AudioPosition): void {
    if (this.disposed) return;
    this.proximityPosition = this.copyPosition(position);
    this.proximityPositionExplicit = true;
    this.updateMonumentProximityGains();
  }

  /** One pulse for one coalesced trade. Flat prints intentionally remain audible. */
  public playTradePulse(sourceId: string, options: TradePulseSoundOptions): void;
  public playTradePulse(sourceId: string, direction: TickDirection, moveRatio?: number): void;
  public playTradePulse(
    sourceId: string,
    optionsOrDirection: TradePulseSoundOptions | TickDirection,
    legacyMoveRatio = 0,
  ): void {
    const direction = typeof optionsOrDirection === 'string' ? optionsOrDirection : optionsOrDirection.direction;
    const moveRatio = typeof optionsOrDirection === 'string'
      ? legacyMoveRatio
      : (optionsOrDirection.moveRatio ?? 0);
    if (!this.canPlaySfx(false, 'market')) return;
    const graph = this.monumentGraphs.get(sourceId);
    if (!graph || !this.context || !this.isMonumentGraphAudible(graph)) return;

    const profile = ASSET_AUDIO_PROFILES[graph.descriptor.symbol];
    const moveClass = classifyMarketMove(moveRatio);
    const now = this.context.currentTime;
    const severity = marketMoveSeverity(moveRatio);
    const directionalPeak = marketMovePeakGain(moveRatio);
    const peak = direction === 'flat'
      ? Math.min(0.048, 0.035 + severity * 0.016)
      : directionalPeak;
    if (direction === 'flat') {
      this.playDampedResonator(graph.input, now, profile.frequency, 0.28, peak * 0.52);
    } else {
      const [first, second] = marketGestureFrequencies(profile.frequency, direction);
      const spacing = moveClass === 'small' ? 0.075 : 0.06;
      this.playGentleNote(graph.input, now, first, 0.25, peak * 0.62, profile.accent);
      this.playGentleNote(graph.input, now + spacing, second, 0.38, peak, profile.accent);
    }
    this.playDampedResonator(
      graph.input,
      now,
      marketBassFrequency(moveRatio),
      0.34 + severity * 0.2,
      peak * (0.2 + severity * 0.3),
    );
    if (moveClass === 'medium' && direction !== 'flat') {
      const [, second] = marketGestureFrequencies(profile.frequency, direction);
      const answer = direction === 'up' ? second * 1.12246 : second * 0.94387;
      this.playGentleNote(
        graph.input,
        now + 0.13,
        Math.min(740, Math.max(196, answer)),
        0.42,
        peak * 0.72,
        profile.accent * 0.5,
      );
    }
  }

  /** Priority fanfare/siren selected by Game's single authoritative event gate. */
  public playMarketAccent(sourceId: string, options: MarketAccentSoundOptions): void {
    if (!this.canPlaySfx(true, 'market') || !this.context) return;
    const graph = this.monumentGraphs.get(sourceId);
    if (!graph || !this.isMonumentGraphAudible(graph)) return;
    const exceptional = options.tier === 'exceptional';
    const requiredVoices = options.direction === 'up' ? (exceptional ? 6 : 5) : (exceptional ? 4 : 2);
    if (this.scheduledSources.size > MAX_SCHEDULED_SOURCES - requiredVoices) return;
    const profile = ASSET_AUDIO_PROFILES[graph.descriptor.symbol];
    if (options.direction === 'up') {
      this.playMarketCelebration(
        graph.input,
        this.context.currentTime,
        profile.frequency,
        options.moveRatio,
        exceptional,
      );
      return;
    }
    this.playMarketWarning(
      graph.input,
      this.context.currentTime,
      profile.frequency,
      options.moveRatio,
      exceptional,
    );
  }

  /** Compatibility alias for older integrations; event accents are intentionally excluded. */
  public playTick(sourceId: string, options: TradePulseSoundOptions): void;
  public playTick(sourceId: string, direction: TickDirection, moveRatio?: number): void;
  public playTick(
    sourceId: string,
    optionsOrDirection: TradePulseSoundOptions | TickDirection,
    legacyMoveRatio = 0,
  ): void {
    if (typeof optionsOrDirection === 'string') {
      this.playTradePulse(sourceId, optionsOrDirection, legacyMoveRatio);
    } else {
      this.playTradePulse(sourceId, optionsOrDirection);
    }
  }

  public playCandleClose(sourceId: string, intensity = 0.5): void {
    if (!this.canPlaySfx(false, 'market') || !this.context) return;
    const graph = this.monumentGraphs.get(sourceId);
    if (!graph || !this.isMonumentGraphAudible(graph)) return;
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
    if (!this.canPlaySfx(false, 'movement') || !this.context || !this.movementBus) return;
    const surface = typeof optionsOrSurface === 'string' ? optionsOrSurface : optionsOrSurface.surface;
    const sprinting = typeof optionsOrSurface === 'string'
      ? legacySprinting
      : (optionsOrSurface.sprinting ?? false);
    const side = typeof optionsOrSurface === 'string' ? undefined : optionsOrSurface.side;
    const intensity = typeof optionsOrSurface === 'string'
      ? 0.72
      : clampUnit(optionsOrSurface.intensity ?? 0.72);
    const leg = typeof optionsOrSurface === 'string' ? undefined : optionsOrSurface.leg;
    const now = this.context.currentTime;
    const settings = this.footstepSettings(surface);
    const sideVariation = side === 'left' ? -0.035 : side === 'right' ? 0.035 : 0;
    const intensityGain = 0.58 + intensity * 0.62;
    const legPitch = leg?.startsWith('front') ? 1.025 : leg?.startsWith('hind') ? 0.975 : 1;
    this.playNoiseBurst(
      this.movementBus,
      now,
      settings.duration,
      settings.filter,
      settings.frequency * (1 + sideVariation) * legPitch,
      settings.gain * (sprinting ? 1.18 : 1) * intensityGain,
    );
    this.playFootThump(
      this.movementBus,
      now,
      settings.thumpFrequency * legPitch,
      (sprinting ? 0.03 : 0.022) * intensityGain,
    );
    if (sprinting) {
      this.playNoiseBurst(
        this.movementBus,
        now,
        0.13,
        'bandpass',
        settings.frequency * 0.72,
        0.011 * intensityGain,
      );
    }
  }

  /** A bright lift for the first jump and a higher magical flourish for the air jump. */
  public playJump(kind: JumpSoundKind): void {
    if (!this.canPlaySfx(false, 'movement') || !this.context || !this.movementBus) return;
    const now = this.context.currentTime;
    if (kind === 'double-jump') {
      this.playMagicalSweep(this.movementBus, now, 523.25, 880, 0.52, 0.036);
      this.playGentleNote(this.movementBus, now + 0.12, 987.77, 0.66, 0.018, 1.5);
      this.playNoiseBurst(this.movementBus, now, 0.11, 'bandpass', 920, 0.0065);
      return;
    }
    this.playMagicalSweep(this.movementBus, now, 369.99, 587.33, 0.42, 0.029);
    this.playNoiseBurst(this.movementBus, now, 0.09, 'bandpass', 720, 0.0055);
  }

  /** A surface-aware soft puff with a small, friendly settling chime. */
  public playLanding(surface: SurfaceKind, intensity = 0.5): void {
    if (!this.canPlaySfx(false, 'movement') || !this.context || !this.movementBus) return;
    const amount = clampUnit(intensity);
    const now = this.context.currentTime;
    const settings = this.footstepSettings(surface);
    this.playNoiseBurst(
      this.movementBus,
      now,
      settings.duration * (0.8 + amount * 0.55),
      settings.filter,
      settings.frequency * 0.9,
      settings.gain * (0.36 + amount * 0.5),
    );
    this.playFootThump(this.movementBus, now, settings.thumpFrequency * 1.12, 0.009 + amount * 0.018);
    this.playGentleNote(this.movementBus, now + 0.035, 587.33, 0.3, 0.005 + amount * 0.006, -1.5);
  }

  /**
   * A short non-positional newsroom chime for genuinely new headlines. It uses
   * only rounded tonal voices—never the transient noise buffer—and shares the
   * visible FX controls and global finite-voice budget.
   */
  public playNewsAlert(intensity = 0.65): void {
    if (!this.canPlaySfx() || !this.context || !this.sfxBus) return;
    if (this.scheduledSources.size > MAX_SCHEDULED_SOURCES - NEWS_ALERT_VOICE_COUNT) return;
    const now = this.context.currentTime;
    if (now - this.lastNewsAlertAt < NEWS_ALERT_COOLDOWN_SECONDS) return;
    this.lastNewsAlertAt = now;

    const amount = clampUnit(intensity);
    const peak = 0.018 + amount * 0.018;
    this.playGentleNote(this.sfxBus, now, 440, 0.42, peak * 0.74, -1.5);
    this.playGentleNote(this.sfxBus, now + 0.105, 587.33, 0.54, peak, 1);
    this.playGentleNote(this.sfxBus, now + 0.245, 739.99, 0.7, peak * 0.82, -0.5);
  }

  /** A rare, rounded night-storm rumble routed through the visible FX mix. */
  public playThunder(intensity = 0.6): void {
    if (!this.canPlaySfx(false, 'weather') || !this.context || !this.weatherBus) return;
    if (this.scheduledSources.size > MAX_SCHEDULED_SOURCES - MARKET_ALERT_RESERVED_VOICES - 3) return;
    const now = this.context.currentTime;
    if (now - this.lastThunderAt < 3) return;
    this.lastThunderAt = now;
    const amount = clampUnit(intensity);
    const peak = 0.02 + amount * 0.026;
    this.playNoiseBurst(this.weatherBus, now, 1.08, 'lowpass', 190, peak * 0.72);
    this.playDampedResonator(this.weatherBus, now + 0.025, 54, 1.02, peak);
    this.playNoiseBurst(this.weatherBus, now + 0.19, 0.72, 'lowpass', 360, peak * 0.38);
  }

  /** Keeps one soft filtered rain bed alive only while a storm is visible. */
  public setRainIntensity(intensity: number): void {
    if (this.disposed) return;
    this.rainIntensity = clampUnit(intensity);
    this.syncRainAmbience();
  }

  public playVegetationRustle(options: VegetationSoundOptions): void;
  public playVegetationRustle(kind: VegetationSoundKind, intensity?: number): void;
  public playVegetationRustle(
    optionsOrKind: VegetationSoundOptions | VegetationSoundKind,
    legacyIntensity = 0.5,
  ): void {
    if (!this.canPlaySfx(false, 'movement') || !this.context || !this.movementBus) return;
    const kind = typeof optionsOrKind === 'string' ? optionsOrKind : optionsOrKind.kind;
    const intensity = clampUnit(
      typeof optionsOrKind === 'string'
        ? legacyIntensity
        : optionsOrKind.intensity ?? legacyIntensity,
    );
    const now = this.context.currentTime;
    if (now - this.lastVegetationAt < 0.105) return;
    this.lastVegetationAt = now;
    if (kind === 'shrub') {
      this.playNoiseBurst(this.movementBus, now, 0.19, 'bandpass', 690, 0.009 + intensity * 0.017);
      this.playNoiseBurst(this.movementBus, now + 0.018, 0.13, 'lowpass', 1_150, 0.004 + intensity * 0.007);
      return;
    }
    this.playNoiseBurst(this.movementBus, now, 0.115, 'bandpass', 940, 0.005 + intensity * 0.011);
  }

  /** A bounded HRTF flyby used by the WTI world's pooled aircraft events. */
  public playJetFlyby(position: AudioPosition, intensity = 0.7): void {
    if (!this.canPlaySfx(false, 'weather') || !this.context || this.scheduledSources.size > MAX_SCHEDULED_SOURCES - 2) {
      return;
    }
    const amount = clampUnit(intensity);
    const spatial = this.createPositionalEffectBus(position, 82, 0.5 + amount * 0.5, this.weatherBus);
    if (!spatial) return;
    const now = this.context.currentTime;
    const duration = 2.15;
    const noise = this.context.createBufferSource();
    const noiseFilter = this.context.createBiquadFilter();
    const noiseGain = this.context.createGain();
    noise.buffer = this.getTransientNoiseBuffer();
    noise.loop = true;
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 620 + amount * 430;
    noiseFilter.Q.value = 0.42;
    noiseGain.gain.setValueAtTime(0.0001, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.025 + amount * 0.035, now + 0.32);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(spatial.input);

    const engine = this.context.createOscillator();
    const engineFilter = this.context.createBiquadFilter();
    const engineGain = this.context.createGain();
    engine.type = 'sawtooth';
    engine.frequency.setValueAtTime(128 + amount * 34, now);
    engine.frequency.exponentialRampToValueAtTime(69 + amount * 15, now + duration);
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 470;
    engineFilter.Q.value = 0.5;
    engineGain.gain.setValueAtTime(0.0001, now);
    engineGain.gain.exponentialRampToValueAtTime(0.012 + amount * 0.018, now + 0.24);
    engineGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    engine.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(spatial.input);

    spatial.panner.positionX.setValueAtTime(position.x - 7, now);
    spatial.panner.positionX.setTargetAtTime(position.x + 7, now + 0.28, 0.62);
    noise.start(now, this.random() * Math.max(0, this.getTransientNoiseBuffer().duration - 0.02));
    noise.stop(now + duration + 0.03);
    engine.start(now);
    engine.stop(now + duration + 0.03);
    this.trackFiniteVoice(
      [noise, engine],
      [
        noise, noiseFilter, noiseGain,
        engine, engineFilter, engineGain,
        ...spatial.nodes,
      ],
    );
  }

  /** A rounded, distance-bounded HRTF blast for WTI world set dressing. */
  public playDistantExplosion(position: AudioPosition, intensity = 0.7): void {
    if (!this.canPlaySfx(false, 'weather') || !this.context || this.scheduledSources.size > MAX_SCHEDULED_SOURCES - 3) {
      return;
    }
    const amount = clampUnit(intensity);
    const spatial = this.createPositionalEffectBus(position, 96, 0.52 + amount * 0.48, this.weatherBus);
    if (!spatial) return;
    const now = this.context.currentTime;

    const body = this.context.createBufferSource();
    const bodyFilter = this.context.createBiquadFilter();
    const bodyGain = this.context.createGain();
    body.buffer = this.getTransientNoiseBuffer();
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.value = 330 + amount * 180;
    bodyFilter.Q.value = 0.48;
    bodyGain.gain.setValueAtTime(0.0001, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.045 + amount * 0.07, now + 0.012);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.42);
    body.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(spatial.input);

    const crack = this.context.createBufferSource();
    const crackFilter = this.context.createBiquadFilter();
    const crackGain = this.context.createGain();
    crack.buffer = this.getTransientNoiseBuffer();
    crackFilter.type = 'bandpass';
    crackFilter.frequency.value = 820;
    crackFilter.Q.value = 0.65;
    crackGain.gain.setValueAtTime(0.0001, now);
    crackGain.gain.exponentialRampToValueAtTime(0.018 + amount * 0.024, now + 0.004);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    crack.connect(crackFilter);
    crackFilter.connect(crackGain);
    crackGain.connect(spatial.input);

    const rumble = this.context.createOscillator();
    const rumbleGain = this.context.createGain();
    rumble.type = 'sine';
    rumble.frequency.setValueAtTime(61, now);
    rumble.frequency.exponentialRampToValueAtTime(34, now + 1.35);
    rumbleGain.gain.setValueAtTime(0.0001, now);
    rumbleGain.gain.exponentialRampToValueAtTime(0.028 + amount * 0.044, now + 0.018);
    rumbleGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.48);
    rumble.connect(rumbleGain);
    rumbleGain.connect(spatial.input);

    body.start(now, this.random() * 0.05, 1.48);
    crack.start(now, this.random() * 0.12, 0.28);
    rumble.start(now);
    rumble.stop(now + 1.5);
    this.trackFiniteVoice(
      [body, crack, rumble],
      [
        body, bodyFilter, bodyGain,
        crack, crackFilter, crackGain,
        rumble, rumbleGain,
        ...spatial.nodes,
      ],
    );
  }

  /** A separate soft cue for portal channel start, cancellation, and arrival. */
  public playPortalChime(stage: 'start' | 'cancel' | 'complete'): void {
    if (!this.canPlaySfx() || !this.context || !this.sfxBus) return;
    const now = this.context.currentTime;
    if (stage === 'cancel') {
      this.playGentleNote(this.sfxBus, now, 440, 0.3, 0.011, -1.2);
      this.playGentleNote(this.sfxBus, now + 0.08, 369.99, 0.38, 0.009, 1.2);
      return;
    }
    if (stage === 'start') {
      this.playGentleNote(this.sfxBus, now, 369.99, 0.55, 0.012, -0.8);
      this.playGentleNote(this.sfxBus, now + 0.13, 493.88, 0.68, 0.014, 0.8);
      return;
    }
    this.playGentleNote(this.sfxBus, now, 440, 0.5, 0.014, -1.3);
    this.playGentleNote(this.sfxBus, now + 0.11, 587.33, 0.62, 0.018, 1.3);
    this.playGentleNote(this.sfxBus, now + 0.24, 739.99, 0.82, 0.016, 0);
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

  public setMarketVolume(volume: number): void {
    this.setSubmixVolume('market', volume);
  }

  public setWeatherVolume(volume: number): void {
    this.setSubmixVolume('weather', volume);
  }

  public setMovementVolume(volume: number): void {
    this.setSubmixVolume('movement', volume);
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

  public toggleMarketMuted(force?: boolean): boolean {
    return this.toggleSubmixMuted('market', force);
  }

  public toggleWeatherMuted(force?: boolean): boolean {
    return this.toggleSubmixMuted('weather', force);
  }

  public toggleMovementMuted(force?: boolean): boolean {
    return this.toggleSubmixMuted('movement', force);
  }

  public setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.clearAmbientTimers();
      this.stopRainAmbience(0.08);
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
        this.syncRainAmbience();
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
    this.stopRainAmbience(0);
    for (const graph of this.rainGraphs) this.cleanupRainGraph(graph);
    this.rainGraphs.clear();
    for (const source of this.scheduledSources) safeStop(source);
    for (const node of this.finiteNodes) safeDisconnect(node);
    this.scheduledSources.clear();
    this.finiteNodes.clear();
    for (const graph of this.monumentGraphs.values()) this.disposeMonumentGraph(graph);
    this.monumentGraphs.clear();
    this.desiredSources.clear();
    for (const node of [
      this.ambientBus,
      this.marketBus,
      this.weatherBus,
      this.movementBus,
      this.sfxBus,
      this.masterBus,
      this.outputCompressor,
    ]) {
      if (node) safeDisconnect(node);
    }
    const context = this.context;
    this.context = null;
    this.masterBus = null;
    this.ambientBus = null;
    this.marketBus = null;
    this.weatherBus = null;
    this.movementBus = null;
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
    const market = context.createGain();
    const weather = context.createGain();
    const movement = context.createGain();
    const compressor = context.createDynamicsCompressor();
    ambient.gain.value = 0.4;
    sfx.gain.value = 1;
    compressor.threshold.value = -15;
    compressor.knee.value = 18;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.22;
    ambient.connect(master);
    market.connect(sfx);
    weather.connect(sfx);
    movement.connect(sfx);
    sfx.connect(master);
    master.connect(compressor);
    compressor.connect(context.destination);
    this.masterBus = master;
    this.ambientBus = ambient;
    this.sfxBus = sfx;
    this.marketBus = market;
    this.weatherBus = weather;
    this.movementBus = movement;
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
    this.marketBus?.gain.setTargetAtTime(
      this.marketMutedValue ? 0 : Math.pow(this.marketVolumeValue, 1.3),
      now,
      0.025,
    );
    this.weatherBus?.gain.setTargetAtTime(
      this.weatherMutedValue ? 0 : Math.pow(this.weatherVolumeValue, 1.3),
      now,
      0.04,
    );
    this.movementBus?.gain.setTargetAtTime(
      this.movementMutedValue ? 0 : Math.pow(this.movementVolumeValue, 1.3),
      now,
      0.025,
    );
  }

  private createPositionalEffectBus(
    position: AudioPosition,
    maxDistance: number,
    trim: number,
    destination: GainNode | null = this.sfxBus,
  ): { input: GainNode; panner: PannerNode; nodes: readonly AudioNode[] } | null {
    if (!this.context || !destination) return null;
    const distance = Math.hypot(
      position.x - this.proximityPosition.x,
      position.y - this.proximityPosition.y,
      position.z - this.proximityPosition.z,
    );
    if (!Number.isFinite(distance) || distance >= maxDistance) return null;
    const fullRadius = 12;
    const progress = clampUnit((distance - fullRadius) / Math.max(1, maxDistance - fullRadius));
    const proximity = distance <= fullRadius ? 1 : (1 - progress) ** 2;
    const input = this.context.createGain();
    const panner = this.context.createPanner();
    input.gain.value = clampUnit(trim) * proximity;
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = maxDistance + 1;
    panner.rolloffFactor = 0;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;
    input.connect(panner);
    panner.connect(destination);
    return { input, panner, nodes: [input, panner] };
  }

  private syncMonumentGraphs(): void {
    if (!this.context || !this.marketBus) return;
    for (const [id, graph] of this.monumentGraphs) {
      if (!this.desiredSources.has(id)) {
        this.disposeMonumentGraph(graph);
        this.monumentGraphs.delete(id);
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
      panner.panningModel = 'HRTF';
      // The explicit fox-proximity curve owns distance. HRTF supplies only
      // direction, preventing the previous second exponential attenuation.
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.maxDistance = MARKET_AUDIO_MAX_RADIUS + 4;
      panner.rolloffFactor = 0;
      input.connect(panner);
      panner.connect(this.marketBus);
      const graph = { descriptor, input, panner, proximityGain: 0 };
      this.monumentGraphs.set(descriptor.id, graph);
      this.positionMonumentGraph(graph);
    }
  }

  private positionMonumentGraph(graph: MonumentGraph): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    const { x, y, z } = graph.descriptor.position;
    graph.proximityGain = this.proximityGainFor(graph.descriptor);
    graph.input.gain.setTargetAtTime(
      (graph.descriptor.gain ?? 1) * graph.proximityGain,
      now,
      0.08,
    );
    graph.panner.positionX.setTargetAtTime(x, now, 0.035);
    graph.panner.positionY.setTargetAtTime(y, now, 0.035);
    graph.panner.positionZ.setTargetAtTime(z, now, 0.035);
  }

  private disposeMonumentGraph(graph: MonumentGraph): void {
    safeDisconnect(graph.input);
    safeDisconnect(graph.panner);
  }

  private proximityGainFor(descriptor: MonumentAudioSource): number {
    const dx = descriptor.position.x - this.proximityPosition.x;
    const dz = descriptor.position.z - this.proximityPosition.z;
    return marketSourceProximityGain(Math.hypot(dx, dz));
  }

  private isMonumentGraphAudible(graph: MonumentGraph): boolean {
    return (graph.descriptor.gain ?? 1) * graph.proximityGain > 0.001;
  }

  private updateMonumentProximityGains(): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const graph of this.monumentGraphs.values()) {
      graph.proximityGain = this.proximityGainFor(graph.descriptor);
      graph.input.gain.setTargetAtTime(
        (graph.descriptor.gain ?? 1) * graph.proximityGain,
        now,
        0.12,
      );
    }
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
    if (
      this.ambientStarted
      || !this.context
      || !this.ambientBus
      || !this.weatherBus
      || this.disposed
    ) return;
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
    atmosphereGain.connect(this.weatherBus);
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

  private syncRainAmbience(): void {
    if (
      !this.context
      || !this.weatherBus
      || !this.visible
      || this.weatherMutedValue
      || this.weatherVolumeValue <= 0.001
      || this.rainIntensity <= 0.01
    ) {
      if (this.activeRainGraph) this.stopRainAmbience(1.15);
      return;
    }
    const now = this.context.currentTime;
    if (!this.activeRainGraph) {
      // A rapid hide/show can leave one source finishing its short fade while
      // the new storm bed begins. Never retain more than that single tail.
      while (this.rainGraphs.size >= 2) {
        const oldest = this.rainGraphs.values().next().value as RainAmbienceGraph | undefined;
        if (!oldest) break;
        safeStop(oldest.source);
        this.cleanupRainGraph(oldest);
      }
      const source = this.context.createBufferSource();
      const highpass = this.context.createBiquadFilter();
      const lowpass = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      source.buffer = this.getTransientNoiseBuffer();
      source.loop = true;
      highpass.type = 'highpass';
      highpass.frequency.value = 1_050;
      highpass.Q.value = 0.25;
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 4_800;
      lowpass.Q.value = 0.2;
      gain.gain.setValueAtTime(0.0001, now);
      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(gain);
      gain.connect(this.weatherBus);
      const graph: RainAmbienceGraph = {
        source,
        highpass,
        lowpass,
        gain,
        nodes: [source, highpass, lowpass, gain],
      };
      source.addEventListener('ended', () => this.cleanupRainGraph(graph), { once: true });
      source.start(now, this.random() * Math.max(0, this.getTransientNoiseBuffer().duration - 0.02));
      this.activeRainGraph = graph;
      this.rainGraphs.add(graph);
    }
    const target = 0.006 + this.rainIntensity * 0.017;
    this.activeRainGraph.gain.gain.cancelScheduledValues(now);
    this.activeRainGraph.gain.gain.setTargetAtTime(target, now, 0.38);
    this.activeRainGraph.lowpass.frequency.setTargetAtTime(
      4_100 + this.rainIntensity * 1_300,
      now,
      0.75,
    );
  }

  private stopRainAmbience(fadeSeconds: number): void {
    const graph = this.activeRainGraph;
    if (!graph || !this.context) return;
    this.activeRainGraph = null;
    const now = this.context.currentTime;
    const fade = Math.max(0, fadeSeconds);
    graph.gain.gain.cancelScheduledValues(now);
    if (fade <= 0.001) {
      graph.gain.gain.setValueAtTime(0.0001, now);
    } else {
      graph.gain.gain.setTargetAtTime(0.0001, now, Math.max(0.02, fade * 0.28));
    }
    try {
      graph.source.stop(now + fade);
    } catch {
      this.cleanupRainGraph(graph);
    }
  }

  private cleanupRainGraph(graph: RainAmbienceGraph): void {
    if (this.activeRainGraph === graph) this.activeRainGraph = null;
    this.rainGraphs.delete(graph);
    for (const node of graph.nodes) safeDisconnect(node);
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

  /** A clear positional siren for a genuinely large one-minute drop. */
  private playMarketWarning(
    destination: AudioNode,
    at: number,
    baseFrequency: number,
    moveRatio: number,
    exceptional: boolean,
  ): void {
    if (!this.context || this.scheduledSources.size > MAX_SCHEDULED_SOURCES - (exceptional ? 4 : 2)) return;
    const upper = Math.min(587.33, Math.max(349.23, baseFrequency * 1.32));
    const peak = Math.min(0.16, Math.max(0.105, marketMovePeakGain(moveRatio) * 1.16));
    const duration = exceptional ? 1.5 : 1.05;
    this.playMarketSiren(destination, at, upper, upper * 0.48, duration, peak);
    this.playDampedResonator(destination, at + 0.025, 110, duration * 0.72, peak * 0.62);
    if (exceptional) {
      this.playMarketSiren(destination, at + 0.5, upper * 0.88, upper * 0.42, 1, peak * 0.9);
      this.playDampedResonator(destination, at + 0.52, 92, 0.86, peak * 0.48);
    }
  }

  /** A rounded but unmistakable two-sweep warning voice. */
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

  private canPlayEffect(priority = false): boolean {
    const voiceLimit = priority
      ? MAX_SCHEDULED_SOURCES
      : MAX_SCHEDULED_SOURCES - MARKET_ALERT_RESERVED_VOICES;
    return !this.disposed
      && this.visible
      && this.context?.state === 'running'
      && this.scheduledSources.size < voiceLimit;
  }

  private submixPreference(kind: AudioSubmixKind): {
    volume: number;
    muted: boolean;
  } {
    switch (kind) {
      case 'market': return { volume: this.marketVolumeValue, muted: this.marketMutedValue };
      case 'weather': return { volume: this.weatherVolumeValue, muted: this.weatherMutedValue };
      case 'movement': return { volume: this.movementVolumeValue, muted: this.movementMutedValue };
    }
  }

  private setSubmixVolume(kind: AudioSubmixKind, volume: number): void {
    if (this.disposed) return;
    const next = clampUnit(volume);
    const current = this.submixPreference(kind).volume;
    if (next === current) return;
    switch (kind) {
      case 'market':
        this.marketVolumeValue = next;
        this.persist(MARKET_VOLUME_KEY, String(next));
        break;
      case 'weather':
        this.weatherVolumeValue = next;
        this.persist(WEATHER_VOLUME_KEY, String(next));
        break;
      case 'movement':
        this.movementVolumeValue = next;
        this.persist(MOVEMENT_VOLUME_KEY, String(next));
        break;
    }
    this.applyChannelGains();
    if (kind === 'weather') this.syncRainAmbience();
    this.emit();
  }

  private toggleSubmixMuted(kind: AudioSubmixKind, force?: boolean): boolean {
    if (this.disposed) return this.submixPreference(kind).muted;
    const next = force ?? !this.submixPreference(kind).muted;
    switch (kind) {
      case 'market':
        this.marketMutedValue = next;
        this.persist(MARKET_MUTED_KEY, String(next));
        break;
      case 'weather':
        this.weatherMutedValue = next;
        this.persist(WEATHER_MUTED_KEY, String(next));
        break;
      case 'movement':
        this.movementMutedValue = next;
        this.persist(MOVEMENT_MUTED_KEY, String(next));
        break;
    }
    this.applyChannelGains();
    if (kind === 'weather') this.syncRainAmbience();
    this.emit();
    return next;
  }

  private canPlaySfx(priority = false, submix?: AudioSubmixKind): boolean {
    const submixEnabled = !submix || (() => {
      const preference = this.submixPreference(submix);
      return !preference.muted && preference.volume > 0.001;
    })();
    return !this.sfxMutedValue
      && this.sfxVolumeValue > 0.001
      && submixEnabled
      && this.canPlayEffect(priority);
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
