import { describe, expect, it, vi } from 'vitest';
import {
  AMBIENT_KEY_DELAY_RANGE_SECONDS,
  AMBIENT_PAD_DELAY_RANGE_SECONDS,
  AMBIENT_PAD_VOICINGS,
  ASSET_AUDIO_PROFILES,
  AudioEngine,
  classifyMarketMove,
  D_MAJOR_PENTATONIC_HZ,
  delayInRange,
  EMPTY_COLORED_NOISE_STATE,
  MARKET_AUDIO_FULL_RADIUS,
  MARKET_AUDIO_MAX_RADIUS,
  MARKET_MOVE_THRESHOLDS,
  marketBassFrequency,
  marketGestureFrequencies,
  marketMovePeakGain,
  marketMoveSeverity,
  marketSourceProximityGain,
  nextColoredNoiseSample,
  normaliseMoveIntensity,
  pickAmbientResponseIndex,
  pickNonRepeatingIndex,
} from '../src/audio';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

interface FakeNode extends Partial<AudioScheduledSourceNode> {
  readonly connect: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly start?: ReturnType<typeof vi.fn>;
  readonly stop?: ReturnType<typeof vi.fn>;
  readonly gain?: AudioParam;
  readonly frequency?: AudioParam;
  readonly detune?: AudioParam;
  readonly delayTime?: AudioParam;
  readonly Q?: AudioParam;
  loop?: boolean;
  buffer?: AudioBuffer | null;
  type?: string;
}

function makeParam(initial = 0): AudioParam {
  const param = {
    value: initial,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn((value: number) => {
      param.value = value;
      return param;
    }),
    setTargetAtTime: vi.fn((value: number) => {
      param.value = value;
      return param;
    }),
    exponentialRampToValueAtTime: vi.fn((value: number) => {
      param.value = value;
      return param;
    }),
  };
  return param as unknown as AudioParam;
}

function makeFakeContext(): {
  readonly context: AudioContext;
  readonly nodes: FakeNode[];
  readonly oscillators: FakeNode[];
  readonly bufferSources: FakeNode[];
  readonly close: ReturnType<typeof vi.fn>;
} {
  const nodes: FakeNode[] = [];
  const oscillators: FakeNode[] = [];
  const bufferSources: FakeNode[] = [];
  const createNode = (parameters: readonly string[] = []): FakeNode => {
    const node: FakeNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    for (const parameter of parameters) {
      Object.assign(node, { [parameter]: makeParam() });
    }
    nodes.push(node);
    return node;
  };
  let state: AudioContextState = 'suspended';
  const close = vi.fn(async () => {
    state = 'closed';
  });
  const listenerParams = Object.fromEntries([
    'positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ',
  ].map((key) => [key, makeParam()]));
  const context = {
    currentTime: 0,
    sampleRate: 100,
    destination: createNode(),
    listener: listenerParams,
    get state(): AudioContextState {
      return state;
    },
    resume: vi.fn(async () => {
      state = 'running';
    }),
    suspend: vi.fn(async () => {
      state = 'suspended';
    }),
    close,
    createGain: vi.fn(() => createNode(['gain']) as unknown as GainNode),
    createBiquadFilter: vi.fn(() => {
      const node = createNode(['frequency', 'Q']);
      return node as unknown as BiquadFilterNode;
    }),
    createDelay: vi.fn(() => createNode(['delayTime']) as unknown as DelayNode),
    createPanner: vi.fn(() => {
      const node = createNode(['positionX', 'positionY', 'positionZ']);
      return node as unknown as PannerNode;
    }),
    createDynamicsCompressor: vi.fn(() => {
      const node = createNode(['threshold', 'knee', 'ratio', 'attack', 'release']);
      return node as unknown as DynamicsCompressorNode;
    }),
    createOscillator: vi.fn(() => {
      const node = createNode(['frequency', 'detune']);
      Object.assign(node, {
        start: vi.fn(),
        stop: vi.fn(),
        addEventListener: vi.fn(),
      });
      oscillators.push(node);
      return node as unknown as OscillatorNode;
    }),
    createBufferSource: vi.fn(() => {
      const node = createNode();
      Object.assign(node, {
        start: vi.fn(),
        stop: vi.fn(),
        addEventListener: vi.fn(),
        buffer: null,
        loop: false,
      });
      bufferSources.push(node);
      return node as unknown as AudioBufferSourceNode;
    }),
    createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => {
      const channel = new Float32Array(length);
      return {
        duration: length / sampleRate,
        getChannelData: () => channel,
      } as unknown as AudioBuffer;
    }),
  } as unknown as AudioContext;
  return { context, nodes, oscillators, bufferSources, close };
}

