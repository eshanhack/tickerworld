import { describe, expect, it, vi } from 'vitest';
import {
  AMBIENT_KEY_DELAY_RANGE_SECONDS,
  AMBIENT_PAD_DELAY_RANGE_SECONDS,
  AMBIENT_PAD_VOICINGS,
  ASSET_AUDIO_PROFILES,
  AudioEngine,
  delayInRange,
  EMPTY_COLORED_NOISE_STATE,
  marketGestureFrequencies,
  nextColoredNoiseSample,
  normaliseMoveIntensity,
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

  it('reports unavailable cleanly when Web Audio is missing', async () => {
    const engine = new AudioEngine({ storage: null });
    expect(engine.state.status).toBe('unavailable');
    await expect(engine.unlock()).resolves.toBe(false);
    engine.dispose();
    expect(engine.state.status).toBe('disposed');
  });
});

describe('audio mapping', () => {
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
  it('uses the locked sparse timing ranges', () => {
    expect(delayInRange(0, AMBIENT_KEY_DELAY_RANGE_SECONDS)).toBe(9);
    expect(delayInRange(1, AMBIENT_KEY_DELAY_RANGE_SECONDS)).toBe(17);
    expect(delayInRange(0.5, AMBIENT_PAD_DELAY_RANGE_SECONDS)).toBe(23);
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
