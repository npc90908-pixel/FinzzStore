// ============================================================================
// PM2 PROCESS FILE — CommonJS fallback for PM2 versions that cannot load the
// ESM ecosystem.config.js (PM2 < 5.3). Same content, keep both in sync.
//   pm2 start ecosystem.config.cjs --env production
// ============================================================================
module.exports = {
  apps: [
    {
      name: 'finzz-store',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 12,
      min_uptime: '20s',
      restart_delay: 2000,
      kill_timeout: 15000,
      max_memory_restart: '512M',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        LOG_LEVEL: 'info',
        TRUST_PROXY: 'true',
        JOBS_ENABLED: 'true',
        ORDER_POLLER_ENABLED: 'true',
        RECONCILIATION_ENABLED: 'true'
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true
    }
  ]
};
