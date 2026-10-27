// ============================================================================
// PM2 PROCESS FILE
//
//   pm2 start ecosystem.config.js --env production
//   pm2 save && pm2 startup
//
// One process per VPS is enough: background jobs are guarded by a PostgreSQL
// job lease, so extra instances would simply idle instead of double-polling.
// Secrets are NOT written here — PM2 reads the environment of the shell that
// starts it. Keep real values in /etc/finzz/finzz.env (chmod 600) and start
// with: set -a; . /etc/finzz/finzz.env; set +a; pm2 start ecosystem.config.js
// ============================================================================
export default {
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
      kill_timeout: 15000, // matches the graceful shutdown budget in server.js
      wait_ready: false,
      max_memory_restart: '512M',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        LOG_LEVEL: 'info',
        // Cloudflare Tunnel terminates TLS in front of this port; the tunnel
        // must reach 127.0.0.1:3000 and never be exposed directly to the VPS NIC.
        TRUST_PROXY: 'true',
        JOBS_ENABLED: 'true',
        ORDER_POLLER_ENABLED: 'true',
        RECONCILIATION_ENABLED: 'true'
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
      env_file: undefined
    }
  ]
};
