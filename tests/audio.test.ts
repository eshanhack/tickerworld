import { describe, expect, it, vi } from 'vitest';
import { ASSET_AUDIO_PROFILES, AudioEngine, normaliseMoveIntensity } from '../src/audio';

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
});
