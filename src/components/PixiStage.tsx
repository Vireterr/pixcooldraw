// PixiStage.tsx
//
// Scaffold for the future migration of the drawing engine to GPU/WebGL rendering
// via PixiJS. This component ONLY wires up a PixiJS Application and mounts its
// canvas into the React tree — it does not touch, read, or replace any of the
// existing drawing tools, UI, or pixel-buffer logic in `routes/index.tsx`.
//
// Rendered inert (pointer-events disabled, not visually intrusive) so it has zero
// effect on the current app behavior. Future work can:
//   - grab `app.current` from the ref this component exposes via `onReady`
//   - create a PIXI.Texture from the existing RGBA pixel buffer each frame
//   - draw it as a single full-canvas PIXI.Sprite instead of `ctx.putImageData`
//
// See the module-level comment in routes/index.tsx (search "PixiStage") for the
// planned integration point.

import { useEffect, useRef } from "react";
import { Application } from "pixi.js";

export interface PixiStageProps {
  /** Logical width of the stage, in CSS pixels. Independent of the drawing canvas size for now. */
  width: number;
  /** Logical height of the stage, in CSS pixels. */
  height: number;
  /** Called once the PixiJS Application has finished initializing. */
  onReady?: (app: Application) => void;
  /** Set true to render the Pixi canvas visibly (debug only). Defaults to hidden/inert. */
  debugVisible?: boolean;
}

/**
 * Mounts a PixiJS (v8) Application inside a div and keeps it sized to
 * `width`/`height`. Does not render anything on top of it — that's left to
 * future code that pushes the pixel buffer into a texture/sprite via `onReady`.
 */
export function PixiStage({ width, height, onReady, debugVisible = false }: PixiStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    const app = new Application();
    appRef.current = app;

    app
      .init({
        width,
        height,
        backgroundAlpha: 0,
        antialias: false,
        // WebGL preferred; PixiJS v8 falls back automatically if unavailable.
        preference: "webgl",
      })
      .then(() => {
        if (cancelled) {
          // Component unmounted while init() was in flight — tear down immediately.
          app.destroy(true, { children: true, texture: true });
          return;
        }
        host.appendChild(app.canvas);
        onReady?.(app);
      })
      .catch((err) => {
        console.error("[PixiStage] failed to initialize PixiJS application:", err);
      });

    return () => {
      cancelled = true;
      if (appRef.current) {
        try {
          appRef.current.destroy(true, { children: true, texture: true });
        } catch {
          // already destroyed
        }
        appRef.current = null;
      }
    };
    // Intentionally init once per mount; resizing is handled in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep an already-initialized renderer in sync with size changes.
  useEffect(() => {
    appRef.current?.renderer?.resize(width, height);
  }, [width, height]);

  return (
    <div
      ref={hostRef}
      data-pixi-stage=""
      style={
        debugVisible
          ? { position: "absolute", inset: 0 }
          : {
              position: "absolute",
              inset: 0,
              width: 0,
              height: 0,
              overflow: "hidden",
              pointerEvents: "none",
              opacity: 0,
            }
      }
    />
  );
}
