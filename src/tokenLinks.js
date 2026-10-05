// src/tokenLinks.js
//
// Builds a quick "view this token" link for external platforms, so a fresh
// buy prints something you can click straight from the terminal instead of
// having to paste the mint address in manually.

/**
 * Axiom Trade's token page URL, keyed by mint address.
 * NOTE: this URL pattern (axiom.trade/meme/<mint>) is not from Axiom's own
 * official docs — it was corroborated from community tooling, not verified
 * against a live render. If it 404s or lands on the wrong token for you,
 * tell me the correct pattern and this one-liner gets fixed immediately.
 */
function axiomLink(mint) {
  return `https://axiom.trade/meme/${mint}`;
}

module.exports = { axiomLink };
