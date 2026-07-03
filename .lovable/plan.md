## Scope

Extend the existing drawing studio in `src/routes/index.tsx` without breaking current brushes, layers, history, export or pan/zoom. All additions are additive.

## 1. Tool system

Add a top-level `Tool` mode alongside brushes:

```
type Tool = "brush" | "select-rect" | "select-object" | "transform"
```

Sidebar toolbar (above brush list): Кисть, Ластик, Выделение, Выделение объекта, Свободная трансформация.

### Rectangular selection (`select-rect`)
- Drag creates world-space rect `{ x,y,w,h, layerId }`.
- Animated marching-ants overlay (dashed stroke, `lineDashOffset` in the existing RAF loop).
- Actions: Delete / Duplicate / Clear on selected region. Strokes hit by cached `bbox`; images by rectangle intersection.

### Object selection (`select-object`)
- Click picks top-most object under cursor in active layer:
  - Image: rect hit-test.
  - Stroke: expanded bbox → per-segment distance ≤ size/2.
- Selected object drawn with outline; supports Delete / Ctrl+D.

### Free transform (`transform`)
- Auto-enabled when an object/region is selected, or picked from toolbar.
- 8 scale handles + rotate handle above bbox. Drag inside = move; corner = uniform (Shift constrain); rotate handle = rotate around center.
- Applies affine transform to underlying data:
  - Image gains `rotation` (default 0); renderer uses `translate/rotate`.
  - Stroke points transformed by matrix; `size` scaled by average scale.
- Commit on pointer-up → single `pushHistory()` snapshot. Esc cancels.

## 2. Layer blend modes

Add `blendMode: GlobalCompositeOperation` to `Layer` (default `"source-over"`).

- `renderScene` and export renderer set `ctx.globalCompositeOperation = layer.blendMode` before drawing each layer's composite; reset after.
- Layers panel row gets a compact `<select>`:
  `normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity`.
- Included in `serializeLayers` for undo/redo.

## 3. Extended color palette

Replace lone hue slider with a full color picker; keep backward compatibility.

- State: `color: { h, s, l, a }`. Derive existing `hue` from `color.h`; extend brush code to read optional `hsl` on `Stroke` (falls back to current constants).
- New collapsible "Цвет" panel:
  - Canvas-based 2D saturation/lightness square + hue slider.
  - Alpha slider.
  - Hex + HSL numeric inputs.
  - Preset swatches (12) + user palette (up to 24, "Сохранить" adds current; right-click removes).
  - Eyedropper button: next canvas click samples pixel from composed scene.

## 4. Gradient brush

New `BrushKind: "gradient"`. Renders each stroke as a gradient-filled band along the path, animated over time.

- Stroke gains optional `gradient: { stops: [{ offset:0..1, h,s,l,a }, ...], angle: number, animate: boolean }`. Defaults: two stops derived from current color + complement, `angle=0`, `animate=true`.
- Renderer:
  - Builds a `CanvasGradient` per segment along the direction of travel (or across the stroke width for cross-stroke gradients — toggle via `angle`).
  - When `animate=true`, offsets are shifted by `(t * speed) % 1` each frame → flowing gradient. Uses the existing time-driven RAF; drives the dirty flag.
  - Uses `ctx.lineWidth = size`, `lineCap: "round"`, `strokeStyle = gradient` per short segment (segment length ≈ 24px so stops remain visible on curves).
- New UI in brush parameters when Gradient is active:
  - Stop editor (add/remove/reorder stops, each with color chip from the color picker).
  - Angle (0–360°) and animation speed sliders.
  - "Взять из палитры" quick-fill from preset palette.
- Included in serialization; snapshots without `gradient` fall back to defaults.

## Technical notes

- Files:
  - `src/routes/index.tsx` — wire new state and UI.
  - `src/lib/canvas-tools.ts` — `strokeBBox`, `hitTestStroke`, `transformPoint`, matrix builder, dash helper.
  - `src/lib/color.ts` — hsl↔hex↔rgb converters.
  - `src/components/color-picker.tsx` — canvas SL square + hue/alpha + swatches + eyedropper trigger.
  - `src/components/gradient-editor.tsx` — stops editor with color picker popover.
  - `src/components/tool-bar.tsx` — 5-button top-level tool selector.
- Renderer overlays for selection/transform are on-screen only; skipped in export renderer (kept clean for GIF/MP4/PNG).
- `serializeLayers` gains `blendMode`, stroke `hsl`, stroke `gradient`, image `rotation`. Missing fields default gracefully.
- History unchanged in shape (string snapshots); every new mutation goes through existing `pushHistory()`.
- Keyboard: `B` brush, `V` select-rect, `O` select-object, `T` transform; `Del` delete, `Ctrl+D` duplicate, `Esc` cancel.
- Non-breaking defaults: tool = `brush`, blend mode = `normal`, color = current hue 200 / s90 / l55 / a1, no `gradient` on old strokes → identical rendering for existing content.

## Deliverables

Updated `src/routes/index.tsx` plus the five new small modules above. No routing, export pipeline signature, or existing brush algorithm changes beyond the optional `hsl`/`gradient` reads.
