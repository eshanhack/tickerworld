import type { Application, NextFunction, Request, Response } from 'express';
import express from 'express';
import {
  ANIMAL_KINDS,
  ASSET_SYMBOLS,
  MARKET_ROOM_MAX_CLIENTS,
  MARKET_SLUGS,
  PREMIUM_SKINS,
  isActorId,
  isAssetSymbol,
  type RuntimeKillSwitches,
} from '@tickerworld/shared';
import { z } from 'zod';
import { databaseIsReady } from './db/database.js';
import type { ServerRuntime } from './runtime.js';
import { hashIp } from './services/crypto.js';
import {
  InputError,
  RateLimitError,
  ServiceError,
  ServiceUnavailableError,
  UnauthorizedError,
} from './services/errors.js';

const walletSchema = z.string().min(32).max(44);
const actorSchema = z.string().refine(isActorId, { message: 'Invalid actor identity' });
const authChallengeSchema = z.object({
  publicKey: walletSchema,
  actorId: actorSchema,
  anonymousToken: z.string().min(40).max(1_024),
});
const authVerifySchema = z.object({
  challengeId: z.string().min(10).max(64),
  publicKey: walletSchema,
  signature: z.string().min(64).max(180),
  actorId: actorSchema,
  anonymousToken: z.string().min(40).max(1_024),
});
const profileSchema = z.object({
  animal: z.enum(ANIMAL_KINDS).optional(),
  skin: z.enum(['base', ...PREMIUM_SKINS]).optional(),
  lastMarket: z.enum(MARKET_SLUGS).optional(),
});
const usernameSchema = z.object({ username: z.string().min(1).max(64) });
const quoteSchema = z.object({
  sku: z.string().min(1).max(48),
  username: z.string().min(1).max(64).optional(),
});
const confirmSchema = z.object({
  quoteId: z.string().min(10).max(64),
  signature: z.string().min(64).max(180),
});
const blockSchema = z.object({ actorId: actorSchema });
const adminActionSchema = z.object({
  action: z.enum(['mute', 'kick', 'wallet_temp_ban', 'ip_throttle']),
  targetActorId: actorSchema.optional(),
  targetWalletAddress: walletSchema.optional(),
  targetIpHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reason: z.string().min(3).max(280),
  expiresAt: z.number().int().positive().nullable().optional(),
}).refine(
  (value) => value.targetActorId || value.targetWalletAddress || value.targetIpHash,
  { message: 'At least one target is required' },
).refine(
  (value) => (value.action === 'mute' || value.action === 'kick')
    ? Boolean(value.targetActorId)
    : value.action === 'wallet_temp_ban'
      ? Boolean((value.targetActorId || value.targetWalletAddress) && value.expiresAt)
      : Boolean(value.targetIpHash && value.expiresAt),
  { message: 'Action target and temporary expiry do not match the action type' },
);
const reportResolutionSchema = z.object({ status: z.enum(['resolved', 'dismissed']) });
const inviteCreateSchema = z.object({
  market: z.enum(MARKET_SLUGS),
  roomId: z.string().min(4).max(128),
  anonymousToken: z.string().min(40).max(1_024).optional(),
  sessionToken: z.string().min(20).max(1_024).optional(),
}).refine((value) => Boolean(value.anonymousToken) !== Boolean(value.sessionToken), {
  message: 'Supply exactly one signed identity',
});
const inviteRedeemSchema = z.object({ token: z.string().min(40).max(1_024) });
const newsAccountSchema = z.object({
  scope: z.enum(ASSET_SYMBOLS),
  handle: z.string().trim().min(1).max(16),
  accountId: z.string().regex(/^\d{1,32}$/).optional(),
  anonymousToken: z.string().min(40).max(1_024),
}).strict();
const switchPatchSchema = z.object({
  admissions: z.boolean().optional(),
  chatSend: z.boolean().optional(),
  newsIngest: z.boolean().optional(),
  directMarketFallback: z.boolean().optional(),
  publicWalletAuth: z.boolean().optional(),
  purchases: z.boolean().optional(),
  adminActions: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one switch is required' });

function bearerToken(request: Request): string | undefined {
  const authorization = request.header('authorization');
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,})$/);
  return match?.[1];
}

