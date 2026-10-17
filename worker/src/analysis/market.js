/**
 * The market snapshot the robot uses. OUR OWN trade data first (candles built from the live feed: real-time, no
 * third-party call); the outside price service is only a fallback for coins we have not watched, such as older
 * coins the scanner finds. Set OWN_DATA_ONLY=true to switch that fallback off completely.
 */
const collector = require('../data/collector');
const dex = require('./dexscreener');

async function getTokenMarket(mint) {
  const own = collector.marketFor(mint);
  if (own) return own;
  if (process.env.OWN_DATA_ONLY === 'true') return null;
  return dex.getTokenMarket(mint);
}
module.exports = { getTokenMarket };
