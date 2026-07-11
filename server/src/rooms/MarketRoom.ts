import {
  CHAT_HISTORY_LIMIT,
  CLIENT_MESSAGES,
  MARKET_ROOM_MAX_CLIENTS,
  PROTOCOL_VERSION,
  SERVER_MESSAGES,
  STATE_PATCH_RATE_MS,
  allocateSpawnAssignment,
  isActorId,
  isAnimalKind,
  isMarketSlug,
  isModerationReason,
  isSkinId,
  normalizeYaw,
  type ChatMessage,
  type EntitlementSku,
  type IdentityRefreshMessage,
  type JoinOptions,
  type MarketSlug,
  type MoveSnapshot,
  type ReportSendMessage,
} from '@tickerworld/shared';
import { CloseCode, Room, validate, type AuthContext, type Client } from '@colyseus/core';
import { z } from 'zod';
import { createId } from '../services/crypto.js';
import { websocketOrigin, websocketPeer } from '../services/canonicalIp.js';
import { validateMove, type MoveTracker } from './MoveValidator.js';
import { MarketRoomState, PlayerState } from './schema.js';
import {
  getRoomServices,
  isAllowedRoomOrigin,
  resolveRoomIdentity,
  resolveRoomIdentityWithIpHash,
  type RoomIdentity,
} from './roomServices.js';

interface RoomAuthData extends RoomIdentity {
  ipHash: string;
  admissionReservationId: string;
}

interface MarketClientData extends Omit<RoomIdentity, 'entitlements'> {
  ipHash: string;
  entitlements: ReadonlySet<EntitlementSku>;
  move: MoveTracker;
  lastReportAt: number;
  spawnSlot: number;
}

type MarketClient = Client<{ auth: RoomAuthData; userData: MarketClientData }>;

const moveSchema = z.object({
  protocolVersion: z.number().int(),
  sequence: z.number().int().nonnegative(),
  sentAt: z.number().finite(),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  yaw: z.number().finite(),
  speed: z.number().finite(),
  verticalSpeed: z.number().finite(),
  grounded: z.boolean(),
  gait: z.enum(['idle', 'walk', 'run', 'air', 'glide']),
});

const chatSchema = z.object({
  protocolVersion: z.number().int(),
  text: z.string().max(560),
});

const appearanceSchema = z.object({
  protocolVersion: z.number().int(),
  animal: z.string(),
  skin: z.string(),
});

const reportSchema = z.object({
  protocolVersion: z.number().int(),
  targetActorId: z.string().min(1).max(64),
  reason: z.string(),
  note: z.string().max(280).optional(),
});

const identityRefreshSchema = z.object({
  protocolVersion: z.number().int(),
  sessionToken: z.string().min(20).max(1_024).optional(),
  anonymousToken: z.string().min(40).max(1_024).optional(),
});

export class MarketRoom extends Room<{ state: MarketRoomState; client: MarketClient }> {
  override maxClients = MARKET_ROOM_MAX_CLIENTS;
  override patchRate = STATE_PATCH_RATE_MS;
  override autoDispose = true;
  override state = new MarketRoomState();
  private market: MarketSlug = 'btc';
  private readonly chatHistory: ChatMessage[] = [];
  private readonly occupiedSpawnSlots = new Set<number>();

  override messages = {
    [CLIENT_MESSAGES.move]: validate(moveSchema, (client, message) => {
      this.handleMove(client, message as MoveSnapshot);
    }),
    [CLIENT_MESSAGES.chat]: validate(chatSchema, (client, message) => {
      this.handleChat(client, message);
    }),
    [CLIENT_MESSAGES.appearance]: validate(appearanceSchema, (client, message) => {
      this.handleAppearance(client, message);
    }),
    [CLIENT_MESSAGES.report]: validate(reportSchema, (client, message) => {
      void this.handleReport(client, message as ReportSendMessage);
    }),
    [CLIENT_MESSAGES.identityRefresh]: validate(identityRefreshSchema, (client, message) => {
      void this.handleIdentityRefresh(client, message as IdentityRefreshMessage);
    }),
  };

