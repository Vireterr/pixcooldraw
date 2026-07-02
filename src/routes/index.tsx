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
  points: StrokePoint[];
  born: number;
  originY?: number;
  ink?: { phase: number };
  rain?: { x: number; y: number; vy: number; hue: number; len: number; seed: number; spawnY: number }[];
}

interface ImageItem {
  id: number;
  src: string;
  x: number; y: number; w: number; h: number;
}

interface Layer {
  id: number;
  name: string;
  visible: boolean;
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

function hash(n: number) {
  n = (n << 13) ^ n;
  return 1.0 - (((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741823.5);
}

let strokeIdCounter = 0;
let layerIdCounter = 0;
let imageIdCounter = 0;

function serializeLayers(layers: Layer[]): string {
  return JSON.stringify(layers.map(l => ({
    id: l.id, name: l.name, visible: l.visible,
    strokes: l.strokes.map(s => ({
      id: s.id, kind: s.kind, mode: s.mode, size: s.size, hue: s.hue,
      speed: s.speed, density: s.density, noise: s.noise,
      intensity: s.intensity, dynamics: s.dynamics,
      points: s.points, born: s.born, originY: s.originY,
    })),
    images: l.images,
  })));
}
function deserializeLayers(str: string): Layer[] {
  const parsed = JSON.parse(str) as Layer[];
  return parsed.map(l => ({ ...l, images: l.images || [] }));
}

// Renders one stroke into ctx (assumes ctx transform already in canvas-world space)
function renderStroke(ctx: CanvasRenderingContext2D, s: Stroke, t: number, dtRaw: number, now: number) {
  const dt = dtRaw * (0.3 + s.speed * 2.4);
  const tt = t * (0.3 + s.speed * 2.4);
  const lifeMs = now - s.born;
  const modeHueShift = s.mode === "rainbow" ? (lifeMs * 0.05) % 360 : 0;
  const modePulse = s.mode === "pulse" ? 0.6 + 0.5 * Math.sin(tt * 2) : 1;
  const modeSpray = s.mode === "spray" ? 2.2 : 1;
  const alphaMul = (0.25 + s.intensity * 0.9) * modePulse;
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
          const l = 55 + edge * 25;
          ctx.fillStyle = `hsla(${hueI}, 85%, ${l}%, ${alphaMul * edge})`;
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
      ctx.fillStyle = `hsla(${hueR}, 100%, 65%, ${alphaMul * 0.75})`;
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
    const coreCol = `hsla(${hueL}, 100%, 82%, ${alphaMul})`;
    const glowCol = `hsla(${hueL}, 100%, 60%, ${alphaMul * 0.45})`;
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
        ctx.fillStyle = `hsla(${hueP}, 95%, ${55 + k * 3}%, ${a})`;
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
          ctx.fillStyle = `hsla(${hueD + (bayer ? 30 : 0)}, 95%, ${lit}%, ${alphaMul * (1 - dist)})`;
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

// Render a full frame of the fixed canvas (world 0..canvasW × 0..canvasH) into a target ctx sized targetW×targetH.
// Handles background, image layers, strokes. No pan/zoom (used for exports).
function renderFrameToCanvas(
  tctx: CanvasRenderingContext2D,
  targetW: number, targetH: number,
  canvasW: number, canvasH: number,
  layers: Layer[],
  imgCache: Map<string, HTMLImageElement>,
  t: number, dtRaw: number, now: number,
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
    for (const im of layer.images) {
      const img = imgCache.get(im.src);
      if (img && img.complete && img.naturalWidth) tctx.drawImage(img, im.x, im.y, im.w, im.h);
    }
    for (const s of layer.strokes) {
      if (s.points.length === 0) continue;
      renderStroke(tctx, s, t, dtRaw, now);
    }
  }
  tctx.setTransform(1, 0, 0, 1, 0, 0);
}

function Index() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // viewport (screen) size — fills workspace
  const [viewport, setViewport] = useState({ w: 800, h: 600 });
  // fixed canvas world dimensions
  const [canvasSize, setCanvasSize] = useState({ w: 1200, h: 800 });
  const canvasSizeRef = useRef(canvasSize);
  useEffect(() => { canvasSizeRef.current = canvasSize; }, [canvasSize]);
  const [pendingW, setPendingW] = useState("1200");
  const [pendingH, setPendingH] = useState("800");

  // view (pan+zoom): screen = world * zoom + pan
  const viewRef = useRef({ panX: 0, panY: 0, zoom: 1 });
  const [zoomDisplay, setZoomDisplay] = useState(1);

  // layers
  const [layers, setLayers] = useState<Layer[]>(() => [{
    id: ++layerIdCounter, name: "Слой 1", visible: true, strokes: [], images: [],
  }]);
  const [activeLayerId, setActiveLayerId] = useState<number>(() => layerIdCounter);
  const layersRef = useRef(layers);
  const activeLayerIdRef = useRef(activeLayerId);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  useEffect(() => { activeLayerIdRef.current = activeLayerId; }, [activeLayerId]);

  // image bitmap cache
  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const ensureImg = (src: string): HTMLImageElement | null => {
    const c = imgCache.current;
    let img = c.get(src);
    if (!img) {
      img = new Image();
      img.src = src;
      c.set(src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  };

  // dirty flag — only redraw when animated strokes exist or scene changed
  const dirtyRef = useRef(true);
  const markDirty = () => { dirtyRef.current = true; };

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

  const [brush, setBrush] = useState<BrushKind>("ribbon");
  const [mode, setMode] = useState<ModeKind>("normal");
  const [hue, setHue] = useState(200);
  const [size, setSize] = useState(28);
  const [speed, setSpeed] = useState(0.5);
  const [density, setDensity] = useState(0.5);
  const [noise, setNoise] = useState(0.4);
  const [intensity, setIntensity] = useState(0.7);
  const [dynamics, setDynamics] = useState(0.5);
  const [recording, setRecording] = useState<null | "gif" | "mp4">(null);
  const [recordProgress, setRecordProgress] = useState(0);

  // Export settings
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
    brush: useRef(brush), mode: useRef(mode), hue: useRef(hue), size: useRef(size),
    speed: useRef(speed), density: useRef(density), noise: useRef(noise),
    intensity: useRef(intensity), dynamics: useRef(dynamics),
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

  // resize viewport to workspace
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

  // Fit view when canvas size changes
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

  // Render loop — skip when nothing animated and nothing dirty
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dtRaw = Math.min(50, now - last);
      last = now;
      const c = canvasRef.current;
      if (!c) { raf = requestAnimationFrame(tick); return; }
      const animated = hasAnimatedContent();
      if (!animated && !dirtyRef.current) { raf = requestAnimationFrame(tick); return; }
      dirtyRef.current = false;

      const ctx = c.getContext("2d")!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vw = viewport.w, vh = viewport.h;

      // clear workspace
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0a0b12";
      ctx.fillRect(0, 0, vw, vh);

      const view = viewRef.current;
      const cs = canvasSizeRef.current;

      // canvas drop shadow
      const cxp = view.panX, cyp = view.panY, cwp = cs.w * view.zoom, chp = cs.h * view.zoom;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(cxp + 6, cyp + 8, cwp, chp);
      // canvas background
      ctx.fillStyle = "#05060c";
      ctx.fillRect(cxp, cyp, cwp, chp);
      // border
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      ctx.strokeRect(cxp + 0.5, cyp + 0.5, cwp, chp);

      // world transform + clip to canvas rect
      ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cs.w, cs.h);
      ctx.clip();

      const t = now / 1000;
      for (const layer of layersRef.current) {
        if (!layer.visible) continue;
        for (const im of layer.images) {
          const img = ensureImg(im.src);
          if (img) ctx.drawImage(img, im.x, im.y, im.w, im.h);
        }
        for (const s of layer.strokes) {
          if (s.points.length === 0) continue;
          renderStroke(ctx, s, t, dtRaw, now);
        }
      }
      ctx.restore();

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewport]);

  // === Pointer / touch: pan + zoom + draw ===
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
      points: [],
      born: performance.now(),
      originY: wy,
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

    if (refs.brush.current === "eraser") {
      const w = screenToWorld(local.x, local.y);
      eraseAt(w.x, w.y, refs.size.current);
      drawingPointerId.current = e.pointerId;
      lastDrawScreen.current = local;
      return;
    }
    drawingPointerId.current = e.pointerId;
    lastDrawScreen.current = local;
    const w = screenToWorld(local.x, local.y);
    beginStroke(w.x, w.y);
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
    if (refs.brush.current === "eraser") {
      const w = screenToWorld(local.x, local.y);
      eraseAt(w.x, w.y, refs.size.current);
      lastDrawScreen.current = local;
      return;
    }
    const px = lastDrawScreen.current.x, py = lastDrawScreen.current.y;
    const dx = local.x - px, dy = local.y - py;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.floor(dist / 5));
    for (let i = 1; i <= steps; i++) {
      const sx = px + dx * (i / steps), sy = py + dy * (i / steps);
      const w = screenToWorld(sx, sy);
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
      if (currentStrokeRef.current) {
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

  useEffect(() => {
    const dn = (e: KeyboardEvent) => {
      if (e.code === "Space" && !spaceRef.current) {
        spaceRef.current = true;
        setSpaceDown(true);
      }
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (meta && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") { spaceRef.current = false; setSpaceDown(false); }
    };
    window.addEventListener("keydown", dn);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", dn); window.removeEventListener("keyup", up); };
  }, [undo, redo]);

  // === Layer ops ===
  const addLayer = () => {
    const id = ++layerIdCounter;
    const next = [...layersRef.current, { id, name: `Слой ${layersRef.current.length + 1}`, visible: true, strokes: [], images: [] }];
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

  // Canvas ops
  const applyCanvasSize = () => {
    const w = Math.max(64, Math.min(8192, parseInt(pendingW) || canvasSize.w));
    const h = Math.max(64, Math.min(8192, parseInt(pendingH) || canvasSize.h));
    setCanvasSize({ w, h });
  };
  const newCanvas = () => {
    const w = Math.max(64, Math.min(8192, parseInt(pendingW) || 1200));
    const h = Math.max(64, Math.min(8192, parseInt(pendingH) || 800));
    layerIdCounter += 1;
    const fresh = [{ id: layerIdCounter, name: "Слой 1", visible: true, strokes: [], images: [] } as Layer];
    layersRef.current = fresh;
    setLayers(fresh);
    setActiveLayerId(layerIdCounter);
    setCanvasSize({ w, h });
    historyRef.current = [serializeLayers(fresh)];
    historyIdxRef.current = 0;
    setHistoryVer(v => v + 1);
    markDirty();
  };

  // === Import images ===
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
          const image: ImageItem = { id: ++imageIdCounter, src, x: (cs.w - w) / 2, y: (cs.h - h) / 2, w, h };
          imgCache.current.set(src, img);
          const id = ++layerIdCounter;
          const layer: Layer = { id, name: file.name.slice(0, 24), visible: true, strokes: [], images: [image] };
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

  // === Export ===
  // PNG: render at 2x resolution of the fixed canvas
  const savePng = () => {
    const cs = canvasSizeRef.current;
    const scale = 2;
    const tmp = document.createElement("canvas");
    tmp.width = cs.w * scale;
    tmp.height = cs.h * scale;
    const tctx = tmp.getContext("2d")!;
    const now = performance.now();
    renderFrameToCanvas(tctx, tmp.width, tmp.height, cs.w, cs.h, layersRef.current, imgCache.current, now / 1000, 16, now);
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
      const gif = GIFEncoder();
      const delay = Math.round(1000 / gifFps);
      const dtRaw = 1000 / gifFps;
      const startNow = performance.now();

      for (let i = 0; i < total; i++) {
        const now = startNow + i * dtRaw;
        renderFrameToCanvas(tctx, gifW, gifH, cs.w, cs.h, layersRef.current, imgCache.current, now / 1000, dtRaw, now);
        const data = tctx.getImageData(0, 0, gifW, gifH).data;
        const palette = quantize(data, 256);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, gifW, gifH, { palette, delay });
        setRecordProgress((i + 1) / total);
        if ((i & 1) === 0) await new Promise(r => setTimeout(r, 0));
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
    } finally {
      setRecording(null); setRecordProgress(0);
    }
  };

  // MP4: offscreen canvas driven frame-by-frame; captureStream + requestFrame
  const exportMp4 = async () => {
    if (recording) return;
    const cs = canvasSizeRef.current;
    const outW = cs.w * mp4Scale;
    const outH = cs.h * mp4Scale;
    const total = mp4Fps * mp4Seconds;
    const tmp = document.createElement("canvas");
    tmp.width = outW; tmp.height = outH;
    const tctx = tmp.getContext("2d")!;
    // initial paint
    renderFrameToCanvas(tctx, outW, outH, cs.w, cs.h, layersRef.current, imgCache.current, 0, 1000 / mp4Fps, performance.now());

    interface CaptureCanvas extends HTMLCanvasElement { captureStream(fps?: number): MediaStream }
    const stream = (tmp as CaptureCanvas).captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamVideoTrack & { requestFrame?: () => void };

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
      renderFrameToCanvas(tctx, outW, outH, cs.w, cs.h, layersRef.current, imgCache.current, now / 1000, dtRaw, now);
      if (track.requestFrame) track.requestFrame();
      setRecordProgress((i + 1) / total);
      // yield to allow encoder to consume
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

  const cursor = spaceDown || panState.current ? "grab" : brush === "eraser" ? "cell" : "crosshair";

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
                className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 ${activeLayerId === l.id ? "border-white/40 bg-white/10" : "border-white/5 bg-transparent hover:bg-white/[0.04]"} ${dragOverLayer === l.id ? "ring-1 ring-cyan-400/60" : ""}`}
              >
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
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-1.5">
            <button onClick={clearActive} className="flex-1 rounded border border-white/10 px-1.5 py-1 text-[10px] uppercase tracking-widest text-white/60 hover:bg-white/5">Очистить слой</button>
            <button onClick={clearAll} className="flex-1 rounded border border-white/10 px-1.5 py-1 text-[10px] uppercase tracking-widest text-white/60 hover:bg-white/5">Всё</button>
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
          <div className="mb-1.5 text-[9px] uppercase tracking-widest text-white/40">Кисть</div>
          <div className="grid grid-cols-2 gap-1">
            {BRUSHES.map(b => (
              <button key={b.id} onClick={() => setBrush(b.id)} className={`rounded border px-2 py-1 text-[10px] tracking-wider transition ${brush === b.id ? "border-white/60 bg-white/15" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}>{b.label}</button>
            ))}
          </div>
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
          <label className="block text-[10px] uppercase tracking-widest text-white/50">
            <span className="mb-1 flex items-center justify-between">
              <span>Цвет</span>
              <span className="h-4 w-4 rounded-full border border-white/30" style={{ backgroundColor: `hsl(${hue}, 90%, 60%)` }} />
            </span>
            <input type="range" min={0} max={360} value={hue} onChange={(e) => setHue(+e.target.value)} className="w-full" style={{ background: "linear-gradient(to right, hsl(0,90%,60%), hsl(60,90%,60%), hsl(120,90%,60%), hsl(180,90%,60%), hsl(240,90%,60%), hsl(300,90%,60%), hsl(360,90%,60%))", appearance: "none", height: 6, borderRadius: 999 }} />
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

          {/* GIF */}
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

          {/* MP4 */}
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
          Ctrl+Z / Shift+Ctrl+Z<br/>
          Space + drag · Middle-click = pan<br/>
          Wheel = zoom · Pinch on touch
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
