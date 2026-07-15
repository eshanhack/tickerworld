import { describe, expect, it } from 'vitest';
import { ASSET_SYMBOLS } from '../src/types';
import {
  normalizeWorldChannels,
  populationBadgeLabels,
  worldGridNavigationIndex,
  worldPopulationLabel,
  type WorldPopulationSnapshot,
} from '../src/portals';

describe('world and channel navigator model', () => {
  it('keeps every registered world reachable and population-labelled', () => {
    const visited = new Set<number>();
    let index = 0;
    for (let step = 0; step < ASSET_SYMBOLS.length; step += 1) {
      visited.add(index);
      index = worldGridNavigationIndex(index, 'ArrowRight', ASSET_SYMBOLS.length, 4);
    }
    expect(visited).toEqual(new Set(ASSET_SYMBOLS.map((_symbol, itemIndex) => itemIndex)));
    expect(index).toBe(0);

    for (const symbol of ASSET_SYMBOLS) {
      const population = { symbol, online: 1, shards: 1, connection: 'online' as const };
      expect(worldPopulationLabel(population)).toBe('1 / 50 PEOPLE INSIDE');
      expect(populationBadgeLabels({
        totalOnline: ASSET_SYMBOLS.length,
        worldOnline: 1,
        world: symbol,
        connection: 'online',
        usernames: [],
      }).world).toBe(`1 / 50 IN ${symbol}`);
    }
  });

  it('navigates all four directions and skips nonexistent cells in the short final row', () => {
    expect(worldGridNavigationIndex(0, 'ArrowLeft', 13, 4)).toBe(12);
    expect(worldGridNavigationIndex(12, 'ArrowRight', 13, 4)).toBe(0);
    expect(worldGridNavigationIndex(1, 'ArrowDown', 13, 4)).toBe(5);
    expect(worldGridNavigationIndex(1, 'ArrowUp', 13, 4)).toBe(9);
    expect(worldGridNavigationIndex(12, 'ArrowDown', 13, 4)).toBe(0);
    expect(worldGridNavigationIndex(0, 'ArrowUp', 13, 4)).toBe(12);
  });

  it('preserves exact server channels, rejects impossible rows, and never invents shard counts', () => {
    const population: WorldPopulationSnapshot = {
      symbol: 'BTC',
      online: 63,
      shards: 2,
      connection: 'online',
      channels: [
        { id: 'room-a', label: 'Channel 1', online: 44, capacity: 50, state: 'busy' },
        { id: 'room-b', label: 'Channel 2', online: 19, capacity: 50, state: 'available' },
        { id: 'room-b', label: 'Duplicate', online: 19, capacity: 50, state: 'available' },
        { id: 'invalid', label: 'Impossible', online: 51, capacity: 50, state: 'full' },
      ],
    };
    expect(normalizeWorldChannels(population)).toEqual([
      { id: 'room-a', label: 'Channel 1', online: 44, capacity: 50, state: 'busy' },
      { id: 'room-b', label: 'Channel 2', online: 19, capacity: 50, state: 'available' },
    ]);
  });

  it('falls back to one truthful auto-match row when only aggregate population is available', () => {
    expect(normalizeWorldChannels({
      symbol: 'ETH', online: 73, shards: 2, connection: 'online',
    })).toEqual([{
      id: null,
      label: 'Best of 2 channels',
      online: 73,
      capacity: 100,
      state: 'available',
    }]);
    expect(worldPopulationLabel({
      symbol: 'ETH', online: 73, shards: 2, connection: 'online',
    })).toBe('73 / 100 PEOPLE INSIDE');
    expect(worldPopulationLabel({
      symbol: 'ETH', online: 73, shards: null, connection: 'online',
    })).toBe('73 / 100 PEOPLE INSIDE');
    expect(worldPopulationLabel({
      symbol: 'ETH', online: null, shards: 0, connection: 'offline',
    })).toBe('— / 50 PEOPLE INSIDE');
  });

  it('offers overflow matchmaking when every advertised channel is full', () => {
    const channels = normalizeWorldChannels({
      symbol: 'BTC',
      online: 100,
      shards: 2,
      connection: 'online',
      channels: [
        { id: 'room-a', label: 'Channel 1', online: 50, capacity: 50, state: 'full' },
        { id: 'room-b', label: 'Channel 2', online: 50, capacity: 50, state: 'full' },
      ],
    });
    expect(channels.at(-1)).toMatchObject({
      id: null,
      label: 'Open a new channel',
      state: 'available',
    });
  });
});

describe('online population badge model', () => {
  it('shows total and current-world counts with a de-duplicated public roster', () => {
    const labels = populationBadgeLabels({
      totalOnline: 128,
      totalCapacity: 400,
      worldOnline: 45,
      worldCapacity: 100,
      world: 'BTC',
      connection: 'online',
      usernames: ['MossyRabbit', 'TinyFrog', 'MossyRabbit', '  CloudCat  ', ''],
    });
    expect(labels).toEqual({
      total: '128 / 400 ONLINE',
      world: '45 / 100 IN BTC',
      roster: ['MossyRabbit', 'TinyFrog', 'CloudCat'],
      overflow: 0,
    });
  });

  it('keeps unknown multiplayer counts neutral while reconnecting', () => {
    expect(populationBadgeLabels({
      totalOnline: null,
      worldOnline: null,
      world: 'SHFL',
      connection: 'offline',
      usernames: [],
    })).toMatchObject({ total: '— / 400 ONLINE', world: '— / 50 IN SHFL' });
  });
});
