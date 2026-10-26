import { Loop, Surface, changeSign, clamp, el, formatChange, formatCompact, formatPrice, niceStep, readTheme, reducedMotion, withAlpha, type Theme } from "../core/core.js";

export interface Bar {
  /** Seconds since the epoch, UTC, at the bar's open. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleChartOptions {
  bars: Bar[];
  mode?: "candles" | "line";
  /** How many bars to show at first. */
  visible?: number;
  /** Whether time labels and the crosshair show the hour as well as the date. Defaults to whether bars are
   *  shorter than a day. */
  intraday?: boolean;
  /** Whether bars carry a volume worth a pane of its own; without one, prices take the full height. */
  volume?: boolean;
  /** How values read on the axis, the tags and the legend. */
  format?: (value: number) => string;
  /** Read aloud as the chart's name; say what the reader can do with it. */
  label?: string;
  theme?: Partial<Theme>;
  /** Called with the hovered bar's index, or null when nothing is hovered. */
  onHover?: (index: number | null) => void;
}

interface Range {
  from: number;
  to: number;
}

/** Wide enough for a tiny price like 0.0006396 beside its tag. */
const AXIS_WIDTH = 76;
const TIME_HEIGHT = 26;
const TOP_PAD = 10;
const VOLUME_SHARE = 0.18;
const RIGHT_PAD_BARS = 4;
const MIN_SPAN = 5;
/** How far the view eases toward its target each frame; lower is slower and softer. */
const EASE = 0.22;
/** Momentum kept per frame after a flick, so a pan glides and settles. */
const FRICTION = 0.92;
const DAY = 86_400;
/** Steps for time labels, in seconds. Each is a round unit of clock or calendar time, so labels sit on whole hours and midnights. */
const TIME_STEPS = [300, 900, 1800, 3600, 7200, 10_800, 14_400, 21_600, 43_200, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY];
const TAG_HEIGHT = 18;
/** A price label this close to a tag's centre would peek out from under it, so it is left out. */
const TAG_CLEARANCE = TAG_HEIGHT / 2 + 7;

const dateLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const timeLabel = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

/** A trading chart: candles or a line, a volume pane, and the price axis on the right.
 *  Wheel zooms time around the pointer; dragging pans and glides on release; dragging the price axis stretches or
 *  squeezes prices, after which dragging the plot moves prices too, until Auto. Everything that moves per frame
 *  lives on the instance and is painted in an animation frame, so zooming and panning never wait on anything. */
export class CandleChart {
  private readonly root: HTMLDivElement;
  private readonly surface: Surface;
  private readonly loop: Loop;
  private readonly dot: HTMLSpanElement;
  private readonly legend: HTMLDListElement;
  private readonly autoButton: HTMLButtonElement;
  private readonly options: Required<Omit<CandleChartOptions, "theme" | "onHover" | "label" | "intraday">> & Pick<CandleChartOptions, "theme" | "onHover" | "intraday">;

