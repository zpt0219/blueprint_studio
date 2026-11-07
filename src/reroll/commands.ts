// commands.ts — simplified command model + undo stack (WEB_LITE_REROLL_EDITOR.md §9).
// Each command captures its target by id at construction (ADR-003 spirit: capture
// at init, resolve by id in do/undo — never re-read live selection).

import {
  DEFAULT_FRG_PLACEMENT_MODE,
  cloneTerrain,
  cloneObjectDeep,
  findLayer,
  findObject,
  type FrgCellData,
  type FrgPlacementMode,
  isLocked,
  translateObject,
  type HouseDecoration,
  type LiteObject,
  type LiteTileMap,
  type LiteType,
  type Rect,
  type TerrainMatrix,
} from "./model";
import { resizeHouse } from "./house";

export interface Command {
  label: string;
  do(): void;
  undo(): void;
}

export class UndoStack {
  private undoArr: Command[] = [];
  private redoArr: Command[] = [];

  /** Run a command and record it (clears the redo branch). */
  push(c: Command): void {
    c.do();
    this.undoArr.push(c);
    this.redoArr = [];
  }
  undo(): void {
    const c = this.undoArr.pop();
    if (c) { c.undo(); this.redoArr.push(c); }
  }
  redo(): void {
    const c = this.redoArr.pop();
    if (c) { c.do(); this.undoArr.push(c); }
  }
  get canUndo(): boolean { return this.undoArr.length > 0; }
  get canRedo(): boolean { return this.redoArr.length > 0; }
}

function setPosition(map: LiteTileMap, id: number, x: number, y: number): void {
  const o = findObject(map, id);
  if (o) translateObject(o, x - o.rect[0], y - o.rect[1]);
}

/** Move an object from `before` to `after` (top-left tile coords). */
export function moveObjectCommand(
  map: LiteTileMap,
  id: number,
  before: [number, number],
  after: [number, number],
): Command {
  return {
    label: "Move",
    do: () => setPosition(map, id, after[0], after[1]),
    undo: () => setPosition(map, id, before[0], before[1]),
  };
}

/**
 * Move several objects together by one (dx,dy) delta (group move). Captures the
 * id list + delta; do/undo translate every still-present member. One drag = one
 * undo. The caller is responsible for clamping the delta so the group stays on
 * the map (see CanvasView).
 */
export function moveObjectsCommand(map: LiteTileMap, ids: number[], dx: number, dy: number): Command {
  const shift = (sx: number, sy: number) =>
    ids.forEach((id) => { const o = findObject(map, id); if (o) translateObject(o, sx, sy); });
  return { label: "Move", do: () => shift(dx, dy), undo: () => shift(-dx, -dy) };
}

/** Resize an object's rect (FIXED_RECT). Captures target by id. */
export function resizeObjectCommand(map: LiteTileMap, id: number, before: Rect, after: Rect): Command {
  const set = (r: Rect) => {
    const o = findObject(map, id);
    if (!o) return;
    if (o.type === "HOUSE" && o.house) o.house = resizeHouse(o.house, o.rect, r);
    o.rect = [...r];
  };
  return { label: "Resize", do: () => set(after), undo: () => set(before) };
}

export function setObjectRectCommand(
  map: LiteTileMap,
  id: number,
  beforeRect: Rect,
  afterRect: Rect,
  beforeTerrain?: TerrainMatrix,
  afterTerrain?: TerrainMatrix,
): Command {
  const set = (rect: Rect, terrain?: TerrainMatrix) => {
    const o = findObject(map, id);
    if (!o) return;
    if (terrain) o.terrain = cloneTerrain(terrain);
    if (o.type === "HOUSE" && o.house) o.house = resizeHouse(o.house, o.rect, rect);
    o.rect = [...rect];
  };
  return {
    label: "Set rect",
    do: () => set(afterRect, afterTerrain),
    undo: () => set(beforeRect, beforeTerrain),
  };
}

function setLock(map: LiteTileMap, id: number, locked: boolean): void {
  const o = findObject(map, id);
  if (!o) return;
  if (locked) o.tags["web.lock"] = "true";
  else delete o.tags["web.lock"];
}

/** Toggle an object's lock to `locked` (lock = a `web.lock` tag). */
export function toggleLockCommand(map: LiteTileMap, id: number, locked: boolean): Command {
  return {
    label: locked ? "Lock" : "Unlock",
    do: () => setLock(map, id, locked),
    undo: () => setLock(map, id, !locked),
  };
}

