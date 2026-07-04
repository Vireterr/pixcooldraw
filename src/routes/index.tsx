import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Living Pixels — Animated Brush Studio" },
      { name: "description", content: "Fixed-size animated brush canvas with pan/zoom, layers, image import, and PNG/GIF/MP4 export." },
    ],
  }),
  component: Index,
});

type BrushKind =
  | "ink"
  | "ribbon"
  | "lightning"
  | "pixelRain"
  | "pixelDither"
  | "pixelGlitch"
  | "eraser";

type ModeKind = "normal" | "rainbow" | "pulse" | "spray" | "mirror";

type Tool = "brush" | "select-rect" | "select-brush" | "select-object" | "transform";

type BlendMode =
  | "source-over"
  | "multiply" | "screen" | "overlay"
  | "darken" | "lighten"
  | "color-dodge" | "color-burn"
  | "hard-light" | "soft-light"
  | "difference" | "exclusion"
  | "hue" | "saturation" | "color" | "luminosity";

const BLEND_MODES: { id: BlendMode; label: string }[] = [
  { id: "source-over", label: "Обычный" },
  { id: "multiply", label: "Умножение" },
  { id: "screen", label: "Экран" },
  { id: "overlay", label: "Наложение" },
  { id: "darken", label: "Темнее" },
  { id: "lighten", label: "Светлее" },
  { id: "color-dodge", label: "Осветл." },
  { id: "color-burn", label: "Затемн." },
  { id: "hard-light", label: "Жёсткий" },
  { id: "soft-light", label: "Мягкий" },
  { id: "difference", label: "Разница" },
  { id: "exclusion", label: "Исключ." },
  { id: "hue", label: "Тон" },
  { id: "saturation", label: "Насыщ." },
  { id: "color", label: "Цвет" },
  { id: "luminosity", label: "Ярк." },
];

interface StrokePoint { x: number; y: number; t: number }

interface GradientStop { offset: number; h: number; s: number; l: number; a: number }
interface StrokeGradient { stops: GradientStop[]; angle: number; animate: boolean; speed: number }

interface Stroke {
  id: number;
  kind: BrushKind;
  mode: ModeKind;
  size: number;
  hue: number;
  sat?: number; lit?: number; alpha?: number;
  speed: number;
  density: number;
  noise: number;
  intensity: number;
  dynamics: number;
  points: StrokePoint[];
  born: number;
  originY?: number;
  ink?: { phase: number };
  rain?: { x: number; y: number; vy: number; hue: number; len: number; seed: number; spawnY: number }[];
  gradient?: StrokeGradient;
}

interface ImageItem {
  id: number;
  src: string;
  x: number; y: number; w: number; h: number;
  rotation?: number;
}

interface Layer {
  id: number;
  name: string;
  visible: boolean;
  blendMode?: BlendMode;
  opacity?: number;
  strokes: Stroke[];
  images: ImageItem[];
}

const BRUSHES: { id: BrushKind; label: string }[] = [
  { id: "ink", label: "Чернила" },
  { id: "ribbon", label: "Лента" },
  { id: "lightning", label: "Молния" },
  { id: "pixelRain", label: "Пикс. дождь" },
  { id: "pixelDither", label: "Дизеринг" },
  { id: "pixelGlitch", label: "Глитч" },
  { id: "eraser", label: "Ластик" },
];

const MODES: { id: ModeKind; label: string }[] = [
  { id: "normal", label: "Обычный" },
  { id: "rainbow", label: "Радуга" },
  { id: "pulse", label: "Пульс" },
  { id: "spray", label: "Распыление" },
  { id: "mirror", label: "Зеркало" },
];

const EXPORT_SCALES = [1, 2] as const;
type ExportScale = typeof EXPORT_SCALES[number];

const HISTORY_LIMIT = 40;
const MAX_POINTS_PER_STROKE = 600;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

// Preset color swatches
const PRESET_SWATCHES = [
  "#ffffff", "#000000", "#f43f5e", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#a3a3a3", "#78716c",
];

