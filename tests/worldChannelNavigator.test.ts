import { describe, expect, it } from 'vitest';
import {
  normalizeWorldChannels,
  populationBadgeLabels,
  worldGridNavigationIndex,
  worldPopulationLabel,
  type WorldPopulationSnapshot,
} from '../src/portals';

describe('world and channel navigator model', () => {
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
    })).toBe('73 ONLINE');
    expect(worldPopulationLabel({
      symbol: 'ETH', online: null, shards: 0, connection: 'offline',
    })).toBe('SOLO');
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
      worldOnline: 45,
      world: 'BTC',
      connection: 'online',
      usernames: ['MossyRabbit', 'TinyFrog', 'MossyRabbit', '  CloudCat  ', ''],
    });
    expect(labels).toEqual({
      total: '128 TOTAL ONLINE',
      world: '45 IN BTC',
      roster: ['MossyRabbit', 'TinyFrog', 'CloudCat'],
      overflow: 0,
    });
  });

  it('uses explicit solo copy rather than implying unavailable multiplayer counts', () => {
    expect(populationBadgeLabels({
      totalOnline: null,
      worldOnline: null,
      world: 'SHFL',
      connection: 'offline',
      usernames: [],
    })).toMatchObject({ total: 'SOLO MODE', world: '— IN SHFL' });
  });
});