/** Lock state of an id (helper for toolbar wiring). */
export function lockedOf(map: LiteTileMap, id: number): boolean {
  const o = findObject(map, id);
  return o ? isLocked(o) : false;
}

/**
 * Show/hide several objects at once (per-object `enabled`). Captures each id's
 * prior state so undo restores a mixed selection exactly. Hidden objects drop
 * out of render + hit-test (eachVisibleObject) but stay in the layer list.
 */
export function setObjectsEnabledCommand(map: LiteTileMap, ids: number[], enabled: boolean): Command {
  const before = ids.map((id) => findObject(map, id)?.enabled ?? true);
  const set = (id: number, v: boolean) => { const o = findObject(map, id); if (o) o.enabled = v; };
  return {
    label: enabled ? "Show" : "Hide",
    do: () => ids.forEach((id) => set(id, enabled)),
    undo: () => ids.forEach((id, i) => set(id, before[i])),
  };
}

/** Rename an object's display name (the `web.name` tag; empty clears it). */
export function renameObjectCommand(map: LiteTileMap, id: number, before: string, after: string): Command {
  const set = (name: string) => {
    const o = findObject(map, id);
    if (!o) return;
    if (name) o.tags["web.name"] = name; else delete o.tags["web.name"];
  };
  return { label: "Rename", do: () => set(after), undo: () => set(before) };
}

/** Change a terrain object's autotile type (e.g. fix a 2-edge/2-corner mislabel).
 *  Geometry (the cell matrix) is unchanged; the bound palette is re-resolved. */
export function setObjectTypeCommand(map: LiteTileMap, id: number, before: LiteType, after: LiteType): Command {
  const set = (t: LiteType) => { const o = findObject(map, id); if (o) o.type = t; };
  return { label: "Change type", do: () => set(after), undo: () => set(before) };
}

/** Force a specific pack palette on an object (the `web.palette` tag), or clear
 *  it (undefined) to fall back to automatic role resolution. */
export function setObjectPaletteCommand(map: LiteTileMap, id: number, before: string | undefined, after: string | undefined): Command {
  const set = (hash: string | undefined) => {
    const o = findObject(map, id);
    if (!o) return;
    if (hash) o.tags["web.palette"] = hash; else delete o.tags["web.palette"];
  };
  return { label: after ? "Set palette" : "Reset palette", do: () => set(after), undo: () => set(before) };
}

/** Move a house decoration slot to a new (already-clamped) local cell. */
export function moveHouseDecoCommand(map: LiteTileMap, id: number, index: number, before: [number, number], after: [number, number]): Command {
  const set = (cell: [number, number]) => {
    const o = findObject(map, id);
    if (o?.house?.decorations[index]) o.house.decorations[index].cell = [...cell];
  };
  return { label: "Move decoration", do: () => set(after), undo: () => set(before) };
}

/** Set / clear a decoration slot's palette override (hash). */
export function setHouseDecoPaletteCommand(map: LiteTileMap, id: number, index: number, before: string | undefined, after: string | undefined): Command {
  const set = (h: string | undefined) => {
    const o = findObject(map, id);
    if (!o?.house?.decorations[index]) return;
    if (h) o.house.decorations[index].palette = h; else delete o.house.decorations[index].palette;
  };
  return { label: "Decoration palette", do: () => set(after), undo: () => set(before) };
}

function cloneDecorations(decorations: HouseDecoration[]): HouseDecoration[] {
  return decorations.map((deco) => ({ ...deco, cell: [...deco.cell] as [number, number] }));
}

export function setHouseDecorationsCommand(
  map: LiteTileMap,
  id: number,
  before: HouseDecoration[],
  after: HouseDecoration[],
  label: string,
): Command {
  const set = (decorations: HouseDecoration[]) => {
    const o = findObject(map, id);
    if (o?.house) o.house.decorations = cloneDecorations(decorations);
  };
  return { label, do: () => set(after), undo: () => set(before) };
}

/** Set / clear the wall or roof slot palette override (hash). */
export function setHouseSlotPaletteCommand(map: LiteTileMap, id: number, slot: "wall" | "roof", before: string | undefined, after: string | undefined): Command {
  const set = (h: string | undefined) => {
    const o = findObject(map, id);
    if (!o?.house) return;
    if (h) o.house[slot] = h; else delete o.house[slot];
  };
  return { label: `${slot} palette`, do: () => set(after), undo: () => set(before) };
}

