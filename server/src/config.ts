import { randomBytes } from 'node:crypto';

export interface ServerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string | null;
  databaseSsl: 'disable' | 'verify-full';
  sqlitePath: string;
  publicOrigins: readonly string[];
  trustedProxyCidrs: readonly string[];
  serverHmacSecret: string;
  ipHmacSecret: string;
  treasuryAddress: string | null;
  solanaCluster: 'devnet' | 'mainnet-beta';
  solanaRpcUrl: string | null;
  solUsdPriceUrl: string | null;
  adminWallets: ReadonlySet<string>;
  devSolUsdPrice: number | null;
  limits: {
    maxProcessConnections: number;
    maxRooms: number;
    maxMarketShards: number;
    maxConcurrentConnectionsPerIp: number;
    actorJoinsPerMinute: number;
    ipJoinsPerMinute: number;
    anonymousSessionsPerMinute: number;
    authChallengesPerMinuteByIp: number;
    authChallengesPerMinuteByWallet: number;
    purchaseQuotesPerHour: number;
    purchaseConfirmsPerMinute: number;
  };
}

function envString(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function parseSecret(env: NodeJS.ProcessEnv, key: string, production: boolean): string {
  const value = envString(env, key);
  if (value && value.length >= 32) return value;
  if (production) throw new Error(`${key} must contain at least 32 characters in production`);
  return randomBytes(32).toString('hex');
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = envString(env, key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function isSolanaAddress(value: string): boolean {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let numeric = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return false;
    numeric = numeric * 58n + BigInt(digit);
  }
  let nonZeroBytes = 0;
  while (numeric > 0n) {
    nonZeroBytes += 1;
    numeric >>= 8n;
  }
  const leadingZeroBytes = value.match(/^1*/)?.[0].length ?? 0;
  return leadingZeroBytes + nonZeroBytes === 32;
}

function requireHttpsUrl(value: string | null, key: string, production: boolean): string | null {
  if (!value) {
    if (production) throw new Error(`${key} is required in production`);
    return null;
  }
  try {
    const url = new URL(value);
    if (production && url.protocol !== 'https:') throw new Error('https required');
  } catch {
    throw new Error(`${key} must be a valid${production ? ' HTTPS' : ''} URL`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawEnvironment = envString(env, 'NODE_ENV') ?? 'development';
  const nodeEnv = rawEnvironment === 'production'
    ? 'production'
    : rawEnvironment === 'test'
      ? 'test'
      : 'development';
  const production = nodeEnv === 'production';
  const databaseUrl = envString(env, 'DATABASE_URL');
  if (production && !databaseUrl) {
    throw new Error('DATABASE_URL is required in production; SQLite is development-only');
  }
  const databaseSslValue = envString(env, 'DATABASE_SSL');
  if (databaseSslValue && databaseSslValue !== 'disable' && databaseSslValue !== 'verify-full') {
    throw new Error('DATABASE_SSL must be disable or verify-full');
  }
  const databaseSsl: ServerConfig['databaseSsl'] = databaseSslValue as ServerConfig['databaseSsl'] | null
    ?? (databaseUrl && !/^(?:postgres(?:ql)?:\/\/)?(?:[^@]+@)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i.test(databaseUrl)
      ? 'verify-full'
      : 'disable');
  if (production && databaseSslValue !== 'verify-full') {
    throw new Error('DATABASE_SSL=verify-full is required explicitly in production');
  }

  const rawPort = Number(envString(env, 'PORT') ?? '2567');
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65_535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  const clusterValue = envString(env, 'SOLANA_CLUSTER');
  const solanaCluster = production
    ? 'mainnet-beta'
    : clusterValue === 'mainnet-beta'
      ? 'mainnet-beta'
      : 'devnet';
  const treasuryAddress = envString(env, 'TREASURY_ADDRESS');
  if (production && (!treasuryAddress || !isSolanaAddress(treasuryAddress))) {
    throw new Error('TREASURY_ADDRESS must be a valid Solana address in production');
  }
  const solanaRpcUrl = requireHttpsUrl(envString(env, 'SOLANA_RPC_URL'), 'SOLANA_RPC_URL', production);
  const solUsdPriceUrl = requireHttpsUrl(envString(env, 'SOL_USD_PRICE_URL'), 'SOL_USD_PRICE_URL', production);
  const adminWallets = (envString(env, 'ADMIN_WALLETS') ?? '')
    .split(',')
    .map((wallet) => wallet.trim())
    .filter(Boolean);
  if (production && (adminWallets.length === 0 || adminWallets.some((wallet) => !isSolanaAddress(wallet)))) {
    throw new Error('ADMIN_WALLETS must contain at least one valid Solana address in production');
  }

  const devPrice = Number(envString(env, 'DEV_SOL_USD_PRICE'));
  const devSolUsdPrice = !production && Number.isFinite(devPrice) && devPrice > 0
    ? devPrice
    : null;
  const publicOriginValue = envString(env, 'PUBLIC_ORIGIN');
  if (production && !publicOriginValue) {
    throw new Error('PUBLIC_ORIGIN is required explicitly in production');
  }
  const publicOrigins = (publicOriginValue ?? 'http://127.0.0.1:4173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      let url: URL;
      try { url = new URL(origin); } catch { throw new Error('PUBLIC_ORIGIN must contain valid origins'); }
      const normalizedInput = origin.replace(/\/$/, '');
      if ((production && url.protocol !== 'https:')
        || url.origin !== normalizedInput
        || url.username
        || url.password) {
        throw new Error('PUBLIC_ORIGIN must contain exact HTTPS origins without paths or credentials');
      }
      return url.origin;
    });
  const trustedProxyCidrs = (envString(env, 'TRUSTED_PROXY_CIDRS') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (production && trustedProxyCidrs.length === 0) {
    throw new Error('TRUSTED_PROXY_CIDRS is required in production');
  }

  return {
    nodeEnv,
    port: rawPort,
    databaseUrl,
    databaseSsl,
    sqlitePath: envString(env, 'SQLITE_PATH') ?? './data/tickerworld.sqlite',
    publicOrigins,
    trustedProxyCidrs,
    serverHmacSecret: parseSecret(env, 'SERVER_HMAC_SECRET', production),
    ipHmacSecret: parseSecret(env, 'IP_HMAC_SECRET', production),
    treasuryAddress,
    solanaCluster,
    solanaRpcUrl,
    solUsdPriceUrl,
    adminWallets: new Set(adminWallets),
    devSolUsdPrice,
    limits: {
      maxProcessConnections: positiveInteger(env, 'MAX_PROCESS_CONNECTIONS', 400),
      maxRooms: positiveInteger(env, 'MAX_ROOMS', 16),
      maxMarketShards: positiveInteger(env, 'MAX_MARKET_SHARDS', 8),
      maxConcurrentConnectionsPerIp: positiveInteger(env, 'MAX_CONCURRENT_PER_IP', 20),
      actorJoinsPerMinute: positiveInteger(env, 'ACTOR_JOINS_PER_MINUTE', 12),
      ipJoinsPerMinute: positiveInteger(env, 'IP_JOINS_PER_MINUTE', 30),
      anonymousSessionsPerMinute: positiveInteger(env, 'ANONYMOUS_SESSIONS_PER_MINUTE', 10),
      authChallengesPerMinuteByIp: positiveInteger(env, 'AUTH_CHALLENGES_PER_MINUTE_IP', 5),
      authChallengesPerMinuteByWallet: positiveInteger(env, 'AUTH_CHALLENGES_PER_MINUTE_WALLET', 5),
      purchaseQuotesPerHour: positiveInteger(env, 'PURCHASE_QUOTES_PER_HOUR', 10),
      purchaseConfirmsPerMinute: positiveInteger(env, 'PURCHASE_CONFIRMS_PER_MINUTE', 12),
    },
  };
}
