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
  populations: PopulationDirectory;
  admissions: AdmissionControl;
  clientIps: CanonicalIpResolver;
  requestLimits: SlidingWindowRateLimiter;
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
  const paymentVerifier: ChainPaymentVerifier = overrides.paymentVerifier ?? (config.solanaRpcUrl
    ? new SolanaRpcPaymentVerifier(config.solanaRpcUrl, config.solanaCluster)
    : new UnavailableChainPaymentVerifier());
  const quoteAuthorityReady = quoteAuthority.initialize
    ? await quoteAuthority.initialize().catch(() => false)
    : quoteAuthority.available;
  const paymentVerifierReady = paymentVerifier.initialize
    ? await paymentVerifier.initialize().catch(() => false)
    : paymentVerifier.available;
  if (config.nodeEnv === 'production' && (!quoteAuthorityReady || !paymentVerifierReady)) {
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
  const runtime: ServerRuntime = {
    config,
    db,
    anonymous,
    auth,
    economy,
    moderation,
    chatSafety,
    chatLimits,
    populations,
    admissions,
    clientIps,
    requestLimits,
    async dispose() {
      populations.clear();
      admissions.clear();
      requestLimits.clear();
      chatLimits.clear();
      if (!overrides.db) await db.destroy();
    },
  };
  configureRoomServices({
    auth,
    anonymous,
    chatSafety,
    chatLimits,
    moderation,
    populations,
    admissions,
    clientIps,
    ipHmacSecret: config.ipHmacSecret,
    publicOrigins: config.publicOrigins,
    requireWebSocketOrigin: config.nodeEnv === 'production',
  });
  return runtime;
}