function hash(n: number) {
  n = (n << 13) ^ n;
  return 1.0 - (((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741823.5);
}

let strokeIdCounter = 0;
let layerIdCounter = 0;
let imageIdCounter = 0;

/* ---------- Color helpers ---------- */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    switch (mx) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}
function toHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  const to = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
function fromHex(hex: string): [number, number, number] | null {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return rgbToHsl((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

function serializeLayers(layers: Layer[]): string {
  return JSON.stringify(layers.map(l => ({
    id: l.id, name: l.name, visible: l.visible,
    blendMode: l.blendMode || "source-over",
    opacity: l.opacity ?? 1,
    strokes: l.strokes.map(s => ({
      id: s.id, kind: s.kind, mode: s.mode, size: s.size, hue: s.hue,
      sat: s.sat, lit: s.lit, alpha: s.alpha,
      speed: s.speed, density: s.density, noise: s.noise,
      intensity: s.intensity, dynamics: s.dynamics,
      points: s.points, born: s.born, originY: s.originY,
      gradient: s.gradient,
    })),
    images: l.images,
  })));
}
function deserializeLayers(str: string): Layer[] {
  const parsed = JSON.parse(str) as Layer[];
  return parsed.map(l => ({
    ...l,
    blendMode: l.blendMode || "source-over",
    opacity: l.opacity ?? 1,
    images: l.images || [],
  }));
}

/* ---------- Stroke bounding box + hit tests ---------- */
function strokeBBox(s: Stroke) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = s.size;
  return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}
function rectIntersects(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}
function pointInRect(px: number, py: number, r: { x: number; y: number; w: number; h: number }) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}
function hitTestStroke(s: Stroke, x: number, y: number): boolean {
  const bb = strokeBBox(s);
  if (!pointInRect(x, y, bb)) return false;
  const tol = s.size * 0.6 + 4;
  for (let i = 0; i < s.points.length - 1; i++) {
    const p = s.points[i], q = s.points[i + 1];
    const dx = q.x - p.x, dy = q.y - p.y;
    const L2 = dx * dx + dy * dy || 1;
    let t = ((x - p.x) * dx + (y - p.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    const cx = p.x + dx * t, cy = p.y + dy * t;
    if (Math.hypot(cx - x, cy - y) <= tol) return true;
  }
  if (s.points.length === 1) return Math.hypot(s.points[0].x - x, s.points[0].y - y) <= tol;
  return false;
}

/* ---------- Stroke renderer ---------- */
function renderStroke(ctx: CanvasRenderingContext2D, s: Stroke, t: number, dtRaw: number, now: number) {
  const dt = dtRaw * (0.3 + s.speed * 2.4);
  const tt = t * (0.3 + s.speed * 2.4);
  const lifeMs = now - s.born;
  const modeHueShift = s.mode === "rainbow" ? (lifeMs * 0.05) % 360 : 0;
  const modePulse = s.mode === "pulse" ? 0.6 + 0.5 * Math.sin(tt * 2) : 1;
  const modeSpray = s.mode === "spray" ? 2.2 : 1;
  const SAT = s.sat ?? 90;
  const A_MUL = s.alpha ?? 1;
  const alphaMul = (0.25 + s.intensity * 0.9) * modePulse * A_MUL;
  const pts = s.points;

  if (s.kind === "ink") {
    if (!s.ink) s.ink = { phase: Math.random() * 100 };
    s.ink.phase += dt * 0.002;
    const grid = Math.max(2, Math.round(s.size / 8));
    const hueI = (s.hue + modeHueShift) % 360;
    const thickness = Math.max(grid, s.size * (0.45 + s.intensity * 0.55) * modePulse * modeSpray);
    const half = thickness / 2;
    const phaseI = s.ink.phase;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], nxt = pts[i + 1];
      const dx = nxt.x - p.x, dy = nxt.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const num = Math.max(1, Math.floor(len / grid));
      for (let k = 0; k <= num; k++) {
        const f = k / num;
        const cx = p.x + dx * f, cy = p.y + dy * f;
        const wob = Math.sin((i + f) * 0.3 + phaseI * 6) * s.size * 0.12 * s.dynamics
                  + hash(i + f + phaseI * 10) * s.noise * grid * 2;
        for (let t2 = -half; t2 <= half; t2 += grid) {
          const gx = Math.round((cx + nx * (t2 + wob)) / grid) * grid;
          const gy = Math.round((cy + ny * (t2 + wob)) / grid) * grid;
          const edge = 1 - Math.abs(t2) / (half + 1);
          const l = (s.lit ?? 55) + edge * 25;
          ctx.fillStyle = `hsla(${hueI}, ${SAT}%, ${l}%, ${alphaMul * edge})`;
          ctx.fillRect(gx, gy, grid, grid);
        }
      }
    }
  }
  else if (s.kind === "ribbon") {
    const grid = Math.max(2, Math.round(s.size / 8));
    const passes = Math.max(1, Math.floor(1 + s.density * 3));
    for (let pass = 0; pass < passes; pass++) {
      const phase = tt * 2 + pass * 0.7;
      const amp = s.size * 0.6 * (0.3 + s.dynamics) + Math.sin(tt + pass) * s.size * 0.2;
      const hueR = (s.hue + pass * 20 + modeHueShift) % 360;
      ctx.fillStyle = `hsla(${hueR}, ${SAT}%, ${s.lit ?? 65}%, ${alphaMul * 0.75})`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], nxt = pts[i + 1];
        const dx = nxt.x - p.x, dy = nxt.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const num = Math.max(1, Math.floor(len / grid));
        for (let k = 0; k <= num; k++) {
          const f = k / num;
          const wave = Math.sin(p.t * 3 + phase + (i + f) * 0.15) * amp
                     + hash(i + f + tt) * s.noise * s.size * 0.5;
          const gx = Math.round((p.x + dx * f + nx * wave) / grid) * grid;
          const gy = Math.round((p.y + dy * f + ny * wave) / grid) * grid;
          ctx.fillRect(gx, gy, grid, grid);
        }
      }
    }
  }
  else if (s.kind === "lightning") {
    const grid = Math.max(2, Math.round(s.size / 6));
    const arcs = Math.max(1, Math.floor(1 + s.density * 5));
    const hueL = (s.hue + modeHueShift) % 360;
    const coreCol = `hsla(${hueL}, ${SAT}%, ${s.lit ?? 82}%, ${alphaMul})`;
    const glowCol = `hsla(${hueL}, ${SAT}%, ${(s.lit ?? 82) - 22}%, ${alphaMul * 0.45})`;
    for (let a = 0; a < arcs; a++) {
      if (Math.random() > 0.3 + s.intensity * 0.6) continue;
      const i0 = Math.floor(Math.random() * pts.length);
      const i1 = Math.min(pts.length - 1, i0 + 1 + Math.floor(Math.random() * (5 + s.dynamics * 30)));
      const p0 = pts[i0], p1 = pts[i1];
      const segs = 6 + Math.floor(s.dynamics * 10);
      let ppx = p0.x, ppy = p0.y;
      for (let i = 1; i <= segs; i++) {
        const f = i / segs;
        const nxx = p0.x + (p1.x - p0.x) * f + (Math.random() - 0.5) * s.size * (0.5 + s.noise * 1.5);
        const nyy = p0.y + (p1.y - p0.y) * f + (Math.random() - 0.5) * s.size * (0.5 + s.noise * 1.5);
        const ddx = nxx - ppx, ddy = nyy - ppy;
        const dlen = Math.hypot(ddx, ddy) || 1;
        const num = Math.max(1, Math.floor(dlen / grid));
        for (let k = 0; k <= num; k++) {
          const f2 = k / num;
          const gx = Math.round((ppx + ddx * f2) / grid) * grid;
          const gy = Math.round((ppy + ddy * f2) / grid) * grid;
          ctx.fillStyle = glowCol;
          ctx.fillRect(gx - grid, gy, grid, grid);
          ctx.fillRect(gx + grid, gy, grid, grid);
          ctx.fillRect(gx, gy - grid, grid, grid);
          ctx.fillRect(gx, gy + grid, grid, grid);
          ctx.fillStyle = coreCol;
          ctx.fillRect(gx, gy, grid, grid);
        }
        ppx = nxx; ppy = nyy;
      }
    }
  }
  else if (s.kind === "pixelRain") {
    const grid = Math.max(3, Math.round(s.size / 4));
    const target = Math.min(200, Math.floor(10 + s.density * 80));
    if (!s.rain) s.rain = [];
    while (s.rain.length < target) {
      const p = pts[Math.floor(Math.random() * pts.length)];
      s.rain.push({
        x: Math.round(p.x / grid) * grid + (Math.random() - 0.5) * s.size,
        y: p.y,
        vy: 0.5 + Math.random() * 2 * (0.3 + s.dynamics * 2),
        hue: s.hue + (Math.random() - 0.5) * 40,
        len: 3 + Math.floor(Math.random() * 8 * (0.3 + s.dynamics)),
        seed: Math.random() * 1000,
        spawnY: p.y,
      });
    }
    const fallLimit = 1400;
    for (let i = s.rain.length - 1; i >= 0; i--) {
      const r = s.rain[i];
      r.y += r.vy * dt * 0.1;
      r.x += hash(tt + r.seed) * s.noise * 0.8;
      if (r.y - r.spawnY > fallLimit) { s.rain.splice(i, 1); continue; }
      const hueP = (r.hue + modeHueShift) % 360;
      for (let k = 0; k < r.len; k++) {
        const a = alphaMul * (1 - k / r.len);
        ctx.fillStyle = `hsla(${hueP}, ${SAT}%, ${55 + k * 3}%, ${a})`;
        ctx.fillRect(Math.round(r.x / grid) * grid, Math.round((r.y - k * grid) / grid) * grid, grid, grid);
      }
    }
  }
  else if (s.kind === "pixelDither") {
    const grid = Math.max(4, Math.round(s.size / 4));
    const hueD = (s.hue + modeHueShift) % 360;
    const sweep = (tt * (0.5 + s.speed * 2)) % 1;
    const step = Math.max(1, Math.floor(pts.length / 40));
    for (let pi = 0; pi < pts.length; pi += step) {
      const p = pts[pi];
      const radius = s.size * (1 + s.dynamics * 1.5);
      const cx = Math.round(p.x / grid) * grid;
      const cy = Math.round(p.y / grid) * grid;
      for (let dx = -radius; dx <= radius; dx += grid) {
        for (let dy = -radius; dy <= radius; dy += grid) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const gx = cx + dx, gy = cy + dy;
          const bayer = (((gx / grid) & 1) ^ ((gy / grid) & 1));
          const dist = Math.hypot(dx, dy) / radius;
          const threshold = sweep + bayer * 0.4 + hash(gx + gy * 7) * s.noise * 0.4;
          if (dist > threshold) continue;
          if (Math.random() > 0.05 + s.density * 0.4) continue;
          const lit = 50 + (1 - dist) * 30;
          ctx.fillStyle = `hsla(${hueD + (bayer ? 30 : 0)}, ${SAT}%, ${lit}%, ${alphaMul * (1 - dist)})`;
          ctx.fillRect(gx, gy, grid, grid);
        }
      }
    }
  }
  else if (s.kind === "pixelGlitch") {
    const grid = Math.max(2, Math.round(s.size / 6));
    const hueG = (s.hue + modeHueShift) % 360;
    const step = Math.max(1, Math.floor(pts.length / 30));
    for (let pi = 0; pi < pts.length; pi += step) {
      const p = pts[pi];
      const radius = s.size * (0.8 + s.dynamics * 1.5);
      const slices = 3 + Math.floor(s.density * 8);
      for (let i = 0; i < slices; i++) {
        const yOff = (i / slices - 0.5) * radius * 2;
        const shift = (hash(Math.floor(tt * 8) + i + p.t) * 2) * s.size * (0.3 + s.noise * 2);
        const widthLine = radius * 2 * (0.6 + Math.random() * 0.4);
        const x0 = p.x - widthLine / 2 + shift;
        const y0 = Math.round((p.y + yOff) / grid) * grid;
        const offs = [-grid, 0, grid];
        const hues = [hueG % 360, (hueG + 120) % 360, (hueG + 240) % 360];
        for (let c2 = 0; c2 < 3; c2++) {
          ctx.fillStyle = `hsla(${hues[c2]}, ${SAT}%, 55%, ${alphaMul * 0.55})`;
          for (let xb = 0; xb < widthLine; xb += grid) {
            if (Math.random() > 0.4 + s.intensity * 0.5) continue;
            ctx.fillRect(Math.round((x0 + xb + offs[c2]) / grid) * grid, y0, grid, grid);
          }
        }
      }
    }
  }

  // Gradient effect — applied in addition to base kind when s.gradient is present
  if (s.gradient && s.kind !== "eraser") {
    const pts2 = s.points;
    if (pts2.length < 2) return;
    const g = s.gradient;
    const flow = g.animate ? (tt * g.speed) : 0;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = s.size * modePulse * modeSpray;
    const segLen = 40;
    // integrate cumulative length
    const cum: number[] = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const total = cum[cum.length - 1] || 1;
    // draw sub-segments
    let acc = 0;
    let i = 1;
    let prev = { x: pts[0].x, y: pts[0].y };
    while (i < pts.length) {
      const p = pts[i];
      const dx = p.x - prev.x, dy = p.y - prev.y;
      const d = Math.hypot(dx, dy);
      if (d < segLen) { prev = p; acc += d; i++; continue; }
      const steps = Math.ceil(d / segLen);
      for (let k = 0; k < steps; k++) {
        const a0 = k / steps, a1 = (k + 1) / steps;
        const sx0 = prev.x + dx * a0, sy0 = prev.y + dy * a0;
        const sx1 = prev.x + dx * a1, sy1 = prev.y + dy * a1;
        const grad = ctx.createLinearGradient(sx0, sy0, sx1, sy1);
        const base = (acc + d * a0) / total;
        for (const stp of g.stops) {
          const off = ((stp.offset + base + flow) % 1 + 1) % 1;
          const [r, gg, bb] = hslToRgb(stp.h, stp.s, stp.l);
          grad.addColorStop(off, `rgba(${r},${gg},${bb},${stp.a * alphaMul})`);
        }
        // also add first stop at 0 to avoid gaps
        {
          const stp = g.stops[0];
          const [r, gg, bb] = hslToRgb(stp.h, stp.s, stp.l);
          grad.addColorStop(0, `rgba(${r},${gg},${bb},${stp.a * alphaMul})`);
          grad.addColorStop(1, `rgba(${r},${gg},${bb},${stp.a * alphaMul})`);
        }
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(sx0, sy0);
        ctx.lineTo(sx1, sy1);
        ctx.stroke();
      }
      prev = p; acc += d; i++;
    }
    ctx.restore();
  }
}

/* ---------- Draw image with rotation ---------- */
function drawImageItem(ctx: CanvasRenderingContext2D, img: HTMLImageElement, im: ImageItem) {
  const rot = im.rotation || 0;
  if (rot === 0) {
    ctx.drawImage(img, im.x, im.y, im.w, im.h);
    return;
  }
  ctx.save();
  ctx.translate(im.x + im.w / 2, im.y + im.h / 2);
  ctx.rotate(rot);
  ctx.drawImage(img, -im.w / 2, -im.h / 2, im.w, im.h);
  ctx.restore();
}

/* ---------- Render layer content (into a ctx assumed to be at world space) ---------- */
function renderLayerContent(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  imgCache: Map<string, HTMLImageElement>,
  t: number, dtRaw: number, now: number,
) {
  for (const im of layer.images) {
    const img = imgCache.get(im.src);
    if (img && img.complete && img.naturalWidth) drawImageItem(ctx, img, im);
  }
  for (const s of layer.strokes) {
    if (s.points.length === 0) continue;
    renderStroke(ctx, s, t, dtRaw, now);
  }
}

/* ---------- Full frame render (exports, no pan/zoom) ---------- */
function renderFrameToCanvas(
  tctx: CanvasRenderingContext2D,
  targetW: number, targetH: number,
  canvasW: number, canvasH: number,
  layers: Layer[],
  imgCache: Map<string, HTMLImageElement>,
  t: number, dtRaw: number, now: number,
  layerBuffer?: HTMLCanvasElement,
  selectionMask?: HTMLCanvasElement | null,
) {
  const sx = targetW / canvasW, sy = targetH / canvasH;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.fillStyle = "#05060c";
  tctx.fillRect(0, 0, targetW, targetH);
  tctx.setTransform(sx, 0, 0, sy, 0, 0);
  tctx.beginPath();
  tctx.rect(0, 0, canvasW, canvasH);
  tctx.clip();
  for (const layer of layers) {
    if (!layer.visible) continue;
    const bm: BlendMode = layer.blendMode || "source-over";
    const op = layer.opacity ?? 1;
    const useBuffer = bm !== "source-over" || !!selectionMask;
    if (useBuffer && layerBuffer) {
      layerBuffer.width = canvasW; layerBuffer.height = canvasH;
      const lctx = layerBuffer.getContext("2d")!;
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, canvasW, canvasH);
      renderLayerContent(lctx, layer, imgCache, t, dtRaw, now);
      if (selectionMask) {
        lctx.globalCompositeOperation = "destination-in";
        lctx.drawImage(selectionMask, 0, 0);
        lctx.globalCompositeOperation = "source-over";
      }
      const prev = tctx.globalCompositeOperation;
      const prevA = tctx.globalAlpha;
      tctx.globalCompositeOperation = bm;
      tctx.globalAlpha = op;
      tctx.drawImage(layerBuffer, 0, 0);
      tctx.globalCompositeOperation = prev;
      tctx.globalAlpha = prevA;
    } else {
      const prevA = tctx.globalAlpha;
      tctx.globalAlpha = op;
      renderLayerContent(tctx, layer, imgCache, t, dtRaw, now);
      tctx.globalAlpha = prevA;
    }
  }
  tctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* ---------- Selection / Transform types ---------- */
type SelectionRect = { x: number; y: number; w: number; h: number };
type SelectedObject =
  | { kind: "stroke"; layerId: number; strokeId: number }
  | { kind: "image"; layerId: number; imageId: number };

type TransformHandle = "move" | "rotate" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