  static override async onAuth(
    _token: string,
    options: JoinOptions,
    context: AuthContext,
  ): Promise<RoomAuthData> {
    if (!isMarketSlug(options?.market)) throw new Error('invalid_market');
    const services = getRoomServices();
    if (!isAllowedRoomOrigin(
      websocketOrigin(context ?? {}),
      services.publicOrigins,
      services.requireWebSocketOrigin,
    )) throw new Error('origin_not_allowed');
    const { peer, forwarded } = websocketPeer(context ?? {});
    const canonicalIp = services.clientIps.resolve(peer, forwarded);
    const identity = await resolveRoomIdentity(options, canonicalIp);
    const rejection = services.moderation.connectionRejection(identity);
    if (rejection) throw new Error(rejection);
    const admissionReservationId = services.admissions.reserve(
      identity.actorId,
      identity.ipHash,
      options.market,
    );
    return { ...identity, admissionReservationId };
  }

  override onCreate(options: Partial<JoinOptions>): void {
    if (!isMarketSlug(options.market)) throw new Error('invalid_market');
    this.market = options.market;
    this.state.market = options.market;
    this.state.protocolVersion = PROTOCOL_VERSION;
    this.maxMessagesPerSecond = 30;
    const services = getRoomServices();
    services.admissions.registerRoom(this.roomId, this.market);
    const directory = services.populations;
    directory.register(this.roomId, this.market, (populations) => {
      this.broadcast(SERVER_MESSAGES.population, populations);
    });
  }

  override onJoin(client: MarketClient, options: JoinOptions): void {
    const identity = client.auth;
    if (!identity) throw new Error('missing_room_identity');
    if (options.market !== this.market) throw new Error('market_mismatch');
    const connectionKey = `${this.roomId}:${client.sessionId}`;
    getRoomServices().admissions.activate(
      identity.admissionReservationId,
      identity.actorId,
      this.market,
      connectionKey,
    );
    const fromMarket = isMarketSlug(options.fromMarket) ? options.fromMarket : undefined;
    const spawn = allocateSpawnAssignment(
      identity.actorId,
      this.market,
      fromMarket,
      this.occupiedSpawnSlots,
    );
    this.occupiedSpawnSlots.add(spawn.slot);
    client.userData = {
      ...identity,
      entitlements: new Set(identity.entitlements),
      move: { lastSequence: -1, lastAcceptedAt: 0, lastReceivedAt: 0 },
      lastReportAt: 0,
      spawnSlot: spawn.slot,
    };
    const player = new PlayerState();
    player.actorId = identity.actorId;
    player.x = spawn.x;
    player.z = spawn.z;
    player.y = spawn.y;
    player.yaw = spawn.yaw;
    player.animal = identity.animal;
    player.skin = identity.skin;
    player.username = identity.username ?? '';
    player.updatedAt = Date.now();
    this.state.players.set(client.sessionId, player);
    getRoomServices().moderation.registerConnection(connectionKey, {
      actorId: identity.actorId,
      walletAddress: identity.walletAddress,
      ipHash: identity.ipHash,
      disconnect: (code, reason) => client.leave(code, reason),
    });
    // onJoin runs before joinOrCreate resolves in the browser. Defer bootstrap
    // messages until the client has installed its handlers.
    this.clock.setTimeout(() => {
      if (!this.clients.includes(client)) return;
      getRoomServices().populations.update(this.roomId, this.clients.length);
      client.send(SERVER_MESSAGES.population, getRoomServices().populations.snapshot());
      for (const message of this.chatHistory) client.send(SERVER_MESSAGES.chat, message);
    }, 200);
  }

