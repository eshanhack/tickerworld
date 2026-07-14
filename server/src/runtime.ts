import type { Kysely } from 'kysely';
import type { ServerConfig } from './config.js';
import { createDatabase, migrateDatabase } from './db/database.js';
import type { DatabaseSchema } from './db/types.js';
import { PopulationDirectory } from './rooms/PopulationDirectory.js';
import { configureRoomServices } from './rooms/roomServices.js';
import { AnonymousIdentityService } from './services/anonymousIdentity.js';
import {
  AuthService,
  Ed25519WalletSignatureVerifier,
  type WalletSignatureVerifier,
} from './services/auth.js';
import { ChatSafety, SharedChatRateLimiter } from './services/chatSafety.js';
import { ChatRelay } from './services/chatRelay.js';
import {
  DevelopmentQuoteAuthority,
  EconomyService,
  HttpSolUsdQuoteAuthority,
  SolanaRpcPaymentVerifier,
  UnavailableChainPaymentVerifier,
  UnavailableQuoteAuthority,
  type ChainPaymentVerifier,
  type QuoteAuthority,
} from './services/economy.js';
import { ModerationService } from './services/moderation.js';
import { AdmissionControl } from './services/admission.js';
import { CanonicalIpResolver } from './services/canonicalIp.js';
import { SlidingWindowRateLimiter } from './services/rateLimits.js';
import { RuntimeSwitchboard } from './services/runtimeSwitches.js';
import { PartyInviteService } from './services/partyInvites.js';
import { DisabledMarketRelay, HyperliquidMarketRelay, type MarketRelay } from './services/marketRelay.js';
import {
  DatabaseNewsIngestLease,
  DatabaseNewsRequestBudget,
  NewsIngestService,
} from './services/newsIngest.js';
import { SafeLogger } from './services/safeLogger.js';
import { RetentionService } from './services/retention.js';

export interface RuntimeOverrides {
  db?: Kysely<DatabaseSchema>;
  walletVerifier?: WalletSignatureVerifier;
  quoteAuthority?: QuoteAuthority;
  paymentVerifier?: ChainPaymentVerifier;
}

export interface ServerRuntime {
  config: ServerConfig;
  db: Kysely<DatabaseSchema>;
  anonymous: AnonymousIdentityService;
  auth: AuthService;
  economy: EconomyService;
  moderation: ModerationService;
  chatSafety: ChatSafety;
  chatLimits: SharedChatRateLimiter;
  chatRelay: ChatRelay;
  populations: PopulationDirectory;
  admissions: AdmissionControl;
  clientIps: CanonicalIpResolver;
  requestLimits: SlidingWindowRateLimiter;
  switches: RuntimeSwitchboard;
  invites: PartyInviteService;
  marketRelay: MarketRelay;
  news: NewsIngestService;
  logger: SafeLogger;
  retention: RetentionService;
  dispose(): Promise<void>;
}

export async function createRuntime(
  config: ServerConfig,
  overrides: RuntimeOverrides = {},
): Promise<ServerRuntime> {
  const db = overrides.db ?? createDatabase(config);
  await migrateDatabase(db);
  const anonymous = new AnonymousIdentityService(config.serverHmacSecret);
  const auth = new AuthService(db, overrides.walletVerifier ?? new Ed25519WalletSignatureVerifier());
  const quoteAuthority: QuoteAuthority = overrides.quoteAuthority
    ?? (config.devSolUsdPrice
      ? new DevelopmentQuoteAuthority(config.devSolUsdPrice)
      : config.solUsdPriceUrl
        ? new HttpSolUsdQuoteAuthority(config.solUsdPriceUrl)
        : new UnavailableQuoteAuthority());
  const chatSafety = new ChatSafety();
  const chatLimits = new SharedChatRateLimiter();
  const chatRelay = new ChatRelay();
  const paymentVerifier: ChainPaymentVerifier = overrides.paymentVerifier ?? (config.solanaRpcUrl
    ? new SolanaRpcPaymentVerifier(config.solanaRpcUrl, config.solanaCluster)
    : new UnavailableChainPaymentVerifier());
  const quoteAuthorityReady = quoteAuthority.initialize
    ? await quoteAuthority.initialize().catch(() => false)
    : quoteAuthority.available;
  const paymentVerifierReady = paymentVerifier.initialize
    ? await paymentVerifier.initialize().catch(() => false)
    : paymentVerifier.available;
  if (config.nodeEnv === 'production' && config.launchSwitches.purchases
    && (!quoteAuthorityReady || !paymentVerifierReady)) {
    throw new Error('Production economy providers failed readiness checks');
  }
  const economy = new EconomyService(
    db,
    config,
    quoteAuthority,
    paymentVerifier,
    (canonical) => chatSafety.isReservedUsername(canonical),
  );
  const moderation = new ModerationService(db);
  await moderation.hydrate();
  const populations = new PopulationDirectory();
  const admissions = new AdmissionControl(config.limits);
  const clientIps = new CanonicalIpResolver(config.trustedProxyCidrs);
  const requestLimits = new SlidingWindowRateLimiter();
  const switches = new RuntimeSwitchboard(config.launchSwitches, config.limits.maxProcessConnections);
  const invites = new PartyInviteService(config.serverHmacSecret);
  const marketRelay: MarketRelay = config.marketRelayEnabled
    ? new HyperliquidMarketRelay()
    : new DisabledMarketRelay();
  const news = new NewsIngestService(
    config.xBearerToken,
    config.xTrackedHandles,
    config.xDailyRequestLimit,
    switches,
    fetch,
    Date.now,
    60_000,
    new DatabaseNewsRequestBudget(db),
    db,
    new DatabaseNewsIngestLease(db),
  );
  const logger = new SafeLogger();
  const retention = new RetentionService(db, logger);
  await retention.run();
  await news.initialize();
  marketRelay.start();
  news.start();
  retention.start();
  const runtime: ServerRuntime = {
    config,
    db,
    anonymous,
    auth,
    economy,
    moderation,
    chatSafety,
    chatLimits,
    chatRelay,
    populations,
    admissions,
    clientIps,
    requestLimits,
    switches,
    invites,
    marketRelay,
    news,
    logger,
    retention,
    async dispose() {
      populations.clear();
      admissions.clear();
      requestLimits.clear();
      chatLimits.clear();
      chatRelay.clear();
      invites.clear();
      marketRelay.dispose();
      await news.dispose();
      retention.dispose();
      if (!overrides.db) await db.destroy();
    },
  };
  configureRoomServices({
    auth,
    anonymous,
    chatSafety,
    chatLimits,
    chatRelay,
    moderation,
    populations,
    admissions,
    clientIps,
    ipHmacSecret: config.ipHmacSecret,
    publicOrigins: config.publicOrigins,
    requireWebSocketOrigin: config.nodeEnv === 'production',
    switches,
    invites,
    marketRelay,
    logger,
  });
  return runtime;
}
