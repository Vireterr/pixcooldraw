import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Living Pixels — Animated Brush Studio" },
      { name: "description", content: "Draw with living animated brushes, layers, undo/redo and quality export to GIF/MP4." },
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
  | "fill"
  | "eraser";

type ModeKind = "normal" | "rainbow" | "gradient" | "pulse" | "spray" | "mirror";

interface StrokePoint { x: number; y: number; t: number }

interface Stroke {
  id: number;
  kind: BrushKind;
  mode: ModeKind;
  size: number;
  hue: number;
  speed: number;
  density: number;
  noise: number;
  intensity: number;
  dynamics: number;
  rainbowFlow: boolean;
  rainbowFlowSpeed: number;
  gradientSpeed: number;
  gradientColors: { hue: number; weight: number }[];
  gradientAngle: number;
  points: StrokePoint[];
  born: number;
  // transient per-brush buckets (not serialized in history)
  ink?: { phase: number };
  rain?: { x: number; y: number; vy: number; hue: number; len: number; seed: number }[];
}

interface Layer {
  id: number;
  name: string;
  visible: boolean;
  strokes: Stroke[];
}

const BRUSHES: { id: BrushKind; label: string }[] = [
  { id: "ink", label: "Чернила" },
  { id: "ribbon", label: "Лента" },
  { id: "lightning", label: "Молния" },
  { id: "pixelRain", label: "Пикс. дождь" },
  { id: "pixelDither", label: "Дизеринг" },
  { id: "pixelGlitch", label: "Глитч" },
  { id: "fill", label: "Заливка" },
  { id: "eraser", label: "Ластик" },
];

const MODES: { id: ModeKind; label: string }[] = [
  { id: "normal", label: "Обычный" },
  { id: "rainbow", label: "Радуга" },
  { id: "gradient", label: "Градиент" },
  { id: "pulse", label: "Пульс" },
  { id: "spray", label: "Распыление" },
  { id: "mirror", label: "Зеркало" },
];

const GIF_PRESETS = {
  low:    { colors: 64,  label: "Низкое" },
  medium: { colors: 128, label: "Среднее" },
  high:   { colors: 256, label: "Высокое" },
} as const;
type GifQ = keyof typeof GIF_PRESETS;

const MP4_PRESETS = {
  low:    { bps: 2_500_000, label: "Низкое" },
  medium: { bps: 6_000_000, label: "Среднее" },
  high:   { bps: 12_000_000, label: "Высокое" },
} as const;
type Mp4Q = keyof typeof MP4_PRESETS;

const SCALES = [1, 2, 3] as const;
const DURATIONS = [2, 3, 4, 6, 8, 10] as const;
const FPS_OPTIONS = [10, 15, 24, 30, 60] as const;

const HISTORY_LIMIT = 60;
const MAX_POINTS_PER_STROKE = 600;

// ==== PERF: tunables ====
// Global cap on live pixelRain particles across the ENTIRE scene (was 200 PER STROKE before).
const GLOBAL_RAIN_CAP = 500;
// Every this many total points across the visible scene, live rendering skips one extra point
// per segment for ink/ribbon/lightning. Keeps per-frame cost roughly bounded instead of growing
// linearly forever with stroke count/length.
const LOAD_STEP_DIVISOR = 4000;

