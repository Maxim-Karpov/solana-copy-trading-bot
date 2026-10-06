// scripts/check-site.js — `npm run check-site -- <web page> <coin address>`
// Tries a web page exactly the way the bot does after a buy: would it be
// allowed (the safety filters), and does the page show the coin's address?
// Needs no settings file, wallet or RPC; changes nothing.
const coinLinks = require('../src/coinLinks');

const [url, mint] = process.argv.slice(2);
if (!url || !mint) {
  console.log('Usage: npm run check-site -- <web page> <coin address>\nExample: npm run check-site -- https://example.com/ So11111111111111111111111111111111111111112');
  process.exit(1);
}
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
  console.log('The coin address does not look like a Solana address (32-44 letters and digits).');
  process.exit(1);
}

(async () => {
  const t0 = Date.now();
  const line = (ok, text) => console.log(`${ok === null ? '·' : ok ? '✅' : '❌'} ${text}`);
  const cleaned = coinLinks.cleanLink(url);
  line(Boolean(cleaned), cleaned ? 'Looks like a normal web link' : 'Not a usable web link (must start with http:// or https:// and have a domain)');
  if (!cleaned) return;
  const why = await coinLinks.unsafeReason(cleaned);
  line(!why, why ? `Safety filter: the bot would NOT fetch this: ${why}` : 'Safety filter: allowed (https, a public host, no internal address)');
  if (why) {
    line(null, 'So after a buy the bot would show no address check for this page.');
    return;
  }
  const steps = [];
  const result = await coinLinks.siteMentions(cleaned, mint, { trace: (s) => steps.push(s) });
  for (const s of steps) {
    if (s.step === 'fetched') console.log(`  fetched ${s.url} -> HTTP ${s.status}`);
    if (s.step === 'read') console.log(`  read ${s.bytes} characters of the page`);
    if (s.step === 'refused') console.log(`  stopped at ${s.url}: ${s.why}`);
  }
  if (result === 'link') line(true, "The link itself is this coin's address page (nothing to fetch).");
  else if (result === 'page') line(true, "The page shows this coin's address.");
  else if (result === false) line(false, "The page does NOT show this coin's address. (Pages built by scripts may show it on screen without it being in the page text the bot can read.)");
  else {
    const last = steps.filter((s) => s.step === 'fetched').pop();
    line(null, `Couldn't read the page (${last && last.status >= 400 ? `the site answered HTTP ${last.status}, often a block on automated visits` : 'error, timeout after 2 s, too many redirects, or a redirect somewhere not allowed'}): the bot would show no address check.`);
  }
  console.log(`Took ${Date.now() - t0} ms.`);
})().catch((e) => { console.log('Failed:', e.message); process.exit(1); });