describe('AudioEngine preferences and fallback', () => {
  it('starts fresh users at full FX while keeping the music mix gentle', () => {
    const storage = new MemoryStorage();
    const engine = new AudioEngine({ storage });

    expect(engine.state).toMatchObject({
      musicVolume: 0.72,
      sfxVolume: 1,
      musicMuted: false,
      sfxMuted: false,
    });
    expect(storage.getItem('tickerworld:audio:sfx-volume')).toBe('1');
    engine.dispose();
  });

  it('persists clamped volume and mute without requiring an AudioContext', () => {
    const storage = new MemoryStorage();
    const engine = new AudioEngine({ storage });
    const states = vi.fn();
    engine.subscribe(states);

    engine.setVolume(4);
    expect(engine.volume).toBe(1);
    expect(engine.toggleMute()).toBe(true);

    const restored = new AudioEngine({ storage });
    expect(restored.volume).toBe(1);
    expect(restored.muted).toBe(true);
    expect(states).toHaveBeenCalled();
    engine.dispose();
    restored.dispose();
  });

  it('persists independent music and sound-effect preferences', () => {
    const storage = new MemoryStorage();
    const engine = new AudioEngine({ storage });

    engine.setMusicVolume(0.28);
    engine.setSfxVolume(0.84);
    engine.toggleMusicMuted(true);
    engine.toggleSfxMuted(false);

    const restored = new AudioEngine({ storage });
    expect(restored.state).toMatchObject({
      musicVolume: 0.28,
      musicMuted: true,
      sfxVolume: 0.84,
      sfxMuted: false,
    });
    expect(restored.musicVolume).toBe(0.28);
    expect(restored.sfxVolume).toBe(0.84);
    engine.dispose();
    restored.dispose();
  });

  it('migrates legacy master preferences into visible channels without a hidden mute', async () => {
    const storage = new MemoryStorage();
    storage.setItem('tickerworld:audio:volume', '0.36');
    storage.setItem('tickerworld:audio:muted', 'true');
    const fake = makeFakeContext();
    const engine = new AudioEngine({ storage, contextFactory: () => fake.context });

    expect(engine.state).toMatchObject({
      musicVolume: 0.36,
      sfxVolume: 0.36,
      musicMuted: true,
      sfxMuted: true,
    });
    await engine.unlock();
    expect(fake.nodes[1]?.gain?.setTargetAtTime).toHaveBeenCalledWith(1, 0, 0.025);

    // The old API now controls both visible channels rather than an invisible
    // master gain that could remain stuck at zero.
    engine.toggleMute(false);
    engine.setVolume(0.62);
    expect(engine.state).toMatchObject({
      volume: 0.62,
      muted: false,
      musicVolume: 0.62,
      sfxVolume: 0.62,
      musicMuted: false,
      sfxMuted: false,
    });
    engine.dispose();
  });

  it('upgrades only the materialised old default to full FX once', () => {
    const storage = new MemoryStorage();
    // The previous split-channel release wrote these two keys even when the
    // player never touched a volume control; it did not always write master.
    storage.setItem('tickerworld:audio:music-volume', '0.72');
    storage.setItem('tickerworld:audio:sfx-volume', '0.72');

    const migrated = new AudioEngine({ storage });
    expect(migrated.musicVolume).toBe(0.72);
    expect(migrated.sfxVolume).toBe(1);
    migrated.dispose();

    // Once marked, a later explicit preference is never interpreted as the old default.
    storage.setItem('tickerworld:audio:sfx-volume', '0.72');
    const restored = new AudioEngine({ storage });
    expect(restored.sfxVolume).toBe(0.72);
    restored.dispose();
  });

  it('reports unavailable cleanly when Web Audio is missing', async () => {
    const engine = new AudioEngine({ storage: null });
    expect(engine.state.status).toBe('unavailable');
    await expect(engine.unlock()).resolves.toBe(false);
    engine.dispose();
    expect(engine.state.status).toBe('disposed');
  });
});

