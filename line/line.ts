import { Loop, Surface, clamp, easeOutCubic, el, formatPrice, readTheme, reducedMotion, withAlpha, type Theme } from "../core/core.js";

export interface Point {
  /** Seconds since the epoch, UTC. */
  time: number;
  value: number;
}

export interface ScrubState {
  index: number;
  point: Point;
  /** The scrubbed value against the reference, as a ratio: 0.012 is +1.2%. */
  change: number;
}

export interface LineChartOptions {
  points: Point[];
  /** What the change is measured from, drawn as a dotted line: yesterday's close on a one-day chart.
   *  Defaults to the first point. */
  reference?: number;
  /** Draw the dotted reference line. On by default when a reference is given. */
  showReference?: boolean;
  /** A pulsing dot on the last point, for a chart that is still moving. */
  live?: boolean;
  format?: (value: number) => string;
  /** How a scrubbed point's time reads above the hairline. */
  formatTime?: (time: number) => string;
  label?: string;
  theme?: Partial<Theme>;
  /** Called while the reader scrubs, and with null when they let go, so the page can swap its headline number. */
  onScrub?: (state: ScrubState | null) => void;
}

/** A brighter green and an orange-red than the other charts; any theme key passed in still wins. */
const LINE_COLORS: Partial<Theme> = { up: "#00c805", down: "#ff5000" };
const PAD_TOP = 28;
const PAD_BOTTOM = 14;
const SAMPLES = 240;
const MORPH_MS = 480;

const defaultTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/** `values` stretched or squeezed to exactly `n` samples by linear interpolation along their index, so two lines
 *  with different point counts can be blended point for point. */
export function resample(values: number[], n: number): number[] {
  if (values.length === 0) return new Array(n).fill(0);
  if (values.length === 1) return new Array(n).fill(values[0]);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const at = (i / (n - 1)) * (values.length - 1);
    const low = Math.floor(at);
    const high = Math.min(values.length - 1, low + 1);
    out[i] = values[low] + (values[high] - values[low]) * (at - low);
  }
  return out;
}

/** A price line: no axes, no grid, one line coloured by whether it is up or down on the
 *  reference, and a hairline you drag across to read any point. Swapping the data morphs the old line into the
 *  new one rather than redrawing it. */
export class LineChart {
  private readonly root: HTMLDivElement;
  private readonly surface: Surface;
  private readonly loop: Loop;
  private readonly dot: HTMLSpanElement;
  private readonly options: LineChartOptions & { format: (value: number) => string; formatTime: (time: number) => string };
  private scrubIndex: number | null = null;
  /** The line as last drawn, in canvas pixels, kept so the next data set can grow out of it. */
  private drawn: number[] | null = null;
  private morphFrom: number[] | null = null;
  private morphStart = 0;
  private readonly cleanup: (() => void)[] = [];

