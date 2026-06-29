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
  | "pixels"
  | "ribbon"
  | "static"
  | "pixelDither"
  | "pixelGlitch"
  | "eraser";

type ModeKind = "normal" | "rainbow" | "pulse" | "spray" | "mirror";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  hue: number;
  kind: BrushKind;
  seed: number;
  baseX: number;
  baseY: number;
}

interface Stroke {
  kind: BrushKind;
  mode: ModeKind;
  size: number;
  hue: number;
  points: { x: number; y: number; t: number }[];
  born: number; // ms
}

const BRUSHES: { id: BrushKind; label: string }[] = [
  { id: "fireflies", label: "Светлячки" },
  { id: "ink", label: "Чернила" },
  { id: "ribbon", label: "Лента" },
  { id: "static", label: "Шум" },
  { id: "pixels", label: "Пиксели" },
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

function Index() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const pointerRef = useRef<{ x: number; y: number; down: boolean; px: number; py: number; lastEmit: number }>({
    x: 0, y: 0, down: false, px: 0, py: 0, lastEmit: 0,
  });

  const [brush, setBrush] = useState<BrushKind>("fireflies");
  const [mode, setMode] = useState<ModeKind>("normal");
  const [hue, setHue] = useState(180);
  const [size, setSize] = useState(28);
  const [recording, setRecording] = useState<null | "gif" | "mp4">(null);
  const [recordProgress, setRecordProgress] = useState(0);

  const brushRef = useRef(brush);
  const modeRef = useRef(mode);
  const hueRef = useRef(hue);
  const sizeRef = useRef(size);
  useEffect(() => { brushRef.current = brush; }, [brush]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { hueRef.current = hue; }, [hue]);
  useEffect(() => { sizeRef.current = size; }, [size]);

  const dprRef = useRef(1);

  const resize = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    dprRef.current = dpr;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  // emit particles for "live" floating effect at stroke points
  const emitFromStrokes = useCallback((now: number) => {
    for (const s of strokesRef.current) {
      if (s.kind === "eraser") continue;
      // sample a few points along the stroke to keep them alive
      const pts = s.points;
      if (pts.length === 0) continue;
      // particle budget per stroke per frame, scales by stroke length
      const budget = Math.min(3, 1 + Math.floor(pts.length / 60));
      for (let b = 0; b < budget; b++) {
        const p = pts[Math.floor(Math.random() * pts.length)];
        const k = s.kind;
        const baseHue = s.mode === "rainbow"
          ? (s.hue + (now - s.born) * 0.05 + p.x * 0.3) % 360
          : s.hue;
        const sz = s.mode === "pulse"
          ? s.size * (0.7 + 0.5 * Math.sin((now - s.born) / 300 + p.t))
          : s.size;
        const spreadMul = s.mode === "spray" ? 2.5 : 1;

        const baseSize =
          k === "pixels" || k === "pixelDither" || k === "pixelGlitch"
            ? Math.max(3, Math.round(sz / 5))
            : k === "ink"
            ? sz * (0.3 + Math.random() * 0.4)
            : k === "ribbon"
            ? sz * 0.35
            : k === "static"
            ? 1.5 + Math.random() * 2.5
            : sz * (0.12 + Math.random() * 0.22);

        const angle = Math.random() * Math.PI * 2;
        particlesRef.current.push({
          x: p.x + (Math.random() - 0.5) * sz * 0.4 * spreadMul,
          y: p.y + (Math.random() - 0.5) * sz * 0.4 * spreadMul,
          baseX: p.x,
          baseY: p.y,
          vx: Math.cos(angle) * 0.4,
          vy: Math.sin(angle) * 0.4,
          life: 0,
          maxLife:
            k === "fireflies" ? 120 + Math.random() * 80 :
            k === "ink" ? 90 + Math.random() * 60 :
            k === "ribbon" ? 40 + Math.random() * 30 :
            k === "static" ? 18 + Math.random() * 18 :
            70 + Math.random() * 50,
          size: baseSize,
          hue: baseHue + (Math.random() - 0.5) * 30,
          kind: k,
          seed: Math.random() * 1000,
        });
      }
    }
    // hard cap
    const cap = 1200;
    if (particlesRef.current.length > cap) {
      particlesRef.current.splice(0, particlesRef.current.length - cap);
    }
  }, []);

  // Eraser draws onto a separate mask immediately — simulated by removing nearby stroke points
  const eraseAt = useCallback((x: number, y: number, r: number) => {
    const r2 = r * r;
    for (const s of strokesRef.current) {
      s.points = s.points.filter(p => {
        const dx = p.x - x, dy = p.y - y;
        return dx * dx + dy * dy > r2;
      });
    }
    strokesRef.current = strokesRef.current.filter(s => s.points.length > 0);
    // also kill nearby particles
    particlesRef.current = particlesRef.current.filter(p => {
      const dx = p.x - x, dy = p.y - y;
      return dx * dx + dy * dy > r2;
    });
  }, []);

  // Main render loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(40, now - last);
      last = now;
      const c = canvasRef.current;
      if (!c) { raf = requestAnimationFrame(tick); return; }
      const ctx = c.getContext("2d")!;
      const w = c.clientWidth;
      const h = c.clientHeight;

      // full clear each frame — strokes are re-rendered live (so they animate forever)
      ctx.fillStyle = "#080a12";
      ctx.fillRect(0, 0, w, h);

      // emit live particles tied to existing strokes
      emitFromStrokes(now);

      // update + draw particles (additive)
      const time = now / 1000;
      const arr = particlesRef.current;
      ctx.globalCompositeOperation = "lighter";
      for (let i = arr.length - 1; i >= 0; i--) {
        const pt = arr[i];
        pt.life += dt;
        const t = pt.life / pt.maxLife;
        if (t >= 1) { arr.splice(i, 1); continue; }
        const a = 1 - t;

        if (pt.kind === "fireflies") {
          pt.vx += Math.sin(time * 2 + pt.seed) * 0.08;
          pt.vy += Math.cos(time * 1.7 + pt.seed) * 0.08 - 0.02;
          pt.vx *= 0.95; pt.vy *= 0.95;
          pt.x += pt.vx; pt.y += pt.vy;
          const flick = 0.5 + 0.5 * Math.sin(time * 8 + pt.seed);
          const r = pt.size * (1 + flick * 0.5);
          ctx.fillStyle = `hsla(${pt.hue}, 100%, ${60 + flick * 20}%, ${a * flick})`;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
          ctx.fill();
        } else if (pt.kind === "ink") {
          pt.vx += (Math.random() - 0.5) * 0.1;
          pt.vy += (Math.random() - 0.5) * 0.1;
          pt.vx *= 0.9; pt.vy *= 0.9;
          pt.x += pt.vx; pt.y += pt.vy;
          ctx.fillStyle = `hsla(${pt.hue}, 70%, 55%, ${a * 0.45})`;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pt.size * (1 - t * 0.2), 0, Math.PI * 2);
          ctx.fill();
        } else if (pt.kind === "ribbon") {
          pt.x += pt.vx; pt.y += pt.vy;
          pt.vy += 0.015;
          ctx.fillStyle = `hsla(${pt.hue}, 100%, 70%, ${a * 0.8})`;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pt.size * (1 - t * 0.6), 0, Math.PI * 2);
          ctx.fill();
        } else if (pt.kind === "static") {
          pt.x = pt.baseX + (Math.random() - 0.5) * 12;
          pt.y = pt.baseY + (Math.random() - 0.5) * 12;
          ctx.fillStyle = `hsla(${pt.hue}, 100%, 85%, ${a})`;
          ctx.fillRect(pt.x, pt.y, pt.size, pt.size);
        } else if (pt.kind === "pixels") {
          const grid = pt.size;
          const gx = Math.round(pt.x / grid) * grid;
          const gy = Math.round(pt.y / grid) * grid;
          const pulse = 0.5 + 0.5 * Math.sin(time * 6 + pt.seed);
          ctx.fillStyle = `hsla(${pt.hue}, 95%, ${50 + pulse * 20}%, ${a})`;
          const sz = grid * (0.6 + pulse * 0.4);
          ctx.fillRect(gx - sz / 2, gy - sz / 2, sz, sz);
        } else if (pt.kind === "pixelDither") {
          const grid = pt.size;
          const gx = Math.round(pt.x / grid) * grid;
          const gy = Math.round(pt.y / grid) * grid;
          // bayer-ish pattern animated
          const checker = ((Math.floor(gx / grid) + Math.floor(gy / grid) + Math.floor(time * 4 + pt.seed)) & 1);
          if (checker) {
            ctx.fillStyle = `hsla(${pt.hue}, 95%, 60%, ${a})`;
            ctx.fillRect(gx, gy, grid, grid);
          } else {
            ctx.fillStyle = `hsla(${pt.hue + 30}, 95%, 45%, ${a * 0.6})`;
            ctx.fillRect(gx, gy, grid, grid);
          }
        } else if (pt.kind === "pixelGlitch") {
          const grid = pt.size;
          const shift = Math.sin(time * 10 + pt.seed) * grid * 2;
          const gx = Math.round((pt.x + shift) / grid) * grid;
          const gy = Math.round(pt.y / grid) * grid;
          // RGB channel split blocks
          ctx.fillStyle = `hsla(0, 100%, 55%, ${a * 0.7})`;
          ctx.fillRect(gx - grid, gy, grid, grid);
          ctx.fillStyle = `hsla(120, 100%, 55%, ${a * 0.7})`;
          ctx.fillRect(gx, gy, grid, grid);
          ctx.fillStyle = `hsla(240, 100%, 60%, ${a * 0.7})`;
          ctx.fillRect(gx + grid, gy, grid, grid);
        }
      }
      ctx.globalCompositeOperation = "source-over";

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [emitFromStrokes]);

  const getPoint = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const addPoint = (x: number, y: number) => {
    const stroke = currentStrokeRef.current;
    if (!stroke) return;
    const now = performance.now();
    stroke.points.push({ x, y, t: (now - stroke.born) / 1000 });
    if (stroke.mode === "mirror") {
      const c = canvasRef.current!;
      stroke.points.push({ x: c.clientWidth - x, y, t: (now - stroke.born) / 1000 });
    }
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const { x, y } = getPoint(e);
    pointerRef.current = { x, y, px: x, py: y, down: true, lastEmit: 0 };
    if (brushRef.current === "eraser") {
      eraseAt(x, y, sizeRef.current);
      return;
    }
    const stroke: Stroke = {
      kind: brushRef.current,
      mode: modeRef.current,
      size: sizeRef.current,
      hue: hueRef.current,
      points: [],
      born: performance.now(),
    };
    currentStrokeRef.current = stroke;
    strokesRef.current.push(stroke);
    addPoint(x, y);
  };
  const onMove = (e: React.PointerEvent) => {
    const { x, y } = getPoint(e);
    pointerRef.current.x = x;
    pointerRef.current.y = y;
    if (!pointerRef.current.down) return;
    if (brushRef.current === "eraser") {
      eraseAt(x, y, sizeRef.current);
      return;
    }
    // densify between previous and current
    const px = pointerRef.current.px;
    const py = pointerRef.current.py;
    const dx = x - px, dy = y - py;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.floor(dist / 4));
    for (let i = 1; i <= steps; i++) {
      addPoint(px + dx * (i / steps), py + dy * (i / steps));
    }
    pointerRef.current.px = x;
    pointerRef.current.py = y;
  };
  const onUp = () => {
    pointerRef.current.down = false;
    currentStrokeRef.current = null;
  };

  const clear = () => {
    strokesRef.current = [];
    particlesRef.current = [];
    currentStrokeRef.current = null;
  };

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
    const mimeCandidates = [
      "video/mp4;codecs=avc1",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    const mime = mimeCandidates.find(m => (window as any).MediaRecorder?.isTypeSupported?.(m)) || "video/webm";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    setRecording("mp4");
    setRecordProgress(0);
    rec.start();
    const duration = 5000;
    const startedAt = performance.now();
    const progressTimer = setInterval(() => {
      setRecordProgress(Math.min(1, (performance.now() - startedAt) / duration));
    }, 100);
    await new Promise(r => setTimeout(r, duration));
    rec.stop();
    await new Promise<void>(r => { rec.onstop = () => r(); });
    clearInterval(progressTimer);
    const blob = new Blob(chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    a.href = url;
    a.download = `living-pixels-${Date.now()}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setRecording(null);
    setRecordProgress(0);
  };

  const exportGif = async () => {
    const c = canvasRef.current;
    if (!c || recording) return;
    setRecording("gif");
    setRecordProgress(0);
    const fps = 15;
    const seconds = 3;
    const total = fps * seconds;
    const gifW = Math.min(480, c.clientWidth);
    const gifH = Math.round(c.clientHeight * (gifW / c.clientWidth));
    const tmp = document.createElement("canvas");
    tmp.width = gifW;
    tmp.height = gifH;
    const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
    const gif = GIFEncoder();
    const delay = Math.round(1000 / fps);

    for (let i = 0; i < total; i++) {
      // wait for next frame
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
    const buf = new Uint8Array(bytes.byteLength);
    buf.set(bytes);
    const blob = new Blob([buf.buffer], { type: "image/gif" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `living-pixels-${Date.now()}.gif`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setRecording(null);
    setRecordProgress(0);
  };

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
          <button
            onClick={savePng}
            disabled={!!recording}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] tracking-widest text-white/80 backdrop-blur-md transition hover:bg-white/10 disabled:opacity-40"
          >PNG</button>
          <button
            onClick={exportGif}
            disabled={!!recording}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] tracking-widest text-white/80 backdrop-blur-md transition hover:bg-white/10 disabled:opacity-40"
          >{recording === "gif" ? `GIF ${Math.round(recordProgress * 100)}%` : "GIF"}</button>
          <button
            onClick={exportMp4}
            disabled={!!recording}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] tracking-widest text-white/80 backdrop-blur-md transition hover:bg-white/10 disabled:opacity-40"
          >{recording === "mp4" ? `MP4 ${Math.round(recordProgress * 100)}%` : "MP4"}</button>
          <button
            onClick={clear}
            disabled={!!recording}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] tracking-widest text-white/80 backdrop-blur-md transition hover:bg-white/10 disabled:opacity-40"
          >ОЧИСТИТЬ</button>
        </div>
      </div>

      {/* Bottom dock */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-4">
        <div className="pointer-events-auto flex max-w-full flex-col gap-3 rounded-2xl border border-white/10 bg-black/50 p-3 backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {BRUSHES.map((b) => (
              <button
                key={b.id}
                onClick={() => setBrush(b.id)}
                className={`rounded-lg border px-2.5 py-1.5 text-[11px] tracking-wider transition ${
                  brush === b.id
                    ? "border-white/70 bg-white/15 text-white"
                    : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06]"
                }`}
              >{b.label}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`rounded-md border px-2 py-1 text-[10px] uppercase tracking-widest transition ${
                  mode === m.id
                    ? "border-white/60 bg-white/10 text-white"
                    : "border-white/5 bg-transparent text-white/40 hover:text-white/80"
                }`}
              >{m.label}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-4 px-2">
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/50">
              Размер
              <input
                type="range" min={4} max={80} value={size}
                onChange={(e) => setSize(+e.target.value)}
                className="accent-white"
              />
              <span className="w-6 text-white/80">{size}</span>
            </label>
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/50">
              Цвет
              <input
                type="range" min={0} max={360} value={hue}
                onChange={(e) => setHue(+e.target.value)}
                className="w-40"
                style={{ background: "linear-gradient(to right, hsl(0,90%,60%), hsl(60,90%,60%), hsl(120,90%,60%), hsl(180,90%,60%), hsl(240,90%,60%), hsl(300,90%,60%), hsl(360,90%,60%))", appearance: "none", height: 6, borderRadius: 999 }}
              />
              <span
                className="h-5 w-5 rounded-full border border-white/30"
                style={{ backgroundColor: `hsl(${hue}, 90%, 60%)` }}
              />
            </label>
          </div>
        </div>
      </div>
    </main>
  );
}
