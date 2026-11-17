# Vista 3D: formas realistas, partes y desgaste visible — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 3D preview look like the user's real maps and make the edge wear visible:
- the wall with openings becomes one face per side, with frames and columns;
- the user chooses which parts of the shape get the texture;
- the walls preset keeps bricks within 10 % of their real size;
- the default wear reaches about half a piece;
- the 3D view reads a 2048 px atlas.

**Architecture:**
- Core:
  - test shapes gain named parts and faces with holes;
  - the walls preset is rebuilt against a pure-core scale test;
  - structure analysis gains a piece-size measure that drives a wear-size proposal, with the same propose-unless-user-set pattern as `proposeFamily`.
- Web:
  - the 3D view triangulates faces with holes and paints untextured parts with a neutral material;
  - it reads its own 2048 px composition when the preview is lower.

**Tech Stack:** TypeScript, Vitest, React 18, zustand, three@0.170.0, WebGPU engine, Playwright (headless Chrome).

**Spec:** `docs/superpowers/specs/2026-11-16-vista3d-formas-y-desgaste-design.md` (approved 2026-11-16). Read it before any task.

## Global Constraints

- Product rules in CLAUDE.md hold, especially rule 1 (proportions) and rule 2 (single height field).
- UI text in Spanish; code and comments in English.
- Matching stays ProBuilder's (`matchHotspot`, decision 79). Only geometry, parts and the preset change.
- Presets are guillotine trees on an 8 m × 8 m atlas in whole cm (`packages/core/src/presets.ts`). A `tileU`/`tileV` rect must span the whole atlas (`validateLayout`, layout.ts:68).
- Storey height is **2.6 m**.
- Brick scale tolerance is **≤ 10 %** on both axes for every face covered by Task 2's scale test.
- The default wear reach is half a piece. The result is measured, not assumed (Task 3).
- Projects saved before this change keep their wear reach and break size.
- The 3D view still draws on demand, pauses while hidden, and reads back as decision 80 says.
- `view3d` settings, including the parts choice, live in `localStorage['hs.view3d']`. They are not part of the project and not tracked as dirty.
- New decisions start at **#85** in `docs/09-decisions.md`.
- three stays pinned at 0.170.0. No new dependencies.

## Review Focus

1. Opening a `.hsp` saved before this change leaves `widthM`/`sizeM` exactly as saved (Task 3 test).
2. A material without pieces (continuous or directional) keeps the fixed reach of 0.04 and break size of 0.03 (Task 3 test).
3. Replacing the material after the user edited the reach keeps the user's value (Task 3 test).
4. All parts toggled off: the shape renders fully neutral, with no errors, and texture readbacks keep working (Task 4 test).
5. Preview resolution already at 2048: the 3D view uses the preview atlas and does not compose a second time (Task 5 test).

---

### Task 1: Test shapes with parts, holes, frames and columns (core)

**Files:**
- Modify: `packages/core/src/fit/shapes.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/shapes.test.ts`

**Interfaces:**
- Produces:

```ts
export type ShapePart = 'body' | 'wall' | 'columns' | 'frames' | 'skirting' | 'floor' | 'ceiling';
export interface ShapeFace {
  quad: FaceQuad; corners: [Vec3, Vec3, Vec3, Vec3]; normal: Vec3;   // unchanged meaning
  part: ShapePart;
  /** Openings cut through the face, as local rects [s0, t0, s1, t1] in metres (s along corners[0]→[1], t along [0]→[3]). */
  holes?: [number, number, number, number][];
}
export const SHAPE_PARTS: Record<TestShape, readonly ShapePart[]>;   // parts present in each shape, in UI order
export const STOREY_HEIGHT_M = 2.6;
```

Geometry (metres):
- **cube, column, stairs:** unchanged geometry. Every face is part `body`.
- **wallWithOpenings:**
  - Overall 4 × 2.6 × 0.2.
  - Door 1 × 2.1 at x −1.5…−0.5. Window 1.2 × 1 at x 0.2…1.4, sill at 1.
  - Front (+Z) and back (−Z) are **one face each** with two `holes`, part `wall`.
  - The ends, the top, and the bottom quads either side of the door are part `wall`.
  - No wall reveals are generated; the frames line the openings.
  - **Frames** (part `frames`) on every opening:
    - 0.09 m wide on each wall face, 0.025 m proud of each face.
    - They line the full depth of the opening: 4 sides on the window, 3 on the door (no bottom).
    - The lining faces point into the opening.
    - The frame's front faces, outer edges and lining are all generated, so no gap shows between wall and frame.
  - **Columns** (part `columns`):
    - One at each end, on the front side only.
    - Each is 0.35 wide, 0.15 proud and 2.6 tall.
    - Front and two side faces; the back sits against the wall and is not generated.
    - The top is generated, the bottom is not.