/** Change a house's wall-band height (rows from the bottom). */
export function setWallHeightCommand(map: LiteTileMap, id: number, before: number, after: number): Command {
  const set = (v: number) => { const o = findObject(map, id); if (o?.house) o.house.wallHeight = v; };
  return { label: "Wall height", do: () => set(after), undo: () => set(before) };
}

export function setHouseOverlapCommand(map: LiteTileMap, id: number, before: number, after: number): Command {
  const set = (v: number) => { const o = findObject(map, id); if (o?.house) o.house.overlap = v; };
  return { label: "Roof overlap", do: () => set(after), undo: () => set(before) };
}

export function setFrgCellsCommand(map: LiteTileMap, id: number, before: FrgCellData[], after: FrgCellData[], label: string): Command {
  const set = (cells: FrgCellData[]) => {
    const o = findObject(map, id);
    if (!o || o.type !== "FIXED_RECT_GROUP") return;
    const placementMode = o.frg?.placementMode ?? DEFAULT_FRG_PLACEMENT_MODE;
    o.frg = { cells: cells.map((cell) => ({ ...cell })), placementMode };
  };
  return {
    label,
    do: () => set(after),
    undo: () => set(before),
  };
}

export function setFrgPlacementModeCommand(map: LiteTileMap, id: number, before: FrgPlacementMode, after: FrgPlacementMode): Command {
  const set = (placementMode: FrgPlacementMode) => {
    const o = findObject(map, id);
    if (!o || o.type !== "FIXED_RECT_GROUP") return;
    o.frg = {
      cells: (o.frg?.cells ?? []).map((cell) => ({ ...cell })),
      placementMode,
    };
  };
  return { label: "FRG placement mode", do: () => set(after), undo: () => set(before) };
}

export function createObjectCommand(map: LiteTileMap, layerId: number, object: LiteObject): Command {
  const snapshot = cloneObjectDeep(object);
  const add = () => {
    const layer = findLayer(map, layerId);
    if (!layer) return;
    if (!layer.objects.some((o) => o.id === snapshot.id)) layer.objects.push(cloneObjectDeep(snapshot));
  };
  const remove = () => {
    const layer = findLayer(map, layerId);
    if (!layer) return;
    layer.objects = layer.objects.filter((o) => o.id !== snapshot.id);
  };
  return { label: "Create object", do: add, undo: remove };
}

export interface LayerObjectSnapshot {
  layerId: number;
  index: number;
  object: LiteObject;
}

function removeObjectsById(map: LiteTileMap, ids: Set<number>): void {
  for (const layer of map.layers) layer.objects = layer.objects.filter((o) => !ids.has(o.id));
}

function restoreObjects(map: LiteTileMap, snapshots: LayerObjectSnapshot[]): void {
  const byLayer = new Map<number, LayerObjectSnapshot[]>();
  for (const snapshot of snapshots) {
    const list = byLayer.get(snapshot.layerId);
    if (list) list.push(snapshot);
    else byLayer.set(snapshot.layerId, [snapshot]);
  }
  for (const [layerId, list] of byLayer) {
    const layer = findLayer(map, layerId);
    if (!layer) continue;
    const ordered = [...list].sort((a, b) => a.index - b.index);
    for (const snapshot of ordered) {
      if (layer.objects.some((o) => o.id === snapshot.object.id)) continue;
      layer.objects.splice(Math.min(snapshot.index, layer.objects.length), 0, cloneObjectDeep(snapshot.object));
    }
  }
}

export function createObjectsCommand(map: LiteTileMap, snapshots: LayerObjectSnapshot[]): Command {
  const stored = snapshots.map((snapshot) => ({ ...snapshot, object: cloneObjectDeep(snapshot.object) }));
  const ids = new Set(stored.map((snapshot) => snapshot.object.id));
  return {
    label: stored.length > 1 ? "Duplicate objects" : "Duplicate object",
    do: () => restoreObjects(map, stored),
    undo: () => removeObjectsById(map, ids),
  };
}

export function deleteObjectsCommand(map: LiteTileMap, snapshots: LayerObjectSnapshot[]): Command {
  const stored = snapshots.map((snapshot) => ({ ...snapshot, object: cloneObjectDeep(snapshot.object) }));
  const ids = new Set(stored.map((snapshot) => snapshot.object.id));
  return {
    label: stored.length > 1 ? "Delete objects" : "Delete object",
    do: () => removeObjectsById(map, ids),
    undo: () => restoreObjects(map, stored),
  };
}

