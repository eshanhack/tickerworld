import { MARKET_ROOM_MAX_CLIENTS, type MarketSlug } from '@tickerworld/shared';
import { randomToken } from './crypto.js';
import { SlidingWindowRateLimiter } from './rateLimits.js';

export type AdmissionRejectionCode =
  | 'actor_already_connected'
  | 'join_rate_limited'
  | 'ip_capacity'
  | 'process_capacity'
  | 'market_capacity'
  | 'invalid_reservation';

export class AdmissionError extends Error {
  constructor(public readonly code: AdmissionRejectionCode) {
    super(code);
    this.name = 'AdmissionError';
  }
}

interface Reservation {
  id: string;
  actorId: string;
  ipHash: string;
  market: MarketSlug;
  expiresAt: number;
}

interface ActiveConnection {
  actorId: string;
  market: MarketSlug;
  connectionKey: string;
  ipHash: string;
}

export interface AdmissionLimits {
  maxProcessConnections: number;
  maxRooms: number;
  maxMarketShards: number;
  maxConcurrentConnectionsPerIp: number;
  actorJoinsPerMinute: number;
  ipJoinsPerMinute: number;
}

/** Enforces launch-scale, single-process admission invariants before matchmaking. */
export class AdmissionControl {
  private readonly limiter = new SlidingWindowRateLimiter();
  private readonly reservations = new Map<string, Reservation>();
  private readonly reservationByActor = new Map<string, string>();
  private readonly activeByActor = new Map<string, ActiveConnection>();
  private readonly actorByConnection = new Map<string, string>();
  private readonly rooms = new Map<string, MarketSlug>();

  constructor(private readonly limits: AdmissionLimits, private readonly reservationTtlMs = 15_000) {}

  reserve(actorId: string, ipHash: string, market: MarketSlug, now = Date.now()): string {
    this.cleanup(now);
    if (this.activeByActor.has(actorId)) throw new AdmissionError('actor_already_connected');
    const pendingId = this.reservationByActor.get(actorId);
    const pending = pendingId ? this.reservations.get(pendingId) : undefined;
    if (pending) {
      throw new AdmissionError('actor_already_connected');
    }
    if (this.activeByActor.size + this.reservations.size >= this.limits.maxProcessConnections) {
      throw new AdmissionError('process_capacity');
    }
    const ipConnections = [...this.activeByActor.values(), ...this.reservations.values()]
      .filter((entry) => entry.ipHash === ipHash).length;
    if (ipConnections >= this.limits.maxConcurrentConnectionsPerIp) {
      throw new AdmissionError('ip_capacity');
    }
    const actorRate = this.limiter.consume(
      'join-actor', actorId, this.limits.actorJoinsPerMinute, 60_000, now,
    );
    const ipRate = this.limiter.consume(
      'join-ip', ipHash, this.limits.ipJoinsPerMinute, 60_000, now,
    );
    if (!actorRate.allowed || !ipRate.allowed) throw new AdmissionError('join_rate_limited');

    const marketConnections = [...this.activeByActor.values(), ...this.reservations.values()]
      .filter((entry) => entry.market === market).length;
    const marketRooms = [...this.rooms.values()].filter((entry) => entry === market).length;
    const existingCapacity = marketRooms * MARKET_ROOM_MAX_CLIENTS;
    if (marketConnections >= existingCapacity
      && (marketRooms >= this.limits.maxMarketShards || this.rooms.size >= this.limits.maxRooms)) {
      throw new AdmissionError(marketRooms >= this.limits.maxMarketShards
        ? 'market_capacity'
        : 'process_capacity');
    }

    const id = randomToken(18);
    const reservation = { id, actorId, ipHash, market, expiresAt: now + this.reservationTtlMs };
    this.reservations.set(id, reservation);
    this.reservationByActor.set(actorId, id);
    return id;
  }

  activate(reservationId: string, actorId: string, market: MarketSlug, connectionKey: string, now = Date.now()): void {
    this.cleanup(now);
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.actorId !== actorId || reservation.market !== market) {
      throw new AdmissionError('invalid_reservation');
    }
    const active = this.activeByActor.get(actorId);
    if (active && active.connectionKey !== connectionKey) throw new AdmissionError('actor_already_connected');
    this.reservations.delete(reservation.id);
    this.reservationByActor.delete(actorId);
    this.activeByActor.set(actorId, { actorId, market, connectionKey, ipHash: reservation.ipHash });
    this.actorByConnection.set(connectionKey, actorId);
  }

  releaseConnection(connectionKey: string): void {
    const actorId = this.actorByConnection.get(connectionKey);
    if (!actorId) return;
    this.actorByConnection.delete(connectionKey);
    const active = this.activeByActor.get(actorId);
    if (active?.connectionKey === connectionKey) this.activeByActor.delete(actorId);
  }

  registerRoom(roomId: string, market: MarketSlug): void {
    if (this.rooms.has(roomId)) return;
    const shards = [...this.rooms.values()].filter((entry) => entry === market).length;
    if (this.rooms.size >= this.limits.maxRooms) throw new AdmissionError('process_capacity');
    if (shards >= this.limits.maxMarketShards) throw new AdmissionError('market_capacity');
    this.rooms.set(roomId, market);
  }

  unregisterRoom(roomId: string): void {
    this.rooms.delete(roomId);
    for (const connectionKey of [...this.actorByConnection.keys()]) {
      if (connectionKey.startsWith(`${roomId}:`)) this.releaseConnection(connectionKey);
    }
  }

  snapshot(): { activeConnections: number; reservations: number; rooms: number } {
    return {
      activeConnections: this.activeByActor.size,
      reservations: this.reservations.size,
      rooms: this.rooms.size,
    };
  }

  clear(): void {
    this.reservations.clear();
    this.reservationByActor.clear();
    this.activeByActor.clear();
    this.actorByConnection.clear();
    this.rooms.clear();
    this.limiter.clear();
  }

  private cleanup(now: number): void {
    for (const [id, reservation] of this.reservations) {
      if (reservation.expiresAt > now) continue;
      this.reservations.delete(id);
      if (this.reservationByActor.get(reservation.actorId) === id) {
        this.reservationByActor.delete(reservation.actorId);
      }
    }
  }
}