describe('audio mapping', () => {
  it('keeps market audio full nearby, fades smoothly, and reaches a hard local cutoff', () => {
    expect(marketSourceProximityGain(0)).toBe(1);
    expect(marketSourceProximityGain(MARKET_AUDIO_FULL_RADIUS)).toBe(1);
    const fade = [14, 20, 26, 32].map(marketSourceProximityGain);
    expect(fade).toEqual([...fade].sort((a, b) => b - a));
    expect(fade.every((gain) => gain > 0 && gain < 1)).toBe(true);
    expect(marketSourceProximityGain(MARKET_AUDIO_MAX_RADIUS)).toBe(0);
    expect(marketSourceProximityGain(MARKET_AUDIO_MAX_RADIUS + 100)).toBe(0);
    expect(marketSourceProximityGain(Number.NaN)).toBe(0);
  });

  it('gives every asset a distinct ordered pitch identity', () => {
    const frequencies = Object.values(ASSET_AUDIO_PROFILES).map(({ frequency }) => frequency);
    expect(new Set(frequencies).size).toBe(8);
    expect(frequencies).toEqual([...frequencies].sort((a, b) => a - b));
  });

  it('compresses market movement into a finite gentle range', () => {
    expect(normaliseMoveIntensity(0)).toBe(0);
    expect(normaliseMoveIntensity(-0.005)).toBeCloseTo(0.5);
    expect(normaliseMoveIntensity(5)).toBe(1);
    expect(normaliseMoveIntensity(Number.NaN)).toBe(0);
  });

  it('classifies and scales market moves perceptually', () => {
    const { medium, large, exceptional } = MARKET_MOVE_THRESHOLDS;
    expect(MARKET_MOVE_THRESHOLDS).toEqual({
      medium: 0.0001,
      large: 0.00035,
      exceptional: 0.001,
    });
    expect(classifyMarketMove(medium - Number.EPSILON)).toBe('small');
    expect(classifyMarketMove(medium)).toBe('medium');
    expect(classifyMarketMove(-(large - Number.EPSILON))).toBe('medium');
    expect(classifyMarketMove(-large)).toBe('large');
    expect(classifyMarketMove(exceptional - Number.EPSILON)).toBe('large');
    expect(classifyMarketMove(exceptional)).toBe('exceptional');
    const severities = [0, 0.00005, 0.0005, 0.005].map(marketMoveSeverity);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
    expect(severities[0]).toBe(0);
    expect(severities.at(-1)).toBe(1);
    expect(marketMoveSeverity(Number.NaN)).toBe(0);

    const tierPeaks = [
      marketMovePeakGain(medium - Number.EPSILON),
      marketMovePeakGain(medium),
      marketMovePeakGain(large),
      marketMovePeakGain(exceptional),
    ];
    expect(tierPeaks).toEqual([...tierPeaks].sort((a, b) => a - b));
    expect(tierPeaks[0]).toBeGreaterThanOrEqual(0.035);
    expect(tierPeaks[2]).toBeGreaterThan(tierPeaks[1] ?? 0);
    expect(tierPeaks[3]).toBeGreaterThan(tierPeaks[2] ?? 0);
    expect(tierPeaks[3]).toBeLessThanOrEqual(0.12);
    expect(marketBassFrequency(exceptional)).toBeLessThan(marketBassFrequency(medium));
    expect(marketBassFrequency(0)).toBe(180);
  });

  it('keeps both notes of every market gesture between 220 and 587 Hz', () => {
    for (const profile of Object.values(ASSET_AUDIO_PROFILES)) {
      for (const direction of ['up', 'down'] as const) {
        const notes = marketGestureFrequencies(profile.frequency, direction);
        expect(Math.min(...notes)).toBeGreaterThanOrEqual(220);
        expect(Math.max(...notes)).toBeLessThanOrEqual(587.33);
        expect(notes[direction === 'up' ? 1 : 0]).toBeGreaterThan(notes[direction === 'up' ? 0 : 1]);
      }
    }
  });
});

