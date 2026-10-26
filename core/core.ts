/** Shared pieces for every chart: canvas sizing, theme tokens, scales and number formatting. */

export interface Theme {
  up: string;
  down: string;
  accent: string;
  text: string;
  muted: string;
  grid: string;
  crosshair: string;
  label: string;
  surface: string;
  font: string;
}

/** The default dark palette. Every key can be overridden by an option or by a
 *  `--chart-<key>` custom property on the chart's container, read on every paint so a theme switch shows at once. */
export const DARK: Theme = {
  up: "#0ecb81",
  down: "#f6465d",
  accent: "#ccff00",
  text: "#f4f4f2",
  muted: "#81817e",
  grid: "rgba(255, 255, 255, 0.07)",
  crosshair: "rgba(255, 255, 255, 0.32)",
  label: "#2a2a2a",
  surface: "#0b0b0c",
  font: "ui-monospace, 'SF Mono', Consolas, monospace",
};

const KEYS = Object.keys(DARK) as (keyof Theme)[];

export function readTheme(element: Element, overrides: Partial<Theme> = {}): Theme {
  const style = getComputedStyle(element);
  const theme = { ...DARK };
  for (const key of KEYS) {
    const value = overrides[key] ?? style.getPropertyValue(`--chart-${key}`).trim();
    if (value) theme[key] = value;
  }
  return theme;
}

export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A colour at an opacity. Takes hex (three or six digits) or rgb()/rgba(). */
export function withAlpha(color: string, opacity: number): string {
  if (color.startsWith("#")) {
    const digits = color.slice(1);
    const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits.slice(0, 6);
    const value = Number.parseInt(full, 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
  }
  const parts = color.match(/[\d.]+/g);
  return parts && parts.length >= 3 ? `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${opacity})` : color;
}

/** A round step that gives about `count` grid lines across a range: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(range: number, count = 5): number {
  if (!(range > 0)) return 1;
  const raw = range / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((step) => step * magnitude >= raw) ?? 10) * magnitude;
}

/** The grid values inside [low, high] for a nice step. */
export function ticks(low: number, high: number, count = 5): number[] {
  const step = niceStep(high - low, count);
  const out: number[] = [];
  // Rounded to the step's precision so 0.1 + 0.2 never prints as 0.30000000000000004.
  const precision = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  for (let value = Math.ceil(low / step) * step; value <= high + step * 1e-9; value += step) {
    out.push(Number(value.toFixed(precision)));
  }
  return out;
}

const price = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const smallPrice = new Intl.NumberFormat("en-US", { minimumSignificantDigits: 4, maximumSignificantDigits: 4 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const signedPercent = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

/** Two decimals, or four significant digits below 0.1, so a price like 0.0006396 still reads. */
export const formatPrice = (n: number) => (n !== 0 && Math.abs(n) < 0.1 ? smallPrice.format(n) : price.format(n));
export const formatCompact = (n: number) => compact.format(n);
/** A ratio as a signed percent with a true minus sign: 0.0123 reads "+1.23%". */
export const formatChange = (n: number) => signedPercent.format(n).replace("-", "−");
/** The sign a change shows once rounded to a hundredth of a percent, so "0.00%" is never coloured as a loss. */
export const changeSign = (n: number) => Math.sign(Math.round(n * 10_000));

/** A canvas that fills `container` at the device's pixel ratio and repaints whenever the box changes size. */
export class Surface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private readonly observer: ResizeObserver;

  constructor(container: HTMLElement, onResize: () => void) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "chart-canvas";
    container.append(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("charts needs a 2D canvas context");
    this.ctx = ctx;
    this.observer = new ResizeObserver(([entry]) => {
      this.width = Math.round(entry.contentRect.width);
      this.height = Math.round(entry.contentRect.height);
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = this.width * dpr;
      this.canvas.height = this.height * dpr;
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      onResize();
    });
    this.observer.observe(container);
  }

  /** Clears the canvas and returns the context, scaled so one unit is one CSS pixel. */
  begin(): CanvasRenderingContext2D {
    const dpr = window.devicePixelRatio || 1;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.width, this.height);
    return this.ctx;
  }

  destroy(): void {
    this.observer.disconnect();
    this.canvas.remove();
  }
}

/** Runs `step` once per animation frame while it returns true, and never more than once per frame. */
export class Loop {
  private frame = 0;

  constructor(private readonly step: () => boolean) {}

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.step()) this.schedule();
    });
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

/** A small element helper for the overlays drawn over a canvas. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}
