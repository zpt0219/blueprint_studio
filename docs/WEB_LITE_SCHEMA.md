# WEB_LITE_SCHEMA — `adna-web-lite` save format

Current version is v4. The in-memory model lives in `src/reroll/model.ts`.
See `docs/WEB_LITE_REROLL_EDITOR.md` §4 for the lite profile.

This is the **web-owned** on-disk format the web editor exports. It is a readable
serialization of the lite TileMap — a documented subset of the desktop TileMap
document (`WEB_LITE_REROLL_EDITOR.md` §4: "web 不发明新格式,而是用 desktop
TileMap 文档的一个子集"). The web app writes this format; a desktop-side loader
(future pass) reads it and opens it **as a new map** using the mapping in §4.

It is intentionally **not** the desktop save format (`save_format.cpp`): no
base64 matrices, no `Recti` objects, no enum ints, no palettes. Those live only
on the desktop side; this format stays web-natural and human-diffable.

---

## 1. Top level

```jsonc
{
  "format": "adna-web-lite",   // magic string; loaders MUST check this
  "version": 4,
  "id": "c494d2187778557bd4b0fb70bfd38bbb", // optional stable map identity for drafts
  "name": "beach_village",     // display name
  "width": 112,                // canvas width in tiles
  "height": 64,                // canvas height in tiles
  "tileResolution": 32,        // map resolution in pixels per tile
  "pack": { "id": "palettes@1", "name": "palettes" }, // optional PalettePack reference
  "layers": Layer[]            // flat layer list, array order = draw order (see §2)
}
```

`width` and `height` record the current canvas size. `tileResolution` records the
map's pixel resolution and defaults to 16 for legacy files that omit it. The
preview samples tiles at the atlas's native resolution.

The web editor assigns `id` to new maps and derives it from the source content
when importing a file without an ID. The ID survives export and reopening under
a different filename. Browser drafts are keyed by that ID.

`pack` identifies the expected PalettePack. The web editor uses the pack
manifest's `packId` and `packVersion` as `id`, with an archive fingerprint for
packs that lack a manifest ID. If a different pack is active, the editor warns
and preserves the expected reference when exporting again.

The web model is a **flat ordered layer list, not a tree** — the blueprint's
layer tree is flattened on import (DFS pre-order; deep layers get a `parent/child`
name prefix). Array order **is** draw order: `layers[i]` draws under `layers[i+1]`.

## 2. Layer

```jsonc
Layer = {
  "name": "__BLUEPRINT__",
  "enabled": true,                             // ALWAYS present; hidden layers export enabled:false
  "tags": { "adna.kind": "blueprint", ... },   // optional; omitted when empty
  "objects": Object[]                          // this layer's objects, in draw order
}
```

When the map originated from a blueprint, **every exported layer carries
`tags["adna.kind"] = "blueprint"`** (stamped on export). On the desktop this makes
each a *blueprint root*, which renders the role→color overlay with **no palettes
required** (`desktop/src/panels/tilemap_view.cpp` `draw_blueprint_overlay`;
`isBlueprintRoot()` / default `BlueprintRenderMode::BLUEPRINT`, `src/core/layer.h`).
So an exported web map opens looking exactly like the web overlay.

`enabled` is exported verbatim — a layer hidden in the web editor exports
`enabled:false` and opens hidden on the desktop (desktop `Layer` has the field).

## 3. Object

```jsonc
Object = {
  "type":  "FIXED_RECT" | "TERRAIN_2_CORNER" | "TERRAIN_2_EDGE"
         | "FIXED_RECT_GROUP" | "DUNGEON" | "HOUSE",
  "rect":  [x, y, w, h],                       // origin + size, tile coords, w/h ≥ 1
  "enabled": true,
  "tags":  { "blueprint.role": "house", ... }, // role drives overlay color; web.lock etc. preserved
  "cells":  [[x, y], ...],   // TERRAIN_2_* and FIXED_RECT_GROUP only — present terrain cells (absolute)
  "points": [[x, y], ...],   // DUNGEON only — absolute border polygon
  "frg": { "placementMode": "free", "noise": { "seed": 0, "scale": 1, "range": [0, 1] },
           "cells": [{ "palette": "hash", "weight": 100 }] }, // optional FIXED_RECT_GROUP settings
  "house": { "wallHeight": 2, "overlap": 1, "wall": "hash", "roof": "hash",
             "decorations": [{ "kind": "door", "cell": [1, 0], "palette": "hash" }] } // HOUSE settings
}
```

- **Geometry by type**: `FIXED_RECT` uses `rect` only. `TERRAIN_2_*` and
  `FIXED_RECT_GROUP` carry `cells` for painted coordinates. Their `rect` gives
  the stored matrix extent, which can include empty cells. `DUNGEON` carries `points`.
- **`tags`** are copied verbatim, including `blueprint.role` / `blueprint.style` /
  `blueprint.label` and any unknown keys (e.g. `web.lock`) — forward-compatible
  round-trip (§4.5). Empty `tags` are omitted.

## 4. Mapping to the desktop save schema (for the future loader)

A desktop loader converts each field to the desktop save encoding (verified
against `src/serialize/json_codec.{h,cpp}`, `src/serialize/save_format.cpp`,
`src/object/tiled_object.h`):

| web-lite field | desktop save encoding |
|---|---|
| `type` (string) | `TiledObject::Type` int: `FIXED_RECT=1`, `DUNGEON=10`, `TERRAIN_2_CORNER=11`, `TERRAIN_2_EDGE=12`, `FIXED_RECT_GROUP=15` |
| `rect: [x,y,w,h]` | `Recti` `{minX:x, minY:y, maxX:x+w-1, maxY:y+h-1}` (inclusive) |
| `cells: [[x,y]…]` | `Int16Matrix` over the stored `rect`: present cell = `0`, empty = `-1`; serialized `{width,height,data_b64}` (base64 of row-major little-endian int16) |
| `points: [[x,y]…]` | `borderPoints`, **object-local** (subtract `rect` origin) |
| `tags` | object tags, verbatim |
| `name`/`width`/`height`/`tileResolution` | `tilemap.{width,height,tileResolution}`; layer/object `name` |
| `layers` (flat, ordered) | `tilemap.layers` — the web layers become **sibling** top-level layers under the desktop root, same order |
| `enabled` (per layer) | desktop `Layer::enabled`, verbatim (hidden stays hidden) |
| per-layer `tags["adna.kind"]="blueprint"` | blueprint-root flag → overlay render mode |

The loader emits the desktop root `{ "tilemap": { formatVersion, width, height,
tileResolution, palettes: [], layers: [<converted layers…>] } }` (handler
context keys default — old files with only `tilemap` still load). The flat web
`layers` map directly to `tilemap.layers` siblings in the same order. Objects need
no palette; the blueprint overlay renders from `blueprint.role` tags.

For `FIXED_RECT_GROUP`, object-level `cells` reconstruct the terrain matrix and
optional `frg` supplies the scatter settings. The proposed desktop mapping above
covers the original overlay profile. A desktop loader also needs mappings for
`HOUSE` and the optional appearance settings if it imports them.

## 5. Versioning

The web editor reads v1 through v4 and exports v4. It ignores unknown fields and
reports unsupported versions when opening a file. The `id` and `pack` fields are
optional so older saves can be opened directly.
