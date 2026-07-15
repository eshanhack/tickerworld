import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const require = createRequire(import.meta.url);

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')) as Record<string, unknown>;
}

describe('delivery configuration', () => {
  it('keeps production X ingestion enabled in the tracked process config', () => {
    const ecosystem = readFileSync(join(ROOT, 'ecosystem.config.cjs'), 'utf8');
    expect(ecosystem).toContain("TICKERWORLD_LIVE_NEWS: 'true'");
  });
  it('uses one stable local client origin', () => {
    const packageJson = readJson('package.json');
    const scripts = packageJson.scripts as Record<string, string>;
    for (const scriptName of ['dev', 'preview']) {
      expect(scripts[scriptName]).toContain('--host 127.0.0.1');
      expect(scripts[scriptName]).toContain('--port 4173');
      expect(scripts[scriptName]).toContain('--strictPort');
    }

    expect(readFileSync(join(ROOT, '.env.example'), 'utf8')).toContain(
      'VITE_MULTIPLAYER_URL=ws://127.0.0.1:2567',
    );
    expect(readFileSync(join(ROOT, 'server/.env.example'), 'utf8')).toContain(
      'PUBLIC_ORIGIN=http://127.0.0.1:4173',
    );
  });

  it('keeps the Vercel client build and SPA fallback explicit', () => {
    const vercel = readJson('vercel.json');
    expect(vercel.framework).toBe('vite');
    expect(vercel.buildCommand).toBe('npm run build');
    expect(vercel.outputDirectory).toBe('dist');
    const packageJson = readJson('package.json');
    expect((packageJson.scripts as Record<string, string>).build)
      .toBe('node scripts/build-project.mjs');
    const buildProject = readFileSync(join(ROOT, 'scripts/build-project.mjs'), 'utf8');
    expect(buildProject).toContain("['scripts/verify-release-assets.mjs']");
    expect(buildProject).toContain("process.env.COLYSEUS_CLOUD !== undefined");
    const rewrites = vercel.rewrites as Array<Record<string, unknown>>;
    for (const slug of ['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'link', 'avax', 'wti', 'test']) {
      expect(rewrites).toContainEqual({ source: `/${slug}`, destination: `/${slug}.html` });
    }
    expect(rewrites.at(-1)).toEqual({ source: '/(.*)', destination: '/index.html' });

    const redirects = vercel.redirects as Array<Record<string, unknown>>;
    for (const host of ['game-tickerworld.vercel.app', 'www.tickerworld.io']) {
      expect(redirects).toContainEqual(expect.objectContaining({
        source: '/:path*',
        destination: 'https://tickerworld.io/:path*',
        permanent: true,
        has: [{ type: 'host', value: host }],
      }));
    }
    const headers = vercel.headers as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    expect(headers.find(({ source }) => source === '/admin')?.headers)
      .toContainEqual({ key: 'X-Robots-Tag', value: 'noindex, nofollow' });
    expect(headers.find(({ source }) => source === '/(.*)')?.headers)
      .toContainEqual({ key: 'X-Content-Type-Options', value: 'nosniff' });
  });

  it('documents fail-closed Vercel/server environments and comprehensive smoke gates', () => {
    const clientEnv = readFileSync(join(ROOT, '.env.example'), 'utf8');
    expect(clientEnv).toContain('VITE_MULTIPLAYER_URL=ws://127.0.0.1:2567');
    expect(clientEnv).toContain('NEWS_CACHE_ORIGIN=http://127.0.0.1:2567');
    expect(clientEnv).not.toMatch(/^X_BEARER_TOKEN=/m);

    const serverEnv = readFileSync(join(ROOT, 'server/.env.example'), 'utf8');
    expect(serverEnv).toContain('ENABLE_DIRECT_MARKET_FALLBACK=true');
    expect(serverEnv).toContain('ENABLE_PUBLIC_WALLET_AUTH=false');
    expect(serverEnv).toContain('ENABLE_PURCHASES=false');
    expect(serverEnv).toContain('X_BEARER_TOKEN=');

    const smoke = readFileSync(join(ROOT, 'scripts/smoke-production.mjs'), 'utf8');
    for (const contract of [
      '/api/capabilities',
      'maxPlayersPerShard === 50',
      'publicWalletAuth === false',
      'purchases === false',
      '1200×630',
      '/privacy',
      '/terms',
      '/community',
      '/support',
      '/status',
    ]) expect(smoke).toContain(contract);
  });

  it('runs exactly one readiness-aware Colyseus process', () => {
    const ecosystem = require(join(ROOT, 'server/ecosystem.config.cjs')) as {
      apps?: Array<Record<string, unknown>>;
    };
    expect(ecosystem.apps).toHaveLength(1);
    expect(ecosystem.apps?.[0]).toMatchObject({
      cwd: join(ROOT, 'server'),
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      wait_ready: true,
      env: { NODE_ENV: 'production' },
      env_production: { NODE_ENV: 'production' },
    });

    const rootEcosystem = require(join(ROOT, 'ecosystem.config.cjs')) as {
      apps?: Array<Record<string, unknown>>;
    };
    expect(rootEcosystem.apps).toHaveLength(1);
    expect(rootEcosystem.apps?.[0]).toMatchObject({
      cwd: ROOT,
      script: 'server/dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      wait_ready: true,
      env: { NODE_ENV: 'production' },
    });
  });

  it('keeps dependency audits in the release gate', () => {
    const packageJson = readJson('package.json');
    const scripts = packageJson.scripts as Record<string, string>;
    expect(scripts['audit:release']).toContain('npm audit --audit-level=high');
    expect(scripts['audit:release']).toContain('npm --prefix server audit --audit-level=high');
    expect(scripts['verify:release']).toContain('npm run audit:release');
  });

  it('never tracks cloud credentials or local databases', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    for (const pattern of [
      '.colyseus-cloud.json',
      'server/data/',
      'server/**/*.sqlite',
      'server/**/*.sqlite-*',
      'server/dist/',
      'shared/dist/',
    ]) {
      expect(ignore).toContain(pattern);
    }
    const dockerIgnore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    expect(dockerIgnore).toContain('**/.colyseus-cloud.json');
    expect(dockerIgnore).toContain('**/data');
  });
});
