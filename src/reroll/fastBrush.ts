// fastBrush.ts — Fast Brush auto-targeting, Bresenham stroke interpolation,
// flood-fill, rect-fill, and per-tile multi-image stack inspection.

import {
  DEFAULT_FRG_PLACEMENT_MODE,
  assignUniqueObjectNames,
  createMapAlignedTerrain,
  displayName,
  isLocked,
  roleOf,
  setTerrainCell,
  type Layer,
  type LiteObject,
  type LiteTileMap,
  type LiteType,
} from "./model";
import { createCategoryLayer } from "./loadSave";
import { objectTypeForRole, roleRoot, stratumForRole } from "./roleTree";
import { PaletteMode, type Palette } from "./pack/types";

export type BrushToolId = "brush" | "eraser" | "rect" | "bucket" | "eyedropper" | "select";
export type BrushShape = "square" | "circle";
export type PropBrushStyle = "brush" | "stamp";

export interface ActiveBrushConfig {
  tool: BrushToolId;
  role: string;
  paletteHash: string | null;
  size: number;
  shape: BrushShape;
  /** When true, painting a cell in a category layer clears other objects' cells at (x,y) in the same category layer. Default false (stacking!). */
  replaceSameLayer: boolean;
  /** For fixed_rect roles (trees, rocks, props): "brush" paints into a FIXED_RECT_GROUP matrix; "stamp" places individual FIXED_RECTs. */
  propStyle: PropBrushStyle;
}

export interface TileStackItem {
  layerId: number;
  layerName: string;
  stratum: "ground" | "vertical";
  objectId: number;
  objectName: string;
  objectType: LiteType;
  role: string;
  paletteHash?: string;
  hasMatrix: boolean;
}

/** Bresenham 2D integer line points from (x0, y0) to (x1, y1) inclusive. */
export function bresenhamLine(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  let x = Math.round(x0);
  let y = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = Math.abs(bx - x);
  const sx = x < bx ? 1 : -1;
  const dy = -Math.abs(by - y);
  const sy = y < by ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x, y]);
    if (x === bx && y === by) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** Cells covered by a brush dab centered at (tx, ty), clamped to map bounds. */
export function brushFootprint(
  tx: number,
  ty: number,
  size: number,
  shape: BrushShape,
  mapW: number,
  mapH: number,
): [number, number][] {
  const out: [number, number][] = [];
  const r = Math.floor(size / 2);
  const rSq = (size / 2) * (size / 2);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (shape === "circle" && size >= 3 && dx * dx + dy * dy > rSq + 0.25) continue;
      const x = tx + dx;
      const y = ty + dy;
      if (x < 0 || y < 0 || x >= mapW || y >= mapH) continue;
      out.push([x, y]);
    }
  }
  return out;
}

export function targetLiteTypeForRole(role: string, propStyle: PropBrushStyle = "brush"): LiteType {
  if (role === "building/house") return "HOUSE";
  if (
    role.startsWith("terrain_decoration/path/bridge") ||
    role.startsWith("terrain_decoration/traversal") ||
    role.startsWith("building/")
  ) {
    return "FIXED_RECT";
  }
  const objType = objectTypeForRole(role);
  if (objType === "terrain_line") return "TERRAIN_2_EDGE";
  if (objType === "terrain_area") return "TERRAIN_2_CORNER";
  if (objType === "fixed_rect") {
    return propStyle === "stamp" ? "FIXED_RECT" : "FIXED_RECT_GROUP";
  }
  return "TERRAIN_2_CORNER";
}

export function isMatrixBrushType(t: LiteType): boolean {
  return t === "TERRAIN_2_CORNER" || t === "TERRAIN_2_EDGE" || t === "FIXED_RECT_GROUP";
}