function requestIp(request: Request, runtime: ServerRuntime): string {
  return runtime.clientIps.resolve(
    request.socket.remoteAddress,
    request.headers['x-forwarded-for'],
  );
}

function requestIpHash(request: Request, runtime: ServerRuntime): string {
  return hashIp(runtime.config.ipHmacSecret, requestIp(request, runtime));
}

function enforceRateLimit(
  runtime: ServerRuntime,
  namespace: string,
  key: string,
  limit: number,
  windowMs: number,
): void {
  const result = runtime.requestLimits.consume(namespace, key, limit, windowMs);
  if (!result.allowed) {
    throw new RateLimitError(`${namespace}_rate_limited`, 'Too many requests; try again shortly', result.retryAfterMs);
  }
}

function requireFeature(runtime: ServerRuntime, key: keyof RuntimeKillSwitches): void {
  if (!runtime.switches.enabled(key)) {
    throw new ServiceUnavailableError(`${key}_disabled`, 'This feature is currently unavailable');
  }
}

export function configureHttp(app: Application, runtime: ServerRuntime): void {
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const origin = request.header('origin');
    if (origin && !runtime.config.publicOrigins.includes(origin)) {
      response.status(403).json({ error: 'origin_not_allowed' });
      return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

  app.get('/healthz', (_request, response) => {
    response.json({ status: 'ok', protocolVersion: 2 });
  });
  app.get('/api/capabilities', (_request, response) => {
    response.setHeader('Cache-Control', 'private, no-store');
    response.json(runtime.switches.capabilities({
      marketRelayAvailable: runtime.marketRelay.available(),
      newsAvailable: runtime.news.available(),
    }));
  });
  app.get('/readyz', async (_request, response) => {
    const [database] = await Promise.all([
      databaseIsReady(runtime.db),
      runtime.economy.refreshReadiness(),
    ]);
    const marketRelay = runtime.marketRelay.status();
    const features = {
      database,
      walletAuth: runtime.switches.enabled('publicWalletAuth') && runtime.auth.ready,
      purchases: runtime.switches.enabled('purchases') && runtime.economy.ready,
      trustedProxy: runtime.config.trustedProxyCidrs.length > 0,
      administration: runtime.switches.enabled('adminActions')
        && runtime.config.adminWallets.size > 0,
      marketRelay: runtime.marketRelay.available(),
      marketAgeMs: marketRelay.ageMs,
      news: runtime.news.available(),
      newsIngestor: runtime.news.leaderStatus(),
      newsTokenConfigured: Boolean(runtime.config.xBearerToken),
      runtimeEnvironment: runtime.config.nodeEnv,
    };
    const productionProvidersReady = features.trustedProxy
      && (!runtime.switches.enabled('publicWalletAuth') || features.walletAuth)
      && (!runtime.switches.enabled('purchases') || features.purchases)
      && (!runtime.switches.enabled('adminActions') || features.administration);
    const ready = database
      && (runtime.config.nodeEnv !== 'production' || productionProvidersReady);
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      features,
    });
  });
  app.get('/api/populations', (_request, response) => {
    response.json({ populations: runtime.populations.snapshot() });
  });
  app.get('/api/news', (request, response) => {
    if (Object.keys(request.query).some((key) => key !== 'scope')) {
      throw new InputError('invalid_news_scope', 'Only the bounded scope query is supported');
    }
    const rawScope = typeof request.query.scope === 'string' ? request.query.scope.toUpperCase() : undefined;
    if (rawScope && !isAssetSymbol(rawScope)) {
      throw new InputError('invalid_news_scope', 'Unknown market scope');
    }
    const scope = rawScope && isAssetSymbol(rawScope)
      ? rawScope as Parameters<ServerRuntime['news']['snapshot']>[0]
      : undefined;
    response.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=10');
    response.json(runtime.news.snapshot(scope));
  });
  app.post('/api/news/accounts', async (request, response) => {
    const body = newsAccountSchema.parse(request.body);
    // Reject forged/expired identity proofs before touching either the IP or
    // actor bucket. Otherwise an unauthenticated caller behind a shared NAT can
    // consume the whole household's small paid-provider allowance.
    const identity = runtime.anonymous.verify(body.anonymousToken);
    if (!identity) throw new UnauthorizedError('Anonymous identity proof is invalid');
    // Only an immutable id can enter the high-volume retention bucket. A
    // mutable handle may have been reclaimed by a different X account and is
    // therefore always treated as a bounded acquisition.
    const knownAssociation = body.accountId !== undefined
      && runtime.news.isAccountIdAssociated(body.scope, body.accountId);
    enforceRateLimit(
      runtime,
      knownAssociation ? 'news_account_touch_ip' : 'news_account_add_ip',
      requestIpHash(request, runtime),
      knownAssociation ? 256 : 3,
      knownAssociation ? 60 * 60_000 : 24 * 60 * 60_000,
    );
    enforceRateLimit(
      runtime,
      knownAssociation ? 'news_account_touch_actor' : 'news_account_add_actor',
      identity.actorId,
      knownAssociation ? 64 : 2,
      knownAssociation ? 60 * 60_000 : 24 * 60 * 60_000,
    );
    const account = knownAssociation
      ? await runtime.news.touchAccount(body.scope, body.accountId!)
      : body.accountId
        ? await runtime.news.addAccountById(body.scope, body.accountId)
        : await runtime.news.addAccount(body.scope, body.handle);
    response.setHeader('Cache-Control', 'private, no-store');
    response.status(201).json({ account });
  });
  app.post('/api/anonymous/session', (request, response) => {
    enforceRateLimit(
      runtime,
      'anonymous_session',
      requestIpHash(request, runtime),
      runtime.config.limits.anonymousSessionsPerMinute,
      60_000,
    );
    response.status(201).json(runtime.anonymous.issue());
  });

  app.post('/api/invites', async (request, response) => {
    requireFeature(runtime, 'admissions');
    const body = inviteCreateSchema.parse(request.body);
    let actorId: string;
    if (body.anonymousToken) {
      const identity = runtime.anonymous.verify(body.anonymousToken);
      if (!identity) throw new UnauthorizedError('Anonymous identity proof is invalid');
      actorId = identity.actorId;
    } else {
      const account = await runtime.auth.authenticate(body.sessionToken);
      actorId = account.actorId;
    }
    enforceRateLimit(runtime, 'party_invite', actorId, 20, 60_000);
    const room = runtime.populations.room(body.roomId);
    if (!room || room.market !== body.market || !runtime.admissions.isActorInRoom(actorId, body.roomId)) {
      throw new InputError('party_invalid', 'The invitation room is not active for this player');
    }
    if (room.clients >= MARKET_ROOM_MAX_CLIENTS) {
      throw new ServiceError(409, 'party_full', 'The current shard is full');
    }
    response.status(201).json(runtime.invites.issue(
      actorId,
      body.roomId,
      body.market,
      Date.now(),
      runtime.admissions.actorPosition(actorId),
    ));
  });
  app.post('/api/invites/redeem', (request, response) => {
    requireFeature(runtime, 'admissions');
    enforceRateLimit(runtime, 'party_redeem', requestIpHash(request, runtime), 60, 60_000);
    const { token } = inviteRedeemSchema.parse(request.body);
    const invite = runtime.invites.inspect(token);
    if (!invite.ok) {
      response.json({ ok: false, code: invite.code, fallbackMarket: null });
      return;
    }
    const room = runtime.populations.room(invite.roomId);
    if (!room || room.market !== invite.market) {
      response.json({ ok: false, code: 'party_invalid', fallbackMarket: invite.market });
      return;
    }
    if (room.clients >= MARKET_ROOM_MAX_CLIENTS) {
      response.json({ ok: false, code: 'party_full', fallbackMarket: invite.market });
      return;
    }
    response.json({
      ok: true,
      market: invite.market,
      roomId: invite.roomId,
      expiresAt: invite.expiresAt,
    });
  });

  const adminChallenge = async (request: Request, response: Response): Promise<void> => {
    const body = authChallengeSchema.parse(request.body);
    if (!runtime.config.adminWallets.has(body.publicKey)) {
      throw new UnauthorizedError('Admin wallet is not allowlisted');
    }
    const ipHash = requestIpHash(request, runtime);
    enforceRateLimit(
      runtime,
      'admin_auth_challenge_ip',
      ipHash,
      runtime.config.limits.authChallengesPerMinuteByIp,
      60_000,
    );
    enforceRateLimit(
      runtime,
      'admin_auth_challenge_wallet',
      body.publicKey,
      runtime.config.limits.authChallengesPerMinuteByWallet,
      60_000,
    );
    const identity = runtime.anonymous.verify(body.anonymousToken);
    if (!identity || identity.actorId !== body.actorId) {
      throw new UnauthorizedError('Anonymous identity proof is invalid');
    }
    response.status(201).json(await runtime.auth.issueChallenge(
      body.publicKey,
      identity.actorId,
      identity.animal,
      ipHash,
    ));
  };
  const adminVerify = async (request: Request, response: Response): Promise<void> => {
    const body = authVerifySchema.parse(request.body);
    if (!runtime.config.adminWallets.has(body.publicKey)) {
      throw new UnauthorizedError('Admin wallet is not allowlisted');
    }
    const identity = runtime.anonymous.verify(body.anonymousToken);
    if (!identity || identity.actorId !== body.actorId) {
      throw new UnauthorizedError('Anonymous identity proof is invalid');
    }
    const verified = await runtime.auth.verifyChallenge({
      challengeId: body.challengeId,
      walletAddress: body.publicKey,
      actorId: body.actorId,
      signature: body.signature,
    });
    response.json({ sessionToken: verified.token, profile: verified.profile });
  };
  app.post('/api/admin/auth/challenge', adminChallenge);
  app.post('/api/admin/auth/verify', adminVerify);

  app.post('/api/auth/challenge', async (request, response) => {
    requireFeature(runtime, 'publicWalletAuth');
    const body = authChallengeSchema.parse(request.body);
    const ipHash = requestIpHash(request, runtime);
    enforceRateLimit(
      runtime,
      'auth_challenge_ip',
      ipHash,
      runtime.config.limits.authChallengesPerMinuteByIp,
      60_000,
    );
    enforceRateLimit(
      runtime,
      'auth_challenge_wallet',
      body.publicKey,
      runtime.config.limits.authChallengesPerMinuteByWallet,
      60_000,
    );
    const identity = runtime.anonymous.verify(body.anonymousToken);
    if (!identity || identity.actorId !== body.actorId) {
      throw new UnauthorizedError('Anonymous identity proof is invalid');
    }
    response.status(201).json(await runtime.auth.issueChallenge(
      body.publicKey,
      identity.actorId,
      identity.animal,
      ipHash,
    ));
  });
  app.post('/api/auth/verify', async (request, response) => {
    requireFeature(runtime, 'publicWalletAuth');
    const body = authVerifySchema.parse(request.body);
    const identity = runtime.anonymous.verify(body.anonymousToken);
    if (!identity || identity.actorId !== body.actorId) {
      throw new UnauthorizedError('Anonymous identity proof is invalid');
    }
    const verified = await runtime.auth.verifyChallenge({
      challengeId: body.challengeId,
      walletAddress: body.publicKey,
      actorId: body.actorId,
      signature: body.signature,
    });
    response.json({
      sessionToken: verified.token,
      profile: verified.profile,
      blocks: await runtime.auth.listBlocks(verified.profile.id),
    });
  });
  app.post('/api/auth/logout', async (request, response) => {
    await runtime.auth.revoke(bearerToken(request));
    response.sendStatus(204);
  });

  const sendProfile = async (request: Request, response: Response): Promise<void> => {
    const account = await runtime.auth.authenticate(bearerToken(request));
    response.json(await runtime.auth.profileForAccount(account.accountId));
  };
  app.get('/api/account', sendProfile);
  app.get('/api/account/profile', sendProfile);
  const updateProfile = async (request: Request, response: Response): Promise<void> => {
    const account = await runtime.auth.authenticate(bearerToken(request));
    response.json(await runtime.auth.updateProfile(account.accountId, profileSchema.parse(request.body)));
  };
  app.patch('/api/account/profile', updateProfile);
  app.put('/api/account/profile', updateProfile);
  app.put('/api/account/username', async (request, response) => {
    const account = await runtime.auth.authenticate(bearerToken(request));
    const { username } = usernameSchema.parse(request.body);
    response.json(await runtime.auth.claimUsername(
      account.accountId,
      username,
      (canonical) => runtime.chatSafety.isReservedUsername(canonical),
    ));
  });
  app.get('/api/account/blocks', async (request, response) => {
    const account = await runtime.auth.authenticate(bearerToken(request));
    response.json(await runtime.auth.listBlocks(account.accountId));
  });
  app.put('/api/account/blocks', async (request, response) => {
    const account = await runtime.auth.authenticate(bearerToken(request));
    const { actorId } = blockSchema.parse(request.body);
    await runtime.auth.addBlock(account.accountId, actorId);
    response.sendStatus(204);
  });
  app.put('/api/account/blocks/:actorId', async (request, response) => {
    const account = await runtime.auth.authenticate(bearerToken(request));
    const actorId = actorSchema.parse(request.params.actorId);
    await runtime.auth.addBlock(account.accountId, actorId);
    response.sendStatus(204);
  });
  app.delete('/api/account/blocks/:actorId', async (request, response) => {
    const account = await runtime.auth.authenticate(bearerToken(request));
    const actorId = actorSchema.parse(request.params.actorId);
    await runtime.auth.removeBlock(account.accountId, actorId);
    response.sendStatus(204);
  });

  app.post('/api/purchases/quote', async (request, response) => {
    requireFeature(runtime, 'purchases');
    const account = await runtime.auth.authenticate(bearerToken(request));
    enforceRateLimit(
      runtime,
      'purchase_quote',
      account.accountId,
      runtime.config.limits.purchaseQuotesPerHour,
      60 * 60_000,
    );
    const { sku, username } = quoteSchema.parse(request.body);
    response.status(201).json(await runtime.economy.createQuote(
      account.accountId,
      sku,
      username ? { username } : {},
    ));
  });
  app.post('/api/purchases/confirm', async (request, response) => {
    requireFeature(runtime, 'purchases');
    const account = await runtime.auth.authenticate(bearerToken(request));
    enforceRateLimit(
      runtime,
      'purchase_confirm',
      account.accountId,
      runtime.config.limits.purchaseConfirmsPerMinute,
      60_000,
    );
    const body = confirmSchema.parse(request.body);
    const confirmation = await runtime.economy.confirmPayment(
      account.accountId,
      body.quoteId,
      body.signature,
    );
    if (confirmation.state === 'pending') {
      response.status(202).json({ status: 'pending' });
      return;
    }
    response.json({
      status: confirmation.state,
      profile: await runtime.auth.profileForAccount(account.accountId),
    });
  });

  app.get('/api/admin/reports', async (request, response) => {
    requireFeature(runtime, 'adminActions');
    const account = await requireAdmin(request, runtime);
    void account;
    const reports = await runtime.db.selectFrom('moderation_reports')
      .selectAll()
      .where('status', '=', 'open')
      .orderBy('created_at', 'asc')
      .limit(100)
      .execute();
    response.json({ reports });
  });
  app.post('/api/admin/actions', async (request, response) => {
    requireFeature(runtime, 'adminActions');
    const account = await requireAdmin(request, runtime);
    const body = adminActionSchema.parse(request.body);
    let targetWalletAddress = body.targetWalletAddress ?? null;
    if (body.action === 'wallet_temp_ban' && !targetWalletAddress && body.targetActorId) {
      const targetAccount = await runtime.db.selectFrom('accounts')
        .select('wallet_address')
        .where('actor_id', '=', body.targetActorId)
        .executeTakeFirst();
      targetWalletAddress = targetAccount?.wallet_address ?? null;
      if (!targetWalletAddress) {
        throw new InputError('target_has_no_wallet', 'That actor has no connected wallet account');
      }
    }
    let id: string;
    try {
      id = await runtime.moderation.createAction({
        admin_account_id: account.accountId,
        target_actor_id: body.targetActorId ?? null,
        target_wallet_address: targetWalletAddress,
        target_ip_hash: body.targetIpHash ?? null,
        action: body.action,
        reason: body.reason.normalize('NFKC').trim(),
        expires_at: body.expiresAt ?? null,
      });
      if (body.targetActorId) {
        await runtime.db.updateTable('moderation_reports')
          .set({ status: 'resolved', resolved_at: Date.now() })
          .where('target_actor_id', '=', body.targetActorId)
          .where('status', '=', 'open')
          .execute();
      }
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceUnavailableError(
        'moderation_persistence_failed',
        'The moderation action could not be stored',
      );
    }
    response.status(201).json({ id });
  });
  app.patch('/api/admin/reports/:reportId', async (request, response) => {
    requireFeature(runtime, 'adminActions');
    await requireAdmin(request, runtime);
    const reportId = z.string().min(10).max(64).parse(request.params.reportId);
    const { status } = reportResolutionSchema.parse(request.body);
    let numUpdatedRows = 0;
    try {
      const result = await runtime.db.updateTable('moderation_reports')
        .set({ status, resolved_at: Date.now() })
        .where('id', '=', reportId)
        .where('status', '=', 'open')
        .executeTakeFirst();
      numUpdatedRows = Number(result.numUpdatedRows);
    } catch {
      throw new ServiceUnavailableError(
        'moderation_persistence_failed',
        'The report resolution could not be stored',
      );
    }
    if (numUpdatedRows !== 1) {
      response.status(404).json({ error: 'report_not_found' });
      return;
    }
    response.sendStatus(204);
  });
  app.patch('/api/admin/capabilities', async (request, response) => {
    await requireAdmin(request, runtime);
    const patch = switchPatchSchema.parse(request.body);
    if (patch.purchases && !runtime.economy.ready) {
      throw new ServiceUnavailableError('purchases_not_ready', 'Purchase providers are unavailable');
    }
    if (patch.publicWalletAuth && !runtime.auth.ready) {
      throw new ServiceUnavailableError('wallet_auth_not_ready', 'Wallet authentication is unavailable');
    }
    if (patch.adminActions && runtime.config.adminWallets.size === 0) {
      throw new ServiceUnavailableError('admin_not_ready', 'No admin wallet is configured');
    }
    if (patch.newsIngest && (!runtime.config.xBearerToken
      || (runtime.config.nodeEnv === 'production' && !runtime.config.databaseUrl))) {
      throw new ServiceUnavailableError(
        'news_ingest_not_ready',
        'Live X news requires a paid token and the shared production database',
      );
    }
    const switches = runtime.switches.update(patch);
    response.json({ switches, updatedAt: Date.now() });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ServiceError) {
      if (error instanceof RateLimitError) {
        response.setHeader('Retry-After', Math.max(1, Math.ceil(error.retryAfterMs / 1_000)));
      }
      response.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: 'invalid_request', issues: error.issues });
      return;
    }
    runtime.logger.error('http_error', {
      method: _request.method,
      path: _request.path,
      code: error instanceof Error ? error.name : 'unknown',
    });
    response.status(500).json({ error: 'internal_error' });
  });
}

async function requireAdmin(request: Request, runtime: ServerRuntime) {
  const account = await runtime.auth.authenticate(bearerToken(request));
  if (!runtime.config.adminWallets.has(account.walletAddress)) {
    throw new UnauthorizedError('Admin wallet is not allowlisted');
  }
  return account;
}
