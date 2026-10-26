import { Loop, Surface, clamp, el, formatCompact, formatPrice, ticks, readTheme, reducedMotion, withAlpha, type Theme } from "../core/core.js";

/** One order book level: a price and the size resting at it. */
export type Level = [price: number, size: number];

export interface DepthLevel {
  price: number;
  size: number;
  /** Size resting at this price and every better one. */
  total: number;
  /** The same, in the quote currency. */
  notional: number;
}

export interface DepthChartOptions {
  bids: Level[];
  asks: Level[];
  /** The asset being traded and the one it is priced in, for the tooltip: BTC and USDT. */
  base?: string;
  quote?: string;
  /** How far either side of the mid price to show at first, as a ratio: 0.01 is one percent. */
  range?: number;
  formatPrice?: (value: number) => string;
  formatSize?: (value: number) => string;
  label?: string;
  theme?: Partial<Theme>;
}

const AXIS_WIDTH = 64;
const TOP = 30;
const BOTTOM = 24;
const MIN_RANGE = 0.0005;
const MAX_RANGE = 0.5;

const size = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/** Sorts one side from the best price outward and adds up size and notional as it goes deeper. Bids run from the
 *  highest price down, asks from the lowest up, so `total` always grows away from the mid price. */
export function accumulate(levels: Level[], side: "bid" | "ask"): DepthLevel[] {
  const sorted = [...levels].filter(([, s]) => s > 0).sort((a, b) => (side === "bid" ? b[0] - a[0] : a[0] - b[0]));
  let total = 0;
  let notional = 0;
  return sorted.map(([price, s]) => {
    total += s;
    notional += price * s;
    return { price, size: s, total, notional };
  });
}

/** The cumulative depth reached at `price`: every level at that price or better. */
export function depthAt(levels: DepthLevel[], price: number, side: "bid" | "ask"): DepthLevel | null {
  let found: DepthLevel | null = null;
  for (const level of levels) {
    if (side === "bid" ? level.price >= price : level.price <= price) found = level;
    else break;
  }
  return found;
}

/** An order book depth chart: bids stepping down to the mid price in green on the left,
 *  asks stepping up from it in red on the right, each the running total of size from the best price outward.
 *  Hover reads the total at any price; the wheel widens or narrows the band around the mid price. */
