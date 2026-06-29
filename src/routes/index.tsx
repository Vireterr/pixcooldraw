import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Living Pixels — Animated Brush Studio" },
      { name: "description", content: "Draw with living brushes and animated pixels that breathe, drift, and pulse on a digital canvas." },
      { property: "og:title", content: "Living Pixels — Animated Brush Studio" },
      { property: "og:description", content: "Draw with living brushes and animated pixels that breathe, drift, and pulse." },
    ],
  }),
  component: Index,
});

type BrushKind = "fireflies" | "ink" | "pixels" | "ribbon" | "static";

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
}

const BRUSHES: { id: BrushKind; label: string; desc: string }[] = [
  { id: "fireflies", label: "Светлячки", desc: "мерцают и парят" },
  { id: "ink", label: "Живые чернила", desc: "растекаются и дышат" },
  { id: "pixels", label: "Пиксели", desc: "анимированная сетка" },
  { id: "ribbon", label: "Лента", desc: "плавная линия с хвостом" },
  { id: "static", label: "Шум", desc: "электрический разряд" },
];

function Index() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const pointerRef = useRef<{ x: number; y: number; down: boolean; px: number; py: number }>({
    x: 0, y: 0, down: false, px: 0, py: 0,
  });
  const trailLayerRef = useRef<HTMLCanvasElement | null>(null);

  const [brush, setBrush] = useState<BrushKind>("fireflies");
  const [hue, setHue] = useState(180);
  const [size, setSize] = useState(28);
  const brushRef = useRef(brush);
  const hueRef = useRef(hue);
  const sizeRef = useRef(size);

  useEffect(() => { brushRef.current = brush; }, [brush]);
  useEffect(() => { hueRef.current = hue; }, [hue]);
  useEffect(() => { sizeRef.current = size; }, [size]);

  const resize = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const trail = document.createElement("canvas");
    trail.width = c.width;
    trail.height = c.height;
    const tctx = trail.getContext("2d")!;
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (trailLayerRef.current) {
      tctx.drawImage(trailLayerRef.current, 0, 0, w, h);
    }
    trailLayerRef.current = trail;
  }, []);

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  const spawn = useCallback((x: number, y: number, dx: number, dy: number) => {
    const k = brushRef.current;
    const s = sizeRef.current;
    const h = hueRef.current;
    const speed = Math.hypot(dx, dy);
    const count =
      k === "pixels" ? 3 :
      k === "ink" ? 4 :
      k === "ribbon" ? 2 :
      k === "static" ? 6 : 5;

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spread = k === "ribbon" ? 0.2 : k === "ink" ? 1.2 : 2;
      particlesRef.current.push({
        x: x + (Math.random() - 0.5) * s * 0.4,
        y: y + (Math.random() - 0.5) * s * 0.4,
        vx: Math.cos(angle) * spread + dx * 0.1,
        vy: Math.sin(angle) * spread + dy * 0.1,
        life: 0,
        maxLife: k === "pixels" ? 80 + Math.random() * 60 :
                 k === "ink" ? 120 + Math.random() * 80 :
                 k === "ribbon" ? 40 + Math.random() * 20 :
                 k === "static" ? 20 + Math.random() * 20 :
                 100 + Math.random() * 80,
        size: k === "pixels" ? Math.max(4, Math.round(s / 4)) :
              k === "ink" ? s * (0.4 + Math.random() * 0.6) :
              k === "ribbon" ? s * 0.5 :
              k === "static" ? 2 + Math.random() * 3 :
              s * (0.15 + Math.random() * 0.3),
        hue: h + (Math.random() - 0.5) * 40,
        kind: k,
        seed: Math.random() * 1000,
      });
    }

    // ribbon also burns into trail layer
    if (k === "ribbon" && trailLayerRef.current) {
      const tctx = trailLayerRef.current.getContext("2d")!;
      tctx.strokeStyle = `hsla(${h}, 90%, 60%, 0.4)`;
      tctx.lineWidth = s * 0.4;
      tctx.lineCap = "round";
      tctx.beginPath();
      tctx.moveTo(x - dx, y - dy);
      tctx.lineTo(x, y);
      tctx.stroke();
    }
    if (k === "ink" && trailLayerRef.current && speed > 0.1) {
      const tctx = trailLayerRef.current.getContext("2d")!;
      const grad = tctx.createRadialGradient(x, y, 0, x, y, s * 0.6);
      grad.addColorStop(0, `hsla(${h}, 80%, 50%, 0.25)`);
      grad.addColorStop(1, `hsla(${h}, 80%, 50%, 0)`);
      tctx.fillStyle = grad;
      tctx.beginPath();
      tctx.arc(x, y, s * 0.6, 0, Math.PI * 2);
      tctx.fill();
    }
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      const c = canvasRef.current;
      if (!c) { raf = requestAnimationFrame(tick); return; }
      const ctx = c.getContext("2d")!;
      const w = c.clientWidth;
      const h = c.clientHeight;

      // background fade
      ctx.fillStyle = "rgba(8, 10, 18, 0.18)";
      ctx.fillRect(0, 0, w, h);

      // persistent trail layer slowly fades
      if (trailLayerRef.current) {
        const tctx = trailLayerRef.current.getContext("2d")!;
        tctx.globalCompositeOperation = "destination-out";
        tctx.fillStyle = "rgba(0,0,0,0.005)";
        tctx.fillRect(0, 0, w, h);
        tctx.globalCompositeOperation = "source-over";
        ctx.drawImage(trailLayerRef.current, 0, 0, w, h);
      }

      // continuous emission while pressed
      const p = pointerRef.current;
      if (p.down) {
        const dx = p.x - p.px;
        const dy = p.y - p.py;
        const dist = Math.hypot(dx, dy);
        const steps = Math.max(1, Math.floor(dist / 3));
        for (let i = 0; i < steps; i++) {
          const t = i / steps;
          spawn(p.px + dx * t, p.py + dy * t, dx, dy);
        }
        p.px = p.x;
        p.py = p.y;
      }

      // particles
      const time = now / 1000;
      const arr = particlesRef.current;
      ctx.globalCompositeOperation = "lighter";
      for (let i = arr.length - 1; i >= 0; i--) {
        const pt = arr[i];
        pt.life += dt;
        const t = pt.life / pt.maxLife;
        if (t >= 1) { arr.splice(i, 1); continue; }

        if (pt.kind === "fireflies") {
          pt.vx += Math.sin(time * 2 + pt.seed) * 0.08;
          pt.vy += Math.cos(time * 1.7 + pt.seed) * 0.08 - 0.02;
          pt.vx *= 0.96; pt.vy *= 0.96;
          pt.x += pt.vx; pt.y += pt.vy;
          const flick = 0.5 + 0.5 * Math.sin(time * 8 + pt.seed);
          const a = (1 - t) * flick;
          const r = pt.size * (1 + flick * 0.4);
          const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r * 3);
          grad.addColorStop(0, `hsla(${pt.hue}, 100%, 75%, ${a})`);
          grad.addColorStop(0.3, `hsla(${pt.hue}, 100%, 60%, ${a * 0.4})`);
          grad.addColorStop(1, `hsla(${pt.hue}, 100%, 50%, 0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, r * 3, 0, Math.PI * 2);
          ctx.fill();
        } else if (pt.kind === "ink") {
          pt.vx += (Math.random() - 0.5) * 0.15;
          pt.vy += (Math.random() - 0.5) * 0.15;
          pt.vx *= 0.92; pt.vy *= 0.92;
          pt.x += pt.vx; pt.y += pt.vy;
          const a = (1 - t) * 0.5;
          ctx.fillStyle = `hsla(${pt.hue}, 70%, 55%, ${a})`;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pt.size * (1 - t * 0.3), 0, Math.PI * 2);
          ctx.fill();
        } else if (pt.kind === "pixels") {
          // jittery grid-snapped pixels that animate scale/hue
          const grid = pt.size;
          const gx = Math.round(pt.x / grid) * grid;
          const gy = Math.round(pt.y / grid) * grid;
          const pulse = 0.5 + 0.5 * Math.sin(time * 10 + pt.seed);
          const a = (1 - t);
          const hueShift = pt.hue + Math.sin(time * 3 + pt.seed) * 30;
          ctx.fillStyle = `hsla(${hueShift}, 95%, ${50 + pulse * 20}%, ${a})`;
          const s = grid * (0.6 + pulse * 0.4);
          ctx.fillRect(gx - s / 2, gy - s / 2, s, s);
          // small satellites
          if (Math.random() < 0.3) {
            ctx.fillStyle = `hsla(${hueShift + 60}, 95%, 70%, ${a * 0.5})`;
            ctx.fillRect(gx + grid, gy, grid * 0.4, grid * 0.4);
          }
        } else if (pt.kind === "ribbon") {
          pt.x += pt.vx; pt.y += pt.vy;
          pt.vy += 0.02;
          const a = (1 - t) * 0.8;
          ctx.fillStyle = `hsla(${pt.hue}, 100%, 70%, ${a})`;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pt.size * (1 - t), 0, Math.PI * 2);
          ctx.fill();
        } else if (pt.kind === "static") {
          pt.x += pt.vx + (Math.random() - 0.5) * 3;
          pt.y += pt.vy + (Math.random() - 0.5) * 3;
          const a = (1 - t);
          ctx.fillStyle = `hsla(${pt.hue}, 100%, 80%, ${a})`;
          ctx.fillRect(pt.x, pt.y, pt.size, pt.size);
        }
      }
      ctx.globalCompositeOperation = "source-over";

      // hue drift
      hueRef.current = (hueRef.current + 0.15) % 360;
      setHue((prev) => (prev + 0.15) % 360);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawn]);

  const getPoint = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const { x, y } = getPoint(e);
    pointerRef.current = { x, y, px: x, py: y, down: true };
  };
  const onMove = (e: React.PointerEvent) => {
    const { x, y } = getPoint(e);
    pointerRef.current.x = x;
    pointerRef.current.y = y;
    if (!pointerRef.current.down) {
      pointerRef.current.px = x;
      pointerRef.current.py = y;
    }
  };
  const onUp = () => { pointerRef.current.down = false; };

  const clear = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#080a12";
    ctx.fillRect(0, 0, c.clientWidth, c.clientHeight);
    if (trailLayerRef.current) {
      const tctx = trailLayerRef.current.getContext("2d")!;
      tctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
    }
    particlesRef.current = [];
  };

  const save = () => {
    const c = canvasRef.current;
    if (!c) return;
    const link = document.createElement("a");
    link.download = `living-pixels-${Date.now()}.png`;
    link.href = c.toDataURL("image/png");
    link.click();
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
        style={{ background: "radial-gradient(ellipse at center, #0f1428 0%, #050610 100%)" }}
      />

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-5">
        <h1 className="pointer-events-auto select-none text-sm font-medium tracking-[0.3em] text-white/70">
          LIVING&nbsp;PIXELS
        </h1>
        <div className="pointer-events-auto flex gap-2">
          <button
            onClick={save}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs tracking-widest text-white/80 backdrop-blur-md transition hover:bg-white/10"
          >
            СОХРАНИТЬ
          </button>
          <button
            onClick={clear}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs tracking-widest text-white/80 backdrop-blur-md transition hover:bg-white/10"
          >
            ОЧИСТИТЬ
          </button>
        </div>
      </div>

      {/* Bottom dock */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-5">
        <div className="pointer-events-auto flex flex-col gap-4 rounded-2xl border border-white/10 bg-black/40 p-4 backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {BRUSHES.map((b) => (
              <button
                key={b.id}
                onClick={() => setBrush(b.id)}
                className={`group rounded-xl border px-3 py-2 text-left transition ${
                  brush === b.id
                    ? "border-white/60 bg-white/10 text-white"
                    : "border-white/10 bg-white/[0.02] text-white/60 hover:bg-white/[0.06] hover:text-white/90"
                }`}
              >
                <div className="text-xs font-medium tracking-wider">{b.label}</div>
                <div className="text-[10px] text-white/40">{b.desc}</div>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-4 px-2">
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/50">
              Размер
              <input
                type="range" min={6} max={80} value={size}
                onChange={(e) => setSize(+e.target.value)}
                className="accent-white"
              />
              <span className="w-6 text-white/80">{size}</span>
            </label>
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/50">
              Цвет
              <input
                type="range" min={0} max={360} value={hue}
                onChange={(e) => { setHue(+e.target.value); hueRef.current = +e.target.value; }}
                className="flex-1"
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