  constructor(container: HTMLElement, options: LineChartOptions) {
    this.options = {
      format: formatPrice,
      formatTime: (time) => defaultTime.format(time * 1000),
      ...options,
      theme: { ...LINE_COLORS, ...options.theme },
    };
    this.root = el("div", "chart-root chart-line", container);
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "img");
    this.root.setAttribute("aria-label", options.label ?? "Price line. Move across it to read each point; arrow keys step through them.");
    this.surface = new Surface(this.root, () => this.loop.schedule());
    this.loop = new Loop(() => this.draw());
    this.dot = el("span", "chart-last-dot", this.root);
    this.dot.setAttribute("aria-hidden", "true");
    this.bind();
  }

  /** Swaps the line for a new one, for example a different range, and morphs between the two. */
  setData(points: Point[], reference?: number): void {
    if (this.drawn && !reducedMotion()) {
      this.morphFrom = this.drawn;
      this.morphStart = performance.now();
    }
    this.options.points = points;
    this.options.reference = reference;
    this.setScrub(null);
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

  private get reference(): number {
    return this.options.reference ?? this.options.points[0]?.value ?? 0;
  }

  private draw(): boolean {
    const { width, height } = this.surface;
    const { points } = this.options;
    if (width === 0 || height === 0 || points.length === 0) return false;
    const colors = readTheme(this.root, this.options.theme);
    const ctx = this.surface.begin();

    const reference = this.reference;
    let low = reference;
    let high = reference;
    for (const point of points) {
      low = Math.min(low, point.value);
      high = Math.max(high, point.value);
    }
    const pad = (high - low || Math.abs(high) * 0.01 || 1) * 0.08;
    low -= pad;
    high += pad;
    const plotH = height - PAD_TOP - PAD_BOTTOM;
    const y = (value: number) => PAD_TOP + ((high - value) / (high - low)) * plotH;
    const span = width - 1 - this.rightInset;
    const x = (index: number) => (points.length === 1 ? width / 2 : (index / (points.length - 1)) * span + 1);

    // The target line, sampled at a fixed count so a morph can blend it with whatever was on screen before.
    const target = resample(points.map((point) => y(point.value)), SAMPLES);
    let line = target;
    let morphing = false;
    if (this.morphFrom) {
      const t = clamp((performance.now() - this.morphStart) / MORPH_MS, 0, 1);
      const eased = easeOutCubic(t);
      const from = this.morphFrom;
      line = target.map((row, i) => from[i] + (row - from[i]) * eased);
      morphing = t < 1;
      if (!morphing) this.morphFrom = null;
    }
    this.drawn = line;
    const sampleX = (i: number) => (i / (SAMPLES - 1)) * span + 1;

    const scrub = morphing ? null : this.scrubIndex;
    const shownValue = points[scrub ?? points.length - 1].value;
    const color = shownValue >= reference ? colors.up : colors.down;

    // The reference line: round dots marking the previous close.
    if (this.options.showReference ?? this.options.reference !== undefined) {
      const row = Math.round(y(reference)) + 0.5;
      ctx.strokeStyle = withAlpha(colors.muted, 0.7);
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.setLineDash([0.1, 5]);
      ctx.beginPath();
      ctx.moveTo(0, row);
      ctx.lineTo(width, row);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Up to the scrubbed point the line is in colour; past it, the part the reader has not reached yet fades.
    const cut = scrub === null ? width : x(scrub);
    const path = (from: number, to: number) => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < SAMPLES; i++) {
        const px = sampleX(i);
        if (px < from - 1 || px > to + 1) continue;
        if (!started) {
          ctx.moveTo(px, line[i]);
          started = true;
        } else {
          ctx.lineTo(px, line[i]);
        }
      }
    };
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (scrub !== null) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cut, 0, width - cut, height);
      ctx.clip();
      path(0, width);
      ctx.strokeStyle = withAlpha(colors.muted, 0.45);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cut, height);
    ctx.clip();
    path(0, width);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();

    if (scrub !== null) {
      const px = Math.round(x(scrub)) + 0.5;
      const py = y(points[scrub].value);
      ctx.strokeStyle = withAlpha(colors.muted, 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, PAD_TOP - 6);
      ctx.lineTo(px, height);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.strokeStyle = colors.surface;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
      // The scrubbed time sits above the hairline, kept inside the chart at either edge.
      ctx.font = `12px ${colors.font}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      const text = this.options.formatTime(points[scrub].time);
      const half = ctx.measureText(text).width / 2;
      ctx.fillStyle = colors.muted;
      ctx.fillText(text, clamp(px, half + 2, width - half - 2), PAD_TOP / 2 - 2);
    }

    const showDot = Boolean(this.options.live) && scrub === null && !morphing;
    this.dot.style.opacity = showDot ? "1" : "0";
    this.dot.style.transform = `translate(${x(points.length - 1)}px, ${y(points[points.length - 1].value)}px)`;
    this.dot.style.setProperty("--chart-dot", color);
    return morphing;
  }

  private setScrub(index: number | null): void {
    if (this.scrubIndex === index) return;
    this.scrubIndex = index;
    const { points, onScrub } = this.options;
    if (!onScrub) return;
    if (index === null) onScrub(null);
    else onScrub({ index, point: points[index], change: points[index].value / this.reference - 1 });
  }

  private on<K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void) {
    this.root.addEventListener(type, handler as EventListener);
    this.cleanup.push(() => this.root.removeEventListener(type, handler as EventListener));
  }

  /** Room at the right end for the live dot at full pulse, so it never hangs outside the chart. */
  private get rightInset(): number {
    return this.options.live ? 14 : 1;
  }

  private indexAt(clientX: number): number {
    const rect = this.root.getBoundingClientRect();
    const count = this.options.points.length;
    return clamp(Math.round(((clientX - rect.left - 1) / (rect.width - 1 - this.rightInset)) * (count - 1)), 0, count - 1);
  }

  private bind(): void {
    const move = (event: PointerEvent) => {
      this.setScrub(this.indexAt(event.clientX));
      this.loop.schedule();
    };
    this.on("pointermove", move);
    this.on("pointerdown", move);
    this.on("pointerleave", () => {
      this.setScrub(null);
      this.loop.schedule();
    });
    this.on("keydown", (event) => {
      const last = this.options.points.length - 1;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const step = event.shiftKey ? 10 : 1;
        const from = this.scrubIndex ?? last;
        this.setScrub(clamp(from + (event.key === "ArrowLeft" ? -step : step), 0, last));
      } else if (event.key === "Home" || event.key === "End") {
        this.setScrub(event.key === "Home" ? 0 : last);
      } else if (event.key === "Escape") {
        this.setScrub(null);
      } else {
        return;
      }
      event.preventDefault();
      this.loop.schedule();
    });
  }
}