describe('ambient composition', () => {
  it('uses a calm but regularly audible key cadence and slow pad changes', () => {
    expect(delayInRange(0, AMBIENT_KEY_DELAY_RANGE_SECONDS)).toBe(5);
    expect(delayInRange(1, AMBIENT_KEY_DELAY_RANGE_SECONDS)).toBe(10);
    expect(delayInRange(0.5, AMBIENT_PAD_DELAY_RANGE_SECONDS)).toBe(31);
    expect(Math.min(...D_MAJOR_PENTATONIC_HZ)).toBeGreaterThanOrEqual(293.66);
    expect(Math.min(...AMBIENT_PAD_VOICINGS.flat())).toBeGreaterThanOrEqual(146.83);
  });

  it('answers a key with a different in-scale note deterministically', () => {
    expect(pickAmbientResponseIndex(0, 0)).toBe(2);
    expect(pickAmbientResponseIndex(0, 1)).toBe(3);
    expect(pickAmbientResponseIndex(9, 0)).toBe(7);
    for (let primary = 0; primary < D_MAJOR_PENTATONIC_HZ.length; primary += 1) {
      const answer = pickAmbientResponseIndex(primary, 0.5);
      expect(answer).toBeGreaterThanOrEqual(0);
      expect(answer).toBeLessThan(D_MAJOR_PENTATONIC_HZ.length);
      expect(answer).not.toBe(primary);
    }
  });

  it('never immediately repeats a pad voicing', () => {
    for (let previous = 0; previous < AMBIENT_PAD_VOICINGS.length; previous += 1) {
      for (const random of [0, 0.25, 0.5, 0.75, 1]) {
        expect(pickNonRepeatingIndex(random, previous, AMBIENT_PAD_VOICINGS.length)).not.toBe(previous);
      }
    }
  });

  it('generates deterministic bounded colored atmosphere samples', () => {
    const render = (): number[] => {
      let state = EMPTY_COLORED_NOISE_STATE;
      return Array.from({ length: 128 }, (_, index) => {
        const step = nextColoredNoiseSample(index % 2 === 0 ? 1 : -1, state);
        state = step.state;
        return step.sample;
      });
    };
    const first = render();
    expect(render()).toEqual(first);
    expect(first.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1)).toBe(true);
    const averageDelta = first.slice(1).reduce((sum, sample, index) => (
      sum + Math.abs(sample - (first[index] ?? sample))
    ), 0) / (first.length - 1);
    expect(averageDelta).toBeLessThan(0.8);
  });
});

