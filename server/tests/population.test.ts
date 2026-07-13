import { describe, expect, it, vi } from 'vitest';
import { PopulationDirectory } from '../src/rooms/PopulationDirectory.js';
import { MarketRoom } from '../src/rooms/MarketRoom.js';

describe('market population directory', () => {
  it('locks each overflow shard to 50 clients and 100ms patches', () => {
    const room = new MarketRoom();
    expect(room.maxClients).toBe(50);
    expect(room.patchRate).toBe(100);
    expect(room.autoDispose).toBe(true);
  });

  it('aggregates overflow shards by market and publishes changes', () => {
    const directory = new PopulationDirectory();
    const publish = vi.fn();
    directory.register('btc-1', 'btc', publish);
    directory.register('btc-2', 'btc', publish);
    directory.register('eth-1', 'eth', publish);
    directory.update('btc-1', 50);
    directory.update('btc-2', 25);
    directory.update('eth-1', 7);
    expect(directory.snapshot().find((entry) => entry.market === 'btc')).toMatchObject({
      online: 75,
      shards: 2,
      channels: [
        { roomId: 'btc-1', channel: 1, online: 50, capacity: 50 },
        { roomId: 'btc-2', channel: 2, online: 25, capacity: 50 },
      ],
    });
    expect(directory.snapshot().find((entry) => entry.market === 'eth')).toMatchObject({ online: 7, shards: 1 });
    expect(publish).toHaveBeenCalled();
    directory.unregister('btc-2');
    expect(directory.snapshot().find((entry) => entry.market === 'btc')).toMatchObject({ online: 50, shards: 1 });

    // Empty channel numbers are reused without renumbering live channels.
    directory.register('btc-3', 'btc', publish);
    expect(directory.snapshot().find((entry) => entry.market === 'btc')?.channels).toEqual([
      { roomId: 'btc-1', channel: 1, online: 50, capacity: 50 },
      { roomId: 'btc-3', channel: 2, online: 0, capacity: 50 },
    ]);
  });
});