- **corridor:**
  - 2 wide × **2.6** high × 6 long, open ends, normals inward (as today).
  - Floor is part `floor`, ceiling `ceiling`, walls `wall`, skirtings (front and top) `skirting`.
  - **Columns** (part `columns`): 3 per wall, centred at z = −2, 0 and 2, with the same 0.35 × 0.15 section from floor to ceiling.
    - The face toward the corridor and the two side faces are generated, normals into the corridor.
    - Skirtings are split around the columns so they never overlap a column.
- `SHAPE_PARTS`:
  - cube, column, stairs: `['body']`
  - wallWithOpenings: `['wall', 'columns', 'frames']`
  - corridor: `['wall', 'columns', 'skirting', 'floor', 'ceiling']`

- [ ] **Step 1: Write the failing tests** in shapes.test.ts. Keep the existing generic checks for every face: rectangle, winding, v axis, no coplanar overlap, and membership on solid shapes. Adapt membership to faces with holes, where points inside a hole are air.
  - `wallWithOpenings` has exactly 2 faces of size 4 × 2.6 (normals ±Z), each with 2 holes: `[0.5, 0, 1.5, 2.1]` and `[2.2, 1, 3.4, 2]` in local metres. The back face's s axis runs the other way; assert its holes mirrored accordingly.
  - Pin the face counts per part and comment each count.
  - Every face of `frames` and `columns` has `part` set. No face of part `wall` lies inside an opening's lining volume.
  - Corridor wall faces are 6 × 2.6. Every corridor column front face is 0.35 × 2.6 and every side face is 0.15 × 2.6.
  - `SHAPE_PARTS` equals the lists above, and every face's part is listed for its shape.
  - The area check of today's wall test becomes: front area = 4·2.6 − 2.1 − 1.2.
- [ ] **Step 2:** Run `npm test -w @hotspotter/core`. Expected: FAIL.
- [ ] **Step 3:** Implement. `rect()` gains a `part` argument. Holes are given in the face's local (s, t) frame.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Web code that builds faces still compiles: `part` is required, `holes` optional.
- [ ] **Step 5:** Commit `feat(core): test shapes with parts, holes, frames and columns`.

### Task 2: Walls preset within 10 % brick scale (core + docs)

**Files:**
- Modify: `packages/core/src/presets.ts`, `apps/web/src/i18n/es.ts` (preset tooltip), the component that renders the preset Select (find it with grep for `presets:` in es.ts usage), `docs/03-material-and-layout.md`, `docs/09-decisions.md`
- Test: `packages/core/test/presetScale.test.ts` (new)

**Interfaces:**
- Consumes:
  - `buildShape`, `SHAPE_PARTS` and `STOREY_HEIGHT_M` from Task 1;
  - `fitFaces(faces, layout, rotations, {seed, runoff})` (packages/core/src/fit/fitFaces.ts);
  - `presetLayout`, or however presets build a `HotspotLayout`: grep presets.ts for the exported builder.
- Produces:
  - `export function faceBrickScale(face: ShapeFace, fit: HotspotFit, layout: HotspotLayout): [number, number]`, in `packages/core/src/fit/scale.ts` and exported from index. It returns the ratio of face metres to rect metres along the face's two axes. A tiled axis counts as 1.
  - The rebuilt `walls` preset.

**Scale definition:**
- Per face axis, use the rect's metres along the atlas axis that face axis maps to (honour `fit.rotated`), with metres per px = `worldWidthM / widthPx`.
- Ratio = face metres / rect metres. A face axis along the fit's tiling axis is 1.

**Faces covered:** every face with `useOn === 'walls'` in parts `wall`, `columns` or `body`, of the shapes `cube`, `wallWithOpenings` and `corridor`, plus the cube's top face.

- [ ] **Step 1: Write the failing test.** Build the walls preset at 2048 px. For each covered face, compute `fitFaces` with seeds 0..7 and runoff false and true. Assert `Math.abs(r − 1) <= 0.10` for both ratios. On failure, print shape, face index, rectId and ratios.
  - Keep `validateLayout(preset)` free of issues.
  - The existing `presets.test.ts` checks still pass.