function hash(n: number) {
  n = (n << 13) ^ n;
  return 1.0 - (((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741823.5);
}

// ==== Custom gradient tool: color <-> hue conversion + multi-stop interpolation ====
function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return Math.round(h);
}
function hueToHex(hue: number): string {
  const s = 0.9, l = 0.6;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
// Cyclic interpolation across N user-picked hues, each with its own WEIGHT controlling how much
// of the 0..1 cycle it occupies (higher weight = that color dominates a larger stretch, and the
// transition into/out of it takes proportionally longer). t travels continuously (not clamped to
// [0,1]), so feeding it a growing time-based value makes the palette flow endlessly along the stroke.
function sampleGradient(stops: { hue: number; weight: number }[], t: number): number {
  const n = stops.length;
  if (n === 0) return 0;
  if (n === 1) return stops[0].hue;
  const totalW = stops.reduce((a, s) => a + Math.max(0.05, s.weight), 0);
  const norm = ((t % 1) + 1) % 1;
  let acc = 0;
  let idx = n - 1;
  let segStart = 0, segEnd = 1;
  for (let i = 0; i < n; i++) {
    const w = Math.max(0.05, stops[i].weight) / totalW;
    const next = acc + w;
    if (norm < next || i === n - 1) { idx = i; segStart = acc; segEnd = next; break; }
    acc = next;
  }
  const frac = segEnd > segStart ? (norm - segStart) / (segEnd - segStart) : 0;
  const c0 = stops[idx].hue;
  const c1 = stops[(idx + 1) % n].hue;
  const diff = ((c1 - c0 + 540) % 360) - 180; // shortest angular path between the two stops
  return (c0 + diff * frac + 360) % 360;
}
// Direction the brush actually travelled, from the first point to the last, in degrees.
// Falls back to 0 for a stroke with no real movement (e.g. a single-click "Заливка" — in that
// case the gradientAngle slider becomes the sole, absolute angle control since there's no
// natural stroke direction to derive from).
function strokeAutoAngleDeg(pts: StrokePoint[]): number {
  if (pts.length < 2) return 0;
  const p0 = pts[0], p1 = pts[pts.length - 1];
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  if (Math.hypot(dx, dy) < 1) return 0;
  return ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
}

let strokeIdCounter = 0;
let layerIdCounter = 0;

// Strip transient fields for history snapshots
function serializeLayers(layers: Layer[]): string {
  return JSON.stringify(layers.map(l => ({
    id: l.id, name: l.name, visible: l.visible,
    strokes: l.strokes.map(s => ({
      id: s.id, kind: s.kind, mode: s.mode, size: s.size, hue: s.hue,
      speed: s.speed, density: s.density, noise: s.noise,
      intensity: s.intensity, dynamics: s.dynamics,
      rainbowFlow: s.rainbowFlow, rainbowFlowSpeed: s.rainbowFlowSpeed, gradientSpeed: s.gradientSpeed,
      gradientColors: s.gradientColors, gradientAngle: s.gradientAngle,
      points: s.points, born: s.born,
    })),
  })));
}
function deserializeLayers(str: string): Layer[] {
  return JSON.parse(str) as Layer[];
}

// ==== PERF: cached pixelDither offset patterns ====
// Previously recomputed a nested dx/dy loop with Math.hypot for EVERY sampled point, EVERY frame.
// The offset pattern only depends on (grid, radius), which are fixed per-stroke — so cache it once
// per (grid, radius) pair and reuse across frames/strokes.
const ditherOffsetCache = new Map<string, { dx: number; dy: number; dist: number }[]>();
function getDitherOffsets(grid: number, radius: number) {
  const key = `${grid}_${Math.round(radius)}`;
  let cached = ditherOffsetCache.get(key);
  if (cached) return cached;
  const list: { dx: number; dy: number; dist: number }[] = [];
  for (let dx = -radius; dx <= radius; dx += grid) {
    for (let dy = -radius; dy <= radius; dy += grid) {
      if (dx * dx + dy * dy > radius * radius) continue;
      list.push({ dx, dy, dist: Math.hypot(dx, dy) / radius });
    }
  }
  ditherOffsetCache.set(key, list);
  return list;
}

// ==== PERF: render options ====
// step: for ink/ribbon, how many points to skip per iteration during LIVE preview (1 = full quality,
//       used always for exports). Scales automatically with total scene load.
// rainBudget: a MUTABLE shared object so pixelRain strokes across the whole frame collectively respect
//       one global particle cap instead of each stroke keeping its own separate 200-particle pool.
interface RenderOpts {
  step: number;
  rainBudget: { left: number };
}
const FULL_QUALITY_OPTS: RenderOpts = { step: 1, rainBudget: { left: Infinity } };

function Index() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // canvas size config
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 1280, h: 800 });

  // layers
  const [layers, setLayers] = useState<Layer[]>(() => [{
    id: ++layerIdCounter, name: "Слой 1", visible: true, strokes: [],
  }]);
  const [activeLayerId, setActiveLayerId] = useState<number>(() => layerIdCounter);
  const layersRef = useRef(layers);
  const activeLayerIdRef = useRef(activeLayerId);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  useEffect(() => { activeLayerIdRef.current = activeLayerId; }, [activeLayerId]);

  // history
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
  }, []);

  const undo = useCallback(() => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    const restored = deserializeLayers(historyRef.current[historyIdxRef.current]);
    layersRef.current = restored;
    setLayers(restored);
    setHistoryVer(v => v + 1);
  }, []);
  const redo = useCallback(() => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    const restored = deserializeLayers(historyRef.current[historyIdxRef.current]);
    layersRef.current = restored;
    setLayers(restored);
    setHistoryVer(v => v + 1);
  }, []);

  const canUndo = historyIdxRef.current > 0;
  const canRedo = historyIdxRef.current < historyRef.current.length - 1;
  void historyVer;

  const currentStrokeRef = useRef<Stroke | null>(null);
  const pointerRef = useRef({ x: 0, y: 0, down: false, px: 0, py: 0 });

  const [brush, setBrush] = useState<BrushKind>("ribbon");
  const [mode, setMode] = useState<ModeKind>("normal");
  const [hue, setHue] = useState(200);
  const [size, setSize] = useState(28);
  const [speed, setSpeed] = useState(0.5);
  const [density, setDensity] = useState(0.5);
  const [noise, setNoise] = useState(0.4);
  const [intensity, setIntensity] = useState(0.7);
  const [dynamics, setDynamics] = useState(0.5);
  const [rainbowFlow, setRainbowFlow] = useState(true);
  const [rainbowFlowSpeed, setRainbowFlowSpeed] = useState(0.5);
  const [gradientSpeed, setGradientSpeed] = useState(0.3);
  const [gradientColors, setGradientColors] = useState<{ hue: number; weight: number }[]>([
    { hue: 200, weight: 1 }, { hue: 320, weight: 1 }, { hue: 60, weight: 1 },
  ]);
  const [gradientAngle, setGradientAngle] = useState(0);
  const [recording, setRecording] = useState<null | "gif" | "mp4">(null);
  const [recordProgress, setRecordProgress] = useState(0);
  const [gifQ, setGifQ] = useState<GifQ>("medium");
  const [mp4Q, setMp4Q] = useState<Mp4Q>("medium");
  const [exportScale, setExportScale] = useState<number>(2);
  const [exportSec, setExportSec] = useState<number>(4);
  const [exportFps, setExportFps] = useState<number>(24);
  const [zoom, setZoom] = useState(1);

  const refs = {
    brush: useRef(brush), mode: useRef(mode), hue: useRef(hue), size: useRef(size),
    speed: useRef(speed), density: useRef(density), noise: useRef(noise),
    intensity: useRef(intensity), dynamics: useRef(dynamics),
    rainbowFlow: useRef(rainbowFlow),
    rainbowFlowSpeed: useRef(rainbowFlowSpeed),
    gradientSpeed: useRef(gradientSpeed), gradientColors: useRef(gradientColors),
    gradientAngle: useRef(gradientAngle),
  };
  useEffect(() => { refs.brush.current = brush; });
  useEffect(() => { refs.mode.current = mode; });
  useEffect(() => { refs.hue.current = hue; });
  useEffect(() => { refs.size.current = size; });
  useEffect(() => { refs.speed.current = speed; });
  useEffect(() => { refs.density.current = density; });
  useEffect(() => { refs.noise.current = noise; });
  useEffect(() => { refs.intensity.current = intensity; });
  useEffect(() => { refs.dynamics.current = dynamics; });
  useEffect(() => { refs.rainbowFlow.current = rainbowFlow; });
  useEffect(() => { refs.rainbowFlowSpeed.current = rainbowFlowSpeed; });
  useEffect(() => { refs.gradientSpeed.current = gradientSpeed; });
  useEffect(() => { refs.gradientColors.current = gradientColors; });
  useEffect(() => { refs.gradientAngle.current = gradientAngle; });

  // resize canvas backing store to logical canvasSize
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = canvasSize.w * dpr;
    c.height = canvasSize.h * dpr;
    c.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [canvasSize]);

  const eraseAt = useCallback((x: number, y: number, r: number) => {
    const r2 = r * r;
    const id = activeLayerIdRef.current;
    const layer = layersRef.current.find(l => l.id === id);
    if (!layer) return;
    for (const s of layer.strokes) {
      s.points = s.points.filter(p => {
        const dx = p.x - x, dy = p.y - y;
        return dx * dx + dy * dy > r2;
      });
      if (s.rain) s.rain = s.rain.filter(i => (i.x - x) ** 2 + (i.y - y) ** 2 > r2);
    }
    layer.strokes = layer.strokes.filter(s => s.points.length > 0);
  }, []);

  // Render loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dtRaw = Math.min(50, now - last);
      last = now;
      const c = canvasRef.current;
      if (!c) { raf = requestAnimationFrame(tick); return; }
      const ctx = c.getContext("2d")!;
      const w = canvasSize.w, h = canvasSize.h;

      ctx.fillStyle = "#080a12";
      ctx.fillRect(0, 0, w, h);

      const t = now / 1000;

      // ==== PERF: compute per-frame load and a shared rain budget BEFORE drawing anything ====
      // This lets per-frame cost stay roughly bounded instead of growing linearly forever with
      // however many strokes/points have accumulated in the session.
      let totalPoints = 0;
      let existingRain = 0;
      for (const layer of layersRef.current) {
        if (!layer.visible) continue;
        for (const s of layer.strokes) {
          totalPoints += s.points.length;
          if (s.rain) existingRain += s.rain.length;
        }
      }
      const liveStep = Math.max(1, Math.floor(totalPoints / LOAD_STEP_DIVISOR) + 1);
      const liveOpts: RenderOpts = {
        step: liveStep,
        rainBudget: { left: Math.max(0, GLOBAL_RAIN_CAP - existingRain) },
      };

      for (const layer of layersRef.current) {
        if (!layer.visible) continue;
        for (const s of layer.strokes) {
          if (s.points.length === 0) continue;
          renderStroke(ctx, s, w, h, t, dtRaw, now, liveOpts);
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [canvasSize]);

  // === Stroke renderer ===
  function renderStroke(ctx: CanvasRenderingContext2D, s: Stroke, w: number, h: number, t: number, dtRaw: number, now: number, opts: RenderOpts) {
    const step = Math.max(1, opts.step);
    const dt = dtRaw * (0.3 + s.speed * 2.4);
    const tt = t * (0.3 + s.speed * 2.4);
    const lifeMs = now - s.born;
    const modeHueShift = s.mode === "rainbow" ? (lifeMs * 0.05) % 360 : 0;
    const modePulse = s.mode === "pulse" ? 0.6 + 0.5 * Math.sin(tt * 2) : 1;
    const modeSpray = s.mode === "spray" ? 2.2 : 1;
    const alphaMul = (0.25 + s.intensity * 0.9) * modePulse;
    const pts = s.points;
    // "Радуга: Поток" keeps its original simple full-spectrum sweep, unchanged.
    // "Градиент" is now fully independent and spatial. Its base direction is auto-derived from
    // the way the brush was actually moved (start point -> end point of the stroke) — draw
    // left-to-right and the gradient flows left-to-right, draw diagonally and it follows that
    // diagonal. gradientAngle (the slider) is an ADDITIONAL offset rotated on top of that auto
    // direction — at 0 it does nothing. For strokes with no real movement (a single-click "Заливка")
    // the auto direction is 0, so the slider becomes the sole, absolute angle control there.
    const rainbowFlowActive = s.mode === "rainbow" && s.rainbowFlow;
    const legacySpread = rainbowFlowActive ? 360 : 0;
    const legacyFlow = rainbowFlowActive ? (tt * (10 + s.rainbowFlowSpeed * 150)) % 360 : 0;
    const nSeg = Math.max(1, pts.length - 1);
    const gradAutoAngle = s.mode === "gradient" ? strokeAutoAngleDeg(pts) : 0;
    const gradAngleRad = ((gradAutoAngle + s.gradientAngle) * Math.PI) / 180;
    const gradCos = Math.cos(gradAngleRad), gradSin = Math.sin(gradAngleRad);
    // Normalize the projection so the picked colors span roughly the visible canvas regardless of angle.
    const gradExtent = Math.abs(w * gradCos) + Math.abs(h * gradSin) || 1;
    const gradTravel = tt * (0.03 + s.gradientSpeed * 0.5);
    const gradientHueAtXY = (x: number, y: number): number => {
      const proj = (x * gradCos + y * gradSin) / gradExtent;
      return sampleGradient(s.gradientColors, proj + gradTravel);
    };
    const hueAt = (i: number, f = 0): number => {
      if (s.mode === "gradient") {
        const p0 = pts[Math.min(i, pts.length - 1)];
        const p1 = pts[Math.min(i + 1, pts.length - 1)];
        const px = p0.x + (p1.x - p0.x) * f;
        const py = p0.y + (p1.y - p0.y) * f;
        return gradientHueAtXY(px, py);
      }
      const posT = (i + f) / nSeg;
      return (s.hue + modeHueShift + legacyFlow + legacySpread * posT) % 360;
    };

    if (s.kind === "fill") {
      const alpha = Math.min(1, 0.3 + s.intensity * 0.8) * modePulse;
      if (s.mode === "gradient") {
        // A flat single hue washing the whole canvas every frame reads as "blinking" — instead,
        // bake the same weighted multi-color gradient into a real spatial canvas gradient, sampled
        // at several fixed positions along the chosen angle. gradTravel still animates it, but now
        // as a smoothly scrolling spatial gradient instead of the whole screen flashing one color.
        const halfExtent = gradExtent / 2;
        const cx = w / 2, cy = h / 2;
        const x0 = cx - gradCos * halfExtent, y0 = cy - gradSin * halfExtent;
        const x1 = cx + gradCos * halfExtent, y1 = cy + gradSin * halfExtent;
        const lg = ctx.createLinearGradient(x0, y0, x1, y1);
        const STOPS = 16;
        for (let k = 0; k <= STOPS; k++) {
          const posK = k / STOPS;
          const hueK = sampleGradient(s.gradientColors, posK + gradTravel);
          lg.addColorStop(posK, `hsla(${hueK}, 85%, 55%, ${alpha})`);
        }
        ctx.fillStyle = lg;
      } else {
        const hueF = hueAt(0, 0);
        ctx.fillStyle = `hsla(${hueF}, 85%, 55%, ${alpha})`;
      }
      ctx.fillRect(0, 0, w, h);
      return;
    }

    if (s.kind === "ink") {
      // Pixelated animated line — pixel dots along smooth path with breathing thickness
      if (!s.ink) s.ink = { phase: Math.random() * 100 };
      s.ink.phase += dt * 0.002;
      const grid = Math.max(2, Math.round(s.size / 8));
      const thickness = Math.max(grid, s.size * (0.45 + s.intensity * 0.55) * modePulse * modeSpray);
      const half = thickness / 2;
      const phaseI = s.ink.phase;
      // PERF: skip `step` points at a time under load instead of always walking every single segment.
      for (let i = 0; i < pts.length - 1; i += step) {
        const p = pts[i], nxt = pts[Math.min(i + 1, pts.length - 1)];
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
            const l = 55 + edge * 25;
            ctx.fillStyle = `hsla(${hueAt(i, f)}, 85%, ${l}%, ${alphaMul * edge})`;
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
        // PERF: same decimation as ink — walk fewer segments as scene load grows.
        for (let i = 0; i < pts.length - 1; i += step) {
          const p = pts[i], nxt = pts[Math.min(i + 1, pts.length - 1)];
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
            ctx.fillStyle = `hsla(${(hueAt(i, f) + pass * 20) % 360}, 100%, 65%, ${alphaMul * 0.75})`;
            ctx.fillRect(gx, gy, grid, grid);
          }
        }
      }
    }

    else if (s.kind === "lightning") {
      const grid = Math.max(2, Math.round(s.size / 6));
      const arcs = Math.max(1, Math.floor(1 + s.density * 5));
      for (let a = 0; a < arcs; a++) {
        if (Math.random() > 0.3 + s.intensity * 0.6) continue;
        const i0 = Math.floor(Math.random() * pts.length);
        const i1 = Math.min(pts.length - 1, i0 + 1 + Math.floor(Math.random() * (5 + s.dynamics * 30)));
        const p0 = pts[i0], p1 = pts[i1];
        const hueL = hueAt(i0);
        const coreCol = `hsla(${hueL}, 100%, 82%, ${alphaMul})`;
        const glowCol = `hsla(${hueL}, 100%, 60%, ${alphaMul * 0.45})`;
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
            // PERF: was 4 separate fillRect calls for the glow (one per side) + 1 core = 5 draws
            // per point. Now it's 1 bigger glow rect + 1 core = 2 draws. Same visual read at this
            // grid size, far fewer canvas calls (which is where the real cost is).
            ctx.fillStyle = glowCol;
            ctx.fillRect(gx - grid, gy - grid, grid * 3, grid * 3);
            ctx.fillStyle = coreCol;
            ctx.fillRect(gx, gy, grid, grid);
          }
          ppx = nxx; ppy = nyy;
        }
      }
    }

    else if (s.kind === "pixelRain") {
      const grid = Math.max(3, Math.round(s.size / 4));
      // PERF: target is now capped by the GLOBAL shared budget, not a flat 200-per-stroke pool.
      // (Fixed: previous version's target collapsed to whatever count currently existed, which
      // blocked new particles from ever spawning once old ones fell off-canvas.)
      const currentRainCount = s.rain?.length ?? 0;
      const wantRain = Math.floor(10 + s.density * 80);
      const target = Math.min(wantRain, currentRainCount + Math.max(0, opts.rainBudget.left));
      if (!s.rain) s.rain = [];
      while (s.rain.length < target && opts.rainBudget.left > 0) {
        const idx = Math.floor(Math.random() * pts.length);
        const p = pts[idx];
        s.rain.push({
          x: Math.round(p.x / grid) * grid + (Math.random() - 0.5) * s.size,
          y: p.y,
          vy: 0.5 + Math.random() * 2 * (0.3 + s.dynamics * 2),
          hue: s.mode === "gradient" ? gradientHueAtXY(p.x, p.y) : s.hue + (Math.random() - 0.5) * 40 + legacySpread * idx / nSeg,
          len: 3 + Math.floor(Math.random() * 8 * (0.3 + s.dynamics)),
          seed: Math.random() * 1000,
        });
        opts.rainBudget.left--;
      }
      for (let i = s.rain.length - 1; i >= 0; i--) {
        const r = s.rain[i];
        r.y += r.vy * dt * 0.1;
        r.x += hash(tt + r.seed) * s.noise * 0.8;
        if (r.y > h + 40) { s.rain.splice(i, 1); continue; }
        const hueP = (r.hue + modeHueShift) % 360;
        for (let k = 0; k < r.len; k++) {
          const a = alphaMul * (1 - k / r.len);
          ctx.fillStyle = `hsla(${hueP}, 95%, ${55 + k * 3}%, ${a})`;
          ctx.fillRect(Math.round((r.x) / grid) * grid, Math.round((r.y - k * grid) / grid) * grid, grid, grid);
        }
      }
    }

    else if (s.kind === "pixelDither") {
      const grid = Math.max(4, Math.round(s.size / 4));
      const sweep = (tt * (0.5 + s.speed * 2)) % 1;
      const stepPts = Math.max(1, Math.floor(pts.length / 40));
      const radius = s.size * (1 + s.dynamics * 1.5);
      // PERF: offsets used to be recomputed with a nested dx/dy loop + Math.hypot EVERY frame for
      // EVERY sampled point. They only depend on (grid, radius) which are constant for this stroke,
      // so fetch the cached list once per stroke per frame instead.
      const offsets = getDitherOffsets(grid, radius);
      for (let pi = 0; pi < pts.length; pi += stepPts) {
        const p = pts[pi];
        const hueD = hueAt(pi);
        const cx = Math.round(p.x / grid) * grid;
        const cy = Math.round(p.y / grid) * grid;
        for (const off of offsets) {
          const gx = cx + off.dx, gy = cy + off.dy;
          const bayer = (((gx / grid) & 1) ^ ((gy / grid) & 1));
          const dist = off.dist;
          const threshold = sweep + bayer * 0.4 + hash(gx + gy * 7) * s.noise * 0.4;
          if (dist > threshold) continue;
          if (Math.random() > 0.05 + s.density * 0.4) continue;
          const lit = 50 + (1 - dist) * 30;
          ctx.fillStyle = `hsla(${hueD + (bayer ? 30 : 0)}, 95%, ${lit}%, ${alphaMul * (1 - dist)})`;
          ctx.fillRect(gx, gy, grid, grid);
        }
      }
    }

    else if (s.kind === "pixelGlitch") {
      const grid = Math.max(2, Math.round(s.size / 6));
      const stepPts = Math.max(1, Math.floor(pts.length / 30));
      for (let pi = 0; pi < pts.length; pi += stepPts) {
        const p = pts[pi];
        const hueG = hueAt(pi);
        const radius = s.size * (0.8 + s.dynamics * 1.5);
        const slices = 3 + Math.floor(s.density * 8);
        for (let i = 0; i < slices; i++) {
          const yOff = (i / slices - 0.5) * radius * 2;
          const shift = (hash(Math.floor(tt * 8) + i + p.t) * 2) * s.size * (0.3 + s.noise * 2);
          const widthLine = radius * 2 * (0.6 + Math.random() * 0.4);
          const x0 = p.x - widthLine / 2 + shift;
          const y0 = Math.round((p.y + yOff) / grid) * grid;
          const offs = [-grid, 0, grid];
          let hues: number[];
          if (s.mode === "gradient") {
            // Sample the actual chosen palette at three nearby positions instead of a synthetic
            // +120/+240 hue offset — otherwise the channel-split always looks like a generic RGB
            // trio no matter which colors were picked, making the tool feel unresponsive to them.
            const spread = 0.035;
            const basePos = (p.x * gradCos + p.y * gradSin) / gradExtent + gradTravel;
            hues = [
              sampleGradient(s.gradientColors, basePos - spread),
              sampleGradient(s.gradientColors, basePos),
              sampleGradient(s.gradientColors, basePos + spread),
            ];
          } else {
            hues = [hueG % 360, (hueG + 120) % 360, (hueG + 240) % 360];
          }
          for (let c2 = 0; c2 < 3; c2++) {
            ctx.fillStyle = `hsla(${hues[c2]}, 100%, 55%, ${alphaMul * 0.55})`;
            for (let xb = 0; xb < widthLine; xb += grid) {
              if (Math.random() > 0.4 + s.intensity * 0.5) continue;
              ctx.fillRect(Math.round((x0 + xb + offs[c2]) / grid) * grid, y0, grid, grid);
            }
          }
        }
      }
    }
  }

  function drawSmoothPath(ctx: CanvasRenderingContext2D, pts: StrokePoint[], phase: number, wobble: number, noiseAmt: number) {
    if (pts.length < 2) {
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle as string;
        ctx.fill();
      }
      return;
    }
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const next = pts[i + 1] || p;
      const dx = next.x - p.x, dy = next.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const w = Math.sin(i * 0.3 + phase * 6) * wobble + hash(i + phase * 10) * noiseAmt * wobble * 0.5;
      const x = p.x + nx * w;
      const y = p.y + ny * w;
      if (i === 0) ctx.moveTo(x, y);
      else {
        const prev = pts[i - 1];
        const mx = (prev.x + p.x) / 2;
        const my = (prev.y + p.y) / 2;
        ctx.quadraticCurveTo(mx, my, x, y);
      }
    }
    ctx.stroke();
  }

  // === Pointer ===
  const getPoint = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const sx = canvasSize.w / r.width;
    const sy = canvasSize.h / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  };

  const addPoint = (x: number, y: number) => {
    const s = currentStrokeRef.current;
    if (!s) return;
    const now = performance.now();
    s.points.push({ x, y, t: (now - s.born) / 1000 });
    if (s.mode === "mirror") {
      s.points.push({ x: canvasSize.w - x, y, t: (now - s.born) / 1000 });
    }
    if (s.points.length > MAX_POINTS_PER_STROKE) {
      // decimate: keep every other point from the older half
      const half = Math.floor(MAX_POINTS_PER_STROKE / 2);
      const old = s.points.slice(0, s.points.length - half);
      const recent = s.points.slice(s.points.length - half);
      const dec: StrokePoint[] = [];
      for (let i = 0; i < old.length; i += 2) dec.push(old[i]);
      s.points = dec.concat(recent);
    }
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const { x, y } = getPoint(e);
    pointerRef.current = { x, y, px: x, py: y, down: true };
    if (refs.brush.current === "eraser") { eraseAt(x, y, refs.size.current); return; }
    const layer = layersRef.current.find(l => l.id === activeLayerIdRef.current);
    if (!layer || !layer.visible) return;
    const stroke: Stroke = {
      id: ++strokeIdCounter,
      kind: refs.brush.current,
      mode: refs.mode.current,
      size: refs.size.current,
      hue: refs.hue.current,
      speed: refs.speed.current,
      density: refs.density.current,
      noise: refs.noise.current,
      intensity: refs.intensity.current,
      dynamics: refs.dynamics.current,
      rainbowFlow: refs.rainbowFlow.current,
      rainbowFlowSpeed: refs.rainbowFlowSpeed.current,
      gradientSpeed: refs.gradientSpeed.current,
      gradientColors: refs.gradientColors.current.map(c => ({ ...c })),
      gradientAngle: refs.gradientAngle.current,
      points: [],
      born: performance.now(),
    };
    currentStrokeRef.current = stroke;
    layer.strokes.push(stroke);
    addPoint(x, y);
  };
  const onMove = (e: React.PointerEvent) => {
    const { x, y } = getPoint(e);
    pointerRef.current.x = x; pointerRef.current.y = y;
    if (!pointerRef.current.down) return;
    if (refs.brush.current === "eraser") { eraseAt(x, y, refs.size.current); pointerRef.current.px = x; pointerRef.current.py = y; return; }
    const px = pointerRef.current.px, py = pointerRef.current.py;
    const dx = x - px, dy = y - py;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.floor(dist / 5));
    for (let i = 1; i <= steps; i++) addPoint(px + dx * (i / steps), py + dy * (i / steps));
    pointerRef.current.px = x; pointerRef.current.py = y;
  };
  const onUp = () => {
    if (!pointerRef.current.down) return;
    pointerRef.current.down = false;
    currentStrokeRef.current = null;
    pushHistory();
  };

  // === Layer ops ===
  const addLayer = () => {
    const id = ++layerIdCounter;
    const next = [...layersRef.current, { id, name: `Слой ${layersRef.current.length + 1}`, visible: true, strokes: [] }];
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
  };
  const clearActive = () => {
    const next = layersRef.current.map(l => l.id === activeLayerIdRef.current ? { ...l, strokes: [] } : l);
    layersRef.current = next;
    setLayers(next);
    pushHistory();
  };
  const clearAll = () => {
    const next = layersRef.current.map(l => ({ ...l, strokes: [] }));
    layersRef.current = next;
    setLayers(next);
    pushHistory();
  };

  // === New canvas ===
  const [newW, setNewW] = useState(1280);
  const [newH, setNewH] = useState(800);
  const newCanvas = () => {
    setCanvasSize({ w: newW, h: newH });
    const layer: Layer = { id: ++layerIdCounter, name: "Слой 1", visible: true, strokes: [] };
    const next = [layer];
    layersRef.current = next;
    setLayers(next);
    setActiveLayerId(layer.id);
    historyRef.current = [serializeLayers(next)];
    historyIdxRef.current = 0;
    setHistoryVer(v => v + 1);
  };

  // === Export ===
  // Render the full scene into an arbitrary context (used by exports at full quality).
  // PERF: exports always use FULL_QUALITY_OPTS (step=1, unlimited rain) — the live-preview
  // decimation above never touches exported PNG/GIF/MP4 quality.
  const renderScene = useCallback((tctx: CanvasRenderingContext2D, w: number, h: number, now: number, dtRaw: number) => {
    tctx.fillStyle = "#080a12";
    tctx.fillRect(0, 0, w, h);
    const t = now / 1000;
    for (const layer of layersRef.current) {
      if (!layer.visible) continue;
      for (const s of layer.strokes) {
        if (s.points.length === 0) continue;
        renderStroke(tctx, s, w, h, t, dtRaw, now, FULL_QUALITY_OPTS);
      }
    }
  }, []);

  const savePng = () => {
    const scale = Math.max(1, Math.min(4, exportScale));
    const w = Math.round(canvasSize.w * scale);
    const h = Math.round(canvasSize.h * scale);
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext("2d")!;
    tctx.setTransform(scale, 0, 0, scale, 0, 0);
    renderScene(tctx, canvasSize.w, canvasSize.h, performance.now(), 16.67);
    tmp.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `living-pixels-${Date.now()}@${scale}x.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };

  const exportGif = async () => {
    if (recording) return;
    const preset = GIF_PRESETS[gifQ];
    setRecording("gif"); setRecordProgress(0);
    try {
      const fps = exportFps, seconds = exportSec, total = Math.max(1, Math.round(fps * seconds));
      const scale = Math.max(1, Math.min(4, exportScale));
      const gifW = Math.round(canvasSize.w * scale);
      const gifH = Math.round(canvasSize.h * scale);
      const tmp = document.createElement("canvas");
      tmp.width = gifW; tmp.height = gifH;
      const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
      tctx.setTransform(scale, 0, 0, scale, 0, 0);
      const gif = GIFEncoder();
      const delay = Math.round(1000 / fps);
      const dtRaw = 1000 / fps;
      const startNow = performance.now();
      for (let i = 0; i < total; i++) {
        renderScene(tctx, canvasSize.w, canvasSize.h, startNow + i * dtRaw, dtRaw);
        const data = tctx.getImageData(0, 0, gifW, gifH).data;
        const palette = quantize(data, preset.colors);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, gifW, gifH, { palette, delay });
        setRecordProgress((i + 1) / total);
        if ((i & 3) === 0) await new Promise(r => setTimeout(r, 0));
      }
      gif.finish();
      const bytes = gif.bytesView();
      const buf = new Uint8Array(bytes.byteLength); buf.set(bytes);
      const blob = new Blob([buf], { type: "image/gif" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `living-pixels-${Date.now()}.gif`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      (gif as unknown as { bytes?: () => Uint8Array }).bytes?.();
    } finally {
      setRecording(null); setRecordProgress(0);
    }
  };

  const exportMp4 = async () => {
    if (recording) return;
    const preset = MP4_PRESETS[mp4Q];
    const scale = Math.max(1, Math.min(4, exportScale));
    const seconds = exportSec;
    const fps = exportFps;
    const total = Math.max(1, Math.round(fps * seconds));
    const w = Math.round(canvasSize.w * scale);
    const h = Math.round(canvasSize.h * scale);

    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext("2d")!;
    tctx.setTransform(scale, 0, 0, scale, 0, 0);

    // frame-by-frame stream: captureStream(0) + requestFrame per rendered frame
    const stream = (tmp as HTMLCanvasElement).captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const mimes = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mime = mimes.find(m => (window as any).MediaRecorder?.isTypeSupported?.(m)) || "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: preset.bps });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    setRecording("mp4"); setRecordProgress(0);
    rec.start();
    try {
      const dtRaw = 1000 / fps;
      const startNow = performance.now();
      // prime first frame before start
      renderScene(tctx, canvasSize.w, canvasSize.h, startNow, dtRaw);
      for (let i = 0; i < total; i++) {
        renderScene(tctx, canvasSize.w, canvasSize.h, startNow + i * dtRaw, dtRaw);
        track.requestFrame?.();
        setRecordProgress((i + 1) / total);
        // yield so the encoder can consume the frame
        await new Promise(r => setTimeout(r, 1000 / fps));
      }
    } finally {
      rec.stop();
      await new Promise<void>(r => { rec.onstop = () => r(); });
      track.stop();
      const blob = new Blob(chunks, { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `living-pixels-${Date.now()}.${mime.includes("mp4") ? "mp4" : "webm"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setRecording(null); setRecordProgress(0);
    }
  };

  // Keyboard: Ctrl+Z / Ctrl+Shift+Z
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault(); redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const ParamSlider = ({ label, value, set }: { label: string; value: number; set: (n: number) => void }) => (
    <label className="flex flex-col gap-1 text-[10px] uppercase tracking-widest text-white/50">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="text-white/80">{Math.round(value * 100)}</span>
      </span>
      <input type="range" min={0} max={1} step={0.01} value={value} onChange={(e) => set(+e.target.value)} className="w-full accent-white" />
    </label>
  );

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#05060c] text-white flex">
      {/* Sidebar */}
      <aside className="z-20 flex h-full w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-white/10 bg-black/70 p-3 backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <h1 className="select-none text-[11px] font-medium tracking-[0.3em] text-white/70">LIVING PIXELS</h1>
        </div>

        {/* Undo / Redo */}
        <div className="flex gap-1.5">
          <button onClick={undo} disabled={!canUndo || !!recording} className="flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-wider transition hover:bg-white/10 disabled:opacity-30">↶ Отменить</button>
          <button onClick={redo} disabled={!canRedo || !!recording} className="flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-wider transition hover:bg-white/10 disabled:opacity-30">Вернуть ↷</button>
        </div>

        {/* New canvas */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Холст</div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px]">
            <input type="number" min={64} max={4096} value={newW} onChange={(e) => setNewW(+e.target.value || 0)} className="w-full rounded border border-white/10 bg-black/40 px-1.5 py-1 text-white" />
            <span className="text-white/40">×</span>
            <input type="number" min={64} max={4096} value={newH} onChange={(e) => setNewH(+e.target.value || 0)} className="w-full rounded border border-white/10 bg-black/40 px-1.5 py-1 text-white" />
          </div>
          <button onClick={newCanvas} className="w-full rounded-md border border-white/15 bg-white/10 px-2 py-1.5 text-[11px] tracking-wider hover:bg-white/15">+ Новый холст</button>
          <div className="mt-1.5 text-[9px] text-white/40">Текущий: {canvasSize.w}×{canvasSize.h}</div>
        </section>

        {/* Layers */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[9px] uppercase tracking-widest text-white/40">Слои</div>
            <button onClick={addLayer} className="rounded border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] hover:bg-white/20">+ Слой</button>
          </div>
          <ul className="flex flex-col gap-1">
            {[...layers].reverse().map((l) => (
              <li key={l.id} className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 ${activeLayerId === l.id ? "border-white/40 bg-white/10" : "border-white/5 bg-transparent hover:bg-white/[0.04]"}`}>
                <button onClick={() => toggleLayer(l.id)} className="text-[12px] leading-none text-white/70 hover:text-white" title="Видимость">{l.visible ? "👁" : "—"}</button>
                <button onClick={() => setActiveLayerId(l.id)} className="flex-1 truncate text-left text-[11px]">{l.name}</button>
                <span className="text-[9px] text-white/30">{l.strokes.length}</span>
                <button onClick={() => removeLayer(l.id)} disabled={layers.length === 1} className="text-[11px] text-white/40 hover:text-red-400 disabled:opacity-20" title="Удалить">✕</button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-1.5">
            <button onClick={clearActive} className="flex-1 rounded border border-white/10 px-1.5 py-1 text-[10px] uppercase tracking-widest text-white/60 hover:bg-white/5">Очистить слой</button>
            <button onClick={clearAll} className="flex-1 rounded border border-white/10 px-1.5 py-1 text-[10px] uppercase tracking-widest text-white/60 hover:bg-white/5">Всё</button>
          </div>
        </section>

        {/* Brushes */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Кисть</div>
          <div className="grid grid-cols-2 gap-1">
            {BRUSHES.map(b => (
              <button key={b.id} onClick={() => setBrush(b.id)} className={`rounded border px-2 py-1 text-[10px] tracking-wider transition ${brush === b.id ? "border-white/60 bg-white/15" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}>{b.label}</button>
            ))}
          </div>
        </section>

        {/* Modes */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Режим</div>
          <div className="grid grid-cols-3 gap-1">
            {MODES.map(m => (
              <button key={m.id} onClick={() => setMode(m.id)} className={`rounded border px-1.5 py-1 text-[9px] uppercase tracking-widest transition ${mode === m.id ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{m.label}</button>
            ))}
          </div>
          {mode === "rainbow" && (
            <button
              onClick={() => setRainbowFlow(v => !v)}
              className="mt-1.5 w-full rounded border border-white/10 bg-white/[0.02] px-1.5 py-1 text-[9px] uppercase tracking-widest text-white/60 transition hover:bg-white/5"
            >
              {rainbowFlow ? "Радуга: Поток вдоль мазка" : "Радуга: Мигание целиком"}
            </button>
          )}
          {mode === "rainbow" && rainbowFlow && (
            <div className="mt-2 border-t border-white/10 pt-2">
              <ParamSlider label="Скорость потока" value={rainbowFlowSpeed} set={setRainbowFlowSpeed} />
            </div>
          )}
        </section>

        {/* Dedicated Gradient tool menu — only visible while the Gradient mode is active */}
        {mode === "gradient" && (
          <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
            <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Градиент — цвета</div>

            <div className="space-y-1.5">
              {gradientColors.map((c, i) => (
                <div key={i} className="flex items-center gap-2 rounded border border-white/5 bg-black/20 px-1.5 py-1">
                  <input
                    type="color"
                    value={hueToHex(c.hue)}
                    onChange={(e) => {
                      const hue = hexToHue(e.target.value);
                      setGradientColors(cols => cols.map((cc, ci) => ci === i ? { ...cc, hue } : cc));
                    }}
                    className="h-6 w-6 shrink-0 cursor-pointer rounded border border-white/20 bg-transparent p-0"
                    title={`Цвет ${i + 1}`}
                  />
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={Math.round(c.weight * 50)}
                    onChange={(e) => {
                      const weight = +e.target.value / 50;
                      setGradientColors(cols => cols.map((cc, ci) => ci === i ? { ...cc, weight } : cc));
                    }}
                    className="w-full accent-white"
                    title="Доля этого цвета в смеси"
                  />
                  {gradientColors.length > 2 && (
                    <button
                      onClick={() => setGradientColors(cols => cols.filter((_, ci) => ci !== i))}
                      className="shrink-0 text-[11px] text-white/40 hover:text-red-400"
                      title="Удалить цвет"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {gradientColors.length < 6 && (
                <button
                  onClick={() => setGradientColors(cols => [...cols, { hue: Math.round(Math.random() * 360), weight: 1 }])}
                  className="w-full rounded border border-dashed border-white/30 py-1 text-[10px] text-white/50 hover:border-white/60 hover:text-white"
                >
                  + Добавить цвет
                </button>
              )}
            </div>

            <label className="block text-[10px] uppercase tracking-widest text-white/50">
              <span className="mb-1 flex justify-between">
                <span>Поворот направления</span>
                <span className="text-white/80">{gradientAngle > 0 ? "+" : ""}{gradientAngle}°</span>
              </span>
              <input
                type="range"
                min={-180}
                max={180}
                value={gradientAngle}
                onChange={(e) => setGradientAngle(+e.target.value)}
                className="w-full accent-white"
              />
              <span className="mt-1 block text-[8px] normal-case tracking-normal text-white/30">
                0° — вдоль мазка (для заливки — угол вручную)
              </span>
            </label>

            <ParamSlider label="Скорость потока" value={gradientSpeed} set={setGradientSpeed} />
          </section>
        )}

        {/* Size / Hue */}
        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 space-y-2">
          <label className="block text-[10px] uppercase tracking-widest text-white/50">
            <span className="mb-1 flex justify-between"><span>Размер</span><span className="text-white/80">{size}</span></span>
            <input type="range" min={4} max={120} value={size} onChange={(e) => setSize(+e.target.value)} className="w-full accent-white" />
          </label>
          <label className="block text-[10px] uppercase tracking-widest text-white/50">
            <span className="mb-1 flex items-center justify-between">
              <span>Цвет</span>
              <span className="h-4 w-4 rounded-full border border-white/30" style={{ backgroundColor: `hsl(${hue}, 90%, 60%)` }} />
            </span>
            <input type="range" min={0} max={360} value={hue} onChange={(e) => setHue(+e.target.value)} className="w-full" style={{ background: "linear-gradient(to right, hsl(0,90%,60%), hsl(60,90%,60%), hsl(120,90%,60%), hsl(180,90%,60%), hsl(240,90%,60%), hsl(300,90%,60%), hsl(360,90%,60%))", appearance: "none", height: 6, borderRadius: 999 }} />
          </label>
        </section>

        {/* Params */}
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

          {/* Scale + Duration selectors (shared) */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[9px] uppercase tracking-widest text-white/40">
              <span>Масштаб</span>
              <span className="text-white/70 normal-case tracking-normal">{Math.round(canvasSize.w * exportScale)}×{Math.round(canvasSize.h * exportScale)}</span>
            </div>
            <div className="flex gap-1">
              {SCALES.map(s => (
                <button key={s} onClick={() => setExportScale(s)} className={`flex-1 rounded border px-1 py-1 text-[10px] tracking-wider transition ${exportScale === s ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{s}x</button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[9px] uppercase tracking-widest text-white/40">
              <span>Длительность</span>
              <span className="text-white/70 normal-case tracking-normal">{exportSec}s</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {DURATIONS.map(sec => (
                <button key={sec} onClick={() => setExportSec(sec)} className={`flex-1 rounded border px-1 py-1 text-[10px] tracking-wider transition ${exportSec === sec ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{sec}s</button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[9px] uppercase tracking-widest text-white/40">
              <span>FPS</span>
              <span className="text-white/70 normal-case tracking-normal">{exportFps} fps</span>
            </div>
            <div className="flex gap-1">
              {FPS_OPTIONS.map(f => (
                <button key={f} onClick={() => setExportFps(f)} className={`flex-1 rounded border px-1 py-1 text-[10px] tracking-wider transition ${exportFps === f ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{f}</button>
              ))}
            </div>
          </div>

          <button onClick={savePng} disabled={!!recording} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-widest hover:bg-white/10 disabled:opacity-40">PNG · {exportScale}x</button>

          <div className="space-y-1">
            <div className="flex gap-1">
              {(Object.keys(GIF_PRESETS) as GifQ[]).map(q => (
                <button key={q} onClick={() => setGifQ(q)} className={`flex-1 rounded border px-1 py-1 text-[9px] uppercase tracking-widest transition ${gifQ === q ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{GIF_PRESETS[q].label}</button>
              ))}
            </div>
            <button onClick={exportGif} disabled={!!recording} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-widest hover:bg-white/10 disabled:opacity-40">
              {recording === "gif" ? `GIF ${Math.round(recordProgress * 100)}%` : `GIF · ${exportFps}fps ${exportSec}s`}
            </button>
          </div>

          <div className="space-y-1">
            <div className="flex gap-1">
              {(Object.keys(MP4_PRESETS) as Mp4Q[]).map(q => (
                <button key={q} onClick={() => setMp4Q(q)} className={`flex-1 rounded border px-1 py-1 text-[9px] uppercase tracking-widest transition ${mp4Q === q ? "border-white/60 bg-white/10" : "border-white/5 text-white/40 hover:text-white/80"}`}>{MP4_PRESETS[q].label}</button>
              ))}
            </div>
            <button onClick={exportMp4} disabled={!!recording} className="w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] tracking-widest hover:bg-white/10 disabled:opacity-40">
              {recording === "mp4" ? `MP4 ${Math.round(recordProgress * 100)}%` : `MP4 · ${exportFps}fps ${exportSec}s ${(MP4_PRESETS[mp4Q].bps/1_000_000).toFixed(1)}M`}
            </button>
          </div>
        </section>

        <div className="text-center text-[9px] text-white/30">Ctrl+Z / Ctrl+Shift+Z</div>
      </aside>

      {/* Canvas area */}
      <div
        ref={wrapRef}
        onWheel={(e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          setZoom((z) => Math.min(6, Math.max(0.1, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
        }}
        className="relative flex flex-1 items-center justify-center overflow-auto p-4"
      >
        <div style={{ width: canvasSize.w * zoom, height: canvasSize.h * zoom }} className="flex items-center justify-center">
          <canvas
            ref={canvasRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            style={{ width: canvasSize.w * zoom, height: canvasSize.h * zoom, imageRendering: "pixelated" }}
            className="block touch-none rounded-lg border border-white/10 bg-[#080a12] shadow-2xl cursor-crosshair"
          />
        </div>
        <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-white/10 bg-black/60 p-1 text-[11px] backdrop-blur">
          <button onClick={() => setZoom((z) => Math.max(0.1, z / 1.2))} className="pointer-events-auto rounded px-2 py-0.5 hover:bg-white/10">−</button>
          <button onClick={() => setZoom(1)} className="pointer-events-auto rounded px-2 py-0.5 tabular-nums hover:bg-white/10">{Math.round(zoom * 100)}%</button>
          <button onClick={() => setZoom((z) => Math.min(6, z * 1.2))} className="pointer-events-auto rounded px-2 py-0.5 hover:bg-white/10">+</button>
        </div>
      </div>
    </main>
  );
}
