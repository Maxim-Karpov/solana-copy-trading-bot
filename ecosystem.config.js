// ecosystem.config.js — settings for running the bot under pm2 on a server.
//   Start:   pm2 start ecosystem.config.js
//   Logs:    pm2 logs copybot
//   Status:  pm2 status
// With the Rust fast path built (fastpath/target/release/fastpath) and
// FAST_PATH="rust" in .env, it is started too: pm2 logs fastpath.
const fs = require('fs');
const path = require('path');

const FASTPATH_BIN = path.join(__dirname, 'fastpath', 'target', 'release', 'fastpath');

const apps = [
    {
      name: 'copybot',
      script: 'src/index.js',
      cwd: __dirname,

      // Restart automatically if the bot crashes...
      autorestart: true,
      // ...but NOT after a clean exit (exit code 0), which is what Telegram
      // /stop does. Otherwise pm2 would start it straight back up.
      stop_exit_codes: [0],
      // Give up after 15 crashes in a row that each happen within 10s of
      // starting (e.g. a bad .env value), instead of looping forever.
      max_restarts: 15,
      min_uptime: 10000,

      // `pm2 stop/restart` sends Ctrl+C (SIGINT); the bot then finishes any
      // buy/sell in progress, for up to 30s. pm2's default is to force-kill
      // after 1.6s, so give it 35s.
      kill_timeout: 35000,

      // Safety net against a memory leak.
      max_memory_restart: '800M'
    }
];

if (fs.existsSync(FASTPATH_BIN)) {
  apps.push({
    name: 'fastpath',
    script: FASTPATH_BIN,
    interpreter: 'none', // a compiled program, not JavaScript
    cwd: __dirname,
    autorestart: true,
    // It exits cleanly (code 0) when FAST_PATH isn't "rust": stay stopped then.
    stop_exit_codes: [0],
    max_restarts: 15,
    min_uptime: 10000,
    kill_timeout: 5000
  });
}

module.exports = { apps };