- [ ] **Step 2:** Run it. Expected: FAIL. Today the cube's ratio is about 0.71 and the corridor walls stretch.
- [ ] **Step 3: Rebuild `walls`** in presets.ts until the test passes.
  - Use guillotine bands in whole cm that sum to 800 on both axes.
  - Include a 260 cm storey band.
  - Include pillar rects of 35 × 260 and 15 × 260.
  - Include a 200 × 200 rect for the cube.
  - Keep the `half`, `tile` and `wall` groups so docs/03's group names still hold.
  - Avoid any rect that lands within ±25 % but more than 10 % off a covered face, because step 1 of the matcher would pick it.
  - Choose between a `tileU` storey strip and fixed rects as the spec's builder note says. Record the chosen layout and why in a new decision #85.
- [ ] **Step 4:** Docs:
  - docs/03 gets a short Spanish section, "Modelar para el hotspot de paredes": storey height 2.6 m, pillars about 35 cm wide, and why (the hotspot matches by size; walls far from these sizes stretch the texture).
  - Add a tooltip to the walls preset option in the UI, in Spanish, saying the preset is meant for walls about 2.6 m tall.
- [ ] **Step 5:** Run `npm test`. Expected: PASS. Then run `npx playwright test e2e/view3d e2e/app --workers=1` from apps/web. Expected: PASS; if a test pins old rect ids, update its expected ids and say so in the report.
- [ ] **Step 6:** Commit `feat(core): walls preset keeps brick scale within 10 %`.

### Task 3: Wear size proposed from the piece size

**Files:**
- Create: `packages/core/src/structure/pieceSize.ts`
- Modify:
  - `packages/core/src/wear/params.ts`
  - `packages/core/src/document.ts` (parseDoc migration)
  - `packages/core/src/index.ts`
  - `apps/web/src/state/store.ts` (`withProposedFamily` call sites)
  - `apps/web/src/panels/WearSection.tsx`
  - `docs/04-wear.md`
  - `docs/09-decisions.md`
- Test: `packages/core/test/pieceSize.test.ts` (new), `packages/core/test/document.test.ts`, `apps/web/e2e/wear.spec.ts`

**Interfaces:**
- Produces:

```ts
// structure/pieceSize.ts
export function medianPieceSizeM(r: StructureResult, tileSizeM: [number, number]): { longM: number; shortM: number } | null;
// wear/params.ts
export interface WearParams { /* … */ userSetWearSize?: boolean }   // true once the user edits widthM or sizeM
export function proposeWearSize(piece: { longM: number; shortM: number } | null): { widthM: number; sizeM: number };
```

- **`medianPieceSizeM`:**
  - Returns null unless `r.type === 'pieces'` and at least 4 pieces don't touch the image border.
  - Otherwise it returns the medians, over those pieces, of their pixel bounding-box long and short sides, converted to metres with `tileSizeM / [width, height]` per axis.
- **`proposeWearSize`:**
  - With a null piece size it returns `{ widthM: 0.04, sizeM: 0.03 }`, the current defaults.
  - Otherwise it returns `widthM = 0.5·longM` and `sizeM = 0.6·shortM`.
  - If Step 1's measured test fails with these factors, adjust the `sizeM` factor (and, if needed, propose `intensity`; never change `widthM`'s 0.5). Record the final factors in decision #86.
- **`DEFAULT_WEAR` and `defaultWear()`** gain `userSetWearSize: false` explicitly, so new saves carry the key.
- **parseDoc migration:** a saved wear node **without** the `userSetWearSize` key gets `true`, so pre-change projects keep their values. Do this before `normalizeNodes` merges the defaults. parseDoc is only called on opened `.hsp` files (hsp.ts:76).
- **Store:** `withProposedFamily` becomes `withProposedWear(doc, type, materialName, pieceSize)`.
  - It applies the family as before.
  - It sets `widthM`/`sizeM` from `proposeWearSize` unless `userSetWearSize` is true.
  - Update every call site (store.ts:443, 770, 985, 1038) and pass `medianPieceSizeM(result, tileSizeM)` where a structure result exists, or null otherwise.
- **WearSection:** editing Alcance (`widthM`) or Tamaño de rotura (`sizeM`) sets `userSetWearSize: true`, as the family Select does with `userSetFamily`.