function Index() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [viewport, setViewport] = useState({ w: 800, h: 600 });
  const [canvasSize, setCanvasSize] = useState({ w: 1200, h: 800 });
  const canvasSizeRef = useRef(canvasSize);
  useEffect(() => { canvasSizeRef.current = canvasSize; }, [canvasSize]);
  const [pendingW, setPendingW] = useState("1200");
  const [pendingH, setPendingH] = useState("800");

  const viewRef = useRef({ panX: 0, panY: 0, zoom: 1 });
  const [zoomDisplay, setZoomDisplay] = useState(1);

  const [layers, setLayers] = useState<Layer[]>(() => [{
    id: ++layerIdCounter, name: "Слой 1", visible: true, blendMode: "source-over", opacity: 1, strokes: [], images: [],
  }]);
  const [activeLayerId, setActiveLayerId] = useState<number>(() => layerIdCounter);
  const layersRef = useRef(layers);
  const activeLayerIdRef = useRef(activeLayerId);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  useEffect(() => { activeLayerIdRef.current = activeLayerId; }, [activeLayerId]);

  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const layerBufferRef = useRef<HTMLCanvasElement | null>(null);
  const getLayerBuffer = () => {
    if (!layerBufferRef.current) layerBufferRef.current = document.createElement("canvas");
    return layerBufferRef.current;
  };
  const ensureImg = (src: string): HTMLImageElement | null => {
    const c = imgCache.current;
    let img = c.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => markDirty();
      img.src = src;
      c.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  };

  const dirtyRef = useRef(true);
  const markDirty = () => { dirtyRef.current = true; };

  const historyRef = useRef<string[]>([serializeLayers(layers)]);
  const historyIdxRef = useRef(0);
  const [historyVer, setHistoryVer] = useState(0);

  const pushHistory = useCallback(() => {
    const snap = serializeLayers(layersRef.current);
    const stack = historyRef.current;
    if (stack[historyIdxRef.current] === snap) return;
    stack.splice(historyIdxRef.current + 1);
    stack.push(snap);
    if (stack.length > HISTORY_LIMIT) stack.shift();
    historyIdxRef.current = stack.length - 1;
    setHistoryVer(v => v + 1);
    markDirty();
  }, []);

  const undo = useCallback(() => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    const restored = deserializeLayers(historyRef.current[historyIdxRef.current]);
    layersRef.current = restored;
    setLayers(restored);
    setHistoryVer(v => v + 1);
    markDirty();
  }, []);
  const redo = useCallback(() => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    const restored = deserializeLayers(historyRef.current[historyIdxRef.current]);
    layersRef.current = restored;
    setLayers(restored);
    setHistoryVer(v => v + 1);
    markDirty();
  }, []);

  const canUndo = historyIdxRef.current > 0;
  const canRedo = historyIdxRef.current < historyRef.current.length - 1;
  void historyVer;

  const currentStrokeRef = useRef<Stroke | null>(null);

  // Tool state
  const [tool, setTool] = useState<Tool>("brush");
  const toolRef = useRef(tool);
  useEffect(() => { toolRef.current = tool; markDirty(); }, [tool]);

  const [brush, setBrush] = useState<BrushKind>("ribbon");
  const [mode, setMode] = useState<ModeKind>("normal");

  // Extended color
  const [color, setColor] = useState({ h: 200, s: 90, l: 55, a: 1 });
  const colorRef = useRef(color);
  useEffect(() => { colorRef.current = color; }, [color]);

  // Saved palette
  const [savedSwatches, setSavedSwatches] = useState<string[]>([]);
  // Eyedropper
  const [eyedropper, setEyedropper] = useState(false);

  const [size, setSize] = useState(28);
  const [speed, setSpeed] = useState(0.5);
  const [density, setDensity] = useState(0.5);
  const [noise, setNoise] = useState(0.4);
  const [intensity, setIntensity] = useState(0.7);
  const [dynamics, setDynamics] = useState(0.5);

  // Gradient brush config
  const [gradientCfg, setGradientCfg] = useState<StrokeGradient>({
    stops: [
      { offset: 0, h: 200, s: 90, l: 55, a: 1 },
      { offset: 1, h: 320, s: 90, l: 60, a: 1 },
    ],
    angle: 0, animate: true, speed: 0.4,
  });
  const gradientRef = useRef(gradientCfg);
  useEffect(() => { gradientRef.current = gradientCfg; }, [gradientCfg]);

  // Gradient as an independent effect (works with any brush)
  const [gradientEnabled, setGradientEnabled] = useState(false);
  const gradientEnabledRef = useRef(false);
  useEffect(() => { gradientEnabledRef.current = gradientEnabled; }, [gradientEnabled]);

  // Selection mask (world-space alpha mask). White = inside selection.
  const selectionMaskRef = useRef<HTMLCanvasElement | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [selectionBrushSize, setSelectionBrushSize] = useState(48);
  const selectionBrushSizeRef = useRef(selectionBrushSize);
  useEffect(() => { selectionBrushSizeRef.current = selectionBrushSize; }, [selectionBrushSize]);

  const ensureSelectionMask = useCallback((): HTMLCanvasElement => {
    const cs = canvasSizeRef.current;
    let m = selectionMaskRef.current;
    if (!m) { m = document.createElement("canvas"); selectionMaskRef.current = m; }
    if (m.width !== cs.w || m.height !== cs.h) { m.width = cs.w; m.height = cs.h; }
    return m;
  }, []);
  const clearSelectionMask = useCallback(() => {
    const m = selectionMaskRef.current;
    if (m) { const c = m.getContext("2d")!; c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,m.width,m.height); }
    setHasSelection(false);
    markDirty();
  }, []);
  const paintSelectionCircle = useCallback((wx: number, wy: number, r: number, mode: "add" | "sub") => {
    const m = ensureSelectionMask();
    const c = m.getContext("2d")!;
    c.setTransform(1,0,0,1,0,0);
    c.globalCompositeOperation = mode === "sub" ? "destination-out" : "source-over";
    c.fillStyle = "#fff";
    c.beginPath(); c.arc(wx, wy, r, 0, Math.PI * 2); c.fill();
    c.globalCompositeOperation = "source-over";
    setHasSelection(true);
    markDirty();
  }, [ensureSelectionMask]);
  const paintSelectionRect = useCallback((rect: SelectionRect, mode: "add" | "sub" | "replace") => {
    const m = ensureSelectionMask();
    const c = m.getContext("2d")!;
    c.setTransform(1,0,0,1,0,0);
    if (mode === "replace") c.clearRect(0,0,m.width,m.height);
    c.globalCompositeOperation = mode === "sub" ? "destination-out" : "source-over";
    c.fillStyle = "#fff";
    c.fillRect(rect.x, rect.y, rect.w, rect.h);
    c.globalCompositeOperation = "source-over";
    setHasSelection(true);
    markDirty();
  }, [ensureSelectionMask]);
  const selectAllMask = useCallback(() => {
    const cs = canvasSizeRef.current;
    paintSelectionRect({ x: 0, y: 0, w: cs.w, h: cs.h }, "replace");
  }, [paintSelectionRect]);
  const invertMask = useCallback(() => {
    const m = ensureSelectionMask();
    const c = m.getContext("2d")!;
    c.setTransform(1,0,0,1,0,0);
    c.globalCompositeOperation = "xor";
    c.fillStyle = "#fff";
    c.fillRect(0, 0, m.width, m.height);
    c.globalCompositeOperation = "source-over";
    setHasSelection(true);
    markDirty();
  }, [ensureSelectionMask]);


  const [recording, setRecording] = useState<null | "gif" | "mp4">(null);
  const [recordProgress, setRecordProgress] = useState(0);

  const [gifScale, setGifScale] = useState<ExportScale>(1);
  const [gifSeconds, setGifSeconds] = useState(3);
  const [gifFps, setGifFps] = useState(15);
  const [mp4Scale, setMp4Scale] = useState<ExportScale>(1);
  const [mp4Seconds, setMp4Seconds] = useState(5);
  const [mp4Fps, setMp4Fps] = useState(30);
  const [mp4Bitrate, setMp4Bitrate] = useState(6);

  const [spaceDown, setSpaceDown] = useState(false);
  const spaceRef = useRef(false);

  const refs = {
    brush: useRef(brush), mode: useRef(mode), size: useRef(size),
    speed: useRef(speed), density: useRef(density), noise: useRef(noise),
    intensity: useRef(intensity), dynamics: useRef(dynamics),
  };
  useEffect(() => { refs.brush.current = brush; });
  useEffect(() => { refs.mode.current = mode; });
  useEffect(() => { refs.size.current = size; });
  useEffect(() => { refs.speed.current = speed; });
  useEffect(() => { refs.density.current = density; });
  useEffect(() => { refs.noise.current = noise; });
  useEffect(() => { refs.intensity.current = intensity; });
  useEffect(() => { refs.dynamics.current = dynamics; });

  /* ---------- Selection / transform state ---------- */
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const selectionRectRef = useRef<SelectionRect | null>(null);
  useEffect(() => { selectionRectRef.current = selectionRect; markDirty(); }, [selectionRect]);

  const [selectedObj, setSelectedObj] = useState<SelectedObject | null>(null);
  const selectedObjRef = useRef<SelectedObject | null>(null);
  useEffect(() => { selectedObjRef.current = selectedObj; markDirty(); }, [selectedObj]);

  const rectDragRef = useRef<{ startX: number; startY: number } | null>(null);
  const transformRef = useRef<{
    handle: TransformHandle;
    startW: { x: number; y: number };
    origBBox: { x: number; y: number; w: number; h: number };
    origData: string; // serialized snapshot of active layer for rollback if needed (unused)
  } | null>(null);
  void transformRef; // suppress
  const activeTransform = useRef<{
    handle: TransformHandle;
    startW: { x: number; y: number };
    origBBox: { x: number; y: number; w: number; h: number };
    origPoints?: StrokePoint[];
    origImage?: { x: number; y: number; w: number; h: number; rotation: number };
    origSize?: number;
    center?: { x: number; y: number };
    startAngle?: number;
  } | null>(null);

  /* ---------- Helpers ---------- */
  const getSelectedBBox = useCallback((): { x: number; y: number; w: number; h: number } | null => {
    const sel = selectedObjRef.current;
    if (!sel) {
      const r = selectionRectRef.current;
      if (r && r.w > 2 && r.h > 2) return r;
      return null;
    }
    const layer = layersRef.current.find(l => l.id === sel.layerId);
    if (!layer) return null;
    if (sel.kind === "stroke") {
      const s = layer.strokes.find(x => x.id === sel.strokeId);
      if (!s) return null;
      return strokeBBox(s);
    } else {
      const im = layer.images.find(x => x.id === sel.imageId);
      if (!im) return null;
      return { x: im.x, y: im.y, w: im.w, h: im.h };
    }
  }, []);

  /* ---------- Resize ---------- */
  useEffect(() => {
    const onResize = () => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setViewport({ w: Math.max(100, Math.floor(r.width)), h: Math.max(100, Math.floor(r.height)) });
      markDirty();
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = viewport.w * dpr;
    c.height = viewport.h * dpr;
    markDirty();
  }, [viewport]);

  const fitView = useCallback(() => {
    const vw = viewport.w, vh = viewport.h;
    const cs = canvasSizeRef.current;
    const pad = 40;
    const z = Math.min((vw - pad * 2) / cs.w, (vh - pad * 2) / cs.h);
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    viewRef.current = {
      zoom,
      panX: (vw - cs.w * zoom) / 2,
      panY: (vh - cs.h * zoom) / 2,
    };
    setZoomDisplay(zoom);
    markDirty();
  }, [viewport]);

  useEffect(() => { fitView(); }, [canvasSize, fitView]);

  const hasAnimatedContent = () => {
    for (const layer of layersRef.current) {
      if (!layer.visible) continue;
      if (layer.strokes.length > 0) return true;
    }
    return false;
  };

  const eraseAt = useCallback((wx: number, wy: number, r: number) => {
    const r2 = r * r;
    const id = activeLayerIdRef.current;
    const layer = layersRef.current.find(l => l.id === id);
    if (!layer) return;
    for (const s of layer.strokes) {
      s.points = s.points.filter(p => {
        const dx = p.x - wx, dy = p.y - wy;
        return dx * dx + dy * dy > r2;
      });
      if (s.rain) s.rain = s.rain.filter(i => (i.x - wx) ** 2 + (i.y - wy) ** 2 > r2);
    }
    layer.strokes = layer.strokes.filter(s => s.points.length > 0);
    markDirty();
  }, []);

  /* ---------- Render loop ---------- */
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let dashOffset = 0;

    const tick = (now: number) => {
      const dtRaw = Math.min(50, now - last);
      last = now;
      const c = canvasRef.current;
      if (!c) { raf = requestAnimationFrame(tick); return; }
      const hasSelectionAnim = selectionRectRef.current || selectedObjRef.current;
      const animated = hasAnimatedContent() || hasSelectionAnim;
      if (!animated && !dirtyRef.current) { raf = requestAnimationFrame(tick); return; }
      dirtyRef.current = false;
      dashOffset = (dashOffset + 0.5) % 12;

      const ctx = c.getContext("2d")!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vw = viewport.w, vh = viewport.h;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0a0b12";
      ctx.fillRect(0, 0, vw, vh);

      const view = viewRef.current;
      const cs = canvasSizeRef.current;

      const cxp = view.panX, cyp = view.panY, cwp = cs.w * view.zoom, chp = cs.h * view.zoom;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(cxp + 6, cyp + 8, cwp, chp);
      ctx.fillStyle = "#05060c";
      ctx.fillRect(cxp, cyp, cwp, chp);
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      ctx.strokeRect(cxp + 0.5, cyp + 0.5, cwp, chp);

      ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cs.w, cs.h);
      ctx.clip();

      const t = now / 1000;
      const activeMask = hasSelection ? selectionMaskRef.current : null;
      for (const layer of layersRef.current) {
        if (!layer.visible) continue;
        // Preload images
        for (const im of layer.images) ensureImg(im.src);
        const bm: BlendMode = layer.blendMode || "source-over";
        const op = layer.opacity ?? 1;
        const useBuffer = bm !== "source-over" || !!activeMask;
        if (useBuffer) {
          const buf = getLayerBuffer();
          if (buf.width !== cs.w || buf.height !== cs.h) { buf.width = cs.w; buf.height = cs.h; }
          const lctx = buf.getContext("2d")!;
          lctx.setTransform(1, 0, 0, 1, 0, 0);
          lctx.clearRect(0, 0, cs.w, cs.h);
          renderLayerContent(lctx, layer, imgCache.current, t, dtRaw, now);
          if (activeMask) {
            lctx.globalCompositeOperation = "destination-in";
            lctx.drawImage(activeMask, 0, 0);
            lctx.globalCompositeOperation = "source-over";
          }
          const prev = ctx.globalCompositeOperation;
          const prevA = ctx.globalAlpha;
          ctx.globalCompositeOperation = bm;
          ctx.globalAlpha = op;
          ctx.drawImage(buf, 0, 0);
          ctx.globalCompositeOperation = prev;
          ctx.globalAlpha = prevA;
        } else {
          const prevA = ctx.globalAlpha;
          ctx.globalAlpha = op;
          renderLayerContent(ctx, layer, imgCache.current, t, dtRaw, now);
          ctx.globalAlpha = prevA;
        }
      }
      // Selection mask overlay in world-space (before we restore transform)
      if (activeMask) {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        // dim outside selection
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, cs.w, cs.h);
        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = 1;
        ctx.drawImage(activeMask, 0, 0);
        ctx.restore();
      }

      ctx.restore();

      /* Selection / transform overlays (screen space) */
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const selBB = getSelectedBBox();
      if (selBB) {
        const rx = view.panX + selBB.x * view.zoom;
        const ry = view.panY + selBB.y * view.zoom;
        const rw = selBB.w * view.zoom;
        const rh = selBB.h * view.zoom;
        ctx.save();
        ctx.strokeStyle = "rgba(0, 200, 255, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -dashOffset;
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.restore();

        if (toolRef.current === "transform" || selectedObjRef.current) {
          // handles
          const hs = 8;
          const cxs = [rx, rx + rw / 2, rx + rw];
          const cys = [ry, ry + rh / 2, ry + rh];
          ctx.fillStyle = "#0a0b12";
          ctx.strokeStyle = "rgba(0,200,255,0.9)";
          ctx.lineWidth = 1.5;
          for (const hx of cxs) for (const hy of cys) {
            if (hx === rx + rw / 2 && hy === ry + rh / 2) continue;
            ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
            ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
          }
          // rotate handle above
          const rcx = rx + rw / 2, rcy = ry - 24;
          ctx.beginPath();
          ctx.moveTo(rx + rw / 2, ry);
          ctx.lineTo(rcx, rcy);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(rcx, rcy, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewport, getSelectedBBox]);

  /* ---------- Pointer helpers ---------- */
  const screenToWorld = (sx: number, sy: number) => {
    const v = viewRef.current;
    return { x: (sx - v.panX) / v.zoom, y: (sy - v.panY) / v.zoom };
  };

  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const drawingPointerId = useRef<number | null>(null);
  const panState = useRef<{ id: number; sx: number; sy: number; panX: number; panY: number } | null>(null);
  const pinchState = useRef<{ dist: number; midX: number; midY: number; zoom: number; panX: number; panY: number } | null>(null);
  const lastDrawScreen = useRef({ x: 0, y: 0 });

  const beginStroke = (wx: number, wy: number) => {
    const layer = layersRef.current.find(l => l.id === activeLayerIdRef.current);
    if (!layer || !layer.visible) return;
    const col = colorRef.current;
    const stroke: Stroke = {
      id: ++strokeIdCounter,
      kind: refs.brush.current,
      mode: refs.mode.current,
      size: refs.size.current,
      hue: col.h,
      sat: col.s,
      lit: col.l,
      alpha: col.a,
      speed: refs.speed.current,
      density: refs.density.current,
      noise: refs.noise.current,
      intensity: refs.intensity.current,
      dynamics: refs.dynamics.current,
      points: [],
      born: performance.now(),
      originY: wy,
      gradient: gradientEnabledRef.current ? JSON.parse(JSON.stringify(gradientRef.current)) : undefined,
    };
    currentStrokeRef.current = stroke;
    layer.strokes.push(stroke);
    addPoint(wx, wy);
    markDirty();
  };

  const addPoint = (x: number, y: number) => {
    const s = currentStrokeRef.current;
    if (!s) return;
    const now = performance.now();
    s.points.push({ x, y, t: (now - s.born) / 1000 });
    if (s.mode === "mirror") {
      const ox = s.points[0].x;
      s.points.push({ x: 2 * ox - x, y, t: (now - s.born) / 1000 });
    }
    if (s.points.length > MAX_POINTS_PER_STROKE) {
      const half = Math.floor(MAX_POINTS_PER_STROKE / 2);
      const old = s.points.slice(0, s.points.length - half);
      const recent = s.points.slice(s.points.length - half);
      const dec: StrokePoint[] = [];
      for (let i = 0; i < old.length; i += 2) dec.push(old[i]);
      s.points = dec.concat(recent);
    }
    markDirty();
  };

  const localPoint = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /* ---------- Transform handle hit-test (screen space) ---------- */
  const hitHandle = (sx: number, sy: number): TransformHandle | null => {
    const bb = getSelectedBBox();
    if (!bb) return null;
    const v = viewRef.current;
    const rx = v.panX + bb.x * v.zoom;
    const ry = v.panY + bb.y * v.zoom;
    const rw = bb.w * v.zoom;
    const rh = bb.h * v.zoom;
    const hs = 10;
    const rcx = rx + rw / 2, rcy = ry - 24;
    if (Math.hypot(sx - rcx, sy - rcy) < 10) return "rotate";
    const inRange = (x: number, y: number) => Math.abs(sx - x) < hs && Math.abs(sy - y) < hs;
    if (inRange(rx, ry)) return "nw";
    if (inRange(rx + rw / 2, ry)) return "n";
    if (inRange(rx + rw, ry)) return "ne";
    if (inRange(rx + rw, ry + rh / 2)) return "e";
    if (inRange(rx + rw, ry + rh)) return "se";
    if (inRange(rx + rw / 2, ry + rh)) return "s";
    if (inRange(rx, ry + rh)) return "sw";
    if (inRange(rx, ry + rh / 2)) return "w";
    if (sx >= rx && sx <= rx + rw && sy >= ry && sy <= ry + rh) return "move";
    return null;
  };

  const findObjectAt = (wx: number, wy: number): SelectedObject | null => {
    // top-most first — walk all layers reverse
    const layersR = [...layersRef.current].reverse();
    for (const l of layersR) {
      if (!l.visible) continue;
      // images last-drawn are last in list; check reverse
      for (let i = l.images.length - 1; i >= 0; i--) {
        const im = l.images[i];
        if (pointInRect(wx, wy, { x: im.x, y: im.y, w: im.w, h: im.h })) {
          return { kind: "image", layerId: l.id, imageId: im.id };
        }
      }
      for (let i = l.strokes.length - 1; i >= 0; i--) {
        const s = l.strokes[i];
        if (hitTestStroke(s, wx, wy)) return { kind: "stroke", layerId: l.id, strokeId: s.id };
      }
    }
    return null;
  };

  const applyTransformDelta = (curW: { x: number; y: number }) => {
    const tr = activeTransform.current;
    if (!tr) return;
    const sel = selectedObjRef.current;
    const bb = tr.origBBox;

    let dx = curW.x - tr.startW.x;
    let dy = curW.y - tr.startW.y;

    if (tr.handle === "move") {
      // move all
      if (sel) {
        const layer = layersRef.current.find(l => l.id === sel.layerId);
        if (!layer) return;
        if (sel.kind === "image" && tr.origImage) {
          const im = layer.images.find(x => x.id === sel.imageId);
          if (im) { im.x = tr.origImage.x + dx; im.y = tr.origImage.y + dy; }
        } else if (sel.kind === "stroke" && tr.origPoints) {
          const s = layer.strokes.find(x => x.id === sel.strokeId);
          if (s) s.points = tr.origPoints.map(p => ({ x: p.x + dx, y: p.y + dy, t: p.t }));
        }
      } else if (selectionRectRef.current) {
        // move selection rectangle (visual only)
        const r = selectionRectRef.current;
        setSelectionRect({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
        activeTransform.current = null; // one-shot start; simplest: rebase
      }
      markDirty();
      return;
    }

    if (tr.handle === "rotate" && sel && tr.center) {
      const a0 = tr.startAngle ?? 0;
      const a1 = Math.atan2(curW.y - tr.center.y, curW.x - tr.center.x);
      const da = a1 - a0;
      const cx = tr.center.x, cy = tr.center.y;
      const layer = layersRef.current.find(l => l.id === sel.layerId);
      if (!layer) return;
      const cos = Math.cos(da), sin = Math.sin(da);
      if (sel.kind === "image" && tr.origImage) {
        const im = layer.images.find(x => x.id === sel.imageId);
        if (im) im.rotation = (tr.origImage.rotation || 0) + da;
      } else if (sel.kind === "stroke" && tr.origPoints) {
        const s = layer.strokes.find(x => x.id === sel.strokeId);
        if (s) s.points = tr.origPoints.map(p => {
          const px = p.x - cx, py = p.y - cy;
          return { x: cx + px * cos - py * sin, y: cy + px * sin + py * cos, t: p.t };
        });
      }
      markDirty();
      return;
    }

    // Scale
    if (!sel) return;
    let sx = 1, sy = 1;
    let ax = bb.x, ay = bb.y; // anchor
    switch (tr.handle) {
      case "e":  sx = (bb.w + dx) / bb.w; sy = 1; ax = bb.x; ay = bb.y; break;
      case "w":  sx = (bb.w - dx) / bb.w; sy = 1; ax = bb.x + bb.w; ay = bb.y; break;
      case "s":  sx = 1; sy = (bb.h + dy) / bb.h; ax = bb.x; ay = bb.y; break;
      case "n":  sx = 1; sy = (bb.h - dy) / bb.h; ax = bb.x; ay = bb.y + bb.h; break;
      case "se": sx = (bb.w + dx) / bb.w; sy = (bb.h + dy) / bb.h; ax = bb.x; ay = bb.y; break;
      case "ne": sx = (bb.w + dx) / bb.w; sy = (bb.h - dy) / bb.h; ax = bb.x; ay = bb.y + bb.h; break;
      case "sw": sx = (bb.w - dx) / bb.w; sy = (bb.h + dy) / bb.h; ax = bb.x + bb.w; ay = bb.y; break;
      case "nw": sx = (bb.w - dx) / bb.w; sy = (bb.h - dy) / bb.h; ax = bb.x + bb.w; ay = bb.y + bb.h; break;
      default: return;
    }
    if (!isFinite(sx) || !isFinite(sy) || sx === 0 || sy === 0) return;
    const layer = layersRef.current.find(l => l.id === sel.layerId);
    if (!layer) return;
    if (sel.kind === "image" && tr.origImage) {
      const im = layer.images.find(x => x.id === sel.imageId);
      if (im) {
        im.x = ax + (tr.origImage.x - ax) * sx;
        im.y = ay + (tr.origImage.y - ay) * sy;
        im.w = tr.origImage.w * sx;
        im.h = tr.origImage.h * sy;
      }
    } else if (sel.kind === "stroke" && tr.origPoints) {
      const s = layer.strokes.find(x => x.id === sel.strokeId);
      if (s) {
        s.points = tr.origPoints.map(p => ({
          x: ax + (p.x - ax) * sx,
          y: ay + (p.y - ay) * sy,
          t: p.t,
        }));
        if (tr.origSize) s.size = tr.origSize * (Math.abs(sx) + Math.abs(sy)) / 2;
      }
    }
    markDirty();
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const local = localPoint(e);
    activePointers.current.set(e.pointerId, local);

    if (activePointers.current.size >= 2 && e.pointerType === "touch") {
      if (drawingPointerId.current !== null) {
        currentStrokeRef.current = null;
        drawingPointerId.current = null;
      }
      const pts = [...activePointers.current.values()];
      const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
      pinchState.current = {
        dist: Math.hypot(dx, dy),
        midX: (pts[0].x + pts[1].x) / 2,
        midY: (pts[0].y + pts[1].y) / 2,
        zoom: viewRef.current.zoom,
        panX: viewRef.current.panX,
        panY: viewRef.current.panY,
      };
      return;
    }

    const wantPan = (e.pointerType === "mouse" && e.button === 1) || spaceRef.current;
    if (wantPan) {
      panState.current = { id: e.pointerId, sx: local.x, sy: local.y, panX: viewRef.current.panX, panY: viewRef.current.panY };
      return;
    }

    // Eyedropper: sample color from canvas
    if (eyedropper) {
      const c = canvasRef.current!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const ctx = c.getContext("2d")!;
      try {
        const pix = ctx.getImageData(Math.floor(local.x * dpr), Math.floor(local.y * dpr), 1, 1).data;
        const [h, s, l] = rgbToHsl(pix[0], pix[1], pix[2]);
        setColor({ h, s, l, a: pix[3] / 255 || 1 });
      } catch { /* CORS if img */ }
      setEyedropper(false);
      return;
    }

    const wpt = screenToWorld(local.x, local.y);
    const tl = toolRef.current;

    if (tl === "transform" && selectedObjRef.current) {
      const h = hitHandle(local.x, local.y);
      if (h) {
        const bb = getSelectedBBox()!;
        const sel = selectedObjRef.current;
        const layer = layersRef.current.find(l => l.id === sel.layerId)!;
        let origPoints: StrokePoint[] | undefined;
        let origImage: { x: number; y: number; w: number; h: number; rotation: number } | undefined;
        let origSize: number | undefined;
        if (sel.kind === "stroke") {
          const s = layer.strokes.find(x => x.id === sel.strokeId)!;
          origPoints = s.points.map(p => ({ ...p }));
          origSize = s.size;
        } else {
          const im = layer.images.find(x => x.id === sel.imageId)!;
          origImage = { x: im.x, y: im.y, w: im.w, h: im.h, rotation: im.rotation || 0 };
        }
        const center = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
        activeTransform.current = {
          handle: h,
          startW: wpt,
          origBBox: bb,
          origPoints, origImage, origSize,
          center,
          startAngle: h === "rotate" ? Math.atan2(wpt.y - center.y, wpt.x - center.x) : undefined,
        };
        drawingPointerId.current = e.pointerId;
        lastDrawScreen.current = local;
        return;
      }
      // else fall through to object pick
    }

    if (tl === "select-object") {
      const obj = findObjectAt(wpt.x, wpt.y);
      setSelectedObj(obj);
      setSelectionRect(null);
      if (obj) {
        // enable transform right away
        const bb = getSelectedBBox()!;
        const layer = layersRef.current.find(l => l.id === obj.layerId)!;
        let origPoints: StrokePoint[] | undefined;
        let origImage: { x: number; y: number; w: number; h: number; rotation: number } | undefined;
        let origSize: number | undefined;
        if (obj.kind === "stroke") {
          const s = layer.strokes.find(x => x.id === obj.strokeId)!;
          origPoints = s.points.map(p => ({ ...p }));
          origSize = s.size;
        } else {
          const im = layer.images.find(x => x.id === obj.imageId)!;
          origImage = { x: im.x, y: im.y, w: im.w, h: im.h, rotation: im.rotation || 0 };
        }
        activeTransform.current = {
          handle: "move",
          startW: wpt,
          origBBox: bb,
          origPoints, origImage, origSize,
          center: { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 },
        };
        drawingPointerId.current = e.pointerId;
        lastDrawScreen.current = local;
      }
      return;
    }

    if (tl === "select-rect") {
      setSelectedObj(null);
      rectDragRef.current = { startX: wpt.x, startY: wpt.y };
      setSelectionRect({ x: wpt.x, y: wpt.y, w: 0, h: 0 });
      drawingPointerId.current = e.pointerId;
      lastDrawScreen.current = local;
      return;
    }

    // brush / eraser
    if (refs.brush.current === "eraser") {
      eraseAt(wpt.x, wpt.y, refs.size.current);
      drawingPointerId.current = e.pointerId;
      lastDrawScreen.current = local;
      return;
    }
    drawingPointerId.current = e.pointerId;
    lastDrawScreen.current = local;
    beginStroke(wpt.x, wpt.y);
  };

  const onMove = (e: React.PointerEvent) => {
    const local = localPoint(e);
    if (!activePointers.current.has(e.pointerId)) return;
    activePointers.current.set(e.pointerId, local);

    if (pinchState.current && activePointers.current.size >= 2) {
      const pts = [...activePointers.current.values()];
      const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
      const dist = Math.hypot(dx, dy) || 1;
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const ps = pinchState.current;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, ps.zoom * (dist / ps.dist)));
      const scale = newZoom / ps.zoom;
      viewRef.current.zoom = newZoom;
      viewRef.current.panX = ps.midX - (ps.midX - ps.panX) * scale + (midX - ps.midX);
      viewRef.current.panY = ps.midY - (ps.midY - ps.panY) * scale + (midY - ps.midY);
      setZoomDisplay(newZoom);
      markDirty();
      return;
    }

    if (panState.current && panState.current.id === e.pointerId) {
      const ps = panState.current;
      viewRef.current.panX = ps.panX + (local.x - ps.sx);
      viewRef.current.panY = ps.panY + (local.y - ps.sy);
      markDirty();
      return;
    }

    if (drawingPointerId.current !== e.pointerId) return;

    const wpt = screenToWorld(local.x, local.y);
    const tl = toolRef.current;

    if (activeTransform.current) {
      applyTransformDelta(wpt);
      return;
    }
    if (tl === "select-rect" && rectDragRef.current) {
      const s = rectDragRef.current;
      setSelectionRect({
        x: Math.min(s.startX, wpt.x),
        y: Math.min(s.startY, wpt.y),
        w: Math.abs(wpt.x - s.startX),
        h: Math.abs(wpt.y - s.startY),
      });
      return;
    }
    if (tl === "select-object") return;

    if (refs.brush.current === "eraser") {
      eraseAt(wpt.x, wpt.y, refs.size.current);
      lastDrawScreen.current = local;
      return;
    }
    const px = lastDrawScreen.current.x, py = lastDrawScreen.current.y;
    const dx = local.x - px, dy = local.y - py;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.floor(dist / 5));
    for (let i = 1; i <= steps; i++) {
      const sx2 = px + dx * (i / steps), sy2 = py + dy * (i / steps);
      const w = screenToWorld(sx2, sy2);
      addPoint(w.x, w.y);
    }
    lastDrawScreen.current = local;
  };

  const onUp = (e: React.PointerEvent) => {
    activePointers.current.delete(e.pointerId);
    if (activePointers.current.size < 2) pinchState.current = null;
    if (panState.current && panState.current.id === e.pointerId) panState.current = null;
    if (drawingPointerId.current === e.pointerId) {
      drawingPointerId.current = null;
      if (activeTransform.current) {
        activeTransform.current = null;
        pushHistory();
      } else if (rectDragRef.current) {
        rectDragRef.current = null;
        // keep selection rect
      } else if (currentStrokeRef.current) {
        currentStrokeRef.current = null;
        pushHistory();
      } else if (refs.brush.current === "eraser") {
        pushHistory();
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const r = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) < 50) {
      const factor = Math.exp(-e.deltaY * 0.01);
      const v = viewRef.current;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const scale = newZoom / v.zoom;
      v.panX = sx - (sx - v.panX) * scale;
      v.panY = sy - (sy - v.panY) * scale;
      v.zoom = newZoom;
      setZoomDisplay(newZoom);
    } else {
      viewRef.current.panX -= e.deltaX;
      viewRef.current.panY -= e.deltaY;
    }
    markDirty();
  };

  /* ---------- Selection actions ---------- */
  const deleteSelection = useCallback(() => {
    const sel = selectedObjRef.current;
    if (sel) {
      const next = layersRef.current.map(l => {
        if (l.id !== sel.layerId) return l;
        if (sel.kind === "stroke") return { ...l, strokes: l.strokes.filter(s => s.id !== sel.strokeId) };
        return { ...l, images: l.images.filter(i => i.id !== sel.imageId) };
      });
      layersRef.current = next;
      setLayers(next);
      setSelectedObj(null);
      pushHistory();
      return;
    }
    const rect = selectionRectRef.current;
    if (rect && rect.w > 2 && rect.h > 2) {
      const next = layersRef.current.map(l => {
        if (!l.visible) return l;
        return {
          ...l,
          strokes: l.strokes.filter(s => !rectIntersects(strokeBBox(s), rect)),
          images: l.images.filter(im => !rectIntersects({ x: im.x, y: im.y, w: im.w, h: im.h }, rect)),
        };
      });
      layersRef.current = next;
      setLayers(next);
      setSelectionRect(null);
      pushHistory();
    }
  }, [pushHistory]);

  const duplicateSelection = useCallback(() => {
    const sel = selectedObjRef.current;
    if (!sel) return;
    const layer = layersRef.current.find(l => l.id === sel.layerId);
    if (!layer) return;
    if (sel.kind === "stroke") {
      const s = layer.strokes.find(x => x.id === sel.strokeId);
      if (!s) return;
      const copy: Stroke = JSON.parse(JSON.stringify(s));
      copy.id = ++strokeIdCounter;
      copy.points = copy.points.map(p => ({ ...p, x: p.x + 20, y: p.y + 20 }));
      copy.born = performance.now();
      layer.strokes.push(copy);
      setSelectedObj({ kind: "stroke", layerId: layer.id, strokeId: copy.id });
    } else {
      const im = layer.images.find(x => x.id === sel.imageId);
      if (!im) return;
      const copy: ImageItem = { ...im, id: ++imageIdCounter, x: im.x + 20, y: im.y + 20 };
      layer.images.push(copy);
      setSelectedObj({ kind: "image", layerId: layer.id, imageId: copy.id });
    }
    setLayers([...layersRef.current]);
    pushHistory();
  }, [pushHistory]);

  useEffect(() => {
    const dn = (e: KeyboardEvent) => {
      if (e.code === "Space" && !spaceRef.current) {
        spaceRef.current = true;
        setSpaceDown(true);
      }
      const target = e.target as HTMLElement | null;
      const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (meta && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if (meta && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelection(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && !inField) {
        deleteSelection();
      } else if (e.key === "Escape") {
        setSelectedObj(null); setSelectionRect(null);
      } else if (!inField && !meta) {
        const k = e.key.toLowerCase();
        if (k === "b") setTool("brush");
        else if (k === "v") setTool("select-rect");
        else if (k === "o") setTool("select-object");
        else if (k === "t") setTool("transform");
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") { spaceRef.current = false; setSpaceDown(false); }
    };
    window.addEventListener("keydown", dn);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", dn); window.removeEventListener("keyup", up); };
  }, [undo, redo, deleteSelection, duplicateSelection]);

  /* ---------- Layer ops ---------- */
  const addLayer = () => {
    const id = ++layerIdCounter;
    const next: Layer[] = [...layersRef.current, { id, name: `Слой ${layersRef.current.length + 1}`, visible: true, blendMode: "source-over", opacity: 1, strokes: [], images: [] }];
    layersRef.current = next;
    setLayers(next);
    setActiveLayerId(id);
    pushHistory();
  };
  const removeLayer = (id: number) => {
    if (layersRef.current.length === 1) return;
    const next = layersRef.current.filter(l => l.id !== id);
    layersRef.current = next;
    setLayers(next);
    if (activeLayerIdRef.current === id) setActiveLayerId(next[0].id);
    pushHistory();
  };
  const toggleLayer = (id: number) => {
    const next = layersRef.current.map(l => l.id === id ? { ...l, visible: !l.visible } : l);
    layersRef.current = next;
    setLayers(next);
    markDirty();
  };
  const setLayerBlendMode = (id: number, bm: BlendMode) => {
    const next = layersRef.current.map(l => l.id === id ? { ...l, blendMode: bm } : l);
    layersRef.current = next;
    setLayers(next);
    pushHistory();
  };
  const setLayerOpacity = (id: number, op: number) => {
    const next = layersRef.current.map(l => l.id === id ? { ...l, opacity: op } : l);
    layersRef.current = next;
    setLayers(next);
    markDirty();
  };
  const clearActive = () => {
    const next = layersRef.current.map(l => l.id === activeLayerIdRef.current ? { ...l, strokes: [], images: [] } : l);
    layersRef.current = next;
    setLayers(next);
    pushHistory();
  };
  const clearAll = () => {
    const next = layersRef.current.map(l => ({ ...l, strokes: [], images: [] }));
    layersRef.current = next;
    setLayers(next);
    pushHistory();
  };
  const renameLayer = (id: number, name: string) => {
    const next = layersRef.current.map(l => l.id === id ? { ...l, name } : l);
    layersRef.current = next;
    setLayers(next);
  };
  const reorderLayers = (dragId: number, dropId: number) => {
    if (dragId === dropId) return;
    const arr = [...layersRef.current];
    const fromIdx = arr.findIndex(l => l.id === dragId);
    const toIdx = arr.findIndex(l => l.id === dropId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    layersRef.current = arr;
    setLayers(arr);
    pushHistory();
  };

  const applyCanvasSize = () => {
    const w = Math.max(64, Math.min(8192, parseInt(pendingW) || canvasSize.w));
    const h = Math.max(64, Math.min(8192, parseInt(pendingH) || canvasSize.h));
    setCanvasSize({ w, h });
  };
  const newCanvas = () => {
    const w = Math.max(64, Math.min(8192, parseInt(pendingW) || 1200));
    const h = Math.max(64, Math.min(8192, parseInt(pendingH) || 800));
    layerIdCounter += 1;
    const fresh: Layer[] = [{ id: layerIdCounter, name: "Слой 1", visible: true, blendMode: "source-over", opacity: 1, strokes: [], images: [] }];
    layersRef.current = fresh;
    setLayers(fresh);
    setActiveLayerId(layerIdCounter);
    setCanvasSize({ w, h });
    historyRef.current = [serializeLayers(fresh)];
    historyIdxRef.current = 0;
    setHistoryVer(v => v + 1);
    setSelectedObj(null); setSelectionRect(null);
    markDirty();
  };

  const importFiles = (files: FileList | File[]) => {
    const arr = Array.from(files).filter(f => f.type.startsWith("image/"));
    for (const file of arr) {
      const reader = new FileReader();
      reader.onload = () => {
        const src = reader.result as string;
        const img = new Image();
        img.onload = () => {
          const cs = canvasSizeRef.current;
          const maxDim = Math.min(cs.w, cs.h) * 0.8;
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = img.width * scale, h = img.height * scale;
          const image: ImageItem = { id: ++imageIdCounter, src, x: (cs.w - w) / 2, y: (cs.h - h) / 2, w, h, rotation: 0 };
          imgCache.current.set(src, img);
          const id = ++layerIdCounter;
          const layer: Layer = { id, name: file.name.slice(0, 24), visible: true, blendMode: "source-over", opacity: 1, strokes: [], images: [image] };
          const next = [...layersRef.current, layer];
          layersRef.current = next;
          setLayers(next);
          setActiveLayerId(id);
          pushHistory();
        };
        img.src = src;
      };
      reader.readAsDataURL(file);
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  /* ---------- Export ---------- */
  const savePng = () => {
    const cs = canvasSizeRef.current;
    const scale = 2;
    const tmp = document.createElement("canvas");
    tmp.width = cs.w * scale;
    tmp.height = cs.h * scale;
    const tctx = tmp.getContext("2d")!;
    const now = performance.now();
    const buf = document.createElement("canvas");
    renderFrameToCanvas(tctx, tmp.width, tmp.height, cs.w, cs.h, layersRef.current, imgCache.current, now / 1000, 16, now, buf);
    tmp.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `living-pixels-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };

  const exportGif = async () => {
    if (recording) return;
    setRecording("gif"); setRecordProgress(0);
    try {
      const cs = canvasSizeRef.current;
      const gifW = cs.w * gifScale;
      const gifH = cs.h * gifScale;
      const total = gifFps * gifSeconds;
      const tmp = document.createElement("canvas");
      tmp.width = gifW; tmp.height = gifH;
      const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
      const buf = document.createElement("canvas");
      const gif = GIFEncoder();
      const delay = Math.round(1000 / gifFps);
      const dtRaw = 1000 / gifFps;
      const startNow = performance.now();

      for (let i = 0; i < total; i++) {
        const now = startNow + i * dtRaw;
        renderFrameToCanvas(tctx, gifW, gifH, cs.w, cs.h, layersRef.current, imgCache.current, now / 1000, dtRaw, now, buf);
        const data = tctx.getImageData(0, 0, gifW, gifH).data;
        const palette = quantize(data, 256);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, gifW, gifH, { palette, delay });
        setRecordProgress((i + 1) / total);
        if ((i & 1) === 0) await new Promise(r => setTimeout(r, 0));
      }
      gif.finish();
      const bytes = gif.bytesView();
      const bytesBuf = new Uint8Array(bytes.byteLength); bytesBuf.set(bytes);
      const blob = new Blob([bytesBuf], { type: "image/gif" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `living-pixels-${Date.now()}.gif`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } finally {
      setRecording(null); setRecordProgress(0);
    }
  };

  const exportMp4 = async () => {
    if (recording) return;
    const cs = canvasSizeRef.current;
    const outW = cs.w * mp4Scale;
    const outH = cs.h * mp4Scale;
    const total = mp4Fps * mp4Seconds;
    const tmp = document.createElement("canvas");
    tmp.width = outW; tmp.height = outH;
    const tctx = tmp.getContext("2d")!;
    const buf = document.createElement("canvas");
    renderFrameToCanvas(tctx, outW, outH, cs.w, cs.h, layersRef.current, imgCache.current, 0, 1000 / mp4Fps, performance.now(), buf);

    interface CaptureCanvas extends HTMLCanvasElement { captureStream(fps?: number): MediaStream }
    const stream = (tmp as CaptureCanvas).captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };

    const mimes = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const isSupported = (m: string) => (window as unknown as { MediaRecorder?: { isTypeSupported?: (m: string) => boolean } }).MediaRecorder?.isTypeSupported?.(m) ?? false;
    const mime = mimes.find(isSupported) || "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: mp4Bitrate * 1_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    setRecording("mp4"); setRecordProgress(0);
    rec.start();
    const dtRaw = 1000 / mp4Fps;
    const startNow = performance.now();
    for (let i = 0; i < total; i++) {
      const now = startNow + i * dtRaw;
      renderFrameToCanvas(tctx, outW, outH, cs.w, cs.h, layersRef.current, imgCache.current, now / 1000, dtRaw, now, buf);
      if (track.requestFrame) track.requestFrame();
      setRecordProgress((i + 1) / total);
      await new Promise(r => setTimeout(r, Math.max(1, Math.floor(1000 / mp4Fps))));
    }
    rec.stop();
    await new Promise<void>(r => { rec.onstop = () => r(); });
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `living-pixels-${Date.now()}.${mime.includes("mp4") ? "mp4" : "webm"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setRecording(null); setRecordProgress(0);
  };

  const ParamSlider = ({ label, value, set }: { label: string; value: number; set: (n: number) => void }) => (
    <label className="flex flex-col gap-1 text-[10px] uppercase tracking-widest text-white/50">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="text-white/80">{Math.round(value * 100)}</span>
      </span>
      <input type="range" min={0} max={1} step={0.01} value={value} onChange={(e) => set(+e.target.value)} className="w-full accent-white" />
    </label>
  );

  const draggingLayer = useRef<number | null>(null);
  const [dragOverLayer, setDragOverLayer] = useState<number | null>(null);

  /* ---------- Color picker canvas ---------- */
  const slRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = slRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const w = c.width, h = c.height;
    // Base: full color at top-right (S=100, L=50); build via layered gradients
    // Draw hue-tinted white->color horizontally, then black overlay vertically
    for (let x = 0; x < w; x++) {
      const s = x / (w - 1) * 100;
      for (let y = 0; y < h; y++) {
        const l = (1 - y / (h - 1)) * 100;
        const [r, g, b] = hslToRgb(color.h, s, l);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }, [color.h]);

  const onSLDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    (c as Element).setPointerCapture(e.pointerId);
    const upd = (evt: React.PointerEvent<HTMLCanvasElement>) => {
      const r = c.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, evt.clientX - r.left));
      const y = Math.max(0, Math.min(r.height, evt.clientY - r.top));
      const s = Math.round(x / r.width * 100);
      const l = Math.round((1 - y / r.height) * 100);
      setColor(prev => ({ ...prev, s, l }));
    };
    upd(e);
    const mv = (ev: PointerEvent) => upd(ev as unknown as React.PointerEvent<HTMLCanvasElement>);
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const saveSwatch = () => {
    const hex = toHex(color.h, color.s, color.l);
    setSavedSwatches(prev => prev.includes(hex) ? prev : [...prev, hex].slice(-24));
  };

  const cursor = spaceDown || panState.current ? "grab"
    : eyedropper ? "crosshair"
    : tool === "select-rect" || tool === "select-object" ? "crosshair"
    : tool === "transform" ? "move"
    : brush === "eraser" ? "cell" : "crosshair";

  const currentColorHex = toHex(color.h, color.s, color.l);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#0a0b12] text-white flex">
      {/* Sidebar */}
      <aside className="z-20 flex h-full w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-white/10 bg-black/70 p-3 backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <h1 className="select-none text-[11px] font-medium tracking-[0.3em] text-white/70">LIVING PIXELS</h1>
        </div>

        <div className="flex gap-1.5">
          <button onClick={undo} disabled={!canUndo || !!recording} className="flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-wider transition hover:bg-white/10 disabled:opacity-30">↶ Отменить</button>
          <button onClick={redo} disabled={!canRedo || !!recording} className="flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-wider transition hover:bg-white/10 disabled:opacity-30">Вернуть ↷</button>
        </div>

        {/* Tools */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Инструменты</div>
          <div className="grid grid-cols-4 gap-1">
            {([
              { id: "brush", label: "✎", title: "Кисть (B)" },
              { id: "select-rect", label: "▭", title: "Выделение (V)" },
              { id: "select-object", label: "◎", title: "Выд. объекта (O)" },
              { id: "transform", label: "⤢", title: "Трансформация (T)" },
            ] as { id: Tool; label: string; title: string }[]).map(t => (
              <button
                key={t.id}
                title={t.title}
                onClick={() => setTool(t.id)}
                className={`rounded border px-1 py-1.5 text-[13px] transition ${tool === t.id ? "border-white/60 bg-white/15" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}>
                {t.label}
              </button>
            ))}
          </div>
          {(selectedObj || (selectionRect && selectionRect.w > 2)) && (
            <div className="mt-2 flex gap-1">
              <button onClick={deleteSelection} className="flex-1 rounded border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] tracking-widest text-red-300 hover:bg-red-500/20">Удалить</button>
              <button onClick={duplicateSelection} disabled={!selectedObj} className="flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] tracking-widest hover:bg-white/10 disabled:opacity-30">Дублировать</button>
            </div>
          )}
        </section>

        {/* Canvas size */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-1.5">
          <div className="text-[9px] uppercase tracking-widest text-white/40">Холст {canvasSize.w}×{canvasSize.h}</div>
          <div className="flex gap-1.5">
            <input value={pendingW} onChange={(e) => setPendingW(e.target.value)} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px]" placeholder="Ш" />
            <span className="self-center text-white/40 text-[10px]">×</span>
            <input value={pendingH} onChange={(e) => setPendingH(e.target.value)} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px]" placeholder="В" />
          </div>
          <div className="flex gap-1.5">
            <button onClick={applyCanvasSize} className="flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] tracking-widest hover:bg-white/10">Применить</button>
            <button onClick={newCanvas} className="flex-1 rounded border border-white/10 bg-white/10 px-2 py-1 text-[10px] tracking-widest hover:bg-white/15">Новый холст</button>
          </div>
          <button onClick={fitView} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] tracking-widest hover:bg-white/10">Вписать по размеру</button>
        </section>

        {/* Import */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Импорт</div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) importFiles(e.target.files); e.target.value = ""; }}
          />
          <button onClick={() => fileInputRef.current?.click()} className="w-full rounded-md border border-white/15 bg-white/10 px-2 py-1.5 text-[11px] tracking-wider hover:bg-white/15">📁 Загрузить изображение</button>
        </section>

        {/* Layers */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[9px] uppercase tracking-widest text-white/40">Слои (перетащи ⋮⋮)</div>
            <button onClick={addLayer} className="rounded border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] hover:bg-white/20">+ Слой</button>
          </div>
          <ul className="flex flex-col gap-1">
            {[...layers].reverse().map((l) => (
              <li
                key={l.id}
                draggable
                onDragStart={() => { draggingLayer.current = l.id; }}
                onDragEnd={() => { draggingLayer.current = null; setDragOverLayer(null); }}
                onDragOver={(e) => { e.preventDefault(); setDragOverLayer(l.id); }}
                onDragLeave={() => setDragOverLayer(prev => prev === l.id ? null : prev)}
                onDrop={(e) => {
                  e.preventDefault();
                  const dragId = draggingLayer.current;
                  if (dragId !== null) reorderLayers(dragId, l.id);
                  setDragOverLayer(null);
                }}
                className={`flex flex-col gap-1 rounded-md border px-1.5 py-1 ${activeLayerId === l.id ? "border-white/40 bg-white/10" : "border-white/5 bg-transparent hover:bg-white/[0.04]"} ${dragOverLayer === l.id ? "ring-1 ring-cyan-400/60" : ""}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="cursor-grab text-white/30 select-none" title="Перетащить">⋮⋮</span>
                  <button onClick={() => toggleLayer(l.id)} className="text-[12px] leading-none text-white/70 hover:text-white" title="Видимость">{l.visible ? "👁" : "—"}</button>
                  <input
                    value={l.name}
                    onChange={(e) => renameLayer(l.id, e.target.value)}
                    onFocus={() => setActiveLayerId(l.id)}
                    className={`flex-1 min-w-0 bg-transparent text-[11px] outline-none ${activeLayerId === l.id ? "text-white" : "text-white/70"}`}
                  />
                  <span className="text-[9px] text-white/30">{l.strokes.length + l.images.length}</span>
                  <button onClick={() => removeLayer(l.id)} disabled={layers.length === 1} className="text-[11px] text-white/40 hover:text-red-400 disabled:opacity-20" title="Удалить">✕</button>
                </div>
                <div className="flex items-center gap-1">
                  <select
                    value={l.blendMode || "source-over"}
                    onChange={(e) => setLayerBlendMode(l.id, e.target.value as BlendMode)}
                    className="flex-1 min-w-0 rounded border border-white/10 bg-black/40 px-1 py-0.5 text-[9px] outline-none">
                    {BLEND_MODES.map(bm => <option key={bm.id} value={bm.id}>{bm.label}</option>)}
                  </select>
                  <input type="range" min={0} max={1} step={0.01} value={l.opacity ?? 1}
                    onChange={(e) => setLayerOpacity(l.id, +e.target.value)}
                    onMouseUp={pushHistory} onTouchEnd={pushHistory}
                    className="w-16 accent-white" title="Непрозрачность" />
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-1.5">
            <button onClick={clearActive} className="flex-1 rounded border border-white/10 px-1.5 py-1 text-[10px] uppercase tracking-widest text-white/60 hover:bg-white/5">Очистить слой</button>
            <button onClick={clearAll} className="flex-1 rounded border border-white/10 px-1.5 py-1 text-[10px] uppercase tracking-widest text-white/60 hover:bg-white/5">Всё</button>
          </div>
        </section>

        {/* Color picker */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[9px] uppercase tracking-widest text-white/40">Цвет</div>
            <button
              onClick={() => setEyedropper(v => !v)}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${eyedropper ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-200" : "border-white/10 bg-white/5 hover:bg-white/10"}`}
              title="Пипетка">
              ◉
            </button>
          </div>
          <div className="relative">
            <canvas
              ref={slRef}
              width={220}
              height={120}
              onPointerDown={onSLDown}
              className="w-full rounded border border-white/10"
              style={{ height: 120, touchAction: "none" }}
            />
            <div className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{
                left: `${color.s}%`,
                top: `${100 - color.l}%`,
                mixBlendMode: "difference",
              }} />
          </div>
          <input type="range" min={0} max={360} value={color.h}
            onChange={(e) => setColor(c => ({ ...c, h: +e.target.value }))}
            className="w-full"
            style={{ background: "linear-gradient(to right, hsl(0,90%,60%), hsl(60,90%,60%), hsl(120,90%,60%), hsl(180,90%,60%), hsl(240,90%,60%), hsl(300,90%,60%), hsl(360,90%,60%))", appearance: "none", height: 8, borderRadius: 999 }}
          />
          <div className="flex items-center gap-1.5">
            <div className="h-8 w-8 rounded border border-white/20" style={{ backgroundColor: `rgba(${hslToRgb(color.h, color.s, color.l).join(",")},${color.a})` }} />
            <input
              value={currentColorHex}
              onChange={(e) => {
                const parsed = fromHex(e.target.value);
                if (parsed) setColor(c => ({ ...c, h: parsed[0], s: parsed[1], l: parsed[2] }));
              }}
              className="w-20 rounded border border-white/10 bg-white/5 px-1.5 py-1 text-[10px] tabular-nums"
            />
            <label className="flex flex-1 flex-col text-[9px] text-white/50">
              <span className="flex justify-between"><span>A</span><span>{Math.round(color.a * 100)}</span></span>
              <input type="range" min={0} max={1} step={0.01} value={color.a}
                onChange={(e) => setColor(c => ({ ...c, a: +e.target.value }))}
                className="w-full accent-white" />
            </label>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-widest text-white/40">
              <span>Палитра</span>
              <button onClick={saveSwatch} className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] hover:bg-white/10">+ Сохранить</button>
            </div>
            <div className="grid grid-cols-12 gap-1">
              {PRESET_SWATCHES.map(hex => (
                <button key={hex} onClick={() => {
                  const p = fromHex(hex);
                  if (p) setColor(c => ({ ...c, h: p[0], s: p[1], l: p[2] }));
                }}
                  className="h-4 w-4 rounded border border-white/10 hover:scale-110"
                  style={{ backgroundColor: hex }} title={hex} />
              ))}
            </div>
            {savedSwatches.length > 0 && (
              <div className="mt-1 grid grid-cols-12 gap-1">
                {savedSwatches.map((hex, i) => (
                  <button key={hex + i}
                    onClick={() => {
                      const p = fromHex(hex);
                      if (p) setColor(c => ({ ...c, h: p[0], s: p[1], l: p[2] }));
                    }}
                    onContextMenu={(e) => { e.preventDefault(); setSavedSwatches(prev => prev.filter((_, j) => j !== i)); }}
                    className="h-4 w-4 rounded border border-white/10 hover:scale-110"
                    style={{ backgroundColor: hex }} title={`${hex} (ПКМ — удалить)`} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Brush */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Кисть</div>
          <div className="grid grid-cols-2 gap-1">
            {BRUSHES.map(b => (
              <button key={b.id} onClick={() => { setBrush(b.id); setTool("brush"); }} className={`rounded border px-2 py-1 text-[10px] tracking-wider transition ${brush === b.id && tool === "brush" ? "border-white/60 bg-white/15" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}>{b.label}</button>
            ))}
          </div>
        </section>

        {/* Effects — combinable with any brush */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[9px] uppercase tracking-widest text-white/40">Эффекты</div>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-white/80">
            <input type="checkbox" checked={gradientEnabled} onChange={(e) => setGradientEnabled(e.target.checked)} />
            <span>Градиент</span>
          </label>
          {gradientEnabled && (
            <div className="space-y-2 rounded border border-white/10 bg-black/20 p-2">
              <div className="space-y-1">
                {gradientCfg.stops.map((stp, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input type="color" value={toHex(stp.h, stp.s, stp.l)}
                      onChange={(e) => {
                        const p = fromHex(e.target.value);
                        if (!p) return;
                        setGradientCfg(g => ({ ...g, stops: g.stops.map((s, j) => j === i ? { ...s, h: p[0], s: p[1], l: p[2] } : s) }));
                      }}
                      className="h-5 w-5 rounded border border-white/10 bg-transparent" />
                    <input type="range" min={0} max={1} step={0.01} value={stp.offset}
                      onChange={(e) => setGradientCfg(g => ({ ...g, stops: g.stops.map((s, j) => j === i ? { ...s, offset: +e.target.value } : s) }))}
                      className="flex-1 accent-white" />
                    <input type="range" min={0} max={1} step={0.01} value={stp.a}
                      onChange={(e) => setGradientCfg(g => ({ ...g, stops: g.stops.map((s, j) => j === i ? { ...s, a: +e.target.value } : s) }))}
                      className="w-10 accent-white" title="Alpha" />
                    <button onClick={() => setGradientCfg(g => ({ ...g, stops: g.stops.filter((_, j) => j !== i) }))} disabled={gradientCfg.stops.length <= 2} className="text-[11px] text-white/40 hover:text-red-400 disabled:opacity-20">✕</button>
                  </div>
                ))}
                <button onClick={() => setGradientCfg(g => ({ ...g, stops: [...g.stops, { offset: 1, h: color.h, s: color.s, l: color.l, a: color.a }] }))} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] hover:bg-white/10">+ Стоп</button>
              </div>
              <label className="flex items-center gap-2 text-[10px] text-white/60">
                <input type="checkbox" checked={gradientCfg.animate} onChange={(e) => setGradientCfg(g => ({ ...g, animate: e.target.checked }))} />
                Анимация
              </label>
              <label className="block text-[10px] text-white/50">
                <span className="flex justify-between"><span>Скорость потока</span><span className="text-white/80">{gradientCfg.speed.toFixed(2)}</span></span>
                <input type="range" min={0} max={2} step={0.05} value={gradientCfg.speed}
                  onChange={(e) => setGradientCfg(g => ({ ...g, speed: +e.target.value }))}
                  className="w-full accent-white" />
              </label>
            </div>
          )}
        </section>


        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Режим</div>
          <div className="grid grid-cols-3 gap-1">
            {MODES.map(m => (
              <button key={m.id} onClick={() => setMode(m.id)} className={`rounded border px-1.5 py-1 text-[9px] uppercase tracking-widest transition ${mode === m.id ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{m.label}</button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
          <label className="block text-[10px] uppercase tracking-widest text-white/50">
            <span className="mb-1 flex justify-between"><span>Размер</span><span className="text-white/80">{size}</span></span>
            <input type="range" min={4} max={120} value={size} onChange={(e) => setSize(+e.target.value)} className="w-full accent-white" />
          </label>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
          <div className="mb-1 text-[9px] uppercase tracking-widest text-white/40">Параметры</div>
          <ParamSlider label="Скорость" value={speed} set={setSpeed} />
          <ParamSlider label="Плотность" value={density} set={setDensity} />
          <ParamSlider label="Шум" value={noise} set={setNoise} />
          <ParamSlider label="Интенсив." value={intensity} set={setIntensity} />
          <ParamSlider label="Динамика" value={dynamics} set={setDynamics} />
        </section>

        {/* Export */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
          <div className="text-[9px] uppercase tracking-widest text-white/40">Экспорт</div>
          <button onClick={savePng} disabled={!!recording} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-widest hover:bg-white/10 disabled:opacity-40">
            PNG · {canvasSize.w * 2}×{canvasSize.h * 2}
          </button>

          <div className="space-y-1 border-t border-white/10 pt-2">
            <div className="text-[9px] uppercase tracking-widest text-white/40">GIF</div>
            <div className="flex gap-1">
              <span className="self-center text-[9px] uppercase text-white/40">Масштаб</span>
              {EXPORT_SCALES.map(s => (
                <button key={s} onClick={() => setGifScale(s)} className={`flex-1 rounded border px-1 py-1 text-[9px] transition ${gifScale === s ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{s}x</button>
              ))}
            </div>
            <label className="block text-[10px] text-white/50">
              <span className="flex justify-between"><span>Длительность</span><span className="text-white/80">{gifSeconds}s</span></span>
              <input type="range" min={1} max={15} value={gifSeconds} onChange={(e) => setGifSeconds(+e.target.value)} className="w-full accent-white" />
            </label>
            <label className="block text-[10px] text-white/50">
              <span className="flex justify-between"><span>FPS</span><span className="text-white/80">{gifFps}</span></span>
              <input type="range" min={5} max={30} value={gifFps} onChange={(e) => setGifFps(+e.target.value)} className="w-full accent-white" />
            </label>
            <button onClick={exportGif} disabled={!!recording} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-widest hover:bg-white/10 disabled:opacity-40">
              {recording === "gif" ? `GIF ${Math.round(recordProgress * 100)}%` : `⬇ GIF · ${canvasSize.w * gifScale}×${canvasSize.h * gifScale}`}
            </button>
          </div>

          <div className="space-y-1 border-t border-white/10 pt-2">
            <div className="text-[9px] uppercase tracking-widest text-white/40">MP4 / WebM</div>
            <div className="flex gap-1">
              <span className="self-center text-[9px] uppercase text-white/40">Масштаб</span>
              {EXPORT_SCALES.map(s => (
                <button key={s} onClick={() => setMp4Scale(s)} className={`flex-1 rounded border px-1 py-1 text-[9px] transition ${mp4Scale === s ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{s}x</button>
              ))}
            </div>
            <label className="block text-[10px] text-white/50">
              <span className="flex justify-between"><span>Длительность</span><span className="text-white/80">{mp4Seconds}s</span></span>
              <input type="range" min={1} max={30} value={mp4Seconds} onChange={(e) => setMp4Seconds(+e.target.value)} className="w-full accent-white" />
            </label>
            <label className="block text-[10px] text-white/50">
              <span className="flex justify-between"><span>FPS</span><span className="text-white/80">{mp4Fps}</span></span>
              <input type="range" min={10} max={60} value={mp4Fps} onChange={(e) => setMp4Fps(+e.target.value)} className="w-full accent-white" />
            </label>
            <label className="block text-[10px] text-white/50">
              <span className="flex justify-between"><span>Битрейт</span><span className="text-white/80">{mp4Bitrate}M</span></span>
              <input type="range" min={1} max={20} value={mp4Bitrate} onChange={(e) => setMp4Bitrate(+e.target.value)} className="w-full accent-white" />
            </label>
            <button onClick={exportMp4} disabled={!!recording} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-widest hover:bg-white/10 disabled:opacity-40">
              {recording === "mp4" ? `MP4 ${Math.round(recordProgress * 100)}%` : `⬇ MP4 · ${canvasSize.w * mp4Scale}×${canvasSize.h * mp4Scale}`}
            </button>
          </div>
        </section>

        <div className="text-center text-[9px] leading-relaxed text-white/30">
          B кисть · V выделение · O объект · T трансформ<br/>
          Del удалить · Ctrl+D дублировать · Esc сброс<br/>
          Ctrl+Z / Shift+Ctrl+Z · Space+drag = pan · Wheel = zoom
        </div>
      </aside>

      {/* Workspace */}
      <div
        ref={wrapRef}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragOver(false);
          if (e.dataTransfer?.files.length) importFiles(e.dataTransfer.files);
        }}
        className="relative flex-1 overflow-hidden"
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={onWheel}
          style={{ width: viewport.w, height: viewport.h, cursor, touchAction: "none" }}
          className="block select-none"
        />
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-cyan-400/10 ring-2 ring-inset ring-cyan-400/60 text-cyan-200 text-sm tracking-widest">
            ⬇ Отпустите изображения на холст
          </div>
        )}
        <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-md border border-white/10 bg-black/60 px-3 py-1 text-[10px] tracking-widest text-white/70 backdrop-blur">
          {tool === "brush" ? "КИСТЬ" : tool === "select-rect" ? "ВЫДЕЛЕНИЕ" : tool === "select-object" ? "ВЫД. ОБЪЕКТА" : "ТРАНСФОРМАЦИЯ"}
          {eyedropper && " · ПИПЕТКА"}
        </div>
        <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-white/10 bg-black/60 p-1 text-[11px] backdrop-blur">
          <button
            onClick={() => {
              const v = viewRef.current;
              const sx = viewport.w / 2, sy = viewport.h / 2;
              const nz = Math.max(MIN_ZOOM, v.zoom / 1.2);
              const scale = nz / v.zoom;
              v.panX = sx - (sx - v.panX) * scale;
              v.panY = sy - (sy - v.panY) * scale;
              v.zoom = nz; setZoomDisplay(nz); markDirty();
            }}
            className="pointer-events-auto rounded px-2 py-0.5 hover:bg-white/10">−</button>
          <button onClick={fitView} className="pointer-events-auto rounded px-2 py-0.5 tabular-nums hover:bg-white/10">{Math.round(zoomDisplay * 100)}%</button>
          <button
            onClick={() => {
              const v = viewRef.current;
              const sx = viewport.w / 2, sy = viewport.h / 2;
              const nz = Math.min(MAX_ZOOM, v.zoom * 1.2);
              const scale = nz / v.zoom;
              v.panX = sx - (sx - v.panX) * scale;
              v.panY = sy - (sy - v.panY) * scale;
              v.zoom = nz; setZoomDisplay(nz); markDirty();
            }}
            className="pointer-events-auto rounded px-2 py-0.5 hover:bg-white/10">+</button>
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-white/10 bg-black/60 px-2 py-1 text-[10px] text-white/50 backdrop-blur">
          Холст {canvasSize.w}×{canvasSize.h}
        </div>
      </div>
    </main>
  );
}
