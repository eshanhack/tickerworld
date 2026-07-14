import {
  CHAT_HISTORY_LIMIT,
  CHAT_PROXIMITY_RADIUS,
  type ChatMessage,
  type MarketSlug,
} from '@tickerworld/shared';

interface ChatParticipant {
  actorId: string;
  /** HMAC-derived identifier used only for canonical moderation records. */
  ipHash: string;
  x: number;
  z: number;
  send: (message: ChatMessage) => void;
}

interface ChatRoomEndpoint {
  market: MarketSlug;
  participants: () => readonly ChatParticipant[];
}

interface PositionedChatMessage {
  message: ChatMessage;
  x: number;
  z: number;
}

export interface ChatOrigin {
  roomId: string;
  market: MarketSlug;
  actorId: string;
  x: number;
  z: number;
}

export interface ChatReportContext {
  ipHash: string;
  evidence: readonly ChatMessage[];
}

/**
 * Process-local chat routing for the initial single-process deployment.
 * World messages fan out to every shard of one market. Proximity messages
 * remain inside their originating shard and are selected from canonical
 * server positions, never coordinates supplied with the chat payload.
 */
export class ChatRelay {
  private readonly rooms = new Map<string, ChatRoomEndpoint>();
  private readonly worldHistory = new Map<MarketSlug, ChatMessage[]>();
  private readonly proximityHistory = new Map<string, PositionedChatMessage[]>();

  register(
    roomId: string,
    market: MarketSlug,
    participants: () => readonly ChatParticipant[],
  ): void {
    this.rooms.set(roomId, { market, participants });
  }

  unregister(roomId: string): void {
    this.rooms.delete(roomId);
    this.proximityHistory.delete(roomId);
  }

  publish(message: ChatMessage, origin: ChatOrigin): void {
    const sourceRoom = this.rooms.get(origin.roomId);
    if (!sourceRoom || sourceRoom.market !== origin.market) return;

    if (message.scope === 'proximity') {
      this.rememberProximity(origin.roomId, { message, x: origin.x, z: origin.z });
      this.deliverProximity(sourceRoom, message, origin);
      return;
    }

    this.rememberWorld(origin.market, message);
    for (const room of this.rooms.values()) {
      if (room.market !== origin.market) continue;
      for (const participant of room.participants()) participant.send(message);
    }
  }

  historyForJoin(
    roomId: string,
    market: MarketSlug,
    position: { x: number; z: number },
  ): readonly ChatMessage[] {
    const messages = [...(this.worldHistory.get(market) ?? [])];
    for (const entry of this.proximityHistory.get(roomId) ?? []) {
      if (distance(position, entry) <= CHAT_PROXIMITY_RADIUS) messages.push(entry.message);
    }
    messages.sort((first, second) => first.sentAt - second.sentAt);
    return messages.slice(-CHAT_HISTORY_LIMIT);
  }

  recentForRoom(roomId: string, market: MarketSlug): readonly ChatMessage[] {
    const messages = [
      ...(this.worldHistory.get(market) ?? []),
      ...(this.proximityHistory.get(roomId) ?? []).map(({ message }) => message),
    ];
    messages.sort((first, second) => first.sentAt - second.sentAt);
    return messages.slice(-CHAT_HISTORY_LIMIT);
  }

  /**
   * Resolve an active actor anywhere in the market and assemble evidence from
   * server-owned histories. This lets a world-chat recipient report a sender
   * in another channel without accepting identity or evidence from the client.
   */
  reportContext(market: MarketSlug, actorId: string): ChatReportContext | null {
    let ipHash: string | null = null;
    const messages = [...(this.worldHistory.get(market) ?? [])]
      .filter((message) => message.actorId === actorId);
    for (const [roomId, room] of this.rooms) {
      if (room.market !== market) continue;
      const participant = room.participants().find((candidate) => candidate.actorId === actorId);
      if (participant) ipHash = participant.ipHash;
      for (const entry of this.proximityHistory.get(roomId) ?? []) {
        if (entry.message.actorId === actorId) messages.push(entry.message);
      }
    }
    if (!ipHash) return null;
    messages.sort((first, second) => first.sentAt - second.sentAt);
    return { ipHash, evidence: messages.slice(-CHAT_HISTORY_LIMIT) };
  }

  clear(): void {
    this.rooms.clear();
    this.worldHistory.clear();
    this.proximityHistory.clear();
  }

  private deliverProximity(
    room: ChatRoomEndpoint,
    message: ChatMessage,
    origin: ChatOrigin,
  ): void {
    for (const participant of room.participants()) {
      const isSender = participant.actorId === origin.actorId;
      if (isSender || distance(participant, origin) <= CHAT_PROXIMITY_RADIUS) {
        participant.send(message);
      }
    }
  }

  private rememberWorld(market: MarketSlug, message: ChatMessage): void {
    const history = this.worldHistory.get(market) ?? [];
    history.push(message);
    if (history.length > CHAT_HISTORY_LIMIT) history.shift();
    this.worldHistory.set(market, history);
  }

  private rememberProximity(roomId: string, entry: PositionedChatMessage): void {
    const history = this.proximityHistory.get(roomId) ?? [];
    history.push(entry);
    if (history.length > CHAT_HISTORY_LIMIT) history.shift();
    this.proximityHistory.set(roomId, history);
  }
}

function distance(
  first: { x: number; z: number },
  second: { x: number; z: number },
): number {
  return Math.hypot(first.x - second.x, first.z - second.z);
}