- [ ] **Step 1: Write the failing tests.**
  - Core:
    - `medianPieceSizeM` on a synthetic 4×8 brick grid. Piece 20 × 6.5 cm with 1 cm joints on a 1 m tile gives longM ≈ 0.20 ± 0.01 and shortM ≈ 0.065 ± 0.01.
    - A `continuous` result gives null.
    - `proposeWearSize(null)` deep-equals `{ widthM: 0.04, sizeM: 0.03 }`.
    - `proposeWearSize({longM: 0.2, shortM: 0.065}).widthM` is 0.1.
  - Core, document.test:
    - A doc JSON whose wear params lack `userSetWearSize` parses with `userSetWearSize === true` and `widthM`/`sizeM` unchanged.
    - A doc with `userSetWearSize: false` keeps false.
  - e2e, wear.spec, at previewRes 2048 with bricks wall 13:
    - (a) After import, `widthM` equals `0.5 × medianPieceSizeM.longM` (read through the store hook).
    - (b) **Measured breakage:**
      - Take the largest `group: 'wall'` rect and read back its wearMask.
      - Scan perpendicular to its four edges, but only scanlines within `longM` of a rect corner. For each scanline, take the inward distance in metres to the first pixel with wearMask < 128, capped at `longM`.
      - Assert the median is between 0.25·longM and 0.75·longM, and the 90th percentile is ≥ 0.4·longM.
    - (c) The coverage and islands checks are not `error`.
    - (d) Edit Alcance, replace-import the same folder, and Alcance keeps the edited value.
    - (e) Save a project, edit its saved JSON to remove `userSetWearSize` and set `widthM: 0.04`, open it, and `widthM` stays 0.04. Use project.spec's helpers for writing and opening `.hsp` files.
    - (f) Importing a continuous material (find a non-pieces sample used in other specs) keeps `widthM` at 0.04.
