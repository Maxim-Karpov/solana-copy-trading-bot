// src/envFile.js
//
// Where the bot's settings come from, and which ones are new.
//
// Settings are read from (first one found):
//   1. .env in the bot folder (as before), or
//   2. copybot.env in the folder ABOVE the bot folder (e.g. next to it on
//      your Desktop, or ~/copybot.env on the server). Keeping it there means
//      you can delete/replace the whole bot folder on an update and your
//      settings stay put.
// Settings already set in the environment always win.

const fs = require('fs');
const path = require('path');

const botDir = path.join(__dirname, '..');
const LOCAL = path.join(botDir, '.env');
const OUTSIDE = path.join(botDir, '..', 'copybot.env');
const EXAMPLE = path.join(botDir, '.env.example');

/** Path of the settings file in use, or null. */
function findEnvFile() {
  if (fs.existsSync(LOCAL)) return LOCAL;
  if (fs.existsSync(OUTSIDE)) return OUTSIDE;
  return null;
}

/** Setting names assigned in a .env-style file (KEY=value lines; with includeCommented, also "# KEY=value"). */
function keysIn(file, { includeCommented = false } = {}) {
  if (!file || !fs.existsSync(file)) return [];
  const keys = [];
  const re = includeCommented ? /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/ : /^\s*([A-Z][A-Z0-9_]*)\s*=/;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = re.exec(line);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

/**
 * Compare your settings file with .env.example:
 * { file, missing: settings in the example your file doesn't mention at all
 *   (new since you made it; defaults used),
 *   unknown: settings you have that the example doesn't mention }.
 */
function compareWithExample(file = findEnvFile()) {
  const mine = keysIn(file);
  // A setting left commented out in your file ("# KEY=...") isn't new to you.
  const mentioned = keysIn(file, { includeCommented: true });
  const example = keysIn(EXAMPLE, { includeCommented: true });
  if (!example.length) return { file, missing: [], unknown: [] };
  return {
    file,
    missing: example.filter((k) => !mentioned.includes(k)),
    unknown: mine.filter((k) => !example.includes(k))
  };
}

module.exports = { findEnvFile, keysIn, compareWithExample, LOCAL, OUTSIDE, EXAMPLE };
