import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Living Pixels — Animated Brush Studio" },
      { name: "description", content: "Draw with living animated brushes, pixel effects, eraser and brush modes. Export to GIF and MP4." },
    ],
  }),
  component: Index,
});

type BrushKind =
  | "fireflies"
  | "ink"
  | "ribbon"
  | "lightning"
  | "pixelRain"
  | "pixelDither"
  | "pixelGlitch"
  | "eraser";

type ModeKind = "normal" | "rainbow" | "pulse" | "spray" | "mirror";

interface Stroke {
  id: number;
  kind: BrushKind;
  mode: ModeKind;
  size: number;
  hue: number;
  // params snapshot at draw time
  speed: number;
  density: number;
  noise: number;
  intensity: number;
  dynamics: number;
  points: { x: number; y: number; t: number }[];
  born: number;
  // per-brush state buckets
  fireflies?: { ax: number; ay: number; angle: number; radius: number; hue: number; seed: number; life: number }[];
  ink?: { x: number; y: number; r: number; hue: number; life: number; maxLife: number; vx: number; vy: number }[];
  rain?: { x: number; y: number; vy: number; hue: number; len: number; seed: number }[];
}

const BRUSHES: { id: BrushKind; label: string }[] = [
  { id: "fireflies", label: "Светлячки" },
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

// Simple deterministic noise
function hash(n: number) {
  n = (n << 13) ^ n;
  return 1.0 - (((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741823.5);
}

let strokeIdCounter = 0;

function Index() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const pointerRef = useRef<{ x: number; y: number; down: boolean; px: number; py: number }>({
    x: 0, y: 0, down: false, px: 0, py: 0,
  });

  const [brush, setBrush] = useState<BrushKind>("fireflies");
  const [mode, setMode] = useState<ModeKind>("normal");
  const [hue, setHue] = useState(180);
  const [size, setSize] = useState(28);
  const [speed, setSpeed] = useState(0.5);
  const [density, setDensity] = useState(0.5);
  const [noise, setNoise] = useState(0.4);
  const [intensity, setIntensity] = useState(0.7);
  const [dynamics, setDynamics] = useState(0.5);
  const [recording, setRecording] = useState<null | "gif" | "mp4">(null);
  const [recordProgress, setRecordProgress] = useState(0);

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

  const resize = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    c.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  const eraseAt = useCallback((x: number, y: number, r: number) => {
    const r2 = r * r;
    for (const s of strokesRef.current) {
      s.points = s.points.filter(p => {
        const dx = p.x - x, dy = p.y - y;
        return dx * dx + dy * dy > r2;
      });
      if (s.fireflies) s.fireflies = s.fireflies.filter(f => (f.ax - x) ** 2 + (f.ay - y) ** 2 > r2);
      if (s.ink) s.ink = s.ink.filter(i => (i.x - x) ** 2 + (i.y - y) ** 2 > r2);
      if (s.rain) s.rain = s.rain.filter(i => (i.x - x) ** 2 + (i.y - y) ** 2 > r2);
    }
    strokesRef.current = strokesRef.current.filter(s => s.points.length > 0);
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dtRaw = Math.min(50, now - last);
      last = now;
      const c = canvasRef.current;
      if (!c) { raf = requestAnimationFrame(tick); return; }
      const ctx = c.getContext("2d")!;
      const w = c.clientWidth, h = c.clientHeight;

      ctx.fillStyle = "#080a12";
      ctx.fillRect(0, 0, w, h);

      const t = now / 1000;

      for (const s of strokesRef.current) {
        if (s.points.length === 0) continue;
        const dt = dtRaw * (0.3 + s.speed * 2.4);
        const tt = t * (0.3 + s.speed * 2.4);
        const lifeMs = now - s.born;
        const modeHueShift = s.mode === "rainbow" ? (lifeMs * 0.05) % 360 : 0;
        const modePulse = s.mode === "pulse" ? 0.6 + 0.5 * Math.sin(tt * 2) : 1;
        const modeSpray = s.mode === "spray" ? 2.2 : 1;
        const alphaMul = (0.25 + s.intensity * 0.9) * modePulse;

        // ============== FIREFLIES ==============
        if (s.kind === "fireflies") {
          // orbiting glowing orbs around stroke points
          const target = Math.floor(8 + s.density * 60 + s.points.length * 0.15);
          if (!s.fireflies) s.fireflies = [];
          while (s.fireflies.length < target) {
            const p = s.points[Math.floor(Math.random() * s.points.length)];
            s.fireflies.push({
              ax: p.x, ay: p.y,
              angle: Math.random() * Math.PI * 2,
              radius: s.size * (0.3 + Math.random() * 1.2 * s.dynamics + 0.3),
              hue: s.hue + (Math.random() - 0.5) * 50,
              seed: Math.random() * 1000,
              life: 0,
            });
          }
          if (s.fireflies.length > target) s.fireflies.length = target;

          ctx.globalCompositeOperation = "lighter";
          for (const f of s.fireflies) {
            f.life += dt;
            f.angle += dt * 0.001 * (0.5 + s.dynamics * 2) + hash(f.seed + tt) * 0.02 * s.noise;
            // anchor drifts gently along stroke
            const anchor = s.points[Math.floor((f.seed * 13) % s.points.length)];
            f.ax += (anchor.x - f.ax) * 0.02;
            f.ay += (anchor.y - f.ay) * 0.02;
            const flick = 0.4 + 0.6 * Math.sin(tt * 6 + f.seed);
            const r = (s.size * 0.18) * (0.7 + flick * 0.6);
            const x = f.ax + Math.cos(f.angle) * f.radius + hash(tt + f.seed) * s.noise * s.size * 0.4;
            const y = f.ay + Math.sin(f.angle) * f.radius + hash(tt * 1.3 + f.seed) * s.noise * s.size * 0.4;
            const hueF = (f.hue + modeHueShift) % 360;
            const a = alphaMul * flick;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
            g.addColorStop(0, `hsla(${hueF}, 100%, 80%, ${a})`);
            g.addColorStop(0.3, `hsla(${hueF}, 100%, 60%, ${a * 0.5})`);
            g.addColorStop(1, `hsla(${hueF}, 100%, 50%, 0)`);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, r * 4, 0, Math.PI * 2);
            ctx.fill();
            if (s.mode === "mirror") {
              const mx = w - x;
              const g2 = ctx.createRadialGradient(mx, y, 0, mx, y, r * 4);
              g2.addColorStop(0, `hsla(${hueF}, 100%, 80%, ${a})`);
              g2.addColorStop(1, `hsla(${hueF}, 100%, 50%, 0)`);
              ctx.fillStyle = g2;
              ctx.beginPath();
              ctx.arc(mx, y, r * 4, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          ctx.globalCompositeOperation = "source-over";
        }

        // ============== INK ==============
        else if (s.kind === "ink") {
          // soft diffusing blobs that breathe and slowly drift outward
          const target = Math.floor(5 + s.density * 40 + s.points.length * 0.1);
          if (!s.ink) s.ink = [];
          while (s.ink.length < target) {
            const p = s.points[Math.floor(Math.random() * s.points.length)];
            const ang = Math.random() * Math.PI * 2;
            s.ink.push({
              x: p.x, y: p.y,
              vx: Math.cos(ang) * 0.1 * s.dynamics,
              vy: Math.sin(ang) * 0.1 * s.dynamics,
              r: s.size * (0.5 + Math.random() * 0.6),
              hue: s.hue + (Math.random() - 0.5) * 20,
              life: 0,
              maxLife: 2000 + Math.random() * 1500,
            });
          }
          for (let i = s.ink.length - 1; i >= 0; i--) {
            const k = s.ink[i];
            k.life += dt;
            if (k.life >= k.maxLife) { s.ink.splice(i, 1); continue; }
            k.x += k.vx + hash(tt + i) * s.noise * 0.5;
            k.y += k.vy + hash(tt * 1.1 + i) * s.noise * 0.5;
            const lt = k.life / k.maxLife;
            const r = k.r * (0.6 + lt * 0.9) * modeSpray;
            const a = alphaMul * (1 - lt) * 0.5;
            const hueI = (k.hue + modeHueShift) % 360;
            const g = ctx.createRadialGradient(k.x, k.y, 0, k.x, k.y, r);
            g.addColorStop(0, `hsla(${hueI}, 75%, 50%, ${a})`);
            g.addColorStop(0.6, `hsla(${hueI}, 75%, 45%, ${a * 0.4})`);
            g.addColorStop(1, `hsla(${hueI}, 75%, 40%, 0)`);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(k.x, k.y, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // ============== RIBBON ==============
        else if (s.kind === "ribbon") {
          // continuous flowing ribbon along the stroke with sine wobble and hue gradient
          const pts = s.points;
          const passes = Math.max(1, Math.floor(1 + s.density * 4));
          for (let pass = 0; pass < passes; pass++) {
            const phase = tt * 2 + pass * 0.7;
            const amp = s.size * 0.6 * (0.3 + s.dynamics) + Math.sin(tt + pass) * s.size * 0.2;
            ctx.lineWidth = s.size * (0.15 + s.intensity * 0.4) * modePulse;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            const hueR = (s.hue + pass * 20 + modeHueShift) % 360;
            ctx.strokeStyle = `hsla(${hueR}, 100%, 65%, ${alphaMul * 0.55})`;
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const p = pts[i];
              const next = pts[i + 1] || p;
              const dx = next.x - p.x, dy = next.y - p.y;
              const len = Math.hypot(dx, dy) || 1;
              const nx = -dy / len, ny = dx / len;
              const wave = Math.sin(p.t * 3 + phase + i * 0.15) * amp + hash(i + tt) * s.noise * s.size * 0.5;
              const x = p.x + nx * wave;
              const y = p.y + ny * wave;
              if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }

        // ============== LIGHTNING ==============
        else if (s.kind === "lightning") {
          // electric arcs jumping between random stroke points
          const arcs = Math.max(1, Math.floor(1 + s.density * 6));
          ctx.globalCompositeOperation = "lighter";
          for (let a = 0; a < arcs; a++) {
            if (Math.random() > 0.3 + s.intensity * 0.6) continue;
            const i0 = Math.floor(Math.random() * s.points.length);
            const i1 = Math.min(s.points.length - 1, i0 + 1 + Math.floor(Math.random() * (5 + s.dynamics * 30)));
            const p0 = s.points[i0], p1 = s.points[i1];
            const segs = 8 + Math.floor(s.dynamics * 12);
            const hueL = (s.hue + modeHueShift) % 360;
            ctx.strokeStyle = `hsla(${hueL}, 100%, 80%, ${alphaMul})`;
            ctx.lineWidth = 1 + s.intensity * 2;
            ctx.shadowColor = `hsl(${hueL}, 100%, 70%)`;
            ctx.shadowBlur = 12 * s.intensity;
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            for (let i = 1; i < segs; i++) {
              const f = i / segs;
              const x = p0.x + (p1.x - p0.x) * f + (Math.random() - 0.5) * s.size * (0.5 + s.noise * 1.5);
              const y = p0.y + (p1.y - p0.y) * f + (Math.random() - 0.5) * s.size * (0.5 + s.noise * 1.5);
              ctx.lineTo(x, y);
            }
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();
          }
          ctx.shadowBlur = 0;
          ctx.globalCompositeOperation = "source-over";
        }

        // ============== PIXEL RAIN ==============
        else if (s.kind === "pixelRain") {
          // pixels fall downward from stroke points, leaving trails
          const grid = Math.max(3, Math.round(s.size / 4));
          const target = Math.floor(10 + s.density * 80);
          if (!s.rain) s.rain = [];
          while (s.rain.length < target) {
            const p = s.points[Math.floor(Math.random() * s.points.length)];
            s.rain.push({
              x: Math.round(p.x / grid) * grid + (Math.random() - 0.5) * s.size,
              y: p.y,
              vy: 0.5 + Math.random() * 2 * (0.3 + s.dynamics * 2),
              hue: s.hue + (Math.random() - 0.5) * 40,
              len: 3 + Math.floor(Math.random() * 8 * (0.3 + s.dynamics)),
              seed: Math.random() * 1000,
            });
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

        // ============== PIXEL DITHER ==============
        else if (s.kind === "pixelDither") {
          // scanning bayer dither sweep across the stroke bounds
          const grid = Math.max(3, Math.round(s.size / 5));
          const passes = Math.max(1, Math.floor(1 + s.density * 4));
          const hueD = (s.hue + modeHueShift) % 360;
          const sweep = (tt * (0.5 + s.speed * 2)) % 1;
          for (const p of s.points) {
            const radius = s.size * (1 + s.dynamics * 2);
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
                if (Math.random() > 0.05 + s.density * 0.4 / passes) continue;
                const lit = 50 + (1 - dist) * 30;
                ctx.fillStyle = `hsla(${hueD + (bayer ? 30 : 0)}, 95%, ${lit}%, ${alphaMul * (1 - dist)})`;
                ctx.fillRect(gx, gy, grid, grid);
              }
            }
          }
        }

        // ============== PIXEL GLITCH ==============
        else if (s.kind === "pixelGlitch") {
          // horizontal slice displacement + RGB channel split
          const grid = Math.max(2, Math.round(s.size / 6));
          const hueG = (s.hue + modeHueShift) % 360;
          for (const p of s.points) {
            const radius = s.size * (0.8 + s.dynamics * 1.5);
            const slices = 4 + Math.floor(s.density * 12);
            for (let i = 0; i < slices; i++) {
              const yOff = (i / slices - 0.5) * radius * 2;
              const shift = (hash(Math.floor(tt * 8) + i + p.t) * 2) * s.size * (0.3 + s.noise * 2);
              const widthLine = radius * 2 * (0.6 + Math.random() * 0.4);
              const x0 = p.x - widthLine / 2 + shift;
              const y0 = Math.round((p.y + yOff) / grid) * grid;
              // R / G / B offset blocks
              const offs = [-grid, 0, grid];
              const hues = [(hueG) % 360, (hueG + 120) % 360, (hueG + 240) % 360];
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

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const getPoint = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const addPoint = (x: number, y: number) => {
    const s = currentStrokeRef.current;
    if (!s) return;
    const now = performance.now();
    s.points.push({ x, y, t: (now - s.born) / 1000 });
    if (s.mode === "mirror" && s.kind !== "fireflies") {
      const c = canvasRef.current!;
      s.points.push({ x: c.clientWidth - x, y, t: (now - s.born) / 1000 });
    }
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const { x, y } = getPoint(e);
    pointerRef.current = { x, y, px: x, py: y, down: true };
    if (refs.brush.current === "eraser") { eraseAt(x, y, refs.size.current); return; }
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
    };
    currentStrokeRef.current = stroke;
    strokesRef.current.push(stroke);
    addPoint(x, y);
  };
  const onMove = (e: React.PointerEvent) => {
    const { x, y } = getPoint(e);
    pointerRef.current.x = x; pointerRef.current.y = y;
    if (!pointerRef.current.down) return;
    if (refs.brush.current === "eraser") { eraseAt(x, y, refs.size.current); return; }
    const px = pointerRef.current.px, py = pointerRef.current.py;
    const dx = x - px, dy = y - py;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.floor(dist / 5));
    for (let i = 1; i <= steps; i++) addPoint(px + dx * (i / steps), py + dy * (i / steps));
    pointerRef.current.px = x; pointerRef.current.py = y;
  };
  const onUp = () => { pointerRef.current.down = false; currentStrokeRef.current = null; };

  const clear = () => { strokesRef.current = []; currentStrokeRef.current = null; };

  const savePng = () => {
    const c = canvasRef.current;
    if (!c) return;
    const link = document.createElement("a");
    link.download = `living-pixels-${Date.now()}.png`;
    link.href = c.toDataURL("image/png");
    link.click();
  };

  const exportMp4 = async () => {
    const c = canvasRef.current;
    if (!c || recording) return;
    const stream = c.captureStream(30);
    const mimes = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mime = mimes.find(m => (window as any).MediaRecorder?.isTypeSupported?.(m)) || "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    setRecording("mp4"); setRecordProgress(0);
    rec.start();
    const duration = 5000;
    const startedAt = performance.now();
    const timer = setInterval(() => setRecordProgress(Math.min(1, (performance.now() - startedAt) / duration)), 100);
    await new Promise(r => setTimeout(r, duration));
    rec.stop();
    await new Promise<void>(r => { rec.onstop = () => r(); });
    clearInterval(timer);
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `living-pixels-${Date.now()}.${mime.includes("mp4") ? "mp4" : "webm"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setRecording(null); setRecordProgress(0);
  };

  const exportGif = async () => {
    const c = canvasRef.current;
    if (!c || recording) return;
    setRecording("gif"); setRecordProgress(0);
    const fps = 15, seconds = 3, total = fps * seconds;
    const gifW = Math.min(480, c.clientWidth);
    const gifH = Math.round(c.clientHeight * (gifW / c.clientWidth));
    const tmp = document.createElement("canvas");
    tmp.width = gifW; tmp.height = gifH;
    const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
    const gif = GIFEncoder();
    const delay = Math.round(1000 / fps);
    for (let i = 0; i < total; i++) {
      await new Promise(requestAnimationFrame);
      tctx.drawImage(c, 0, 0, gifW, gifH);
      const data = tctx.getImageData(0, 0, gifW, gifH).data;
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, gifW, gifH, { palette, delay });
      setRecordProgress((i + 1) / total);
    }
    gif.finish();
    const bytes = gif.bytesView();
    const buf = new Uint8Array(bytes.byteLength); buf.set(bytes);
    const blob = new Blob([buf.buffer], { type: "image/gif" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `living-pixels-${Date.now()}.gif`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setRecording(null); setRecordProgress(0);
  };

  const ParamSlider = ({ label, value, set }: { label: string; value: number; set: (n: number) => void }) => (
    <label className="flex flex-col gap-0.5 text-[9px] uppercase tracking-widest text-white/50">
      <span className="flex justify-between"><span>{label}</span><span className="text-white/80">{Math.round(value * 100)}</span></span>
      <input
        type="range" min={0} max={1} step={0.01} value={value}
        onChange={(e) => set(+e.target.value)}
        className="w-24 accent-white"
      />
    </label>
  );

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#080a12] text-white">
      <canvas
        ref={canvasRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
      />

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-4">
        <h1 className="pointer-events-auto select-none text-sm font-medium tracking-[0.3em] text-white/70">
          LIVING&nbsp;PIXELS
        </h1>
        <div className="pointer-events-auto flex flex-wrap justify-end gap-2">
          <button onClick={savePng} disabled={!!recording} className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] tracking-widest text-white/80 backdrop-blur-md transition hover:bg-white/10 disabled:opacity-40">PNG</button>
          <button onClick={exportGif} disabled={!!recording} className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] tracking-widest text-white/80 backdrop-blur-md transition hover:bg-white/10 disabled:opacity-40">{recording === "gif" ? `GIF ${Math.round(recordProgress * 100)}%` : "GIF"}</button>
          <button onClick={exportMp4} disabled={!!recording} className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] tracking-widest text-white/80 backdrop-blur-md transition hover:bg-white/10 disabled:opacity-40">{recording === "mp4" ? `MP4 ${Math.round(recordProgress * 100)}%` : "MP4"}</button>
          <button onClick={clear} disabled={!!recording} className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] tracking-widest text-white/80 backdrop-blur-md transition hover:bg-white/10 disabled:opacity-40">ОЧИСТИТЬ</button>
        </div>
      </div>

      {/* Bottom dock */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-3">
        <div className="pointer-events-auto flex max-w-full flex-col gap-2 rounded-2xl border border-white/10 bg-black/55 p-3 backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {BRUSHES.map((b) => (
              <button
                key={b.id}
                onClick={() => setBrush(b.id)}
                className={`rounded-lg border px-2.5 py-1.5 text-[11px] tracking-wider transition ${brush === b.id ? "border-white/70 bg-white/15 text-white" : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"}`}
              >{b.label}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`rounded-md border px-2 py-1 text-[10px] uppercase tracking-widest transition ${mode === m.id ? "border-white/60 bg-white/10 text-white" : "border-white/5 bg-transparent text-white/40 hover:text-white/80"}`}
              >{m.label}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 px-1">
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/50">
              Размер
              <input type="range" min={4} max={80} value={size} onChange={(e) => setSize(+e.target.value)} className="w-24 accent-white" />
              <span className="w-6 text-white/80">{size}</span>
            </label>
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/50">
              Цвет
              <input type="range" min={0} max={360} value={hue} onChange={(e) => setHue(+e.target.value)} className="w-32"
                style={{ background: "linear-gradient(to right, hsl(0,90%,60%), hsl(60,90%,60%), hsl(120,90%,60%), hsl(180,90%,60%), hsl(240,90%,60%), hsl(300,90%,60%), hsl(360,90%,60%))", appearance: "none", height: 6, borderRadius: 999 }} />
              <span className="h-5 w-5 rounded-full border border-white/30" style={{ backgroundColor: `hsl(${hue}, 90%, 60%)` }} />
            </label>
          </div>
          <div className="flex flex-wrap items-end justify-center gap-3 border-t border-white/5 pt-2">
            <ParamSlider label="Скорость" value={speed} set={setSpeed} />
            <ParamSlider label="Плотность" value={density} set={setDensity} />
            <ParamSlider label="Шум" value={noise} set={setNoise} />
            <ParamSlider label="Интенсив." value={intensity} set={setIntensity} />
            <ParamSlider label="Динамика" value={dynamics} set={setDynamics} />
          </div>
        </div>
      </div>
    </main>
  );
}
