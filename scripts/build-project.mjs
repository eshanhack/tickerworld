import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is required to build Tickerworld.');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNpm(args) {
  run(process.execPath, [npmCli, ...args]);
}

if (process.env.COLYSEUS_CLOUD !== undefined) {
  // Colyseus Cloud may be connected to the monorepo root rather than server/.
  // Install only the backend workspaces it needs, build them, and let the root
  // ecosystem file start server/dist/index.js. A server/ root configuration
  // continues to use server/package.json directly.
  runNpm(['install', '--include=dev', '--no-package-lock', '--prefix', 'shared']);
  runNpm(['install', '--include=dev', '--no-package-lock', '--prefix', 'server']);
  runNpm(['run', 'build', '--prefix', 'server']);
} else {
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
  run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
  run(process.execPath, ['scripts/generate-route-shells.mjs']);
  run(process.execPath, ['scripts/verify-release-assets.mjs']);
}
