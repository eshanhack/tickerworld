import type { ChatMessage, MarketSlug, ModerationReason } from '@tickerworld/shared';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, ModerationActionRow } from '../db/types.js';
import { createId } from './crypto.js';

export interface CreateReportInput {
  reporterActorId: string;
  reporterAccountId: string | null;
  targetActorId: string;
  market: MarketSlug;
  reason: ModerationReason;
  note?: string;
  evidence: readonly ChatMessage[];
  ipHash: string;
}

export class ModerationService {
  private readonly activeMutes = new Map<string, number>();
  private readonly walletBans = new Map<string, number>();
  private readonly ipThrottles = new Map<string, number>();
  private readonly liveConnections = new Map<string, {
    actorId: string;
    walletAddress: string | null;
    ipHash: string;
    disconnect: (code: number, reason: string) => void;
  }>();

  constructor(private readonly db: Kysely<DatabaseSchema>) {}

  async hydrate(now = Date.now()): Promise<void> {
    const actions = await this.db.selectFrom('moderation_actions')
      .selectAll()
      .where((expression) => expression.or([
        expression('expires_at', 'is', null),
        expression('expires_at', '>', now),
      ]))
      .execute();
    for (const action of actions) this.applyAction(action, now, false);
  }

  connectionRejection(input: {
    walletAddress: string | null;
    ipHash: string;
  }, now = Date.now()): 'wallet_temp_ban' | 'ip_throttle' | null {
    if (input.walletAddress && this.isActive(this.walletBans, input.walletAddress, now)) {
      return 'wallet_temp_ban';
    }
    if (this.isActive(this.ipThrottles, input.ipHash, now)) return 'ip_throttle';
    return null;
  }

  registerConnection(key: string, input: {
    actorId: string;
    walletAddress: string | null;
    ipHash: string;
    disconnect: (code: number, reason: string) => void;
  }): void {
    this.liveConnections.set(key, input);
  }

  unregisterConnection(key: string): void {
    this.liveConnections.delete(key);
  }

  unregisterRoom(roomId: string): void {
    for (const key of this.liveConnections.keys()) {
      if (key.startsWith(`${roomId}:`)) this.liveConnections.delete(key);
    }
  }

  isMuted(actorId: string, now = Date.now()): boolean {
    const expiry = this.activeMutes.get(actorId);
    if (!expiry) return false;
    if (expiry <= now) {
      this.activeMutes.delete(actorId);
      return false;
    }
    return true;
  }

  async createReport(input: CreateReportInput, now = Date.now()): Promise<string> {
    const id = createId('report');
    await this.db.insertInto('moderation_reports').values({
      id,
      reporter_actor_id: input.reporterActorId,
      reporter_account_id: input.reporterAccountId,
      target_actor_id: input.targetActorId,
      market: input.market,
      reason: input.reason,
      note: input.note?.normalize('NFKC').trim().slice(0, 280) || null,
      evidence_json: JSON.stringify(input.evidence.slice(-20)),
      ip_hash: input.ipHash,
      status: 'open',
      created_at: now,
      resolved_at: null,
    }).execute();
    return id;
  }

  async createAction(input: Omit<ModerationActionRow, 'id' | 'created_at'>, now = Date.now()): Promise<string> {
    const id = createId('action');
    const action = { id, created_at: now, ...input };
    await this.db.insertInto('moderation_actions').values(action).execute();
    this.applyAction(action, now, true);
    return id;
  }

  private applyAction(action: ModerationActionRow, now: number, live: boolean): void {
    if (action.action === 'mute' && action.target_actor_id) {
      this.activeMutes.set(action.target_actor_id, action.expires_at ?? Number.MAX_SAFE_INTEGER);
    } else if (action.action === 'wallet_temp_ban' && action.target_wallet_address) {
      this.walletBans.set(action.target_wallet_address, action.expires_at ?? now);
    } else if (action.action === 'ip_throttle' && action.target_ip_hash) {
      this.ipThrottles.set(action.target_ip_hash, action.expires_at ?? now);
    }
    if (!live) return;
    for (const connection of this.liveConnections.values()) {
      const matches = action.action === 'kick'
        ? Boolean(action.target_actor_id && connection.actorId === action.target_actor_id)
        : action.action === 'wallet_temp_ban'
          ? Boolean(action.target_wallet_address && connection.walletAddress === action.target_wallet_address)
          : action.action === 'ip_throttle'
            ? Boolean(action.target_ip_hash && connection.ipHash === action.target_ip_hash)
            : false;
      if (matches) connection.disconnect(4_201, action.action);
    }
  }

  private isActive(map: Map<string, number>, key: string, now: number): boolean {
    const expiry = map.get(key);
    if (!expiry) return false;
    if (expiry <= now) {
      map.delete(key);
      return false;
    }
    return true;
  }
}
