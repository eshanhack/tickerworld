import {
  MARKET_ROOM_MAX_CLIENTS,
  MARKET_SLUGS,
  type MarketSlug,
  type RoomChannelPopulation,
  type RoomPopulation,
} from '@tickerworld/shared';

interface RoomEntry {
  market: MarketSlug;
  channel: number;
  clients: number;
  publish: (populations: readonly RoomPopulation[]) => void;
}

export class PopulationDirectory {
  private readonly rooms = new Map<string, RoomEntry>();
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPublishedAt = Number.NEGATIVE_INFINITY;
  private readonly publishIntervalMs = 500;

  register(
    roomId: string,
    market: MarketSlug,
    publish: (populations: readonly RoomPopulation[]) => void,
  ): void {
    const occupiedChannels = new Set(
      [...this.rooms.values()]
        .filter((room) => room.market === market)
        .map((room) => room.channel),
    );
    let channel = 1;
    while (occupiedChannels.has(channel)) channel += 1;
    this.rooms.set(roomId, { market, channel, clients: 0, publish });
    this.queuePublish();
  }

  update(roomId: string, clients: number): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.clients = Math.max(0, clients);
    this.queuePublish();
  }

  unregister(roomId: string): void {
    this.rooms.delete(roomId);
    this.queuePublish();
  }

  snapshot(now = Date.now()): readonly RoomPopulation[] {
    return MARKET_SLUGS.map((market) => {
      let online = 0;
      const channels: RoomChannelPopulation[] = [];
      for (const [roomId, room] of this.rooms) {
        if (room.market !== market) continue;
        online += room.clients;
        channels.push({
          roomId,
          channel: room.channel,
          online: room.clients,
          capacity: MARKET_ROOM_MAX_CLIENTS,
        });
      }
      channels.sort((first, second) => first.channel - second.channel);
      return { market, online, shards: channels.length, channels, updatedAt: now };
    });
  }

  room(roomId: string): { market: MarketSlug; channel: number; clients: number } | null {
    const entry = this.rooms.get(roomId);
    return entry ? { market: entry.market, channel: entry.channel, clients: entry.clients } : null;
  }

  clear(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.rooms.clear();
  }

  private queuePublish(now = Date.now()): void {
    const delay = this.publishIntervalMs - (now - this.lastPublishedAt);
    if (delay <= 0) {
      this.publish(now);
      return;
    }
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publish();
    }, delay);
    this.publishTimer.unref?.();
  }

  private publish(now = Date.now()): void {
    this.lastPublishedAt = now;
    const snapshot = this.snapshot(now);
    for (const room of [...this.rooms.values()]) room.publish(snapshot);
  }
}
