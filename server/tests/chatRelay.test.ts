import {
  CHAT_HISTORY_LIMIT,
  CHAT_PROXIMITY_RADIUS,
  type ChatMessage,
  type MarketSlug,
} from '@tickerworld/shared';
import { describe, expect, it } from 'vitest';
import { ChatRelay } from '../src/services/chatRelay.js';

interface TestParticipant {
  actorId: string;
  ipHash: string;
  x: number;
  z: number;
  received: ChatMessage[];
}

function participant(actorId: string, x: number, z: number): TestParticipant {
  return { actorId, ipHash: `ip-${actorId}`, x, z, received: [] };
}

function register(
  relay: ChatRelay,
  roomId: string,
  market: MarketSlug,
  players: readonly TestParticipant[],
): void {
  relay.register(roomId, market, () => players.map((player) => ({
    actorId: player.actorId,
    ipHash: player.ipHash,
    x: player.x,
    z: player.z,
    send: (message: ChatMessage) => player.received.push(message),
  })));
}

function message(
  id: string,
  scope: ChatMessage['scope'],
  actorId = 'sender',
  sentAt = 1,
): ChatMessage {
  return {
    id,
    scope,
    actorId,
    username: null,
    animal: 'fox',
    text: id,
    sentAt,
  };
}

describe('process-wide chat relay', () => {
  it('broadcasts world chat across same-market channels, echoes the sender, and isolates markets', () => {
    const relay = new ChatRelay();
    const sender = participant('sender', 0, 0);
    const otherChannel = participant('other-channel', 60, 60);
    const otherMarket = participant('other-market', 0, 0);
    register(relay, 'btc-channel-1', 'btc', [sender]);
    register(relay, 'btc-channel-2', 'btc', [otherChannel]);
    register(relay, 'eth-channel-1', 'eth', [otherMarket]);

    const entry = message('world-message', 'world');
    relay.publish(entry, {
      roomId: 'btc-channel-1',
      market: 'btc',
      actorId: sender.actorId,
      x: sender.x,
      z: sender.z,
    });

    expect(sender.received).toEqual([entry]);
    expect(otherChannel.received).toEqual([entry]);
    expect(otherMarket.received).toEqual([]);
  });

  it('delivers proximity chat only inside 22 units in the sender channel, including sender echo', () => {
    const relay = new ChatRelay();
    const sender = participant('sender', 4, -3);
    const nearby = participant('nearby', 4 + CHAT_PROXIMITY_RADIUS, -3);
    const far = participant('far', 4 + CHAT_PROXIMITY_RADIUS + 0.01, -3);
    const otherChannel = participant('other-channel', 4, -3);
    register(relay, 'btc-channel-1', 'btc', [sender, nearby, far]);
    register(relay, 'btc-channel-2', 'btc', [otherChannel]);

    const entry = message('nearby-message', 'proximity');
    relay.publish(entry, {
      roomId: 'btc-channel-1',
      market: 'btc',
      actorId: sender.actorId,
      x: sender.x,
      z: sender.z,
    });

    expect(sender.received).toEqual([entry]);
    expect(nearby.received).toEqual([entry]);
    expect(far.received).toEqual([]);
    expect(otherChannel.received).toEqual([]);
  });

  it('keeps bounded histories and filters historical proximity messages by join position', () => {
    const relay = new ChatRelay();
    register(relay, 'btc-channel-1', 'btc', []);
    for (let index = 0; index < CHAT_HISTORY_LIMIT + 5; index += 1) {
      relay.publish(message(`world-${index}`, 'world', 'sender', index), {
        roomId: 'btc-channel-1',
        market: 'btc',
        actorId: 'sender',
        x: 0,
        z: 0,
      });
    }
    const nearbyEntry = message('proximity-near', 'proximity', 'sender', 100);
    relay.publish(nearbyEntry, {
      roomId: 'btc-channel-1',
      market: 'btc',
      actorId: 'sender',
      x: 10,
      z: 10,
    });

    const nearbyHistory = relay.historyForJoin('btc-channel-1', 'btc', { x: 10, z: 10 });
    const farHistory = relay.historyForJoin('btc-channel-1', 'btc', { x: -40, z: -40 });
    expect(nearbyHistory).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(nearbyHistory.at(-1)).toEqual(nearbyEntry);
    expect(farHistory).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(farHistory.some(({ id }) => id === nearbyEntry.id)).toBe(false);
    expect(farHistory[0]?.id).toBe('world-5');
  });

  it('resolves a canonical cross-channel report target with server-owned evidence', () => {
    const relay = new ChatRelay();
    const reporter = participant('reporter', 0, 0);
    const target = participant('target', 0, 0);
    register(relay, 'btc-channel-1', 'btc', [reporter]);
    register(relay, 'btc-channel-2', 'btc', [target]);

    const worldEntry = message('reported-world-message', 'world', target.actorId, 1);
    relay.publish(worldEntry, {
      roomId: 'btc-channel-2',
      market: 'btc',
      actorId: target.actorId,
      x: target.x,
      z: target.z,
    });
    const proximityEntry = message('reported-proximity-message', 'proximity', target.actorId, 2);
    relay.publish(proximityEntry, {
      roomId: 'btc-channel-2',
      market: 'btc',
      actorId: target.actorId,
      x: target.x,
      z: target.z,
    });

    expect(relay.reportContext('btc', target.actorId)).toEqual({
      ipHash: target.ipHash,
      evidence: [worldEntry, proximityEntry],
    });
    expect(relay.reportContext('eth', target.actorId)).toBeNull();
  });
});
