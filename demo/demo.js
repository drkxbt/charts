import { CandleChart, DepthChart, Heatmap, LineChart, formatChange } from "../dist/index.js";
import { sampleBars, sampleBook, sampleRanges, sampleTiles } from "./data.js";

const $ = (selector) => document.querySelector(selector);

/** A segmented control: one pressed button, and a callback with its value. */
function segmented(group, onChange) {
  const buttons = [...group.querySelectorAll("button")];
  for (const button of buttons) {
    button.addEventListener("click", () => {
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
      onChange(button.value);
    });
  }
}

// Candles.
let interval = 3600;
const candles = new CandleChart($("[data-candles]"), {
  bars: sampleBars({ interval }),
  visible: 120,
  label: "Sample BTC/USDT chart, 1 hour candles. Scroll to zoom, drag to pan, drag the price axis to stretch it. Arrow keys read each bar.",
});
segmented($("[data-candle-mode]"), (mode) => candles.setMode(mode));
segmented($("[data-candle-interval]"), (value) => {
  interval = Number(value);
  candles.setBars(sampleBars({ interval, count: interval >= 86400 ? 400 : 600 }), interval >= 86400 ? 160 : 120);
});

// Line: the headline number follows the scrub and falls back to the latest value.
const ranges = sampleRanges();
const value = $("[data-quote-value]");
const change = $("[data-quote-change]");
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const rangeName = { "1D": "Today", "1W": "Past week", "1M": "Past month", "3M": "Past 3 months", "1Y": "Past year", ALL: "All time" };
let range = "1D";

function headline(point, ratio) {
  const reference = ranges[range][0].value;
  value.textContent = usd.format(point.value);
  change.textContent = `${point.value >= reference ? "+" : "−"}${usd.format(Math.abs(point.value - reference))} (${formatChange(ratio)}) ${rangeName[range]}`;
  // The page's accent follows the line: green when up on the range, orange-red when down.
  document.querySelector("[data-line]").closest(".card").style.setProperty("--quote-color", ratio >= 0 ? "#00c805" : "#ff5000");
}

function showLatest() {
  const points = ranges[range];
  const last = points[points.length - 1];
  headline(last, last.value / points[0].value - 1);
}

const line = new LineChart($("[data-line]"), {
  points: ranges[range],
  reference: ranges[range][0].value,
  live: true,
  label: "Sample stock price line. Move across it to read each point; arrow keys step through them.",
  onScrub: (state) => (state ? headline(state.point, state.change) : showLatest()),
});
showLatest();
segmented($("[data-line-range]"), (next) => {
  range = next;
  line.setData(ranges[range], ranges[range][0].value);
  showLatest();
});

// Order book depth.
const book = sampleBook();
const depth = new DepthChart($("[data-depth]"), {
  bids: book.bids,
  asks: book.asks,
  base: "BTC",
  quote: "USDT",
  range: 0.012,
  label: "Sample BTC/USDT order book depth. Hover to read the total at a price, scroll to widen or narrow the range.",
});

// Market heatmap.
const heatmap = new Heatmap($("[data-heatmap]"), {
  tiles: sampleTiles(),
  label: "Sample crypto market heatmap. Tile size is market value, colour is the day's change. Click a sector to zoom in, Escape to zoom out.",
});

// The theme lives in CSS variables; the charts pick them up on their next paint.
const toggle = $("[data-theme-toggle]");
toggle?.addEventListener("click", () => {
  const light = document.documentElement.dataset.theme !== "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  toggle.textContent = light ? "Dark" : "Light";
  toggle.setAttribute("aria-label", `Switch to the ${light ? "dark" : "light"} theme`);
  for (const chart of [candles, line, depth, heatmap]) chart.redraw();
});

export { candles, line, depth, heatmap };
