// Sample data for the demo only. Every number here comes from a seeded random walk, so the page looks the same
// on every load; none of it is a market price.

/** A small seeded generator (mulberry32), so the sample data is the same on every load. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A normally distributed number from two uniform ones (Box-Muller). */
const normal = (random) => Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());

/** OHLCV bars from a random walk with gentle trends and bursts of volatility. */
export function sampleBars({ count = 600, interval = 3600, start = 64000, seed = 7 } = {}) {
  const random = seeded(seed);
  const bars = [];
  const now = Math.floor(Date.UTC(2026, 9, 26, 12) / 1000);
  let price = start;
  let drift = 0;
  let volatility = 0.006;
  for (let i = 0; i < count; i++) {
    if (i % 60 === 0) drift = normal(random) * 0.0012;
    volatility = Math.min(0.02, Math.max(0.003, volatility * (0.9 + random() * 0.2)));
    const open = price;
    let high = open;
    let low = open;
    for (let step = 0; step < 6; step++) {
      price *= 1 + drift / 6 + (normal(random) * volatility) / Math.sqrt(6);
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    const move = Math.abs(price / open - 1);
    bars.push({
      time: now - (count - i) * interval,
      open,
      high: high * (1 + random() * volatility * 0.3),
      low: low * (1 - random() * volatility * 0.3),
      close: price,
      volume: 200 + 9000 * move * (0.6 + random()) + random() * 300,
    });
  }
  return bars;
}

/** A line ending at `last`, built backwards so every range lands on the same latest price. */
function walkTo(last, count, stepSeconds, volatility, random) {
  const points = new Array(count);
  const now = Math.floor(Date.UTC(2026, 9, 26, 20) / 1000);
  let value = last;
  for (let i = count - 1; i >= 0; i--) {
    points[i] = { time: now - (count - 1 - i) * stepSeconds, value };
    value /= 1 + normal(random) * volatility + volatility * 0.08;
  }
  return points;
}

/** One series per range, as a broker app shows them: a day in five-minute steps out to all of it in weeks. */
export function sampleRanges(last = 187.42, seed = 11) {
  const random = seeded(seed);
  const ranges = {
    "1D": walkTo(last, 78, 300, 0.0022, random),
    "1W": walkTo(last, 120, 3600, 0.004, random),
    "1M": walkTo(last, 120, 6 * 3600, 0.008, random),
    "3M": walkTo(last, 90, 86400, 0.014, random),
    "1Y": walkTo(last, 260, 86400, 0.016, random),
    ALL: walkTo(last, 260, 7 * 86400, 0.035, random),
  };
  return ranges;
}

/** An order book around `mid`: thin near the spread, deeper further out, with a few large resting orders. */
export function sampleBook(mid = 64012.5, seed = 3) {
  const random = seeded(seed);
  const bids = [];
  const asks = [];
  const tick = 0.5;
  for (let i = 0; i < 900; i++) {
    const distance = tick * (i + 1) * (1 + i / 120);
    const depth = 0.05 + (i / 900) * 0.8;
    const wall = random() < 0.012 ? 18 + random() * 40 : 0;
    bids.push([Math.round((mid - distance) / tick) * tick, depth * (0.2 + random() * 1.6) + wall]);
    asks.push([Math.round((mid + distance) / tick) * tick, depth * (0.2 + random() * 1.6) + (random() < 0.012 ? 18 + random() * 40 : 0)]);
  }
  return { bids, asks };
}

const SECTORS = {
  "Layer 1": [["BTC", "Bitcoin"], ["ETH", "Ethereum"], ["SOL", "Solana"], ["BNB", "BNB"], ["ADA", "Cardano"], ["AVAX", "Avalanche"], ["TON", "Toncoin"], ["SUI", "Sui"], ["APT", "Aptos"], ["NEAR", "Near"]],
  Payments: [["XRP", "XRP"], ["TRX", "Tron"], ["LTC", "Litecoin"], ["BCH", "Bitcoin Cash"], ["XLM", "Stellar"]],
  DeFi: [["LINK", "Chainlink"], ["UNI", "Uniswap"], ["AAVE", "Aave"], ["HYPE", "Hyperliquid"], ["JUP", "Jupiter"], ["LDO", "Lido"], ["PENDLE", "Pendle"], ["CRV", "Curve"]],
  Memes: [["DOGE", "Dogecoin"], ["SHIB", "Shiba Inu"], ["PEPE", "Pepe"], ["WIF", "dogwifhat"], ["BONK", "Bonk"], ["FLOKI", "Floki"]],
  "Layer 2": [["ARB", "Arbitrum"], ["OP", "Optimism"], ["MNT", "Mantle"], ["POL", "Polygon"], ["STRK", "Starknet"]],
  AI: [["TAO", "Bittensor"], ["FET", "Artificial Superintelligence"], ["RENDER", "Render"], ["WLD", "Worldcoin"]],
};

/** Tiles with sample values that fall off roughly like a real market, and sample daily changes. */
export function sampleTiles(seed = 21) {
  const random = seeded(seed);
  const tiles = [];
  let rank = 0;
  const order = Object.entries(SECTORS).flatMap(([group, coins]) => coins.map(([label, name]) => ({ group, label, name })));
  // Hand-set leaders keep the big two big, the way any market map looks; everything after falls off with rank.
  const leaders = { BTC: 1.27e12, ETH: 4.1e11 };
  for (const coin of order) {
    rank += 1;
    const value = leaders[coin.label] ?? 3e11 / (1 + rank * 0.55) ** 1.2 * (0.6 + random() * 0.9);
    const swing = coin.group === "Memes" ? 0.07 : coin.group === "AI" ? 0.05 : 0.03;
    tiles.push({ id: coin.label, label: coin.label, name: coin.name, group: coin.group, value, change: normal(random) * swing + 0.004 });
  }
  return tiles;
}
