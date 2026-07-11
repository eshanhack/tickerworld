import type { Application, NextFunction, Request, Response } from 'express';
import express from 'express';
import { ANIMAL_KINDS, MARKET_SLUGS, PREMIUM_SKINS, isActorId } from '@tickerworld/shared';
import { z } from 'zod';
import { databaseIsReady } from './db/database.js';
import type { ServerRuntime } from './runtime.js';
import { hashIp } from './services/crypto.js';
import { InputError, RateLimitError, ServiceError, UnauthorizedError } from './services/errors.js';

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
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
  app.get('/readyz', async (_request, response) => {
    const [database] = await Promise.all([
      databaseIsReady(runtime.db),
      runtime.economy.refreshReadiness(),
    ]);
    const features = {
      database,
      walletAuth: runtime.auth.ready,
      purchases: runtime.economy.ready,
      trustedProxy: runtime.config.trustedProxyCidrs.length > 0,
      administration: runtime.config.adminWallets.size > 0,
    };
    const productionProvidersReady = features.walletAuth
      && features.purchases
      && features.trustedProxy
      && features.administration;
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

  app.post('/api/auth/challenge', async (request, response) => {
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
    const id = await runtime.moderation.createAction({
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
    response.status(201).json({ id });
  });
  app.patch('/api/admin/reports/:reportId', async (request, response) => {
    await requireAdmin(request, runtime);
    const reportId = z.string().min(10).max(64).parse(request.params.reportId);
    const { status } = reportResolutionSchema.parse(request.body);
    const result = await runtime.db.updateTable('moderation_reports')
      .set({ status, resolved_at: Date.now() })
      .where('id', '=', reportId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      response.status(404).json({ error: 'report_not_found' });
      return;
    }
    response.sendStatus(204);
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
    console.error(error);
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