- [ ] **Step 2:** Run the core and e2e tests. Expected: FAIL. Before the change, (b) gives a median of about 0.2·longM or less.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test` and `npx playwright test e2e/wear e2e/project e2e/checks --workers=1`. Expected: PASS.
- [ ] **Step 5:** Docs. docs/04 explains that the default reach comes from the piece size, and when the user's value wins. Record decision #86 with the final factors and the migration rule.
- [ ] **Step 6:** Commit `feat: propose wear reach and break size from the piece size`.

### Task 4: Parts and faces with holes in the 3D view

**Files:**
- Modify:
  - `apps/web/src/viewport/three/scene.ts`
  - `apps/web/src/viewport/View3D.tsx`
  - `apps/web/src/state/store.ts` (View3dSettings, sanitize)
  - `apps/web/src/i18n/es.ts`
  - `docs/05-ui.md`
- Test: `apps/web/e2e/view3d.spec.ts`

**Interfaces:**
- Consumes: `ShapeFace.part` and `holes`, plus `SHAPE_PARTS` (Task 1).
- Produces:
  - `View3dSettings.textured: Record<ShapePart, boolean>`. The default is true for everything except `frames` and `skirting`. It is sanitised and persisted in `hs.view3d`; an old stored value without the key falls back to the default.
  - `View3DScene.setShape(faces, fits, layout, textured: Record<ShapePart, boolean>)`.
  - `View3DScene.setTextured(textured)`, which swaps materials only and does not rebuild the geometry.

Rendering:
- **Faces with holes:**
  - Triangulate in the face's local (s, t) frame with `THREE.ShapeUtils.triangulateShape(contour, holes)`.
  - Positions are `corners[0] + s·û + t·v̂`.
  - uv is bilinear from the four corner uvs at (s/w, t/h). The fit is axis-aligned, so this is exact.
- **Parts that are not textured:**
  - Use one shared `MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.85, metalness: 0 })` in every mode.
  - In unlit map modes, use flat mid grey through the existing `hasMap=false` path.
  - Their rect outlines are hidden in `rects` mode.
- **Toolbar:**
  - A compact "Partes" dropdown with one checkbox per part of the current shape, in `SHAPE_PARTS` order.
  - Spanish labels: body "Cuerpo", wall "Pared", columns "Columnas", frames "Marcos", skirting "Rodapié", floor "Suelo", ceiling "Techo".
  - The toolbar stays on one row (the existing 1600×900, 50 % split assertion).

- [ ] **Step 1: Write the failing tests** in view3d.spec.
  - "Pared con huecos" in lit mode:
    - `__hs.view3d.faces()` reports exactly 2 faces with normal ±Z of part `wall`.
    - A screen pixel through the window hole shows the background colour.
  - Default parts:
    - Frames are neutral, so the mean of a frame face's screen pixels is within 12 levels of the neutral grey render. Find a frame face through `faces()`.
    - Turning "Marcos" on changes that face's mean by more than 12.
    - The choice survives a reload, and `dirty` stays false.
  - Review Focus 4: turn every part off. No console errors; the canvas is non-blank and uniform grey on the shape; after a recomposition `view3dTextureGen` still rises.
  - The toolbar is still on one row.
- [ ] **Step 2:** Run `npx playwright test e2e/view3d --workers=1` from apps/web. Expected: FAIL.
- [ ] **Step 3:** Implement. `faces()`, the debug hook, gains `part`.
- [ ] **Step 4:** Run `npx playwright test e2e/view3d e2e/ui --workers=1`. Expected: PASS.
- [ ] **Step 5:** docs/05: describe parts and their defaults, and add decision #87 (parts are view state in `hs.view3d`; neutral material values).
- [ ] **Step 6:** Commit `feat(web): 3d view parts and faces with holes`.

### Task 5: The 3D view reads a 2048 px atlas

**Files:**
- Modify:
  - `apps/web/src/state/store.ts`
  - `apps/web/src/viewport/View3D.tsx`
  - `docs/09-decisions.md` (decision 80 note and #88)
  - `docs/05-ui.md`
- Test: `apps/web/e2e/view3d.spec.ts`

**Interfaces:**
- Produces:
  - `export const VIEW3D_RES = 2048` in store.ts.
  - Store fields `view3dAtlas: AtlasResult | null` and `view3dVisible: boolean`, plus the action `setView3dVisible(v: boolean)`.
  - **When `previewRes >= VIEW3D_RES`:** `view3dAtlas` is the preview `atlas` itself. No extra compose.
  - **Otherwise:**
    - After each committed preview compose, and only while `view3dVisible`, compose once at `VIEW3D_RES` from the same inputs (`composeInputFor`, same layout and placements scaled by `resolveLayout` at that width).
    - Use a new generation counter, `compose3dGen`. It must submit before its first await, like composeAtlas.
    - Swap `view3dAtlas` in place, then destroy the previous 3D maps (never the preview's).
    - The 3D compose is superseded by a newer preview compose, by open or Nuevo, and by hiding the pane.
    - Open and Nuevo set `view3dAtlas: null` and destroy its maps as they do the preview's.
- View3D reads `view3dAtlas` instead of `atlas`, and calls `setView3dVisible` from its existing ResizeObserver visibility.

- [ ] **Step 1: Write the failing tests** in view3d.spec.
  - At previewRes 1024, the 3D texture set's baseColor is 2048 wide. Expose `__hs.view3d.textureWidth`.
  - Maximize the atlas pane (3D hidden), change the wear seed: no 3D compose happens. Expose `__hs.compose3dCount` and assert it does not change. Restore: one compose, then textures at 2048.
  - Review Focus 5: set previewRes to 2048. `compose3dCount` does not change across a recomposition, and `view3dAtlas === atlas`.
  - After 5 seed changes, the module-level live texture count and GPU texture count return to their values from before the changes. This is the existing leak pattern in view3d.spec.
  - structure.spec's "does not block the main thread" test still passes.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test` and `npx playwright test e2e/view3d e2e/structure e2e/project e2e/ui --workers=1`. Expected: PASS.
- [ ] **Step 5:** Docs: decision #88 (why 2048; the extra GPU memory, about 6 × 16 MiB; that hidden means no compose) and a note on decision 80. Update docs/05.
- [ ] **Step 6:** Commit `feat(web): 3d view composes at 2048 px`.

### Task 6: Docs and closing

**Files:**
- Modify: `docs/02-architecture.md` (only if Task 5 changed the data flow it describes), `docs/05-ui.md`, `docs/10-roadmap.md`, `docs/11-test-bench.md` (only if the bench outputs changed)

- [ ] **Step 1: Update docs/10.**
  - Mark these done: the floor-height strip and the pillar strip for the walls preset, the wall with openings in one piece, frames, columns, parts, and the wear proposal.
  - Leave v0.1-D with the `.exe` and the update notices.
- [ ] **Step 2: Verify everything.** Run `npm test`, the full `npx playwright test --workers=1` (in spec-file chunks if needed), `npm run build` and `npm run bench`.
  - Expected: everything passes, and the bench is 7/7 with no check in error.
  - The bench may change because of the new wear defaults. Report any visual or numeric change per set.
- [ ] **Step 3:** Commit `docs: 3d shapes, parts and wear proposal`.
