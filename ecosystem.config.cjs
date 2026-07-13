module.exports = {
  apps: [
    {
      name: 'tickerworld-multiplayer',
      cwd: __dirname,
      script: 'server/dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      time: true,
      wait_ready: true,
      listen_timeout: 30_000,
      kill_timeout: 10_000,
      max_memory_restart: '768M',
      env: {
        NODE_ENV: 'production',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
