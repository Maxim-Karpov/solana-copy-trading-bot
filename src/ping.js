// src/ping.js
//
// Round-trip time to a server, with the system's own `ping` (ICMP; no special
// rights needed on Ubuntu/Debian). Returns the fastest of a few replies in ms,
// or null when there was no reply (many servers drop ping) or `ping` isn't
// installed.

const { execFile } = require('child_process');

let missing = false; // `ping` isn't installed

function ping(ip, { count = 3, timeoutSec = 1 } = {}) {
  if (missing || !ip) return Promise.resolve(null);
  const args = [...(ip.includes(':') ? ['-6'] : []), '-n', '-q', '-c', String(count), '-i', '0.2', '-W', String(timeoutSec), ip];
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: (count * 0.2 + timeoutSec + 2) * 1000 }, (err, stdout) => {
      if (err && err.code === 'ENOENT') {
        missing = true;
        resolve(null);
        return;
      }
      resolve(parseRtt(stdout));
    });
  });
}

/** The minimum round trip from ping's summary line ("rtt min/avg/max/mdev = 0.9/1.2/1.6/0.2 ms"). */
function parseRtt(out) {
  const m = /(?:rtt|round-trip)[^=]*=\s*([\d.]+)\//.exec(out || '');
  return m ? Math.round(Number(m[1]) * 10) / 10 : null;
}

function isAvailable() {
  return !missing;
}

module.exports = { ping, parseRtt, isAvailable };