export class DepthChart {
  private readonly root: HTMLDivElement;
  private readonly surface: Surface;
  private readonly loop: Loop;
  private readonly tip: HTMLDivElement;
  private readonly options: DepthChartOptions & Required<Pick<DepthChartOptions, "base" | "quote" | "range" | "formatPrice" | "formatSize">>;
  private bids: DepthLevel[] = [];
  private asks: DepthLevel[] = [];
  private range: number;
  private targetRange: number;
  private pointer: { x: number; y: number } | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(container: HTMLElement, options: DepthChartOptions) {
    this.options = {
      base: "BASE",
      quote: "QUOTE",
      range: 0.01,
      formatPrice,
      formatSize: (value) => (value >= 10_000 ? formatCompact(value) : size.format(value)),
      ...options,
    };
    this.range = this.options.range;
    this.targetRange = this.range;
    this.root = el("div", "chart-root chart-depth", container);
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "img");
    this.root.setAttribute("aria-label", options.label ?? "Order book depth. Hover to read the total at a price, scroll to widen or narrow the range.");
    this.surface = new Surface(this.root, () => this.loop.schedule());
    this.loop = new Loop(() => this.draw());
    this.tip = el("div", "chart-tip", this.root);
    this.tip.hidden = true;
    this.setBook(options.bids, options.asks);
    this.bind();
  }

  setBook(bids: Level[], asks: Level[]): void {
    this.bids = accumulate(bids, "bid");
    this.asks = accumulate(asks, "ask");
    this.loop.schedule();
  }

  redraw(): void {
    this.loop.schedule();
  }

  destroy(): void {
    this.loop.stop();
    for (const undo of this.cleanup) undo();
    this.surface.destroy();
    this.root.remove();
  }

  private get mid(): number {
    const bid = this.bids[0]?.price;
    const ask = this.asks[0]?.price;
    if (bid === undefined) return ask ?? 0;
    if (ask === undefined) return bid;
    return (bid + ask) / 2;
  }

  private draw(): boolean {
    const { width, height } = this.surface;
    if (width === 0 || height === 0 || (this.bids.length === 0 && this.asks.length === 0)) return false;
    const colors = readTheme(this.root, this.options.theme);
    const ctx = this.surface.begin();
    const { formatPrice: fp, formatSize: fs } = this.options;

    const moving = !reducedMotion() && Math.abs(this.targetRange - this.range) > this.range * 0.001;
    this.range = moving ? this.range + (this.targetRange - this.range) * 0.25 : this.targetRange;

    const mid = this.mid;
    const low = mid * (1 - this.range);
    const high = mid * (1 + this.range);
    const plotW = width - AXIS_WIDTH;
    const bottom = height - BOTTOM;
    const plotH = bottom - TOP;
    const x = (price: number) => ((price - low) / (high - low)) * plotW;

    // The deepest totals still inside the band set the height, with some headroom.
    const bidMax = depthAt(this.bids, low, "bid")?.total ?? 0;
    const askMax = depthAt(this.asks, high, "ask")?.total ?? 0;
    const top = Math.max(bidMax, askMax, 1e-9) * 1.12;
    const y = (total: number) => bottom - (total / top) * plotH;

    ctx.font = `11px ${colors.font}`;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;

    // Size grid on the right, price labels along the bottom.
    ctx.strokeStyle = colors.grid;
    ctx.fillStyle = colors.muted;
    ctx.textAlign = "left";
    for (const value of ticks(0, top, 4)) {
      if (value === 0) continue;
      const row = Math.round(y(value)) + 0.5;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(0, row);
      ctx.lineTo(plotW, row);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(fs(value), plotW + 10, row);
    }
    ctx.textAlign = "center";
    for (const value of ticks(low, high, Math.max(2, Math.floor(plotW / 110)))) {
      const column = x(value);
      if (column < 30 || column > plotW - 30) continue;
      ctx.fillText(fp(value), column, bottom + BOTTOM / 2);
    }

    // One side as a staircase from its best price out to the edge of the band: the stepped edge is stroked, and the
    // same edge closed along the bottom is filled.
    const side = (levels: DepthLevel[], edge: number, color: string, kind: "bid" | "ask", fill = 0.16) => {
      if (levels.length === 0) return;
      const outline = new Path2D();
      outline.moveTo(x(levels[0].price), bottom);
      outline.lineTo(x(levels[0].price), y(levels[0].total));
      let previous = levels[0];
      for (let i = 1; i < levels.length; i++) {
        const level = levels[i];
        if (kind === "bid" ? level.price < edge : level.price > edge) break;
        outline.lineTo(x(level.price), y(previous.total));
        outline.lineTo(x(level.price), y(level.total));
        previous = level;
      }
      outline.lineTo(x(edge), y(previous.total));
      const area = new Path2D(outline);
      area.lineTo(x(edge), bottom);
      area.closePath();
      ctx.fillStyle = withAlpha(color, fill);
      ctx.fill(area);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke(outline);
      ctx.lineWidth = 1;
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, bottom);
    ctx.clip();
    side(this.bids, low, colors.up, "bid");
    side(this.asks, high, colors.down, "ask");

    // The mid price: a dashed line and its value, with the spread beside it.
    const midX = Math.round(x(mid)) + 0.5;
    ctx.strokeStyle = colors.crosshair;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(midX, TOP - 6);
    ctx.lineTo(midX, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const bestBid = this.bids[0]?.price;
    const bestAsk = this.asks[0]?.price;
    const spread = bestBid !== undefined && bestAsk !== undefined ? (bestAsk - bestBid) / mid : null;
    ctx.textAlign = "center";
    ctx.font = `12px ${colors.font}`;
    ctx.fillStyle = colors.text;
    ctx.fillText(fp(mid), midX, 10);
    if (spread !== null) {
      ctx.font = `11px ${colors.font}`;
      ctx.fillStyle = colors.muted;
      ctx.fillText(`Spread ${(spread * 100).toFixed(3)}%`, midX, 24);
    }

    // Hover: the band from the pointer to the mid lights up, and the tooltip reads the total at that price.
    const at = this.pointer;
    let tipShown = false;
    if (at && at.x >= 0 && at.x <= plotW && at.y <= bottom) {
      const price = low + (at.x / plotW) * (high - low);
      const kind: "bid" | "ask" = price <= mid ? "bid" : "ask";
      const levels = kind === "bid" ? this.bids : this.asks;
      const level = depthAt(levels, price, kind);
      if (level) {
        const color = kind === "bid" ? colors.up : colors.down;
        const row = y(level.total);
        const column = Math.round(at.x) + 0.5;
        ctx.save();
        ctx.beginPath();
        ctx.rect(Math.min(column, midX), 0, Math.abs(midX - column), bottom);
        ctx.clip();
        side(levels, kind === "bid" ? low : high, color, kind, 0.22);
        ctx.restore();
        ctx.strokeStyle = colors.crosshair;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(column, TOP);
        ctx.lineTo(column, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.strokeStyle = colors.surface;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(column, row, 4.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
        this.renderTip(price, level, kind, at);
        tipShown = true;
      }
    }
    this.tip.hidden = !tipShown;
    return moving;
  }

  private renderTip(price: number, level: DepthLevel, kind: "bid" | "ask", at: { x: number; y: number }): void {
    const { formatPrice: fp, formatSize: fs, base, quote } = this.options;
    const rows: [string, string][] = [
      ["Price", fp(price)],
      [`Sum (${base})`, fs(level.total)],
      [`Total (${quote})`, formatCompact(level.notional)],
    ];
    this.tip.dataset.side = kind;
    this.tip.replaceChildren(
      ...rows.map(([term, value]) => {
        const row = document.createElement("div");
        row.append(Object.assign(document.createElement("span"), { textContent: term }), Object.assign(document.createElement("b"), { textContent: value }));
        return row;
      }),
    );
    // Beside the pointer, flipped to the other side near the right edge so it never leaves the chart.
    const tipWidth = this.tip.offsetWidth || 180;
    const left = at.x + 16 + tipWidth > this.surface.width - AXIS_WIDTH ? at.x - 16 - tipWidth : at.x + 16;
    this.tip.style.transform = `translate(${Math.max(4, left)}px, ${clamp(at.y - 40, 4, this.surface.height - 90)}px)`;
  }

  private on<K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) {
    this.root.addEventListener(type, handler as EventListener, options);
    this.cleanup.push(() => this.root.removeEventListener(type, handler as EventListener, options));
  }

  private bind(): void {
    const local = (event: MouseEvent) => {
      const rect = this.root.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    this.on("pointermove", (event) => {
      this.pointer = local(event);
      this.loop.schedule();
    });
    this.on("pointerleave", () => {
      this.pointer = null;
      this.loop.schedule();
    });
    this.on("wheel", (event) => {
      event.preventDefault();
      this.targetRange = clamp(this.targetRange * Math.exp(event.deltaY * 0.0015), MIN_RANGE, MAX_RANGE);
      this.loop.schedule();
    }, { passive: false });
    this.on("keydown", (event) => {
      if (event.key !== "+" && event.key !== "=" && event.key !== "-") return;
      event.preventDefault();
      this.targetRange = clamp(this.targetRange * (event.key === "-" ? 1.3 : 0.77), MIN_RANGE, MAX_RANGE);
      this.loop.schedule();
    });
  }
}