  private view: Range = { from: 0, to: 0 };
  private target: Range = { from: 0, to: 0 };
  private velocity = 0;
  private prices: Range = { from: 0, to: 0 };
  private manualPrices: Range | null = null;
  private pointer: { x: number; y: number } | null = null;
  private drag: { kind: "plot" | "axis"; x: number; y: number; time: number; moved: boolean } | null = null;
  private hoverIndex: number | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(container: HTMLElement, options: CandleChartOptions) {
    this.options = {
      mode: "candles",
      visible: 120,
      volume: true,
      format: formatPrice,
      ...options,
    };
    this.root = el("div", "chart-root chart-candles", container);
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "img");
    this.root.setAttribute(
      "aria-label",
      options.label ?? "Price chart. Drag to pan, scroll to zoom, drag the price axis to stretch it. Arrow keys read each bar.",
    );
    this.surface = new Surface(this.root, () => this.loop.schedule());
    this.loop = new Loop(() => this.tick());
    this.dot = el("span", "chart-last-dot", this.root);
    this.dot.setAttribute("aria-hidden", "true");
    this.legend = el("dl", "chart-legend", this.root);
    this.legend.setAttribute("aria-live", "polite");
    this.autoButton = el("button", "chart-auto", this.root);
    this.autoButton.type = "button";
    this.autoButton.textContent = "Auto";
    this.autoButton.title = "Fit prices to the bars on screen";
    this.autoButton.hidden = true;
    this.resetView();
    this.bind();
    this.renderLegend();
  }

  /** Replaces the bars and starts from a fresh view of the most recent ones. */
  setBars(bars: Bar[], visible = this.options.visible): void {
    this.options.bars = bars;
    this.options.visible = visible;
    this.manualPrices = null;
    this.autoButton.hidden = true;
    this.prices = { from: 0, to: 0 };
    this.resetView();
    this.renderLegend();
    this.loop.schedule();
  }

  /** Switches between candles and a line; the view stays where the reader left it and prices re-fit. */
  setMode(mode: "candles" | "line"): void {
    this.options.mode = mode;
    this.renderLegend();
    this.loop.schedule();
  }

  /** Repaints, for instance after the page's theme changed. */
  redraw(): void {
    this.loop.schedule();
  }

  destroy(): void {
    this.loop.stop();
    for (const undo of this.cleanup) undo();
    this.surface.destroy();
    this.root.remove();
  }

  private get count(): number {
    return this.options.bars.length;
  }

  /** Zooming out stops once every bar fits. */
  private get maxSpan(): number {
    return Math.max(MIN_SPAN, this.count + RIGHT_PAD_BARS);
  }

  private get volumeShare(): number {
    return this.options.volume ? VOLUME_SHARE : 0;
  }

  private plotWidth(): number {
    return Math.max(0, this.surface.width - AXIS_WIDTH);
  }

  private paneHeight(): number {
    return Math.max(0, this.surface.height - TIME_HEIGHT);
  }

  private priceHeight(): number {
    return this.paneHeight() * (1 - this.volumeShare) - TOP_PAD;
  }

  private resetView(): void {
    const span = Math.min(this.options.visible, this.count) + RIGHT_PAD_BARS;
    this.view = { from: this.count + RIGHT_PAD_BARS - span, to: this.count + RIGHT_PAD_BARS };
    this.target = { ...this.view };
    this.velocity = 0;
  }

  private clampRange(range: Range): Range {
    const span = clamp(range.to - range.from, MIN_SPAN, this.maxSpan);
    // However far out or over, a few bars stay on screen at either end.
    const from = clamp(range.from, 4 - span, this.count - 4);
    return { from, to: from + span };
  }

  /** The price range fitted to the bars on screen, with a little air above and below. */
  private fittedPrices(): Range {
    const { bars, mode } = this.options;
    const first = clamp(Math.floor(this.view.from), 0, this.count - 1);
    const last = clamp(Math.ceil(this.view.to), 0, this.count - 1);
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let index = first; index <= last; index++) {
      const bar = bars[index];
      low = Math.min(low, mode === "candles" ? bar.low : bar.close);
      high = Math.max(high, mode === "candles" ? bar.high : bar.close);
    }
    const pad = (high - low || high * 0.01) * 0.12;
    return { from: low - pad, to: high + pad };
  }

  /** One animation step: momentum, easing toward the target view, an eased price scale, then paint. */
  private tick(): boolean {
    if (this.count === 0) return false;
    let moving = false;
    // With reduced motion the view and the price scale jump straight to where they are going.
    const ease = reducedMotion() ? 1 : EASE;

    if (Math.abs(this.velocity) > 0.002 && !this.drag) {
      const span = this.target.to - this.target.from;
      const from = this.target.from + this.velocity;
      const next = this.clampRange({ from, to: from + span });
      this.velocity = next.from === this.target.from ? 0 : this.velocity * FRICTION;
      this.target = next;
      moving = true;
    }

    const dFrom = this.target.from - this.view.from;
    const dTo = this.target.to - this.view.to;
    if (Math.abs(dFrom) > 0.001 || Math.abs(dTo) > 0.001) {
      this.view = { from: this.view.from + dFrom * ease, to: this.view.to + dTo * ease };
      moving = true;
    } else {
      this.view = { ...this.target };
    }

    const fitted = this.manualPrices ?? this.fittedPrices();
    const current = this.prices;
    const span = current.to - current.from;
    if (span === 0) {
      this.prices = fitted;
    } else if (Math.abs(fitted.from - current.from) > span * 0.0005 || Math.abs(fitted.to - current.to) > span * 0.0005) {
      this.prices = { from: current.from + (fitted.from - current.from) * ease, to: current.to + (fitted.to - current.to) * ease };
      moving = true;
    } else {
      this.prices = fitted;
    }

    this.draw();
    return moving;
  }

  private draw(): void {
    const { width, height } = this.surface;
    if (width === 0 || height === 0) return;
    const colors = readTheme(this.root, this.options.theme);
    const ctx = this.surface.begin();
    const { bars, mode, format, volume } = this.options;
    const count = this.count;
    const interval = count > 1 ? Math.max(1, bars[1].time - bars[0].time) : DAY;
    const intraday = this.options.intraday ?? interval < DAY;

    const plotW = this.plotWidth();
    const paneH = this.paneHeight();
    const priceH = this.priceHeight();
    const { from, to } = this.view;
    const spacing = plotW / (to - from);
    const x = (index: number) => (index - from + 0.5) * spacing;
    const { from: low, to: high } = this.prices;
    const y = (value: number) => TOP_PAD + ((high - value) / (high - low)) * priceH;
    const first = clamp(Math.floor(from) - 1, 0, count - 1);
    const last = clamp(Math.ceil(to) + 1, 0, count - 1);
    const body = clamp(spacing * 0.68, 1, 18);

    ctx.font = `11px ${colors.font}`;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;

    // The current price and the crosshair each get a tag on the axis; grid labels give way to both.
    const lastBar = bars[count - 1];
    const lastRow = y(lastBar.close);
    const lastTagShown = lastRow > 0 && lastRow < paneH;
    const hovered = this.hoverIndex;
    const crosshairRow = this.pointer && hovered !== null && !this.drag?.moved ? Math.round(this.pointer.y) + 0.5 : null;
    const underTag = (row: number) =>
      (lastTagShown && Math.abs(row - lastRow) < TAG_CLEARANCE) || (crosshairRow !== null && Math.abs(row - crosshairRow) < TAG_CLEARANCE);

    // Price grid: dotted lines, labels on the right.
    const step = niceStep(high - low);
    ctx.strokeStyle = colors.grid;
    ctx.fillStyle = colors.muted;
    ctx.textAlign = "left";
    ctx.setLineDash([2, 4]);
    for (let value = Math.ceil(low / step) * step; value <= high; value += step) {
      const row = Math.round(y(value)) + 0.5;
      if (row > paneH - 2) continue;
      ctx.beginPath();
      ctx.moveTo(0, row);
      ctx.lineTo(plotW, row);
      ctx.stroke();
      if (!underTag(row)) ctx.fillText(format(value), plotW + 10, row);
    }
    ctx.setLineDash([]);

    // Time labels, stepped so they never crowd and land on round clock times: whole hours, midnights, weeks.
    const fewest = Math.max(1, Math.ceil(90 / spacing));
    const stepSeconds = TIME_STEPS.find((step) => step % interval === 0 && step / interval >= fewest) ?? Math.ceil((fewest * interval) / DAY) * DAY;
    const every = Math.max(1, Math.round(stepSeconds / interval));
    const phase = bars[0].time % stepSeconds;
    const offset = phase === 0 ? 0 : Math.round((stepSeconds - phase) / interval) % every;
    ctx.textAlign = "center";
    const firstLabel = offset + Math.ceil((Math.max(0, from) - offset) / every) * every;
    for (let index = firstLabel < 0 ? firstLabel + every : firstLabel; index <= last; index += every) {
      const column = Math.round(x(index)) + 0.5;
      if (column < 28 || column > plotW - 28) continue;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(column, 0);
      ctx.lineTo(column, paneH);
      ctx.stroke();
      const time = bars[index].time;
      ctx.fillStyle = colors.muted;
      ctx.fillText(intraday && time % DAY !== 0 ? timeLabel.format(time * 1000) : dateLabel.format(time * 1000), column, paneH + TIME_HEIGHT / 2);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, paneH);
    ctx.clip();

    // Volume along the bottom of the pane.
    let maxVolume = 0;
    for (let index = first; index <= last; index++) maxVolume = Math.max(maxVolume, bars[index].volume);
    const volumeH = paneH * this.volumeShare;
    for (let index = first; volume && maxVolume > 0 && index <= last; index++) {
      const bar = bars[index];
      const barH = (bar.volume / maxVolume) * (volumeH - 2);
      ctx.fillStyle = withAlpha(bar.close >= bar.open ? colors.up : colors.down, hovered === index ? 0.7 : 0.28);
      ctx.fillRect(x(index) - body / 2, paneH - barH, body, barH);
    }

    if (mode === "candles") {
      for (let index = first; index <= last; index++) {
        const bar = bars[index];
        const color = bar.close >= bar.open ? colors.up : colors.down;
        const column = Math.round(x(index)) + 0.5;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(column, y(bar.high));
        ctx.lineTo(column, y(bar.low));
        ctx.stroke();
        const top = y(Math.max(bar.open, bar.close));
        const bottom = y(Math.min(bar.open, bar.close));
        ctx.fillStyle = color;
        ctx.fillRect(x(index) - body / 2, top, body, Math.max(1, bottom - top));
      }
    } else {
      const trace = () => {
        ctx.beginPath();
        for (let index = first; index <= last; index++) {
          if (index === first) ctx.moveTo(x(index), y(bars[index].close));
          else ctx.lineTo(x(index), y(bars[index].close));
        }
      };
      const gradient = ctx.createLinearGradient(0, TOP_PAD, 0, TOP_PAD + priceH);
      gradient.addColorStop(0, withAlpha(colors.accent, 0.22));
      gradient.addColorStop(1, withAlpha(colors.accent, 0));
      trace();
      ctx.lineTo(x(last), TOP_PAD + priceH);
      ctx.lineTo(x(first), TOP_PAD + priceH);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      trace();
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.restore();

    // The current price: a tag on the axis, and in line mode a pulsing dot laid over the canvas.
    if (lastTagShown) {
      ctx.fillStyle = mode === "line" ? colors.accent : lastBar.close >= lastBar.open ? colors.up : colors.down;
      ctx.beginPath();
      ctx.roundRect(plotW + 3, lastRow - TAG_HEIGHT / 2, AXIS_WIDTH - 6, TAG_HEIGHT, 4);
      ctx.fill();
      ctx.fillStyle = mode === "line" ? colors.surface : "#ffffff";
      ctx.textAlign = "left";
      ctx.fillText(format(lastBar.close), plotW + 10, lastRow);
    }
    const dotX = x(count - 1);
    const showDot = mode === "line" && dotX >= 0 && dotX <= plotW && lastRow > 0 && lastRow < paneH;
    this.dot.style.opacity = showDot ? "1" : "0";
    this.dot.style.transform = `translate(${dotX}px, ${lastRow}px)`;
    this.dot.style.setProperty("--chart-dot", colors.accent);

    // Crosshair, with the price under the pointer and the bar's time.
    if (crosshairRow !== null && hovered !== null) {
      const column = Math.round(x(hovered)) + 0.5;
      const row = crosshairRow;
      ctx.strokeStyle = colors.crosshair;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(column, 0);
      ctx.lineTo(column, paneH);
      ctx.moveTo(0, row);
      ctx.lineTo(plotW, row);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colors.label;
      ctx.beginPath();
      ctx.roundRect(plotW + 3, row - TAG_HEIGHT / 2, AXIS_WIDTH - 6, TAG_HEIGHT, 4);
      ctx.fill();
      ctx.fillStyle = colors.text;
      ctx.textAlign = "left";
      ctx.fillText(format(high - ((row - TOP_PAD) / priceH) * (high - low)), plotW + 10, row);
      const time = bars[hovered].time * 1000;
      const text = intraday ? `${dateLabel.format(time)} ${timeLabel.format(time)}` : dateLabel.format(time);
      const textWidth = ctx.measureText(text).width + 16;
      const left = clamp(column - textWidth / 2, 0, plotW - textWidth);
      ctx.fillStyle = colors.label;
      ctx.beginPath();
      ctx.roundRect(left, paneH + 4, textWidth, 18, 4);
      ctx.fill();
      ctx.fillStyle = colors.text;
      ctx.textAlign = "center";
      ctx.fillText(text, left + textWidth / 2, paneH + 13);
    }
  }

  /** The hovered bar's numbers, over the chart's top-left corner and out of the layout, so they never move it. */
  private renderLegend(): void {
    const { bars, mode, format, volume } = this.options;
    if (bars.length === 0) {
      this.legend.replaceChildren();
      return;
    }
    const shown = bars[this.hoverIndex ?? bars.length - 1];
    const change = shown.close / shown.open - 1;
    const sign = String(changeSign(change));
    const entry = (term: string, value: string, signed = false) => {
      const row = document.createElement("div");
      if (term) row.append(Object.assign(document.createElement("dt"), { textContent: term }));
      const dd = Object.assign(document.createElement("dd"), { textContent: value });
      if (signed) dd.dataset.sign = sign;
      row.append(dd);
      return row;
    };
    const rows = mode === "candles" ? [entry("O", format(shown.open)), entry("H", format(shown.high)), entry("L", format(shown.low))] : [];
    rows.push(entry("C", format(shown.close), true), entry("", formatChange(change), true));
    if (volume) rows.push(entry("Vol", formatCompact(shown.volume)));
    this.legend.replaceChildren(...rows);
  }

  private setHover(index: number | null): void {
    if (this.hoverIndex === index) return;
    this.hoverIndex = index;
    this.renderLegend();
    this.options.onHover?.(index);
  }

  private resetPrices = (): void => {
    this.manualPrices = null;
    this.autoButton.hidden = true;
    this.loop.schedule();
  };

  private local(event: PointerEvent | WheelEvent | MouseEvent) {
    const rect = this.root.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) {
    target.addEventListener(type, handler as EventListener, options);
    this.cleanup.push(() => target.removeEventListener(type, handler as EventListener, options));
  }

  private bind(): void {
    const root = this.root;

    // Wheel zooms around the pointer, and stops the page from scrolling at the same time.
    this.on(root, "wheel", (event) => {
      const plotW = this.plotWidth();
      const at = this.local(event).x;
      if (at < 0 || at > plotW) return;
      event.preventDefault();
      this.velocity = 0;
      const goal = this.target;
      const ratio = at / plotW;
      const anchor = goal.from + ratio * (goal.to - goal.from);
      const nextSpan = clamp((goal.to - goal.from) * Math.exp(event.deltaY * 0.0012), MIN_SPAN, this.maxSpan);
      let from = anchor - ratio * nextSpan;
      if (nextSpan > goal.to - goal.from) {
        // Zooming out brings in more bars before it opens empty space past either end.
        const end = this.count + RIGHT_PAD_BARS;
        from = clamp(from, Math.min(0, goal.from), Math.max(end, goal.to) - nextSpan);
      }
      this.target = this.clampRange({ from, to: from + nextSpan });
      this.loop.schedule();
    }, { passive: false });

    this.on(root, "pointerdown", (event) => {
      if (event.button !== 0 || event.target === this.autoButton) return;
      const at = this.local(event);
      this.velocity = 0;
      this.target = { ...this.view };
      this.drag = { kind: at.x > this.plotWidth() ? "axis" : "plot", x: at.x, y: at.y, time: performance.now(), moved: false };
      root.setPointerCapture(event.pointerId);
    });

    this.on(root, "pointermove", (event) => {
      const at = this.local(event);
      const active = this.drag;

      if (active) {
        const dx = at.x - active.x;
        const dy = at.y - active.y;
        if (!active.moved && Math.hypot(dx, dy) < 3) return;
        active.moved = true;
        const now = performance.now();
        const range = this.prices;

        if (active.kind === "axis") {
          // Dragging the price axis down squeezes prices together, up stretches them apart, around the centre.
          const centre = (range.from + range.to) / 2;
          const half = ((range.to - range.from) / 2) * Math.exp(dy * 0.006);
          this.manualPrices = { from: centre - half, to: centre + half };
          this.prices = { ...this.manualPrices };
          this.autoButton.hidden = false;
        } else {
          const span = this.view.to - this.view.from;
          const from = this.view.from - dx / (this.plotWidth() / span);
          const next = this.clampRange({ from, to: from + span });
          this.velocity = ((next.from - this.view.from) / Math.max(1, now - active.time)) * 16;
          this.view = next;
          this.target = { ...next };
          if (this.manualPrices) {
            const shift = (dy / this.priceHeight()) * (range.to - range.from);
            this.manualPrices = { from: range.from + shift, to: range.to + shift };
            this.prices = { ...this.manualPrices };
          }
        }
        active.x = at.x;
        active.y = at.y;
        active.time = now;
        this.pointer = null;
        this.setHover(null);
        this.loop.schedule();
        return;
      }

      if (at.x > this.plotWidth() || at.y > this.paneHeight()) {
        this.pointer = null;
        this.setHover(null);
      } else {
        const { from, to } = this.view;
        const spacing = this.plotWidth() / (to - from);
        this.pointer = at;
        this.setHover(clamp(Math.round(at.x / spacing - 0.5 + from), 0, this.count - 1));
      }
      this.loop.schedule();
    });

    const endDrag = () => {
      const active = this.drag;
      this.drag = null;
      // A drag that stops before release has no momentum left to carry, and reduced motion carries none at all.
      if (!active?.moved || active.kind !== "plot" || performance.now() - active.time > 80 || reducedMotion()) this.velocity = 0;
      this.loop.schedule();
    };
    this.on(root, "pointerup", endDrag);
    this.on(root, "pointercancel", endDrag);
    this.on(root, "pointerleave", (event) => {
      if (event.pointerType !== "mouse" || this.drag) return;
      this.pointer = null;
      this.setHover(null);
      this.loop.schedule();
    });

    this.on(root, "dblclick", (event) => {
      if (this.local(event).x > this.plotWidth()) this.resetPrices();
    });
    this.on(this.autoButton, "click", this.resetPrices);

    this.on(root, "keydown", (event) => {
      const count = this.count;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const index = clamp((this.hoverIndex ?? count - 1) + (event.key === "ArrowLeft" ? -1 : 1), 0, count - 1);
        const range = this.prices;
        this.pointer = { x: 0, y: TOP_PAD + ((range.to - this.options.bars[index].close) / (range.to - range.from)) * this.priceHeight() };
        this.setHover(index);
      } else if (event.key === "+" || event.key === "=" || event.key === "-") {
        const goal = this.target;
        const nextSpan = clamp((goal.to - goal.from) * (event.key === "-" ? 1.25 : 0.8), MIN_SPAN, this.maxSpan);
        this.target = this.clampRange({ from: goal.to - nextSpan, to: goal.to });
      } else if (event.key === "Escape") {
        this.pointer = null;
        this.setHover(null);
      } else {
        return;
      }
      event.preventDefault();
      this.loop.schedule();
    });
  }
}