export function targetLiteTypeForBrush(role: string, propStyle: PropBrushStyle, palette: Palette | null): LiteType {
  if (!palette?.tilesetId) return targetLiteTypeForRole(role, propStyle);
  if (palette.mode === PaletteMode.TWO_CORNER) return "TERRAIN_2_CORNER";
  if (palette.mode === PaletteMode.TWO_EDGE) return "TERRAIN_2_EDGE";
  return palette.mode === PaletteMode.FIXED_RECT && palette.size[0] === 1 && palette.size[1] === 1
    ? "FIXED_RECT_GROUP" : "FIXED_RECT";
}

export function ensureLayerForRole(map: LiteTileMap, role: string): Layer {
  const root = roleRoot(role) || "terrain";
  const existing = map.layers.find((l) => (l.tags["role.root"] || l.name) === root);
  if (existing) return existing;
  let maxLayerId = -1;
  for (const l of map.layers) maxLayerId = Math.max(maxLayerId, l.id);
  const created = createCategoryLayer(root, maxLayerId + 1, []);
  map.layers.push(created);
  return created;
}

function nextObjectId(map: LiteTileMap): number {
  let maxId = -1;
  for (const l of map.layers) {
    for (const o of l.objects) maxId = Math.max(maxId, o.id);
  }
  return maxId + 1;
}

function objectMatchesBrush(o: LiteObject, role: string, paletteHash: string | null, expectedType: LiteType): boolean {
  if (isLocked(o) || !o.enabled || o.type !== expectedType) return false;
  if (roleOf(o) !== role) return false;
  if (!paletteHash) return true;
  return objectUsesBrushPalette(o, paletteHash);
}

export function objectUsesBrushPalette(o: LiteObject, paletteHash: string): boolean {
  if (o.type === "FIXED_RECT_GROUP" && o.frg?.cells.length) return o.frg.cells.some((c) => c.palette === paletteHash);
  return o.tags["web.palette"] === paletteHash;
}

export interface ResolvedBrushTarget {
  layer: Layer;
  object: LiteObject;
  created: boolean;
}

/**
 * Find or create the target matrix object for a Fast Brush stroke:
 * 1. Currently selected object if it matches (role, type, palette);
 * 2. Top-most unlocked object in the category layer matching (role, type, palette);
 * 3. Create a new object in the category layer on the fly.
 */
export function resolveOrCreateBrushTarget(
  map: LiteTileMap,
  role: string,
  palette: Palette | null,
  propStyle: PropBrushStyle,
  selected: Set<number>,
  forceNew = false,
  origin: [number, number] = [0, 0],
  layerOverride?: Layer,
): ResolvedBrushTarget {
  const layer = layerOverride ?? ensureLayerForRole(map, role);
  const targetType = targetLiteTypeForBrush(role, propStyle, palette);
  const paletteHash = palette?.hash ?? null;

  if (!forceNew) {
    // 1. Check current selection first
    for (const id of selected) {
      const selObj = layer.objects.find((o) => o.id === id);
      if (selObj && isMatrixBrushType(selObj.type) && roleOf(selObj) === role && !isLocked(selObj)
        && (!palette?.tilesetId || selObj.type === targetType)) {
        if (!paletteHash || objectMatchesBrush(selObj, role, paletteHash, selObj.type)) {
          return { layer, object: selObj, created: false };
        }
      }
    }
    // 2. Search top-most matching object in the layer
    for (let i = layer.objects.length - 1; i >= 0; i--) {
      const candidate = layer.objects[i];
      if (objectMatchesBrush(candidate, role, paletteHash, targetType)) {
        return { layer, object: candidate, created: false };
      }
    }
  }

  // 3. Create new matrix object on demand
  const id = nextObjectId(map);
  const baseName = palette?.tilesetId ? palette.style || palette.label || role : role.split("/").slice(-1)[0] || role;
  const tags: Record<string, string> = {
    "blueprint.role": role,
    "web.baseName": baseName,
    "web.name": baseName,
  };
  if (palette?.style) tags["blueprint.style"] = palette.style;
  if (paletteHash && targetType !== "FIXED_RECT_GROUP") {
    tags["web.palette"] = paletteHash;
  }

  const geometry: Pick<LiteObject, "rect" | "terrain"> = targetType === "TERRAIN_2_CORNER" || targetType === "TERRAIN_2_EDGE"
    ? createMapAlignedTerrain(map)
    : {
        rect: [origin[0], origin[1], 1, 1],
        terrain: { ox: origin[0], oy: origin[1], w: 1, h: 1, data: Int16Array.of(-1) },
      };
  const createdObj: LiteObject = {
    id,
    type: targetType,
    enabled: true,
    tags,
    ...geometry,
    ...(targetType === "FIXED_RECT_GROUP" && paletteHash
      ? {
          frg: {
            cells: [{ palette: paletteHash, weight: 100 }],
            placementMode: DEFAULT_FRG_PLACEMENT_MODE,
          },
        }
      : {}),
  };

  layer.objects.push(createdObj);
  assignUniqueObjectNames(map);
  return { layer, object: createdObj, created: true };
}

