# Adna Blueprint Studio

Integrated Web front-end workbench for the blueprint flywheel — combining the **Blueprint Reroll Editor** and the **Asset & Palette Tagger** into a unified, standalone studio.

## Features

- **🗺️ Blueprint Editor (Reroll)**:
  - Full Canvas 2D overlay-parity viewer with role→color rendering.
  - Terrain brush (paint/erase, multi-size, dynamic matrix expansion).
  - Layer & object manipulation (move, resize `FIXED_RECT`, lock, reorder).
  - Deep Undo/Redo stack (`Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z`).
  - Palette pack integration (`.adnapalettepack`) and real-tile rendering.
  - Export to engine-compatible `adna-web-lite` JSON save files.
- **🏷️ Asset Tagger**:
  - Human review tool for palette role & style tagging.
  - Slices swatches out of contact sheets in `.adnatags` bundles.
  - Cascading role hierarchy tree and style tag filters.
  - Local progress auto-save & export to `final_tags.json`.

## Self-Contained Architecture

This repository is **completely standalone** and depends on no external repos:

1. **Role Palette Sync**: `vendor/blueprint_palette.h` is a committed snapshot of the engine header. `npm run generate` parses it into `src/reroll/generated/roleColors.ts` automatically prior to `dev` and `build`.
2. **Procedural Algorithms**: Inlined FastNoiseLite (`noise.ts`) and PRNG (`rng.ts`) under `src/shared/`, mapped via `@lib/*`.
3. **Bundled Samples**: Includes test blueprints and palette packs in `public/sample/` for instant out-of-the-box exploration.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run local development server
npm run dev
# -> http://localhost:5173

# 3. Production build
npm run build
# -> dist/
```

## Project Layout

```
blueprint_studio/
├── vendor/
│   └── blueprint_palette.h       # Engine role palette header snapshot
├── scripts/
│   ├── gen-role-colors.mjs       # Code generator for roleColors.ts
│   └── publish-pages.sh          # One-click GitHub Pages deployment
├── docs/                         # Specification & architecture docs
│   ├── TILEMAP_EDITOR_EVOLUTION_PLAN.md  # 演进总方案 (Master Plan)
│   ├── WEB_LITE_REROLL_EDITOR.md
│   ├── WEB_LITE_SCHEMA.md
│   └── WEB_ASSET_TAGGER_PLAN.md
├── public/
│   └── sample/                   # Sample blueprints and palette packs
└── src/
    ├── shared/                   # Procedural algorithms (noise, PRNG)
    ├── reroll/                   # Blueprint Editor (Canvas 2D, brush, undo)
    ├── tagger/                   # Asset Tagger (bundle reader, swatches)
    ├── App.tsx                   # Unified workbench tab switcher shell
    ├── main.tsx
    └── styles.css
```
