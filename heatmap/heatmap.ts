import { Loop, Surface, clamp, easeOutCubic, el, formatChange, formatCompact, readTheme, reducedMotion, type Theme } from "../core/core.js";

export interface Tile {
  id: string;
  /** Short label drawn on the tile: a ticker like BTC. */
  label: string;
  /** Full name for the tooltip. */
  name?: string;
  /** Sets the tile's area: market cap, volume, weight. */
  value: number;
  /** Sets the colour, as a ratio: -0.04 is down four percent. */
  change: number;
  /** Tiles that share a group sit together under its name and can be zoomed into. */
  group?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HeatmapOptions {
  tiles: Tile[];
  /** The change at which colour stops getting deeper. */
  maxChange?: number;
  formatValue?: (value: number) => string;
  label?: string;
  theme?: Partial<Theme>;
  /** Called when a tile is clicked while zoomed into its group, or when there are no groups. */
  onSelect?: (tile: Tile) => void;
}

const HEADER = 18;
const ZOOM_HEADER = 26;
const ZOOM_MS = 460;

/** Lays `items` out in `rect` with areas in proportion to their values, keeping each tile as close to square as
 *  it can: the squarified treemap of Bruls, Huizing and van Wijk. Biggest first, rows along the shorter side. */
export function squarify<T extends { value: number }>(items: T[], rect: Rect): { item: T; rect: Rect }[] {
  const positive = items.filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const total = positive.reduce((sum, item) => sum + item.value, 0);
  const out: { item: T; rect: Rect }[] = [];
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  const free = { ...rect };
  let row: { item: T; area: number }[] = [];

  const worst = (areas: number[], side: number) => {
    const sum = areas.reduce((a, b) => a + b, 0);
    const max = Math.max(...areas);
    const min = Math.min(...areas);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  const place = () => {
    const sum = row.reduce((a, entry) => a + entry.area, 0);
    if (free.w >= free.h) {
      // A column down the left of what is left.
      const width = sum / free.h;
      let y = free.y;
      for (const entry of row) {
        const h = entry.area / width;
        out.push({ item: entry.item, rect: { x: free.x, y, w: width, h } });
        y += h;
      }
      free.x += width;
      free.w -= width;
    } else {
      // A row across the top of what is left.
      const height = sum / free.w;
      let x = free.x;
      for (const entry of row) {
        const w = entry.area / height;
        out.push({ item: entry.item, rect: { x, y: free.y, w, h: height } });
        x += w;
      }
      free.y += height;
      free.h -= height;
    }
    row = [];
  };

  for (const item of positive) {
    const area = item.value * scale;
    const side = Math.min(free.w, free.h);
    const areas = row.map((entry) => entry.area);
    if (row.length === 0 || worst([...areas, area], side) <= worst(areas, side)) {
      row.push({ item, area });
    } else {
      place();
      row.push({ item, area });
    }
  }
  if (row.length) place();
  return out;
}

type Rgb = [number, number, number];

function parseColor(color: string): Rgb {
  if (color.startsWith("#")) {
    const digits = color.slice(1);
    const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits.slice(0, 6);
    const value = Number.parseInt(full, 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (rgb: Rgb, alpha = 1) => `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${alpha})`;
/** Relative luminance, to pick light or dark text for a tile. */
const luminance = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t });

interface Layout {
  tiles: Map<string, Rect>;
  groups: { name: string; rect: Rect }[];
}

/** A market heatmap: one tile per asset, sized by value and coloured by change, grouped by
 *  sector. Clicking a group zooms into it with the tiles gliding to their new places; Escape or the group's bar
 *  zooms back out. */
export class Heatmap {
  private readonly root: HTMLDivElement;
  private readonly surface: Surface;
  private readonly loop: Loop;
  private readonly tip: HTMLDivElement;
  private readonly options: HeatmapOptions & Required<Pick<HeatmapOptions, "maxChange" | "formatValue">>;
  private zoom: string | null = null;
  private from: Layout | null = null;
  private start = 0;
  private shown: Map<string, Rect> = new Map();
  private layout: Layout = { tiles: new Map(), groups: [] };
  private hover: string | null = null;
  private pointer: { x: number; y: number } | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(container: HTMLElement, options: HeatmapOptions) {
    this.options = { maxChange: 0.1, formatValue: (value) => `$${formatCompact(value)}`, ...options };
    this.root = el("div", "chart-root chart-heatmap", container);
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "img");
    this.root.setAttribute("aria-label", options.label ?? "Market heatmap. Tile size is value, colour is change. Click a group to zoom in, Escape to zoom out.");
    this.surface = new Surface(this.root, () => {
      this.layout = this.compute();
      this.loop.schedule();
    });
    this.loop = new Loop(() => this.draw());
    this.tip = el("div", "chart-tip", this.root);
    this.tip.hidden = true;
    this.bind();
  }

  setTiles(tiles: Tile[]): void {
    this.options.tiles = tiles;
    this.relayout();
  }

  /** Where a tile sits once any zoom has settled, in CSS pixels from the chart's top left, or null when it is
   *  not on screen. For anchoring a popover or a pointer to a tile. */
  tileRect(id: string): Rect | null {
    const rect = this.layout.tiles.get(id);
    return rect ? { ...rect } : null;
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

  private get grouped(): boolean {
    return this.options.tiles.some((tile) => tile.group);
  }

  private relayout(): void {
    this.from = reducedMotion() ? null : { tiles: new Map(this.shown), groups: this.layout.groups };
    this.start = performance.now();
    this.layout = this.compute();
    this.loop.schedule();
  }

  private zoomTo(group: string | null): void {
    if (this.zoom === group) return;
    this.zoom = group;
    this.hover = null;
    this.relayout();
  }

  private compute(): Layout {
    const { width, height } = this.surface;
    const tiles = new Map<string, Rect>();
    const groups: { name: string; rect: Rect }[] = [];
    if (width === 0 || height === 0) return { tiles, groups };
    const all = this.options.tiles;
    const full: Rect = { x: 0, y: 0, w: width, h: height };

    if (this.zoom !== null) {
      const inside = all.filter((tile) => tile.group === this.zoom);
      groups.push({ name: this.zoom, rect: { x: 0, y: 0, w: width, h: ZOOM_HEADER } });
      for (const { item, rect } of squarify(inside, { x: 0, y: ZOOM_HEADER, w: width, h: height - ZOOM_HEADER })) tiles.set(item.id, rect);
      return { tiles, groups };
    }

    if (!this.grouped) {
      for (const { item, rect } of squarify(all, full)) tiles.set(item.id, rect);
      return { tiles, groups };
    }

    const byGroup = new Map<string, Tile[]>();
    for (const tile of all) {
      const name = tile.group ?? "Other";
      byGroup.set(name, [...(byGroup.get(name) ?? []), tile]);
    }
    const sectors = [...byGroup].map(([name, members]) => ({ name, members, value: members.reduce((sum, tile) => sum + tile.value, 0) }));
    for (const { item, rect } of squarify(sectors, full)) {
      // A hairline of background between sectors, and a name bar when the sector is big enough to carry one.
      const inner = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 };
      const header = inner.h > 60 && inner.w > 70 ? HEADER : 0;
      groups.push({ name: item.name, rect: inner });
      for (const tile of squarify(item.members, { x: inner.x, y: inner.y + header, w: inner.w, h: inner.h - header })) tiles.set(tile.item.id, tile.rect);
    }
    return { tiles, groups };
  }

  private colorFor(change: number, theme: Theme): Rgb {
    const t = clamp(change / this.options.maxChange, -1, 1);
    const base = parseColor(theme.label);
    // A gentle curve so small moves still read, and the deepest colour is kept for real moves.
    return mix(base, parseColor(t >= 0 ? theme.up : theme.down), Math.abs(t) ** 0.7 * 0.9);
  }

  private draw(): boolean {
    const { width, height } = this.surface;
    if (width === 0 || height === 0) return false;
    const colors = readTheme(this.root, this.options.theme);
    const ctx = this.surface.begin();

    const t = this.from ? clamp((performance.now() - this.start) / ZOOM_MS, 0, 1) : 1;
    const eased = easeOutCubic(t);
    const moving = t < 1;
    if (!moving) this.from = null;

    ctx.fillStyle = colors.surface;
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const byId = new Map(this.options.tiles.map((tile) => [tile.id, tile]));
    const shown = new Map<string, Rect>();
    const entries: { tile: Tile; rect: Rect; alpha: number }[] = [];
    for (const [id, target] of this.layout.tiles) {
      const tile = byId.get(id);
      if (!tile) continue;
      const before = this.from?.tiles.get(id);
      // A tile that was not on screen before fades in where it lands.
      const rect = before ? lerpRect(before, target, eased) : target;
      entries.push({ tile, rect, alpha: before || !this.from ? 1 : eased });
      shown.set(id, rect);
    }
    // Tiles leaving the view, when zooming in, fade out where they were.
    if (this.from) {
      for (const [id, rect] of this.from.tiles) {
        const tile = byId.get(id);
        if (!tile || this.layout.tiles.has(id)) continue;
        entries.unshift({ tile, rect, alpha: 1 - eased });
      }
    }
    this.shown = shown;

    for (const { tile, rect, alpha } of entries) {
      if (rect.w < 1 || rect.h < 1 || alpha <= 0) continue;
      const rgb = this.colorFor(tile.change, colors);
      const hovered = this.hover === tile.id;
      const x = rect.x + 0.5;
      const y = rect.y + 0.5;
      const w = rect.w - 1;
      const h = rect.h - 1;
      ctx.fillStyle = css(hovered ? mix(rgb, [255, 255, 255], 0.12) : rgb, alpha);
      ctx.fillRect(x, y, w, h);
      if (hovered) {
        ctx.strokeStyle = css(parseColor(colors.text), 0.9 * alpha);
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        ctx.lineWidth = 1;
      }
      // Labels grow with the tile and drop out when there is no room for them.
      if (w < 34 || h < 22) continue;
      const size = clamp(Math.sqrt(w * h) / 5.5, 10, 34);
      const ink = luminance(rgb) > 0.55 ? [17, 17, 18] as Rgb : [255, 255, 255] as Rgb;
      ctx.fillStyle = css(ink, alpha);
      ctx.font = `600 ${size}px ${colors.font}`;
      const twoLines = h > size * 2.6;
      const labelY = twoLines ? y + h / 2 - size * 0.42 : y + h / 2;
      if (ctx.measureText(tile.label).width < w - 6) ctx.fillText(tile.label, x + w / 2, labelY);
      if (twoLines) {
        ctx.font = `${Math.max(9, size * 0.52)}px ${colors.font}`;
        ctx.fillStyle = css(ink, 0.8 * alpha);
        ctx.fillText(formatChange(tile.change), x + w / 2, y + h / 2 + size * 0.5);
      }
    }

    // Sector names over their top edge; when zoomed in, the bar that leads back out.
    ctx.textAlign = "left";
    for (const group of this.layout.groups) {
      const { rect } = group;
      if (this.zoom !== null) {
        ctx.fillStyle = colors.surface;
        ctx.fillRect(0, 0, width, ZOOM_HEADER);
        ctx.fillStyle = colors.text;
        ctx.font = `600 13px ${colors.font}`;
        ctx.fillText(`←  ${group.name}`, 8, ZOOM_HEADER / 2);
        ctx.fillStyle = colors.muted;
        ctx.textAlign = "right";
        ctx.font = `11px ${colors.font}`;
        ctx.fillText("Esc to zoom out", width - 8, ZOOM_HEADER / 2);
        ctx.textAlign = "left";
      } else if (rect.h > 60 && rect.w > 70) {
        ctx.fillStyle = colors.surface;
        ctx.fillRect(rect.x, rect.y, rect.w, HEADER);
        ctx.fillStyle = colors.muted;
        ctx.font = `600 11px ${colors.font}`;
        ctx.fillText(group.name.toUpperCase(), rect.x + 6, rect.y + HEADER / 2 + 1);
      }
    }

    this.renderTip();
    return moving;
  }

  private tileAt(x: number, y: number): Tile | null {
    for (const [id, rect] of this.shown) {
      if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) return this.options.tiles.find((tile) => tile.id === id) ?? null;
    }
    return null;
  }

  private groupAt(x: number, y: number): string | null {
    return this.layout.groups.find(({ rect }) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h)?.name ?? null;
  }

  private renderTip(): void {
    const tile = this.hover ? this.options.tiles.find((entry) => entry.id === this.hover) : null;
    if (!tile || !this.pointer) {
      this.tip.hidden = true;
      return;
    }
    const rows: [string, string][] = [
      [tile.name ?? tile.label, tile.label],
      ["Value", this.options.formatValue(tile.value)],
      ["Change", formatChange(tile.change)],
    ];
    this.tip.dataset.side = tile.change >= 0 ? "bid" : "ask";
    this.tip.replaceChildren(
      ...rows.map(([term, value]) => {
        const row = document.createElement("div");
        row.append(Object.assign(document.createElement("span"), { textContent: term }), Object.assign(document.createElement("b"), { textContent: value }));
        return row;
      }),
    );
    this.tip.hidden = false;
    const tipWidth = this.tip.offsetWidth || 180;
    const tipHeight = this.tip.offsetHeight || 70;
    const { x, y } = this.pointer;
    const left = x + 16 + tipWidth > this.surface.width ? x - 16 - tipWidth : x + 16;
    const top = y + 16 + tipHeight > this.surface.height ? y - 16 - tipHeight : y + 16;
    this.tip.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, top)}px)`;
  }

  private on<K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void) {
    this.root.addEventListener(type, handler as EventListener);
    this.cleanup.push(() => this.root.removeEventListener(type, handler as EventListener));
  }

  private bind(): void {
    const local = (event: MouseEvent) => {
      const rect = this.root.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    this.on("pointermove", (event) => {
      this.pointer = local(event);
      this.hover = this.tileAt(this.pointer.x, this.pointer.y)?.id ?? null;
      this.root.style.cursor = this.hover || (this.zoom !== null && this.pointer.y < ZOOM_HEADER) ? "pointer" : "default";
      this.loop.schedule();
    });
    this.on("pointerleave", () => {
      this.pointer = null;
      this.hover = null;
      this.loop.schedule();
    });
    this.on("click", (event) => {
      const at = local(event);
      if (this.zoom !== null && at.y < ZOOM_HEADER) {
        this.zoomTo(null);
        return;
      }
      const tile = this.tileAt(at.x, at.y);
      if (this.zoom === null && this.grouped) {
        const group = tile?.group ?? this.groupAt(at.x, at.y);
        if (group) this.zoomTo(group);
      } else if (tile) {
        this.options.onSelect?.(tile);
      }
    });
    this.on("keydown", (event) => {
      if (event.key === "Escape" && this.zoom !== null) {
        event.preventDefault();
        this.zoomTo(null);
      }
    });
  }
}