  override async onLeave(client: MarketClient, code?: number): Promise<void> {
    if (code !== CloseCode.CONSENTED && code !== 4_201) {
      try {
        await this.allowReconnection(client, 8);
        return;
      } catch {
        // Reconnection window expired; remove the player below.
      }
    }
    this.state.players.delete(client.sessionId);
    const connectionKey = `${this.roomId}:${client.sessionId}`;
    const data = client.userData;
    if (data) this.occupiedSpawnSlots.delete(data.spawnSlot);
    getRoomServices().moderation.unregisterConnection(connectionKey);
    getRoomServices().admissions.releaseConnection(connectionKey);
    getRoomServices().populations.update(this.roomId, this.state.players.size);
  }

  override onDispose(): void {
    getRoomServices().moderation.unregisterRoom(this.roomId);
    getRoomServices().admissions.unregisterRoom(this.roomId);
    getRoomServices().populations.unregister(this.roomId);
    this.occupiedSpawnSlots.clear();
  }

  private handleMove(client: MarketClient, snapshot: MoveSnapshot): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const now = Date.now();
    const data = this.clientData(client);
    const result = validateMove(snapshot, player, data.move, now);
    data.move.lastReceivedAt = now;
    if (!result.accepted) {
      if (!result.drop) client.send(SERVER_MESSAGES.correction, result.correction);
      return;
    }
    data.move.lastSequence = snapshot.sequence;
    data.move.lastAcceptedAt = now;
    player.x = snapshot.x;
    player.y = snapshot.y;
    player.z = snapshot.z;
    player.yaw = normalizeYaw(snapshot.yaw);
    player.speed = snapshot.speed;
    player.verticalSpeed = snapshot.verticalSpeed;
    player.grounded = snapshot.grounded;
    player.gait = snapshot.gait;
    player.updatedAt = now;
  }

  private handleChat(
    client: MarketClient,
    payload: { protocolVersion: number; text: string },
  ): void {
    if (payload.protocolVersion !== PROTOCOL_VERSION && payload.protocolVersion !== PROTOCOL_VERSION - 1) {
      client.send(SERVER_MESSAGES.chatRejected, { code: 'protocol_mismatch' });
      return;
    }
    const services = getRoomServices();
    const data = this.clientData(client);
    if (services.moderation.isMuted(data.actorId)) {
      client.send(SERVER_MESSAGES.chatRejected, { code: 'muted' });
      return;
    }
    const rate = services.chatLimits.consume(data.actorId, data.ipHash);
    if (!rate.allowed) {
      client.send(SERVER_MESSAGES.chatRejected, {
        code: 'rate_limited',
        retryAfterMs: rate.retryAfterMs,
      });
      return;
    }
    const safe = services.chatSafety.evaluate(payload.text);
    if (!safe.ok) {
      client.send(SERVER_MESSAGES.chatRejected, { code: safe.code });
      return;
    }
    const message: ChatMessage = {
      id: createId('chat'),
      actorId: data.actorId,
      username: data.username,
      animal: data.animal,
      text: safe.text,
      sentAt: Date.now(),
    };
    this.chatHistory.push(message);
    if (this.chatHistory.length > CHAT_HISTORY_LIMIT) this.chatHistory.shift();
    this.broadcast(SERVER_MESSAGES.chat, message);
  }

  private handleAppearance(
    client: MarketClient,
    payload: { protocolVersion: number; animal: string; skin: string },
  ): void {
    if (payload.protocolVersion !== PROTOCOL_VERSION
      || !isAnimalKind(payload.animal)
      || !isSkinId(payload.skin)) return;
    // Anonymous identities keep their assigned animal. Wallet accounts may use
    // every base animal; paid skins require their exact entitlement.
    const data = this.clientData(client);
    if (!data.accountId) return;
    if (payload.skin !== 'base' && !data.entitlements.has(payload.skin)) return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.animal = payload.animal;
    player.skin = payload.skin;
    data.animal = payload.animal;
    data.skin = payload.skin;
  }

  private async handleReport(client: MarketClient, payload: ReportSendMessage): Promise<void> {
    const data = this.clientData(client);
    const now = Date.now();
    const targetClient = this.clients.find(
      (candidate) => this.clientData(candidate).actorId === payload.targetActorId,
    );
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      client.send(SERVER_MESSAGES.reportRejected, { code: 'protocol_mismatch' });
      return;
    }
    if (!isActorId(payload.targetActorId) || !isModerationReason(payload.reason)) {
      client.send(SERVER_MESSAGES.reportRejected, { code: 'invalid_target' });
      return;
    }
    if (payload.targetActorId === data.actorId) {
      client.send(SERVER_MESSAGES.reportRejected, { code: 'self_report' });
      return;
    }
    const remaining = 60_000 - (now - data.lastReportAt);
    if (remaining > 0) {
      client.send(SERVER_MESSAGES.reportRejected, { code: 'rate_limited', retryAfterMs: remaining });
      return;
    }
    if (!targetClient) {
      client.send(SERVER_MESSAGES.reportRejected, { code: 'target_not_found' });
      return;
    }
    data.lastReportAt = now;
    const targetData = this.clientData(targetClient);
    const evidence = this.chatHistory.filter((message) => message.actorId === payload.targetActorId);
    try {
      const reportId = await getRoomServices().moderation.createReport({
        reporterActorId: data.actorId,
        reporterAccountId: data.accountId,
        targetActorId: payload.targetActorId,
        market: this.market,
        reason: payload.reason,
        ...(payload.note ? { note: payload.note } : {}),
        evidence,
        // Store the reported player's HMAC IP identifier, never the reporter's.
        ipHash: targetData.ipHash,
      });
      client.send(SERVER_MESSAGES.reportAccepted, { reportId });
    } catch {
      client.send(SERVER_MESSAGES.reportRejected, { code: 'persistence_failed' });
    }
  }

  private async handleIdentityRefresh(
    client: MarketClient,
    payload: IdentityRefreshMessage,
  ): Promise<void> {
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      client.send(SERVER_MESSAGES.identityRejected, { code: 'protocol_mismatch' });
      return;
    }
    if (Boolean(payload.sessionToken) === Boolean(payload.anonymousToken)) {
      client.send(SERVER_MESSAGES.identityRejected, { code: 'invalid_identity' });
      return;
    }
    const data = this.clientData(client);
    try {
      const identity = await resolveRoomIdentityWithIpHash(payload, data.ipHash);
      if (identity.actorId !== data.actorId) {
        client.send(SERVER_MESSAGES.identityRejected, { code: 'actor_mismatch' });
        return;
      }
      if (getRoomServices().moderation.connectionRejection(identity)) {
        client.send(SERVER_MESSAGES.identityRejected, { code: 'moderated' });
        return;
      }
      data.accountId = identity.accountId;
      data.walletAddress = identity.walletAddress;
      data.username = identity.username;
      data.animal = identity.animal;
      data.skin = identity.skin;
      data.entitlements = new Set(identity.entitlements);
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.username = identity.username ?? '';
        player.animal = identity.animal;
        player.skin = identity.skin;
      }
      getRoomServices().moderation.registerConnection(`${this.roomId}:${client.sessionId}`, {
        actorId: identity.actorId,
        walletAddress: identity.walletAddress,
        ipHash: data.ipHash,
        disconnect: (code, reason) => client.leave(code, reason),
      });
      client.send(SERVER_MESSAGES.identityRefreshed, {
        actorId: identity.actorId,
        username: identity.username,
        animal: identity.animal,
        skin: identity.skin,
        walletConnected: identity.accountId !== null,
      });
    } catch {
      client.send(SERVER_MESSAGES.identityRejected, { code: 'invalid_identity' });
    }
  }

  private clientData(client: MarketClient): MarketClientData {
    if (!client.userData) throw new Error('missing_client_data');
    return client.userData;
  }
}
