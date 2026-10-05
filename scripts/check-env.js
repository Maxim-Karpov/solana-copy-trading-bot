// scripts/check-env.js — `npm run check-env`
// Shows which settings file the bot will use, which settings from
// .env.example you don't have yet (the bot uses their defaults), and any
// settings in your file the bot doesn't recognise (typos?). Never prints values.
const { compareWithExample, LOCAL, OUTSIDE } = require('../src/envFile');

const { file, missing, unknown } = compareWithExample();
if (!file) {
  console.log(`No settings file found. Create one of:\n  ${LOCAL}\n  ${OUTSIDE}\n(copy .env.example and fill it in)`);
  process.exit(1);
}
console.log(`Settings file: ${file}`);
console.log(
  missing.length
    ? `\nNot in your file (the bot uses their defaults; see .env.example for what they do):\n  ${missing.join('\n  ')}`
    : '\nYour file has every setting listed in .env.example.'
);
if (unknown.length) console.log(`\nIn your file but not in .env.example (typo, or an old setting?):\n  ${unknown.join('\n  ')}`);