describe('AudioEngine lifecycle', () => {
  it('plays a bounded tonal news chime only when FX are active and visible', async () => {
    vi.useFakeTimers();
    const fake = makeFakeContext();
    const engine = new AudioEngine({ contextFactory: () => fake.context, storage: null, random: () => 0.5 });

    engine.playNewsAlert();
    expect(fake.oscillators).toHaveLength(0);
    await engine.unlock();
    const baselineOscillators = fake.oscillators.length;
    const baselineBuffers = fake.bufferSources.length;

    engine.toggleSfxMuted(true);
    engine.playNewsAlert();
    expect(fake.oscillators).toHaveLength(baselineOscillators);
    engine.toggleSfxMuted(false);

    engine.setVisible(false);
    engine.playNewsAlert();
    expect(fake.oscillators).toHaveLength(baselineOscillators);
    engine.setVisible(true);
    await Promise.resolve();

    engine.playNewsAlert(0.8);
    expect(fake.oscillators.length - baselineOscillators).toBe(3);
    // The news cue is purely tonal: it never spends a noise-buffer voice.
    expect(fake.bufferSources).toHaveLength(baselineBuffers);
    engine.playNewsAlert(1);
    expect(fake.oscillators.length - baselineOscillators).toBe(3);

    (fake.context as unknown as { currentTime: number }).currentTime = 1.5;
    engine.playNewsAlert(1);
    expect(fake.oscillators.length - baselineOscillators).toBe(6);

    for (let index = 0; index < 14; index += 1) engine.playJump('double-jump');
    const saturatedCount = fake.oscillators.length;
    (fake.context as unknown as { currentTime: number }).currentTime = 3;
    engine.playNewsAlert(1);
    expect(fake.oscillators).toHaveLength(saturatedCount);

    const beforeDispose = fake.oscillators.length;
    engine.dispose();
    engine.playNewsAlert();
    expect(fake.oscillators).toHaveLength(beforeDispose);
    vi.useRealTimers();
  });

  it('uses fox proximity to hard-gate market voices independently from camera listening', async () => {
    vi.useFakeTimers();
    const fake = makeFakeContext();
    const engine = new AudioEngine({ contextFactory: () => fake.context, storage: null, random: () => 0.5 });
    engine.setMonumentSources([{
      id: 'grand:BTC',
      symbol: 'BTC',
      position: { x: 0, y: 2, z: 0 },
    }]);
    engine.updateListener({
      position: { x: 0, y: 8, z: 4 },
      forward: { x: 0, y: -0.2, z: -1 },
    });
    engine.updateProximityPosition({ x: 50, y: 0, z: 0 });
    await engine.unlock();
    const baselineOscillators = fake.oscillators.length;
    const baselineBuffers = fake.bufferSources.length;

    engine.playTradePulse('grand:BTC', { direction: 'up', moveRatio: 0.0002 });
    engine.playCandleClose('grand:BTC');
    expect(fake.oscillators).toHaveLength(baselineOscillators);
    expect(fake.bufferSources).toHaveLength(baselineBuffers);

    // Camera stays put: moving only the fox proximity point makes this market audible.
    engine.updateProximityPosition({ x: 0, y: 0, z: 0 });
    engine.playTradePulse('grand:BTC', { direction: 'up', moveRatio: 0.0002 });
    engine.playCandleClose('grand:BTC');
    expect(fake.oscillators.length).toBeGreaterThan(baselineOscillators);
    expect(fake.bufferSources.length).toBeGreaterThan(baselineBuffers);

    engine.dispose();
    vi.useRealTimers();
  });

  it('hard-gates a zero-gain source and keeps HRTF free of second distance rolloff', async () => {
    vi.useFakeTimers();
    const fake = makeFakeContext();
    const engine = new AudioEngine({ contextFactory: () => fake.context, storage: null, random: () => 0.5 });
    engine.setMonumentSources([{
      id: 'muted:BTC',
      symbol: 'BTC',
      position: { x: 0, y: 2, z: 0 },
      gain: 0,
    }, {
      id: 'audible:BTC',
      symbol: 'BTC',
      position: { x: 6, y: 2, z: 0 },
    }]);
    engine.updateProximityPosition({ x: 0, y: 0, z: 0 });
    await engine.unlock();
    const baselineOscillators = fake.oscillators.length;
    const baselineBuffers = fake.bufferSources.length;

    engine.playTradePulse('muted:BTC', {
      direction: 'up',
      moveRatio: MARKET_MOVE_THRESHOLDS.large,
    });
    expect(fake.oscillators).toHaveLength(baselineOscillators);
    engine.playTradePulse('audible:BTC', {
      direction: 'up',
      moveRatio: MARKET_MOVE_THRESHOLDS.large,
    });
    expect(fake.oscillators.length - baselineOscillators).toBe(3);
    expect(fake.bufferSources.length - baselineBuffers).toBe(0);
    const panners = (fake.context.createPanner as unknown as {
      mock: { results: Array<{ value?: PannerNode }> };
    }).mock.results.flatMap((result) => result.value ? [result.value] : []);
    expect(panners.every((panner) => panner.rolloffFactor === 0)).toBe(true);

    engine.dispose();
    vi.useRealTimers();
  });

  it('schedules a deterministic bright piano call and pentatonic response', async () => {
    vi.useFakeTimers();
    const fake = makeFakeContext();
    const engine = new AudioEngine({ contextFactory: () => fake.context, storage: null, random: () => 0 });
    await engine.unlock();

    expect(fake.oscillators).toHaveLength(7);
    vi.advanceTimersByTime(5_000);
    expect(fake.oscillators).toHaveLength(13);
    expect(fake.oscillators[7]?.frequency?.value).toBeCloseTo(293.66);
    expect(fake.oscillators[10]?.frequency?.value).toBeCloseTo(369.99);

    engine.dispose();
    vi.useRealTimers();
  });

  it('plays bounded magical jump and surface landing voices and cleans them up', async () => {
    vi.useFakeTimers();
    const fake = makeFakeContext();
    const engine = new AudioEngine({ contextFactory: () => fake.context, storage: null, random: () => 0.5 });
    await engine.unlock();
    const oscillatorCount = fake.oscillators.length;
    const bufferSourceCount = fake.bufferSources.length;

    engine.playJump('jump');
    engine.playJump('double-jump');
    engine.playLanding('grass', 0.8);

    expect(fake.oscillators.length - oscillatorCount).toBe(5);
    expect(fake.bufferSources.length - bufferSourceCount).toBe(3);
    engine.dispose();
    expect(fake.oscillators.slice(oscillatorCount).every((source) => (
      (source.stop?.mock.calls.length ?? 0) > 0
    ))).toBe(true);
    expect(fake.nodes.slice(1).every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    vi.useRealTimers();
  });

  it('starts every sprint-footstep layer on the rendered contact time', async () => {
    vi.useFakeTimers();
    const fake = makeFakeContext();
    const engine = new AudioEngine({ contextFactory: () => fake.context, storage: null, random: () => 0.5 });
    await engine.unlock();
    const baselineOscillators = fake.oscillators.length;
    const baselineBuffers = fake.bufferSources.length;
    (fake.context as unknown as { currentTime: number }).currentTime = 2.4;

    engine.playFootstep({
      surface: 'stone',
      sprinting: true,
      side: 'right',
      leg: 'hindRight',
      intensity: 0.86,
    });

    const thumps = fake.oscillators.slice(baselineOscillators);
    const transients = fake.bufferSources.slice(baselineBuffers);
    expect(thumps).toHaveLength(1);
    expect(transients).toHaveLength(2);
    expect(thumps[0]?.start).toHaveBeenCalledWith(2.4);
    expect(transients.every((source) => source.start?.mock.calls[0]?.[0] === 2.4)).toBe(true);
    engine.dispose();
    vi.useRealTimers();
  });

  it('makes every one-minute move tier audibly more distinct', async () => {
    vi.useFakeTimers();
    const renderTier = async (moveRatio: number): Promise<{
      oscillators: number;
      buffers: number;
      maximumGain: number;
    }> => {
      const fake = makeFakeContext();
      const engine = new AudioEngine({ contextFactory: () => fake.context, storage: null, random: () => 0.5 });
      engine.setMonumentSources([{
        id: 'grand:BTC',
        symbol: 'BTC',
        position: { x: 0, y: 2, z: 0 },
      }]);
      await engine.unlock();
      const baselineOscillators = fake.oscillators.length;
      const baselineBuffers = fake.bufferSources.length;
      const baselineNodes = fake.nodes.length;
      engine.playTradePulse('grand:BTC', { direction: 'up', moveRatio });
      const gains = fake.nodes.slice(baselineNodes).flatMap((node) => {
        const ramp = node.gain?.exponentialRampToValueAtTime as unknown as
          | ReturnType<typeof vi.fn>
          | undefined;
        return ramp?.mock.calls.map((call: unknown[]) => Number(call[0])) ?? [];
      });
      const result = {
        oscillators: fake.oscillators.length - baselineOscillators,
        buffers: fake.bufferSources.length - baselineBuffers,
        maximumGain: Math.max(0, ...gains),
      };
      engine.dispose();
      return result;
    };

    const small = await renderTier(0.00005);
    const medium = await renderTier(MARKET_MOVE_THRESHOLDS.medium);
    const large = await renderTier(MARKET_MOVE_THRESHOLDS.large);
    const exceptional = await renderTier(MARKET_MOVE_THRESHOLDS.exceptional);

    expect(small).toMatchObject({ oscillators: 3, buffers: 0 });
    expect(medium).toMatchObject({ oscillators: 4, buffers: 0 });
    expect(large).toMatchObject({ oscillators: 3, buffers: 0 });
    expect(exceptional).toMatchObject({ oscillators: 3, buffers: 0 });
    expect(medium.maximumGain).toBeGreaterThan(small.maximumGain);
    expect(large.maximumGain).toBeGreaterThan(medium.maximumGain);
    expect(exceptional.maximumGain).toBeGreaterThan(large.maximumGain);
    vi.useRealTimers();
  });

  it('plays one focused pulse for directional and flat trades', async () => {
    vi.useFakeTimers();
    const fake = makeFakeContext();
    const engine = new AudioEngine({ contextFactory: () => fake.context, storage: null, random: () => 0.5 });
    engine.setMonumentSources([{
      id: 'grand:BTC',
      symbol: 'BTC',
      position: { x: 0, y: 2, z: 0 },
    }]);
    await engine.unlock();
    const baselineOscillators = fake.oscillators.length;

    engine.playTradePulse('grand:BTC', { direction: 'up', moveRatio: 0.00002 });
    (fake.context as unknown as { currentTime: number }).currentTime = 0.4;
    engine.playTradePulse('grand:BTC', { direction: 'flat', moveRatio: 0 });
    (fake.context as unknown as { currentTime: number }).currentTime = 0.8;
    engine.playTradePulse('grand:BTC', { direction: 'down', moveRatio: 0.00002 });

    // Up and down are two-note gestures plus bass; a repeated print is a
    // quieter neutral resonator plus bass rather than silence.
    expect(fake.oscillators.length - baselineOscillators).toBe(8);
    expect(fake.bufferSources).toHaveLength(1); // The looping ambient atmosphere only.
    engine.dispose();
    vi.useRealTimers();
  });

  it('keeps market accents explicit: fanfare only up and siren only down', async () => {
    vi.useFakeTimers();
    const render = async (direction: 'up' | 'down', tier: 'large' | 'exceptional') => {
      const fake = makeFakeContext();
      const engine = new AudioEngine({ contextFactory: () => fake.context, storage: null, random: () => 0.5 });
      engine.setMonumentSources([{
        id: 'grand:BTC',
        symbol: 'BTC',
        position: { x: 0, y: 2, z: 0 },
      }]);
      await engine.unlock();
      const oscillators = fake.oscillators.length;
      const buffers = fake.bufferSources.length;
      engine.playMarketAccent('grand:BTC', {
        direction,
        tier,
        moveRatio: tier === 'exceptional'
          ? MARKET_MOVE_THRESHOLDS.exceptional
          : MARKET_MOVE_THRESHOLDS.large,
      });
      const result = {
        oscillators: fake.oscillators.length - oscillators,
        buffers: fake.bufferSources.length - buffers,
      };
      engine.dispose();
      return result;
    };

    await expect(render('up', 'large')).resolves.toEqual({ oscillators: 4, buffers: 1 });
    await expect(render('up', 'exceptional')).resolves.toEqual({ oscillators: 5, buffers: 1 });
    await expect(render('down', 'large')).resolves.toEqual({ oscillators: 2, buffers: 0 });
    await expect(render('down', 'exceptional')).resolves.toEqual({ oscillators: 4, buffers: 0 });
    vi.useRealTimers();
  });

  it('reserves alert voices so footsteps and ordinary effects cannot suppress a siren', async () => {
    vi.useFakeTimers();
    const fake = makeFakeContext();
    const engine = new AudioEngine({ contextFactory: () => fake.context, storage: null, random: () => 0.5 });
    engine.setMonumentSources([{
      id: 'grand:ETH',
      symbol: 'ETH',
      position: { x: 0, y: 2, z: 0 },
    }]);
    await engine.unlock();

    for (let index = 0; index < 30; index += 1) engine.playJump('double-jump');
    const scheduled = (engine as unknown as {
      scheduledSources: Set<AudioScheduledSourceNode>;
    }).scheduledSources;
    expect(scheduled.size).toBe(36);
    const baselineOscillators = fake.oscillators.length;
    engine.playMarketAccent('grand:ETH', {
      direction: 'down',
      tier: 'exceptional',
      moveRatio: MARKET_MOVE_THRESHOLDS.exceptional,
    });
    expect(fake.oscillators.length - baselineOscillators).toBe(4);
    expect(scheduled.size).toBe(40);

    engine.toggleSfxMuted(true);
    engine.playMarketAccent('grand:ETH', {
      direction: 'down',
      tier: 'exceptional',
      moveRatio: MARKET_MOVE_THRESHOLDS.exceptional,
    });
    expect(fake.oscillators.length - baselineOscillators).toBe(4);
    engine.dispose();
    vi.useRealTimers();
  });

  it('keeps one ambient graph through repeated unlock and visibility cycles', async () => {
    vi.useFakeTimers();
    const fake = makeFakeContext();
    const contextFactory = vi.fn(() => fake.context);
    const engine = new AudioEngine({ contextFactory, storage: null, random: () => 0.5 });
    engine.setEnvironment({ nightFactor: 0.75 });

    await expect(engine.unlock()).resolves.toBe(true);
    const nodeCount = fake.nodes.length;
    const oscillatorCount = fake.oscillators.length;
    expect(fake.bufferSources).toHaveLength(1);
    expect(fake.bufferSources[0]?.loop).toBe(true);

    await expect(engine.unlock()).resolves.toBe(true);
    engine.setVisible(false);
    await Promise.resolve();
    engine.setVisible(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(contextFactory).toHaveBeenCalledTimes(1);
    expect(fake.nodes).toHaveLength(nodeCount);
    expect(fake.oscillators).toHaveLength(oscillatorCount);
    expect(fake.bufferSources).toHaveLength(1);

    engine.dispose();
    await Promise.resolve();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.nodes.slice(1).every((node) => (
      node.disconnect.mock.calls.length > 0
    ))).toBe(true);
    vi.useRealTimers();
  });
});
