/**
 * PM2 ecosystem configuration for claude-threads
 *
 * Installation:
 *   1. Copy this file to your deployment directory
 *   2. Edit the cwd and env settings as needed
 *   3. Run: pm2 start ecosystem.config.js
 *   4. Run: pm2 save (to persist across reboots)
 *   5. Run: pm2 startup (to enable PM2 on boot)
 *
 * The configuration uses the daemon wrapper which handles exit code 42
 * for automatic restarts after updates.
 */

module.exports = {
  apps: [
    {
      name: 'claude-threads',

      // Use the daemon wrapper for update restarts
      script: 'claude-threads-daemon',

      // Alternative: Run claude-threads directly (no update restarts)
      // script: 'claude-threads',

      // Working directory
      cwd: '/home/your-username/projects',

      // Environment variables
      env: {
        NODE_ENV: 'production',
        // DEBUG: '1',  // Uncomment for debug logging
      },

      // The daemon handles update restarts (exit code 42)
      // PM2 handles unexpected crashes
      // exit code 42 should NOT trigger PM2 restart (daemon handles it)
      stop_exit_codes: [0, 42],

      // PM2 restart settings for unexpected crashes
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // Watch mode (disable for production)
      watch: false,

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/log/pm2/claude-threads-error.log',
      out_file: '/var/log/pm2/claude-threads-out.log',
      merge_logs: true,

      // Resource limits
      max_memory_restart: '500M',

      // Instance settings (keep at 1 for claude-threads)
      instances: 1,
      exec_mode: 'fork',
    },
  ],
};