/** Check if an object covers tile (tx, ty). */
export function objectCoversTile(o: LiteObject, tx: number, ty: number): boolean {
  if (!o.enabled) return false;
  if (o.terrain) {
    const t = o.terrain;
    const cx = tx - t.ox;
    const cy = ty - t.oy;
    if (cx < 0 || cy < 0 || cx >= t.w || cy >= t.h) return false;
    return t.data[cy * t.w + cx] >= 0;
  }
  const [rx, ry, rw, rh] = o.rect;
  return tx >= rx && ty >= ry && tx < rx + rw && ty < ry + rh;
}

/** Return the ordered stack of all visible objects covering tile (tx, ty), from bottom to top. */
export function inspectTileStack(map: LiteTileMap, tx: number, ty: number): TileStackItem[] {
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return [];
  const stack: TileStackItem[] = [];
  for (const layer of map.layers) {
    if (!layer.enabled) continue;
    const stratum: "ground" | "vertical" =
      layer.vertical || (layer.tags["role.stratum"] ?? stratumForRole(layer.name)) === "vertical"
        ? "vertical"
        : "ground";
    for (const o of layer.objects) {
      if (!objectCoversTile(o, tx, ty)) continue;
      const paletteHash =
        o.tags["web.palette"] ||
        (o.frg && o.frg.cells.length > 0 ? o.frg.cells[0].palette : undefined) ||
        o.house?.wall;
      stack.push({
        layerId: layer.id,
        layerName: layer.name,
        stratum,
        objectId: o.id,
        objectName: displayName(o),
        objectType: o.type,
        role: roleOf(o),
        paletteHash,
        hasMatrix: Boolean(o.terrain),
      });
    }
  }
  return stack;
}

/**
 * 4-neighbor flood fill on a terrain matrix object starting at (startX, startY).
 * Returns true if any cell changed.
 */
export function floodFillObjectTerrain(
  map: LiteTileMap,
  obj: LiteObject,
  startX: number,
  startY: number,
  present: boolean,
): boolean {
  if (startX < 0 || startY < 0 || startX >= map.width || startY >= map.height) return false;
  const startPresent = objectCoversTile(obj, startX, startY);
  if (startPresent === present) return false;

  const visited = new Uint8Array(map.width * map.height);
  const queueX = new Int32Array(map.width * map.height);
  const queueY = new Int32Array(map.width * map.height);
  let head = 0;
  let tail = 0;

  const startIdx = startY * map.width + startX;
  visited[startIdx] = 1;
  queueX[tail] = startX;
  queueY[tail] = startY;
  tail++;

  const cells: [number, number][] = [];
  while (head < tail) {
    const cx = queueX[head];
    const cy = queueY[head];
    head++;
    cells.push([cx, cy]);

    const neighbors: [number, number][] = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      const nIdx = ny * map.width + nx;
      if (visited[nIdx]) continue;
      if (objectCoversTile(obj, nx, ny) !== startPresent) continue;
      visited[nIdx] = 1;
      queueX[tail] = nx;
      queueY[tail] = ny;
      tail++;
    }
  }

  let changed = false;
  for (const [x, y] of cells) {
    if (setTerrainCell(obj, x, y, present)) changed = true;
  }
  return changed;
}