export interface TerrainSnapshot {
  terrain: TerrainMatrix;
  rect: Rect;
}

/**
 * One terrain brush stroke = one command. `before`/`after` are matrix+rect
 * snapshots of the painted object (the stroke may have grown the matrix). `do`
 * is idempotent — at push time the live object already holds `after`.
 */
export function paintTerrainCommand(
  map: LiteTileMap,
  id: number,
  before: TerrainSnapshot,
  after: TerrainSnapshot,
): Command {
  const restore = (s: TerrainSnapshot) => {
    const o = findObject(map, id);
    if (o) { o.terrain = cloneTerrain(s.terrain); o.rect = [...s.rect]; }
  };
  return { label: "Paint terrain", do: () => restore(after), undo: () => restore(before) };
}

export function randomizeTerrainCommand(
  map: LiteTileMap,
  id: number,
  before: TerrainSnapshot,
  after: TerrainSnapshot,
  beforeTags: Record<string, string>,
  afterTags: Record<string, string>,
): Command {
  const restore = (snapshot: TerrainSnapshot, tags: Record<string, string>) => {
    const o = findObject(map, id);
    if (!o) return;
    o.terrain = cloneTerrain(snapshot.terrain);
    o.rect = [...snapshot.rect];
    o.tags = { ...tags };
  };
  return {
    label: "Rand terrain",
    do: () => restore(after, afterTags),
    undo: () => restore(before, beforeTags),
  };
}

export function bitwiseObjectCommand(
  map: LiteTileMap,
  id: number,
  before: TerrainSnapshot,
  after: TerrainSnapshot,
  label: string,
): Command {
  const restore = (snapshot: TerrainSnapshot) => {
    const o = findObject(map, id);
    if (!o) return;
    o.terrain = cloneTerrain(snapshot.terrain);
    o.rect = [...snapshot.rect];
  };
  return {
    label,
    do: () => restore(after),
    undo: () => restore(before),
  };
}

export function terrainMutationWithTagsCommand(
  map: LiteTileMap,
  id: number,
  before: TerrainSnapshot,
  after: TerrainSnapshot,
  beforeTags: Record<string, string>,
  afterTags: Record<string, string>,
  label: string,
): Command {
  const restore = (snapshot: TerrainSnapshot, tags: Record<string, string>) => {
    const o = findObject(map, id);
    if (!o) return;
    o.terrain = cloneTerrain(snapshot.terrain);
    o.rect = [...snapshot.rect];
    o.tags = { ...tags };
  };
  return {
    label,
    do: () => restore(after, afterTags),
    undo: () => restore(before, beforeTags),
  };
}

// --- layer commands (document state -> undoable; active-layer highlight is not) ---

/** Toggle a layer's visibility (enabled). Captured by layer id. */
export function toggleLayerEnabledCommand(map: LiteTileMap, layerId: number): Command {
  const set = (v: boolean) => { const l = findLayer(map, layerId); if (l) l.enabled = v; };
  const before = findLayer(map, layerId)?.enabled ?? true;
  return { label: "Toggle layer", do: () => set(!before), undo: () => set(before) };
}

/** Toggle an object's visibility (enabled). Captured by object id. */
export function toggleObjectEnabledCommand(map: LiteTileMap, objectId: number): Command {
  const set = (v: boolean) => { const o = findObject(map, objectId); if (o) o.enabled = v; };
  const before = findObject(map, objectId)?.enabled ?? true;
  return { label: "Toggle object", do: () => set(!before), undo: () => set(before) };
}

function setLayerObjectOrder(map: LiteTileMap, layerId: number, order: number[]): void {
  const layer = findLayer(map, layerId);
  if (!layer || order.length !== layer.objects.length) return;
  const byId = new Map(layer.objects.map((o) => [o.id, o]));
  const next = order.map((id) => byId.get(id)).filter((o): o is NonNullable<typeof o> => o != null);
  if (next.length !== layer.objects.length) return;
  layer.objects = next;
}

/** Restore a layer's object order from captured id lists. */
export function reorderLayerObjectsCommand(
  map: LiteTileMap,
  layerId: number,
  before: number[],
  after: number[],
): Command {
  return {
    label: "Reorder objects",
    do: () => setLayerObjectOrder(map, layerId, after),
    undo: () => setLayerObjectOrder(map, layerId, before),
  };
}

