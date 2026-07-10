import { Quaternion, Vector3, type Camera } from 'three';
import type { SurfaceKind, TickDirection } from '../types';
import { ASSET_AUDIO_PROFILES, clampUnit, normaliseMoveIntensity } from './audioMath';
import type {
  AudioEngineOptions,
  AudioEngineState,
  AudioListenerInput,
  AudioListenerPose,
  AudioPosition,
  AudioStateListener,
  FootstepSoundOptions,
  MonumentAudioSource,
  TickSoundOptions,
} from './types';

const VOLUME_KEY = 'tickerworld:audio:volume';
const MUTED_KEY = 'tickerworld:audio:muted';
const MAX_MONUMENT_SOURCES = 24;
const MAX_SCHEDULED_SOURCES = 48;
const DEFAULT_VOLUME = 0.72;

interface MonumentGraph {
  readonly descriptor: MonumentAudioSource;
  readonly input: GainNode;
  readonly panner: PannerNode;
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
  private noiseBuffer: AudioBuffer | null = null;
  private ambientStarted = false;
  private pluckTimer: ReturnType<typeof setTimeout> | null = null;
  private unlockAttempt: Promise<boolean> | null = null;
  private visible = true;
  private disposed = false;
  private volumeValue: number;
  private mutedValue: boolean;
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
      ...(this.reasonValue ? { reason: this.reasonValue } : {}),
    };
  }

  public get volume(): number {
    return this.volumeValue;
  }

  public get muted(): boolean {
    return this.mutedValue;
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
    if (direction === 'flat' || !this.canPlayEffect()) return;
    const graph = this.monumentGraphs.get(sourceId);
    if (!graph || !this.context) return;

    const profile = ASSET_AUDIO_PROFILES[graph.descriptor.symbol];
    const intensity = normaliseMoveIntensity(moveRatio);
    const now = this.context.currentTime;
    const duration = direction === 'up' ? 0.48 : 0.4;
    const voiceGain = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    filter.type = direction === 'up' ? 'highpass' : 'lowpass';
    filter.frequency.setValueAtTime(direction === 'up' ? 520 : 900, now);
    filter.Q.value = direction === 'up' ? 0.4 : 0.7;
    voiceGain.gain.setValueAtTime(0.0001, now);
    voiceGain.gain.exponentialRampToValueAtTime(0.055 + intensity * 0.085, now + 0.012);
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    filter.connect(voiceGain);
    voiceGain.connect(graph.input);

    const primary = this.context.createOscillator();
    primary.type = direction === 'up' ? 'sine' : 'triangle';
    primary.detune.value = profile.accent;
    const startFrequency = direction === 'up' ? profile.frequency : profile.frequency * 0.48;
    const endFrequency = direction === 'up' ? profile.frequency * 1.26 : profile.frequency * 0.37;
    primary.frequency.setValueAtTime(startFrequency, now);
    primary.frequency.exponentialRampToValueAtTime(endFrequency, now + duration * 0.72);
    primary.connect(filter);
    primary.start(now);
    primary.stop(now + duration + 0.02);
    this.trackFiniteSource(primary, [primary, filter, voiceGain]);

    if (direction === 'up' && this.scheduledSources.size < MAX_SCHEDULED_SOURCES) {
      const shimmer = this.context.createOscillator();
      const shimmerGain = this.context.createGain();
      shimmer.type = 'triangle';
      shimmer.frequency.setValueAtTime(profile.frequency * 2.01, now);
      shimmer.detune.value = profile.accent + 7;
      shimmerGain.gain.setValueAtTime(0.0001, now);
      shimmerGain.gain.exponentialRampToValueAtTime(0.018 + intensity * 0.018, now + 0.008);
      shimmerGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
      shimmer.connect(shimmerGain);
      shimmerGain.connect(graph.input);
      shimmer.start(now);
      shimmer.stop(now + 0.3);
      this.trackFiniteSource(shimmer, [shimmer, shimmerGain]);
    }
  }

  public playCandleClose(sourceId: string, intensity = 0.5): void {
    if (!this.canPlayEffect() || !this.context) return;
    const graph = this.monumentGraphs.get(sourceId);
    if (!graph) return;
    const now = this.context.currentTime;
    const amount = clampUnit(intensity);
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(112, now);
    oscillator.frequency.exponentialRampToValueAtTime(58, now + 0.24);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.065 + amount * 0.055, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    oscillator.connect(gain);
    gain.connect(graph.input);
    oscillator.start(now);
    oscillator.stop(now + 0.32);
    this.trackFiniteSource(oscillator, [oscillator, gain]);
    this.playNoiseBurst(graph.input, now, 0.075, 'lowpass', 680, 0.025 + amount * 0.015);
  }

  public playFootstep(options: FootstepSoundOptions): void;
  public playFootstep(surface: SurfaceKind, sprinting?: boolean): void;
  public playFootstep(
    optionsOrSurface: FootstepSoundOptions | SurfaceKind,
    legacySprinting = false,
  ): void {
    if (!this.canPlayEffect() || !this.context || !this.sfxBus) return;
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
    this.playFootThump(this.sfxBus, now, settings.thumpFrequency, sprinting ? 0.047 : 0.035);
    if (sprinting) {
      this.playNoiseBurst(this.sfxBus, now + 0.035, 0.14, 'bandpass', settings.frequency * 0.72, 0.022);
    }
  }

  public setVolume(volume: number): void {
    if (this.disposed) return;
    const next = clampUnit(volume);
    if (next === this.volumeValue) return;
    this.volumeValue = next;
    this.persist(VOLUME_KEY, String(next));
    this.applyMasterGain();
    this.emit();
  }

  public toggleMute(force?: boolean): boolean {
    if (this.disposed) return this.mutedValue;
    this.mutedValue = force ?? !this.mutedValue;
    this.persist(MUTED_KEY, String(this.mutedValue));
    this.applyMasterGain();
    this.emit();
    return this.mutedValue;
  }

  public setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.clearPluckTimer();
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
        this.scheduleNextPluck();
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
    this.clearPluckTimer();
    this.stopAmbient();
    for (const source of this.scheduledSources) safeStop(source);
    for (const node of this.finiteNodes) safeDisconnect(node);
    this.scheduledSources.clear();
    this.finiteNodes.clear();
    for (const graph of this.monumentGraphs.values()) this.disposeMonumentGraph(graph);
    this.monumentGraphs.clear();
    this.desiredSources.clear();
    for (const node of [this.ambientBus, this.sfxBus, this.masterBus, this.outputCompressor]) {
      if (node) safeDisconnect(node);
    }
    const context = this.context;
    this.context = null;
    this.masterBus = null;
    this.ambientBus = null;
    this.sfxBus = null;
    this.outputCompressor = null;
    this.noiseBuffer = null;
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
    ambient.gain.value = 0.48;
    sfx.gain.value = 0.86;
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
  }

  private applyMasterGain(): void {
    if (!this.masterBus || !this.context) return;
    const target = this.mutedValue ? 0 : Math.pow(this.volumeValue, 1.65);
    const now = this.context.currentTime;
    this.masterBus.gain.cancelScheduledValues(now);
    this.masterBus.gain.setTargetAtTime(target, now, 0.025);
  }

  private syncMonumentGraphs(): void {
    if (!this.context || !this.sfxBus) return;
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
      input.gain.value = descriptor.gain ?? 1;
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'exponential';
      panner.refDistance = 9;
      panner.maxDistance = 82;
      panner.rolloffFactor = 1.45;
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
    const padGain = context.createGain();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 760;
    padFilter.Q.value = 0.35;
    padGain.gain.value = 0.055;
    padFilter.connect(padGain);
    padGain.connect(this.ambientBus);
    this.ambientNodes.add(padFilter);
    this.ambientNodes.add(padGain);

    const chord = [110, 164.81, 220];
    chord.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = index === 1 ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency;
      oscillator.detune.value = [-7, 5, 11][index] ?? 0;
      oscillator.connect(padFilter);
      oscillator.start(now);
      this.ambientSources.add(oscillator);
      this.ambientNodes.add(oscillator);
    });

    const padLfo = context.createOscillator();
    const padLfoDepth = context.createGain();
    padLfo.type = 'sine';
    padLfo.frequency.value = 0.031;
    padLfoDepth.gain.value = 0.016;
    padLfo.connect(padLfoDepth);
    padLfoDepth.connect(padGain.gain);
    padLfo.start(now);
    this.ambientSources.add(padLfo);
    this.ambientNodes.add(padLfo);
    this.ambientNodes.add(padLfoDepth);

    const filterLfo = context.createOscillator();
    const filterDepth = context.createGain();
    filterLfo.type = 'sine';
    filterLfo.frequency.value = 0.017;
    filterDepth.gain.value = 210;
    filterLfo.connect(filterDepth);
    filterDepth.connect(padFilter.frequency);
    filterLfo.start(now);
    this.ambientSources.add(filterLfo);
    this.ambientNodes.add(filterLfo);
    this.ambientNodes.add(filterDepth);

    const wind = context.createBufferSource();
    const windFilter = context.createBiquadFilter();
    const windGain = context.createGain();
    const windLfo = context.createOscillator();
    const windLfoDepth = context.createGain();
    wind.buffer = this.getNoiseBuffer();
    wind.loop = true;
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 520;
    windFilter.Q.value = 0.28;
    windGain.gain.value = 0.025;
    windLfo.frequency.value = 0.047;
    windLfoDepth.gain.value = 0.011;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.ambientBus);
    windLfo.connect(windLfoDepth);
    windLfoDepth.connect(windGain.gain);
    wind.start(now, this.random() * 0.8);
    windLfo.start(now);
    this.ambientSources.add(wind);
    this.ambientSources.add(windLfo);
    for (const node of [wind, windFilter, windGain, windLfo, windLfoDepth]) this.ambientNodes.add(node);
    this.scheduleNextPluck(1.8 + this.random() * 2.4);
  }

  private stopAmbient(): void {
    this.clearPluckTimer();
    for (const source of this.ambientSources) safeStop(source);
    for (const node of this.ambientNodes) safeDisconnect(node);
    this.ambientSources.clear();
    this.ambientNodes.clear();
    this.ambientStarted = false;
  }

  private scheduleNextPluck(delaySeconds = 3.8 + this.random() * 5.2): void {
    this.clearPluckTimer();
    if (!this.visible || !this.ambientStarted || this.disposed) return;
    this.pluckTimer = setTimeout(() => {
      this.pluckTimer = null;
      this.playAmbientPluck();
      this.scheduleNextPluck();
    }, delaySeconds * 1000);
  }

  private clearPluckTimer(): void {
    if (this.pluckTimer === null) return;
    clearTimeout(this.pluckTimer);
    this.pluckTimer = null;
  }

  private playAmbientPluck(): void {
    if (!this.canPlayEffect() || !this.context || !this.ambientBus) return;
    const pentatonic = [220, 246.94, 293.66, 329.63, 369.99, 440];
    const frequency = pentatonic[Math.floor(this.random() * pentatonic.length)] ?? 220;
    const octave = this.random() > 0.78 ? 2 : 1;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = frequency * octave;
    oscillator.detune.value = this.random() * 8 - 4;
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.045, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(this.ambientBus);
    oscillator.start(now);
    oscillator.stop(now + 1.24);
    this.trackFiniteSource(oscillator, [oscillator, filter, gain]);
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
    source.buffer = this.getNoiseBuffer();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = filterType === 'bandpass' ? 0.8 : 0.4;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peakGain, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    const maxOffset = Math.max(0, this.getNoiseBuffer().duration - duration - 0.01);
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

  private getNoiseBuffer(): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    if (!this.context) throw new Error('Audio context is not ready.');
    const length = Math.max(1, Math.floor(this.context.sampleRate * 2));
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < channel.length; index += 1) {
      const white = this.random() * 2 - 1;
      previous = previous * 0.22 + white * 0.78;
      channel[index] = previous;
    }
    this.noiseBuffer = buffer;
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

  private canPlayEffect(): boolean {
    return !this.disposed
      && this.visible
      && this.context?.state === 'running'
      && this.scheduledSources.size < MAX_SCHEDULED_SOURCES;
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
        return { duration: 0.13, filter: 'bandpass', frequency: 720, gain: 0.052, thumpFrequency: 92 };
      case 'stone':
        return { duration: 0.07, filter: 'highpass', frequency: 1350, gain: 0.047, thumpFrequency: 142 };
      case 'grass':
        return { duration: 0.1, filter: 'lowpass', frequency: 1050, gain: 0.044, thumpFrequency: 104 };
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
