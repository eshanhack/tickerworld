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
    expect(vercel.rewrites).toContainEqual({ source: '/(.*)', destination: '/index.html' });
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