/** Combine multiple commands into a single atomic Undo/Redo step. */
export function compositeCommand(label: string, commands: Command[]): Command {
  return {
    label,
    do: () => {
      for (const c of commands) c.do();
    },
    undo: () => {
      for (let i = commands.length - 1; i >= 0; i--) commands[i].undo();
    },
  };
}

function clipAndShiftObject(o: LiteObject, dx: number, dy: number, newW: number, newH: number): LiteObject | null {
  const next = cloneObjectDeep(o);
  translateObject(next, dx, dy);
  if (next.terrain) {
    const t = next.terrain;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let r = 0; r < t.h; r++) {
      for (let c = 0; c < t.w; c++) {
        if (t.data[r * t.w + c] < 0) continue;
        const wx = t.ox + c;
        const wy = t.oy + r;
        if (wx < 0 || wy < 0 || wx >= newW || wy >= newH) continue;
        minX = Math.min(minX, wx);
        minY = Math.min(minY, wy);
        maxX = Math.max(maxX, wx);
        maxY = Math.max(maxY, wy);
      }
    }
    if (maxX < minX || maxY < minY) return null;
    const nw = maxX - minX + 1;
    const nh = maxY - minY + 1;
    const data = new Int16Array(nw * nh).fill(-1);
    for (let r = 0; r < t.h; r++) {
      for (let c = 0; c < t.w; c++) {
        const val = t.data[r * t.w + c];
        if (val < 0) continue;
        const wx = t.ox + c;
        const wy = t.oy + r;
        if (wx < minX || wy < minY || wx > maxX || wy > maxY) continue;
        data[(wy - minY) * nw + (wx - minX)] = val;
      }
    }
    next.terrain = { ox: minX, oy: minY, w: nw, h: nh, data };
    next.rect = [minX, minY, nw, nh];
    return next;
  }
  const [rx, ry, rw, rh] = next.rect;
  if (rx + rw <= 0 || ry + rh <= 0 || rx >= newW || ry >= newH) return null;
  const x0 = Math.max(0, rx);
  const y0 = Math.max(0, ry);
  const x1 = Math.min(newW, rx + rw);
  const y1 = Math.min(newH, ry + rh);
  if (x1 <= x0 || y1 <= y0) return null;
  next.rect = [x0, y0, x1 - x0, y1 - y0];
  return next;
}

/**
 * Resize the canvas to (newWidth, newHeight) with a 9-grid anchor:
 * anchorX / anchorY in {-1 (start), 0 (center), 1 (end)}.
 */
export function resizeMapCommand(
  map: LiteTileMap,
  newWidth: number,
  newHeight: number,
  anchorX: -1 | 0 | 1 = -1,
  anchorY: -1 | 0 | 1 = -1,
): Command {
  const beforeW = map.width;
  const beforeH = map.height;
  const beforeInferred = map.sizeInferred;
  const beforeLayers = map.layers.map((l) => ({
    id: l.id,
    objects: l.objects.map((o) => cloneObjectDeep(o)),
  }));

  const diffW = newWidth - beforeW;
  const diffH = newHeight - beforeH;
  const dx = anchorX === -1 ? 0 : anchorX === 0 ? Math.floor(diffW / 2) : diffW;
  const dy = anchorY === -1 ? 0 : anchorY === 0 ? Math.floor(diffH / 2) : diffH;

  const afterLayers = map.layers.map((l) => ({
    id: l.id,
    objects: l.objects
      .map((o) => clipAndShiftObject(o, dx, dy, newWidth, newHeight))
      .filter((o): o is LiteObject => o !== null),
  }));

  return {
    label: `Resize map to ${newWidth}×${newHeight}`,
    do: () => {
      map.width = newWidth;
      map.height = newHeight;
      map.sizeInferred = false;
      for (const snap of afterLayers) {
        const layer = findLayer(map, snap.id);
        if (layer) layer.objects = snap.objects.map((o) => cloneObjectDeep(o));
      }
    },
    undo: () => {
      map.width = beforeW;
      map.height = beforeH;
      map.sizeInferred = beforeInferred;
      for (const snap of beforeLayers) {
        const layer = findLayer(map, snap.id);
        if (layer) layer.objects = snap.objects.map((o) => cloneObjectDeep(o));
      }
    },
  };
}
