import { describe, expect, it } from 'vitest';
import { MarketCelebrationGate } from '../src/markets';

describe('MarketCelebrationGate', () => {
  it('fires at one-minute large and exceptional thresholds', () => {
    const gate = new MarketCelebrationGate();

    expect(gate.evaluate('BTC', 'up', 0.00034, 1)).toBeNull();
    expect(gate.evaluate('BTC', 'up', 0.00035, 2)).toMatchObject({
      symbol: 'BTC',
      direction: 'up',
      tier: 'large',
    });
    expect(gate.evaluate('BTC', 'up', 0.001, 2.4)).toMatchObject({ tier: 'exceptional' });
  });

  it('does not repeat every presentation tick while a move remains large', () => {
    const gate = new MarketCelebrationGate();
    expect(gate.evaluate('ETH', 'down', 0.0005, 10)).not.toBeNull();
    expect(gate.evaluate('ETH', 'down', 0.00052, 10.4)).toBeNull();
    expect(gate.evaluate('ETH', 'down', 0.00054, 12)).toBeNull();
    expect(gate.evaluate('ETH', 'down', 0.0008, 12.01)?.tier).toBe('large');
  });

  it('rearms after calm movement and allows a later celebration', () => {
    const gate = new MarketCelebrationGate();
    expect(gate.evaluate('SOL', 'up', 0.0004, 3)).not.toBeNull();
    expect(gate.evaluate('SOL', 'up', 0.00001, 3.4)).toBeNull();
    expect(gate.evaluate('SOL', 'up', 0.00042, 3.7)).toMatchObject({ tier: 'large' });
  });

  it('observes distant calm updates without consuming a distant large move', () => {
    const gate = new MarketCelebrationGate();
    expect(gate.evaluate('LINK', 'up', 0.0005, 5)).not.toBeNull();
    gate.observe('LINK', 0.00001);
    expect(gate.evaluate('LINK', 'up', 0.00052, 5.7)).not.toBeNull();

    const fresh = new MarketCelebrationGate();
    fresh.observe('AVAX', 0.0012);
    expect(fresh.evaluate('AVAX', 'down', 0.0012, 8)).toMatchObject({
      direction: 'down',
      tier: 'exceptional',
    });
  });

  it('uses a short global guard so simultaneous feeds do not create a flash wall', () => {
    const gate = new MarketCelebrationGate();
    expect(gate.evaluate('BTC', 'up', 0.0005, 20)).not.toBeNull();
    expect(gate.evaluate('ETH', 'down', 0.0005, 20.1)).toBeNull();
    expect(gate.evaluate('ETH', 'down', 0.0005, 20.23)).not.toBeNull();
  });
});
