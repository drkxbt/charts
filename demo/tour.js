// A looping tour of each chart: a scripted pointer hovers, scrolls, clicks and presses keys while the data keeps
// moving, so a screen recording of this page shows the charts in use. The README previews are recorded from it.
import { depth, heatmap } from "./demo.js";
import { sampleBook, sampleTiles } from "./data.js";

// One loop of every tour. All four share it, so the grid of four repeats as one.
const PERIOD = 10_000;
const TAU = Math.PI * 2;
const GOLDEN_ANGLE = 2.39996;

const page = document.querySelector("[data-tour]");
const requested = new URLSearchParams(location.search).get("chart");
const only = ["candles", "line", "depth", "heatmap"].includes(requested) ? requested : null;
page.dataset.chart = only ?? "all";
for (const card of page.querySelectorAll("[data-card]")) card.hidden = only !== null && card.dataset.card !== only;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const smooth = (t) => t * t * (3 - 2 * t);
const chartIn = (selector) => document.querySelector(`${selector} .chart-root`);

/** Whether a scheduled time fell between the last frame and this one, across the loop's wrap too. */
const crossed = (previous, now, time) => (previous <= now ? previous < time && time <= now : time > previous || time <= now);

/** A point at fractions of an element's box, in the card's own pixels. */
const within = (element, fx, fy) => (card) => {
  const box = element.getBoundingClientRect();
  const origin = card.getBoundingClientRect();
  return { x: box.left - origin.left + box.width * fx, y: box.top - origin.top + box.height * fy };
};

const POINTER_SVG = `<svg class="ghost" viewBox="0 0 20 20" aria-hidden="true">
  <path d="M3.5 2.2v13.6l3.6-3.4 2.4 5.4 2.5-1.1-2.4-5.3h5z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`;

/** One card's tour: the pointer glides between keyframes, each a time and a place, and events fire on schedule. */
class Tour {
  constructor(card, target, keyframes, events = []) {
    this.card = card;
    this.target = target;
    this.keyframes = keyframes;
    this.events = events;
    this.segment = -1;
    this.from = null;
    this.at = null;
    this.inside = false;
    card.insertAdjacentHTML("beforeend", POINTER_SVG);
    this.pointer = card.lastElementChild;
  }

  step(t, previous) {
    for (const [time, run] of this.events) if (crossed(previous, t, time)) run(this);

    let index = this.keyframes.length - 1;
    while (index > 0 && this.keyframes[index][0] > t) index--;
    const [start, place] = this.keyframes[index];
    const [end, next] = this.keyframes[index + 1] ?? [PERIOD, this.keyframes[0][1]];
    // Each leg starts from wherever the pointer is, so a target that moves (a tile after a zoom) never makes it jump.
    if (index !== this.segment) {
      this.segment = index;
      this.from = this.at ?? place(this.card);
    }
    const to = next(this.card);
    const u = smooth(clamp((t - start) / (end - start), 0, 1));
    this.at = { x: this.from.x + (to.x - this.from.x) * u, y: this.from.y + (to.y - this.from.y) * u };
    this.pointer.style.transform = `translate(${this.at.x}px, ${this.at.y}px)`;
    this.move();
  }

  client() {
    const origin = this.card.getBoundingClientRect();
    return { clientX: origin.left + this.at.x, clientY: origin.top + this.at.y };
  }

  move() {
    const point = this.client();
    const box = this.target.getBoundingClientRect();
    const inside = point.clientX >= box.left && point.clientX <= box.right && point.clientY >= box.top && point.clientY <= box.bottom;
    if (inside) {
      this.target.dispatchEvent(new PointerEvent("pointermove", { ...point, bubbles: true, pointerType: "mouse", isPrimary: true }));
    } else if (this.inside) {
      this.target.dispatchEvent(new PointerEvent("pointerleave", { ...point, pointerType: "mouse", isPrimary: true }));
    }
    this.inside = inside;
  }

  click(element) {
    const ring = document.createElement("span");
    ring.className = "ghost-click";
    ring.style.transform = `translate(${this.at.x}px, ${this.at.y}px)`;
    ring.addEventListener("animationend", () => ring.remove());
    this.card.append(ring);
    if (element) element.click();
    else this.target.dispatchEvent(new MouseEvent("click", { ...this.client(), bubbles: true }));
  }

  wheel(deltaY) {
    this.target.dispatchEvent(new WheelEvent("wheel", { ...this.client(), deltaY, bubbles: true, cancelable: true }));
  }

  key(key) {
    this.target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }
}

/** `count` wheel ticks `every` milliseconds apart from `start`. Zooming in and back out by the same ticks at the
 *  same spot lands exactly where it began, which keeps the loop seamless. */
const wheels = (start, count, every, deltaY) => Array.from({ length: count }, (_, i) => [start + i * every, (tour) => tour.wheel(deltaY)]);

function candlesTour(card) {
  const chart = chartIn("[data-candles]");
  const at = (fx, fy) => within(chart, fx, fy);
  return new Tour(card, chart, [
    [0, at(0.06, 0.42)],
    [1300, at(0.4, 0.56)],
    [2600, at(0.76, 0.34)],
    [3900, at(0.76, 0.34)],
    [4900, at(0.56, 0.52)],
    [5800, at(0.76, 0.34)],
    [6900, at(0.76, 0.34)],
    [8500, at(0.3, 0.28)],
  ], [...wheels(3000, 8, 90, -70), ...wheels(6000, 8, 90, 70)]);
}

function lineTour(card) {
  const chart = chartIn("[data-line]");
  const tab = (range) => card.querySelector(`[data-line-range] button[value="${range}"]`);
  const on = (range) => within(tab(range), 0.5, 0.55);
  const press = (range) => (tour) => tour.click(tab(range));
  return new Tour(card, chart, [
    [0, within(chart, 0.01, 0.5)],
    [2800, within(chart, 0.99, 0.5)],
    [3600, on("1M")],
    [4900, on("1Y")],
    [6200, on("ALL")],
    [7600, on("1W")],
    [9000, on("1D")],
  ], [[3650, press("1M")], [4950, press("1Y")], [6250, press("ALL")], [7650, press("1W")], [9050, press("1D")]]);
}

function depthTour(card) {
  const chart = chartIn("[data-depth]");
  const at = (fx, fy) => within(chart, fx, fy);
  return new Tour(card, chart, [
    [0, at(0.03, 0.62)],
    [3000, at(0.88, 0.42)],
    [4300, at(0.88, 0.42)],
    [6000, at(0.14, 0.62)],
    [7300, at(0.14, 0.62)],
    [8600, at(0.3, 0.55)],
  ], [...wheels(3400, 6, 100, -80), ...wheels(6400, 6, 100, 80)]);
}

function heatmapTour(card) {
  const chart = chartIn("[data-heatmap]");
  const tile = (id, fx = 0.5, fy = 0.5) => (from) => {
    const rect = heatmap.tileRect(id);
    if (!rect) return within(chart, 0.5, 0.5)(from);
    const box = chart.getBoundingClientRect();
    const origin = from.getBoundingClientRect();
    return { x: box.left - origin.left + rect.x + rect.w * fx, y: box.top - origin.top + rect.y + rect.h * fy };
  };
  // Hover low in each tile: the tooltip opens below the pointer and the label sits in the middle.
  return new Tour(card, chart, [
    [0, tile("BTC", 0.4, 0.72)],
    [1300, tile("BTC", 0.6, 0.78)],
    [2100, tile("ETH", 0.4, 0.76)],
    [2900, tile("ETH", 0.6, 0.82)],
    [3700, tile("JUP")],
    [4500, tile("JUP", 0.5, 0.78)],
    [5300, tile("UNI", 0.5, 0.8)],
    [6100, tile("LDO", 0.5, 0.8)],
    [6500, tile("LDO", 0.5, 0.8)],
    [7500, tile("SOL", 0.4, 0.8)],
    [8600, tile("SOL", 0.6, 0.84)],
  ], [[3800, (tour) => tour.click()], [6550, (tour) => tour.key("Escape")]]);
}

// The data breathes on the same loop as the pointer, so the last frame flows into the first.
const book = sampleBook();
function liveBook(t) {
  const wave = (i) => 1 + 0.14 * Math.sin((TAU * 2 * t) / PERIOD + i * GOLDEN_ANGLE);
  depth.setBook(book.bids.map(([price, size], i) => [price, size * wave(i)]), book.asks.map(([price, size], i) => [price, size * wave(i + 7)]));
}

const tiles = sampleTiles();
// A new set of tiles restarts the heatmap's glide, so none arrive while a zoom is under way.
const ZOOMS = [[3600, 4500], [6400, 7300]];
function liveTiles(t) {
  if (ZOOMS.some(([from, to]) => t >= from && t <= to)) return;
  heatmap.setTiles(tiles.map((tile, i) => ({ ...tile, change: tile.change + 0.012 * Math.sin((TAU * t) / PERIOD + i * GOLDEN_ANGLE) })));
}

const builders = { candles: candlesTour, line: lineTour, depth: depthTour, heatmap: heatmapTour };
const shown = only ? [only] : Object.keys(builders);

await document.fonts.ready;
await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

const tours = shown.map((name) => builders[name](document.querySelector(`[data-card="${name}"]`)));
const start = performance.now();
// For a recorder: the loop's period and its first frame in wall-clock milliseconds, to cut exactly one loop.
window.tour = { period: PERIOD, start: performance.timeOrigin + start };

let previous = -1;
let lastBook = -Infinity;
let lastTiles = -Infinity;
function frame(now) {
  const t = (now - start) % PERIOD;
  for (const tour of tours) tour.step(t, previous);
  if (shown.includes("depth") && now - lastBook > 100) {
    liveBook(t);
    lastBook = now;
  }
  if (shown.includes("heatmap") && now - lastTiles > 300) {
    liveTiles(t);
    lastTiles = now;
  }
  previous = t;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
