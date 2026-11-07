import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent } from "react";
import { parseBlueprint } from "./blueprint";
import { blueprintToLite } from "./convert";
import { normalizeToCategories } from "./normalize";
import { DEFAULT_FRG_PLACEMENT_MODE, assignUniqueObjectNames, cloneObjectDeep, cloneTerrain, displayName, findLayer, findObject, isLocked, layerOfObject, roleOf, setTerrainCell, translateObject, type FrgCellData, type FrgPlacementMode, type HouseDecorationKind, type LiteObject, type LiteTileMap, type Rect } from "./model";
import { UndoStack, bitwiseObjectCommand, compositeCommand, createObjectCommand, createObjectsCommand, deleteObjectsCommand, moveHouseDecoCommand, moveObjectCommand, moveObjectsCommand, paintTerrainCommand, randomizeTerrainCommand, renameObjectCommand, reorderLayerObjectsCommand, resizeMapCommand, resizeObjectCommand, setFrgCellsCommand, setFrgPlacementModeCommand, setHouseDecoPaletteCommand, setHouseDecorationsCommand, setHouseOverlapCommand, setHouseSlotPaletteCommand, setObjectRectCommand, setObjectsEnabledCommand, setObjectPaletteCommand, setObjectTypeCommand, setWallHeightCommand, terrainMutationWithTagsCommand, toggleLayerEnabledCommand, toggleObjectEnabledCommand, type Command, type LayerObjectSnapshot, type TerrainSnapshot } from "./commands";
import type { LiteType } from "./model";
import { liteToWebSave } from "./saveFormat";
import { createBlankMap, isWebSaveFile, webSaveToLite } from "./loadSave";
import { clearDraft, loadDraft, saveDraft } from "./draft";
import { downloadJson } from "./download";
import { colorForRole } from "./generated/roleColors";
import { applyBitwiseObjectOp, dilateTerrainMatrix, erodeTerrainMatrix, fillTerrainMatrix, flipTerrainMatrix, hasBitwiseOverlap, isBitwiseSupported, keepBorderTerrainMatrix, removeZeroLikeDesktop, terrainMatrixEquals, type BitwiseObjectOp } from "./bitwise";
import { BitwiseObjectModal } from "./components/BitwiseObjectModal";
import { CanvasView, type BrushState } from "./components/CanvasView";
import { Hd2dView } from "./components/Hd2dView";
import { type PlayerState } from "./hd2d/Hd2dWorld";
import { NewMapModal, ResizeMapModal } from "./components/MapLifecycleModals";
import { PalettePickerModal, type PaletteCreateRequest } from "./components/PalettePickerModal";
import { PropsPanel } from "./components/PropsPanel";
import { RoleTreeBrushPanel } from "./components/RoleTreeBrushPanel";
import { loadPackFromUrl } from "./pack/loadPack";
import { compileMap, resolvePaletteForRole } from "./pack/compile";
import { PaletteMode, type Palette, type PackRuntime } from "./pack/types";
import { isStructureMode } from "./pack/slice";
import type { RenderMode } from "./render";
import { generateDecorations } from "./house";
import { createObjectForRole, type CreateKind } from "./objectFactory";
import { createKindsForRole, roleRoot } from "./roleTree";
import { applyNoiseConfig, applyTerrainNoiseConfig, regenerateTerrainByNoise, type TerrainNoiseConfig } from "./terrainNoise";
import {
  brushFootprint,
  ensureLayerForRole,
  floodFillObjectTerrain,
  inspectTileStack,
  isMatrixBrushType,
  objectCoversTile,
  resolveOrCreateBrushTarget,
  targetLiteTypeForRole,
  type ActiveBrushConfig,
} from "./fastBrush";

const borderAsConnected = (o: LiteObject) => o.tags["borderAsConnected"] === "true";

type DropSide = "before" | "after";

interface DraggedObject {
  layerId: number;
  objectId: number;
}

interface DropTarget {
  layerId: number;
  targetId: number;
  side: DropSide;
}

interface ClipboardEntry {
  index: number;
  object: LiteObject;
}

interface ObjectClipboard {
  layerId: number;
  layerName: string;
  entries: ClipboardEntry[];
  pasteCount: number;
}

interface CreatePaletteChoice {
  kind: CreateKind;
  palette: Palette;
  role: string;
}

const HOUSE_CREATE_ROLE = "building/house";
const HOUSE_WALL_ROLE = "building/house_wall";
const HOUSE_ROOF_ROLE = "building/house_roof";

function dropSideFromEvent(e: ReactDragEvent<HTMLDivElement>): DropSide {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function reorderWithinLayer(ids: number[], sourceId: number, targetId: number, side: DropSide): number[] {
  if (sourceId === targetId) return ids;
  const without = ids.filter((id) => id !== sourceId);
  const at = without.indexOf(targetId);
  if (at < 0) return ids;
  const next = [...without];
  next.splice(side === "before" ? at : at + 1, 0, sourceId);
  return next;
}

function sameOrder(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sortCreateChoices<T extends CreatePaletteChoice>(choices: T[]): T[] {
  return choices.slice().sort((a, b) =>
    a.kind.localeCompare(b.kind)
    || a.role.localeCompare(b.role)
    || a.palette.style.localeCompare(b.palette.style)
    || a.palette.hash.localeCompare(b.palette.hash));
}

function uniqueName(existing: Set<string>, base: string): string {
  if (!existing.has(base)) {
    existing.add(base);
    return base;
  }
  let n = 2;
  while (existing.has(`${base} #${n}`)) n++;
  const next = `${base} #${n}`;
  existing.add(next);
  return next;
}

const CREATE_KIND_LABEL: Record<CreateKind, string> = {
  terrain_area: "Area",
  terrain_line: "Line",
  fixed_rect: "Rect",
  fixed_rect_group: "FRG",
  house: "House",
};

const DEFAULT_KIND_ORDER: CreateKind[] = ["terrain_area", "terrain_line", "fixed_rect", "fixed_rect_group", "house"];
const BUILDING_KIND_ORDER: CreateKind[] = ["house", "fixed_rect", "fixed_rect_group", "terrain_area", "terrain_line"];

function paletteSupportsKind(mode: PaletteMode, kind: CreateKind): boolean {
  if (kind === "terrain_area") return mode === PaletteMode.TWO_CORNER || mode === PaletteMode.QUAD;
  if (kind === "terrain_line") return mode === PaletteMode.TWO_EDGE || mode === PaletteMode.CONTOUR;
  if (kind === "fixed_rect" || kind === "fixed_rect_group") {
    return mode === PaletteMode.FIXED_RECT || mode === PaletteMode.NINE_PATCH || mode === PaletteMode.H_STRETCH || mode === PaletteMode.V_STRETCH;
  }
  return mode === PaletteMode.CLIFF;
}

function paletteCreateKinds(palette: Palette): CreateKind[] {
  const roleKinds = createKindsForRole(palette.role);
  return roleKinds.filter((kind) => paletteSupportsKind(palette.mode, kind));
}

function rectEquals(a: Rect, b: Rect): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function cloneTerrainForRect(terrain: TerrainSnapshot["terrain"]): TerrainSnapshot["terrain"] {
  return cloneTerrain(terrain);
}

function terrainAabb(terrain: TerrainSnapshot["terrain"]): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let row = 0; row < terrain.h; row++) {
    for (let col = 0; col < terrain.w; col++) {
      if (terrain.data[row * terrain.w + col] < 0) continue;
      const wx = terrain.ox + col;
      const wy = terrain.oy + row;
      minX = Math.min(minX, wx);
      minY = Math.min(minY, wy);
      maxX = Math.max(maxX, wx);
      maxY = Math.max(maxY, wy);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

function resizeTerrainToRect(terrain: TerrainSnapshot["terrain"], rect: Rect): TerrainSnapshot["terrain"] {
  const next = { ox: rect[0], oy: rect[1], w: rect[2], h: rect[3], data: new Int16Array(rect[2] * rect[3]).fill(-1) };
  for (let row = 0; row < terrain.h; row++) {
    for (let col = 0; col < terrain.w; col++) {
      if (terrain.data[row * terrain.w + col] < 0) continue;
      const wx = terrain.ox + col;
      const wy = terrain.oy + row;
      const nx = wx - next.ox;
      const ny = wy - next.oy;
      if (nx < 0 || ny < 0 || nx >= next.w || ny >= next.h) continue;
      next.data[ny * next.w + nx] = terrain.data[row * terrain.w + col];
    }
  }
  return next;
}

interface StrokeSession {
  mode: "paint" | "erase";
  targetId: number | null;
  createdObj?: { layerId: number; objectId: number };
  beforeMap: Map<number, TerrainSnapshot>;
  dirty: boolean;
}

export type ViewLayout = "triple" | "tilemap_game" | "tilemap_scene" | "2d";

export default function App() {
  const [lang, setLang] = useState<'zh' | 'en'>(() => {
    return (localStorage.getItem('adna_lang') as 'zh' | 'en') || 'zh';
  });
  const [map, setMap] = useState<LiteTileMap | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  // palette pack + real-tile rendering
  const [pack, setPack] = useState<PackRuntime | null>(null);
  const [renderMode, setRenderMode] = useState<RenderMode>("mixed");
  const [packVersion, setPackVersion] = useState(0);
  const [viewLayout, setViewLayout] = useState<ViewLayout>("triple");
  const [player, setPlayer] = useState<PlayerState>({ x: 24, y: 0, z: 18, facing: 1, walkPhase: 0 });
  const [newMapOpen, setNewMapOpen] = useState(false);
  const [resizeMapOpen, setResizeMapOpen] = useState(false);
  const [layersWidth, setLayersWidth] = useState(() => Number(localStorage.getItem("reroll_layers_w")) || 320);
  // draggable width of the right props panel (px), persisted
  const [propsWidth, setPropsWidth] = useState(() => Number(localStorage.getItem("reroll_props_w")) || 250);
  // Split ratio between 2D TileMap and 3D Column (0.15 ~ 0.85, default 0.5)
  const [viewSplitH, setViewSplitH] = useState<number>(() => {
    const saved = Number(localStorage.getItem("reroll_view_split_h"));
    return saved >= 0.15 && saved <= 0.85 ? saved : 0.5;
  });
  // Split ratio between 3D Scene View and 3D Game View (0.15 ~ 0.85, default 0.5)
  const [viewSplitV, setViewSplitV] = useState<number>(() => {
    const saved = Number(localStorage.getItem("reroll_view_split_v"));
    return saved >= 0.15 && saved <= 0.85 ? saved : 0.5;
  });
  const [resizingSplit, setResizingSplit] = useState<"none" | "h" | "v">("none");
  const stageRef = useRef<HTMLDivElement>(null);
  const stackColRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // one-shot Marquee tool armed (docs/SELECTION_MODEL.md); LMB box-selects, then pops back
  const [marquee, setMarquee] = useState(false);
  const [brushConfig, setBrushConfig] = useState<ActiveBrushConfig>({
    tool: "brush",
    role: "terrain_decoration/path/road/area_path",
    paletteHash: null,
    size: 3,
    shape: "square",
    replaceSameLayer: false,
    propStyle: "brush",
  });
  // active layer = pure highlight + selection scope (not undoable, not exported)
  const [activeLayerId, setActiveLayerId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [dragging, setDragging] = useState<DraggedObject | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [createKind, setCreateKind] = useState<CreateKind>("fixed_rect");
  const [createPaletteHash, setCreatePaletteHash] = useState("");
  const [createHouseWallHash, setCreateHouseWallHash] = useState("");
  const [createHouseRoofHash, setCreateHouseRoofHash] = useState("");
  const [createArmed, setCreateArmed] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [bitwiseTargetId, setBitwiseTargetId] = useState<number | null>(null);
  const [bitwiseSourceId, setBitwiseSourceId] = useState<number | null>(null);
  const [clipboard, setClipboard] = useState<ObjectClipboard | null>(null);
  const [anchorId, setAnchorId] = useState<number | null>(null);
  const undo = useRef(new UndoStack());
  const stroke = useRef<StrokeSession | null>(null);
  const decoDrag = useRef<{ id: number; index: number; before: [number, number] } | null>(null);
  const terrainNoisePreview = useRef<{ id: number; before: TerrainSnapshot; beforeTags: Record<string, string> } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<number | null>(null);

  const onChangeBrushConfig = useCallback((patch: Partial<ActiveBrushConfig>) => {
    setBrushConfig((prev) => {
      const next = { ...prev, ...patch };
      if (patch.tool === "select") setMarquee(true);
      else if (patch.tool) setMarquee(false);
      return next;
    });
  }, []);

  const applyNewMapState = useCallback((lite: LiteTileMap) => {
    assignUniqueObjectNames(lite);
    undo.current = new UndoStack();
    setMap(lite);
    setSelected(new Set());
    setAnchorId(null);
    setMarquee(false);
    setClipboard(null);
    setActiveLayerId(lite.layers[0]?.id ?? null);
    setExpanded(new Set());

    // Find player spawner or fallback to map center
    let spawnX = Math.floor(lite.width / 2) + 0.5;
    let spawnZ = Math.floor(lite.height / 2) + 0.5;
    const spawnerLayer = lite.layers.find((l) => l.tags["role.root"] === "spawner" || l.name === "spawner");
    const spawnerObj = spawnerLayer?.objects[0] || lite.layers.flatMap((l) => l.objects).find((o) => roleOf(o).includes("spawner"));
    if (spawnerObj) {
      spawnX = spawnerObj.rect[0] + spawnerObj.rect[2] / 2;
      spawnZ = spawnerObj.rect[1] + spawnerObj.rect[3] / 2;
    }

    setPlayer({
      x: spawnX,
      y: 0,
      z: spawnZ,
      facing: 1,
      walkPhase: 0,
    });
    terrainNoisePreview.current = null;
    setVersion(0);
    setError("");
  }, []);

  const onPlacePlayer = useCallback((tx: number, ty: number) => {
    setPlayer((prev) => ({
      ...prev,
      x: tx + 0.5,
      z: ty + 0.5,
      walkPhase: 0,
    }));
  }, []);

  const build = useCallback((name: string, text: string) => {
    let lite: LiteTileMap;
    const raw = JSON.parse(text);
    if (isWebSaveFile(raw)) {
      lite = webSaveToLite(raw);
    } else {
      lite = normalizeToCategories(blueprintToLite(parseBlueprint(name, text)));
    }
    assignUniqueObjectNames(lite);
    // resume an unfinished local session for this source, if the user wants it
    const draft = loadDraft(name);
    if (draft) {
      const when = new Date(draft.savedAt).toLocaleString();
      const confirmMsg = lang === 'zh'
        ? `发现「${name}」上次未完成的修改（保存于 ${when}）。\n\n确定 = 继续上次进度；取消 = 放弃改动,重新打开。`
        : `Unsaved draft of "${name}" found (from ${when}).\n\nOK = continue editing; Cancel = discard draft and reload.`;
      if (confirm(confirmMsg)) {
        lite = draft.map;
      } else {
        clearDraft(name);
      }
    }
    applyNewMapState(lite);
  }, [lang, applyNewMapState]);

  const load = useCallback((name: string, text: string) => {
    build(name, text);
  }, [build]);

  const onNewMap = useCallback((name: string, width: number, height: number, baseRole: string | null) => {
    const lite = createBlankMap(name, width, height, baseRole);
    applyNewMapState(lite);
    setNewMapOpen(false);
  }, [applyNewMapState]);

  const toggleExpand = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const loadFile = useCallback(async (file: File) => {
    try { load(file.name, await file.text()); }
    catch (e) { setError(`加载失败: ${(e as Error).message}`); }
  }, [load]);

  const loadSample = useCallback(async () => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}sample/hd2d_test_village_32x32.adnaweb.json`);
      if (!res.ok) throw new Error(`sample 不可用 (${res.status})`);
      load("hd2d_test_village_32x32 (sample)", await res.text());
    } catch (e) { setError(`样例加载失败: ${(e as Error).message}`); }
  }, [load]);

  // load the palette pack once: prefer the server's live default (kept current by
  // the tagger's "apply roles" button), fall back to the bundled copy (gh-pages/offline).
  useEffect(() => {
    loadPackFromUrl("/api/reroll-pack")
      .catch(() => loadPackFromUrl(`${import.meta.env.BASE_URL}sample/palettes.adnapalettepack`))
      .then(setPack)
      .catch((e) => setError(`palette pack 加载失败: ${(e as Error).message}`));
  }, []);

  // open straight to the rendered sample village (so the live/Pages link shows
  // tiles immediately); the user can still drop or open their own blueprint
  useEffect(() => { void loadSample(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  // bind a palette to each object by role (also recompiled on edits — type
  // conversion / palette override change the bindings; version bumps on every command)
  const bindings = useMemo(() => (map && pack ? compileMap(map, pack) : null), [map, pack, version]);
  const effectiveFrgCells = useCallback((o: LiteObject): FrgCellData[] => {
    if (o.type !== "FIXED_RECT_GROUP") return [];
    if (o.frg) return o.frg.cells.map((cell) => ({ ...cell }));
    const binding = bindings?.get(o.id);
    if (binding?.kind === "frg") return binding.variants.map((palette) => ({ palette: palette.hash, weight: 100 }));
    const override = o.tags["web.palette"];
    return override ? [{ palette: override, weight: 100 }] : [];
  }, [bindings]);
  const effectiveFrgPlacementMode = useCallback((o: LiteObject): FrgPlacementMode => {
    if (o.type !== "FIXED_RECT_GROUP") return DEFAULT_FRG_PLACEMENT_MODE;
    return o.frg?.placementMode ?? DEFAULT_FRG_PLACEMENT_MODE;
  }, []);
  // invalidate the cached scene when bindings / render mode change
  useEffect(() => { setPackVersion((v) => v + 1); }, [bindings, renderMode]);

  useEffect(() => {
    const onDrop = (e: DragEvent) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) void loadFile(f); };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragover", onDragOver);
    return () => { window.removeEventListener("drop", onDrop); window.removeEventListener("dragover", onDragOver); };
  }, [loadFile]);

  // drag the layers|canvas divider to resize the left panel
  const startLayersResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) =>
      setLayersWidth(Math.min(460, Math.max(240, ev.clientX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // drag the canvas|props divider to resize the right panel
  const startPropsResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) =>
      setPropsWidth(Math.min(560, Math.max(180, window.innerWidth - ev.clientX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);
  useEffect(() => { localStorage.setItem("reroll_layers_w", String(layersWidth)); }, [layersWidth]);
  useEffect(() => { localStorage.setItem("reroll_props_w", String(propsWidth)); }, [propsWidth]);
  useEffect(() => { localStorage.setItem("reroll_view_split_h", String(viewSplitH)); }, [viewSplitH]);
  useEffect(() => { localStorage.setItem("reroll_view_split_v", String(viewSplitV)); }, [viewSplitV]);

  // drag divider between 2D TileMap and 3D Column (horizontal split)
  const startViewHResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    setResizingSplit("h");
    const onMove = (ev: MouseEvent) => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (ev.clientX - rect.left) / rect.width;
      setViewSplitH(Math.min(0.85, Math.max(0.15, ratio)));
    };
    const onUp = () => {
      setResizingSplit("none");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // drag divider between 3D Scene View and 3D Game View (vertical split)
  const startViewVResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const stackCol = stackColRef.current;
    if (!stackCol) return;
    setResizingSplit("v");
    const onMove = (ev: MouseEvent) => {
      const rect = stackCol.getBoundingClientRect();
      if (rect.height <= 0) return;
      const ratio = (ev.clientY - rect.top) / rect.height;
      setViewSplitV(Math.min(0.85, Math.max(0.15, ratio)));
    };
    const onUp = () => {
      setResizingSplit("none");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  const resetViewH = useCallback(() => setViewSplitH(0.5), []);
  const resetViewV = useCallback(() => setViewSplitV(0.5), []);

  // autosave the edit session to localStorage (debounced) — only after a real
  // edit (version>0), so just opening a map doesn't create a phantom "resume?" draft
  useEffect(() => {
    if (!map || version === 0) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveDraft(map.name, map), 500);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [map, version]);

  // --- commands ---
  const run = useCallback((cmd: Command) => { undo.current.push(cmd); setVersion((v) => v + 1); }, []);
  const onUndo = useCallback(() => { undo.current.undo(); setVersion((v) => v + 1); }, []);
  const onRedo = useCallback(() => { undo.current.redo(); setVersion((v) => v + 1); }, []);

  const onResizeMap = useCallback((newW: number, newH: number, anchorX: -1 | 0 | 1, anchorY: -1 | 0 | 1) => {
    if (!map) return;
    run(resizeMapCommand(map, newW, newH, anchorX, anchorY));
    setResizeMapOpen(false);
  }, [map, run]);

  const onExport = useCallback(() => {
    if (!map) return;
    const base = (map.name || "map").replace(/\s*\(sample\)$/, "").replace(/\.[^.]+$/, "") || "map";
    downloadJson(`${base}.adnaweb.json`, liteToWebSave(map));
    clearDraft(map.name); // saved to disk → drop the local resume draft
  }, [map]);

  const onMove = useCallback((id: number, before: [number, number], after: [number, number]) => {
    if (map) run(moveObjectCommand(map, id, before, after));
  }, [map, run]);

  const onResize = useCallback((id: number, before: Rect, after: Rect) => {
    if (map) run(resizeObjectCommand(map, id, before, after));
  }, [map, run]);

  const onToggleLock = useCallback(() => {
    if (!map || selected.size === 0) return;
    const ids = [...selected];
    const lock = ids.some((id) => { const o = findObject(map, id); return o ? !isLocked(o) : false; });
    const apply = (l: boolean) => ids.forEach((id) => {
      const o = findObject(map, id);
      if (o) { if (l) o.tags["web.lock"] = "true"; else delete o.tags["web.lock"]; }
    });
    run({ label: lock ? "Lock" : "Unlock", do: () => apply(lock), undo: () => apply(!lock) });
  }, [map, selected, run]);

  // --- selection (single-layer; docs/SELECTION_MODEL.md) ---
  const revealLayer = useCallback((layerId: number) => {
    setActiveLayerId(layerId);
    setExpanded((prev) => new Set(prev).add(layerId));
  }, []);

  // Replace selection with a single object (switch active layer, set anchor, sync brush role).
  const selectSingle = useCallback((id: number) => {
    if (!map) return;
    const ly = layerOfObject(map, id);
    if (ly) revealLayer(ly.id);
    const obj = findObject(map, id);
    if (obj) {
      const r = roleOf(obj);
      if (r) {
        const pHash = obj.tags["web.palette"] || (obj.frg && obj.frg.cells.length > 0 ? obj.frg.cells[0].palette : null) || null;
        setBrushConfig((prev) => ({
          ...prev,
          role: r,
          paletteHash: pHash,
        }));
      }
    }
    setSelected(new Set([id]));
    setAnchorId(id);
  }, [map, revealLayer]);

  // --- Fast Brush: resolve active palette and paint/erase/fill/eyedropper ---
  const activeBrushPalette = useMemo<Palette | null>(() => {
    if (!pack) return null;
    if (brushConfig.paletteHash) {
      const exact = pack.palettes.find((p) => p.hash === brushConfig.paletteHash);
      if (exact) return exact;
    }
    const targetType = targetLiteTypeForRole(brushConfig.role, brushConfig.propStyle);
    return resolvePaletteForRole(pack.palettes, brushConfig.role, "", 1, targetType) ?? null;
  }, [pack, brushConfig.paletteHash, brushConfig.role, brushConfig.propStyle]);

  const placeNonMatrixObjectAt = useCallback((tx: number, ty: number, overrideSize?: [number, number]) => {
    if (!map) return;
    const layer = ensureLayerForRole(map, brushConfig.role);
    let maxId = -1;
    for (const l of map.layers) for (const o of l.objects) maxId = Math.max(maxId, o.id);
    const id = maxId + 1;
    const targetType = targetLiteTypeForRole(brushConfig.role, brushConfig.propStyle);
    if (targetType === "HOUSE") {
      const wallPal = pack?.palettes.find((p) => p.role === HOUSE_WALL_ROLE && isStructureMode(p.mode)) ?? activeBrushPalette;
      const roofPal = pack?.palettes.find((p) => p.role === HOUSE_ROOF_ROLE && isStructureMode(p.mode)) ?? activeBrushPalette;
      const size: [number, number] = overrideSize ?? [
        Math.max(3, wallPal?.size[0] ?? 4, roofPal?.size[0] ?? 4),
        Math.max(3, (wallPal?.size[1] ?? 2) + (roofPal?.size[1] ?? 2) - 1),
      ];
      const created = createObjectForRole(map, id, HOUSE_CREATE_ROLE, "house", tx, ty, {
        houseWallHash: wallPal?.hash,
        houseRoofHash: roofPal?.hash,
        size,
        style: roofPal?.style || wallPal?.style,
      });
      if (created) {
        run(createObjectCommand(map, layer.id, created));
        selectSingle(id);
      }
      return;
    }
    const size: [number, number] = overrideSize ?? (activeBrushPalette?.size ? [activeBrushPalette.size[0], activeBrushPalette.size[1]] : [2, 2]);
    const created = createObjectForRole(map, id, brushConfig.role, "fixed_rect", tx, ty, {
      paletteHash: activeBrushPalette?.hash,
      size,
      style: activeBrushPalette?.style,
    });
    if (created) {
      run(createObjectCommand(map, layer.id, created));
      selectSingle(id);
    }
  }, [map, brushConfig.role, brushConfig.propStyle, pack, activeBrushPalette, run, selectSingle]);

  const applySessionDab = useCallback((session: StrokeSession, tx: number, ty: number): boolean => {
    if (!map) return false;
    const cells = brushFootprint(tx, ty, brushConfig.size, brushConfig.shape, map.width, map.height);
    let changed = false;

    if (session.mode === "erase") {
      if (session.targetId != null) {
        const target = findObject(map, session.targetId);
        if (!target || !target.terrain || isLocked(target)) return false;
        if (!session.beforeMap.has(target.id)) {
          session.beforeMap.set(target.id, { terrain: cloneTerrain(target.terrain), rect: [...target.rect] as Rect });
        }
        for (const [x, y] of cells) {
          if (setTerrainCell(target, x, y, false)) changed = true;
        }
      } else {
        const layer = ensureLayerForRole(map, brushConfig.role);
        for (const obj of layer.objects) {
          if (!obj.enabled || isLocked(obj) || !obj.terrain || !isMatrixBrushType(obj.type)) continue;
          for (const [x, y] of cells) {
            if (!objectCoversTile(obj, x, y)) continue;
            if (!session.beforeMap.has(obj.id)) {
              session.beforeMap.set(obj.id, { terrain: cloneTerrain(obj.terrain), rect: [...obj.rect] as Rect });
            }
            if (setTerrainCell(obj, x, y, false)) changed = true;
          }
        }
      }
      if (changed) session.dirty = true;
      return changed;
    }

    if (session.targetId == null) return false;
    const target = findObject(map, session.targetId);
    if (!target || !target.terrain || isLocked(target)) return false;
    const layer = layerOfObject(map, target.id);

    for (const [x, y] of cells) {
      if (setTerrainCell(target, x, y, true)) changed = true;
      if (brushConfig.replaceSameLayer && layer) {
        for (const other of layer.objects) {
          if (other.id === target.id || !other.enabled || isLocked(other) || !other.terrain || !isMatrixBrushType(other.type)) continue;
          if (!objectCoversTile(other, x, y)) continue;
          if (!session.beforeMap.has(other.id)) {
            session.beforeMap.set(other.id, { terrain: cloneTerrain(other.terrain), rect: [...other.rect] as Rect });
          }
          if (setTerrainCell(other, x, y, false)) changed = true;
        }
      }
    }
    if (changed) session.dirty = true;
    return changed;
  }, [map, brushConfig.size, brushConfig.shape, brushConfig.role, brushConfig.replaceSameLayer]);

  const commitSessionCommand = useCallback((session: StrokeSession, label: string) => {
    if (!map) return;
    if (!session.dirty) {
      if (session.createdObj) {
        const ly = findLayer(map, session.createdObj.layerId);
        if (ly) ly.objects = ly.objects.filter((o) => o.id !== session.createdObj!.objectId);
      }
      return;
    }
    const cmds: Command[] = [];
    if (session.createdObj) {
      const createdObj = findObject(map, session.createdObj.objectId);
      if (createdObj) {
        cmds.push(createObjectCommand(map, session.createdObj.layerId, createdObj));
      }
    }
    for (const [objId, beforeSnap] of session.beforeMap) {
      if (session.createdObj && objId === session.createdObj.objectId) continue;
      const obj = findObject(map, objId);
      if (!obj || !obj.terrain) continue;
      const afterSnap: TerrainSnapshot = { terrain: cloneTerrain(obj.terrain), rect: [...obj.rect] as Rect };
      cmds.push(paintTerrainCommand(map, objId, beforeSnap, afterSnap));
    }
    if (cmds.length === 1) run(cmds[0]);
    else if (cmds.length > 1) run(compositeCommand(label, cmds));
  }, [map, run]);

  const onStrokeStart = useCallback((tx: number, ty: number) => {
    if (!map) { stroke.current = null; return; }
    if (brushConfig.tool === "eraser") {
      const selFirst = selected.size === 1 ? findObject(map, [...selected][0]) : null;
      const eraseTarget = selFirst && isMatrixBrushType(selFirst.type) && !isLocked(selFirst) && selFirst.terrain
        ? selFirst.id
        : null;
      const session: StrokeSession = {
        mode: "erase",
        targetId: eraseTarget,
        beforeMap: new Map(),
        dirty: false,
      };
      if (applySessionDab(session, tx, ty)) setVersion((v) => v + 1);
      stroke.current = session;
      return;
    }

    const targetType = targetLiteTypeForRole(brushConfig.role, brushConfig.propStyle);
    if (!isMatrixBrushType(targetType)) {
      stroke.current = null;
      placeNonMatrixObjectAt(tx, ty);
      return;
    }

    const resolved = resolveOrCreateBrushTarget(
      map,
      brushConfig.role,
      activeBrushPalette,
      brushConfig.propStyle,
      selected,
    );
    const beforeMap = new Map<number, TerrainSnapshot>();
    if (!resolved.created && resolved.object.terrain) {
      beforeMap.set(resolved.object.id, {
        terrain: cloneTerrain(resolved.object.terrain),
        rect: [...resolved.object.rect] as Rect,
      });
    }
    const session: StrokeSession = {
      mode: "paint",
      targetId: resolved.object.id,
      ...(resolved.created ? { createdObj: { layerId: resolved.layer.id, objectId: resolved.object.id } } : {}),
      beforeMap,
      dirty: false,
    };
    applySessionDab(session, tx, ty);
    revealLayer(resolved.layer.id);
    setSelected(new Set([resolved.object.id]));
    setAnchorId(resolved.object.id);
    setVersion((v) => v + 1);
    stroke.current = session;
  }, [map, brushConfig.tool, brushConfig.role, brushConfig.propStyle, selected, activeBrushPalette, applySessionDab, placeNonMatrixObjectAt, revealLayer]);

  const onStrokePaint = useCallback((tx: number, ty: number) => {
    const session = stroke.current;
    if (!session) return;
    if (applySessionDab(session, tx, ty)) {
      setVersion((v) => v + 1);
    }
  }, [applySessionDab]);

  const onStrokeEnd = useCallback(() => {
    const session = stroke.current;
    stroke.current = null;
    if (!session) return;
    commitSessionCommand(session, session.mode === "erase" ? "Erase tiles" : "Paint tiles");
  }, [commitSessionCommand]);

  const onRectFill = useCallback((loX: number, loY: number, hiX: number, hiY: number) => {
    if (!map) return;
    const clampedLoX = Math.max(0, Math.min(map.width - 1, loX));
    const clampedLoY = Math.max(0, Math.min(map.height - 1, loY));
    const clampedHiX = Math.max(0, Math.min(map.width - 1, hiX));
    const clampedHiY = Math.max(0, Math.min(map.height - 1, hiY));
    const w = clampedHiX - clampedLoX + 1;
    const h = clampedHiY - clampedLoY + 1;

    const targetType = targetLiteTypeForRole(brushConfig.role, brushConfig.propStyle);
    if (!isMatrixBrushType(targetType)) {
      placeNonMatrixObjectAt(clampedLoX, clampedLoY, [Math.max(1, w), Math.max(1, h)]);
      return;
    }

    const resolved = resolveOrCreateBrushTarget(
      map,
      brushConfig.role,
      activeBrushPalette,
      brushConfig.propStyle,
      selected,
    );
    const beforeMap = new Map<number, TerrainSnapshot>();
    if (!resolved.created && resolved.object.terrain) {
      beforeMap.set(resolved.object.id, {
        terrain: cloneTerrain(resolved.object.terrain),
        rect: [...resolved.object.rect] as Rect,
      });
    }
    const session: StrokeSession = {
      mode: "paint",
      targetId: resolved.object.id,
      ...(resolved.created ? { createdObj: { layerId: resolved.layer.id, objectId: resolved.object.id } } : {}),
      beforeMap,
      dirty: false,
    };
    for (let y = clampedLoY; y <= clampedHiY; y++) {
      for (let x = clampedLoX; x <= clampedHiX; x++) {
        if (setTerrainCell(resolved.object, x, y, true)) session.dirty = true;
        if (brushConfig.replaceSameLayer) {
          for (const other of resolved.layer.objects) {
            if (other.id === resolved.object.id || !other.enabled || isLocked(other) || !other.terrain || !isMatrixBrushType(other.type)) continue;
            if (!objectCoversTile(other, x, y)) continue;
            if (!session.beforeMap.has(other.id)) {
              session.beforeMap.set(other.id, { terrain: cloneTerrain(other.terrain), rect: [...other.rect] as Rect });
            }
            if (setTerrainCell(other, x, y, false)) session.dirty = true;
          }
        }
      }
    }
    revealLayer(resolved.layer.id);
    setSelected(new Set([resolved.object.id]));
    setAnchorId(resolved.object.id);
    commitSessionCommand(session, "Rect fill");
  }, [map, brushConfig.role, brushConfig.propStyle, brushConfig.replaceSameLayer, activeBrushPalette, selected, placeNonMatrixObjectAt, revealLayer, commitSessionCommand]);

  const onBucketFill = useCallback((tx: number, ty: number) => {
    if (!map) return;
    const targetType = targetLiteTypeForRole(brushConfig.role, brushConfig.propStyle);
    if (!isMatrixBrushType(targetType)) {
      placeNonMatrixObjectAt(tx, ty);
      return;
    }
    const resolved = resolveOrCreateBrushTarget(
      map,
      brushConfig.role,
      activeBrushPalette,
      brushConfig.propStyle,
      selected,
    );
    const beforeMap = new Map<number, TerrainSnapshot>();
    if (!resolved.created && resolved.object.terrain) {
      beforeMap.set(resolved.object.id, {
        terrain: cloneTerrain(resolved.object.terrain),
        rect: [...resolved.object.rect] as Rect,
      });
    }
    const session: StrokeSession = {
      mode: "paint",
      targetId: resolved.object.id,
      ...(resolved.created ? { createdObj: { layerId: resolved.layer.id, objectId: resolved.object.id } } : {}),
      beforeMap,
      dirty: floodFillObjectTerrain(map, resolved.object, tx, ty, true),
    };
    revealLayer(resolved.layer.id);
    setSelected(new Set([resolved.object.id]));
    setAnchorId(resolved.object.id);
    commitSessionCommand(session, "Flood fill");
  }, [map, brushConfig.role, brushConfig.propStyle, activeBrushPalette, selected, placeNonMatrixObjectAt, revealLayer, commitSessionCommand]);

  const onEyedropper = useCallback((tx: number, ty: number) => {
    if (!map) return;
    const stack = inspectTileStack(map, tx, ty);
    if (stack.length === 0) return;
    const top = stack[stack.length - 1];
    setBrushConfig((prev) => ({
      ...prev,
      tool: "brush",
      role: top.role || prev.role,
      paletteHash: top.paletteHash ?? null,
    }));
    selectSingle(top.objectId);
  }, [map, selectSingle]);

  // Ctrl-toggle membership; only within the active layer (else switch + single).
  const toggleSelect = useCallback((id: number) => {
    if (!map) return;
    const ly = layerOfObject(map, id);
    if (!ly) return;
    if (ly.id !== activeLayerId) { selectSingle(id); return; }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setAnchorId(id);
  }, [map, activeLayerId, selectSingle]);

  const selectRange = useCallback((id: number) => {
    if (!map) return;
    const ly = layerOfObject(map, id);
    if (!ly || anchorId == null || ly.id !== activeLayerId) { selectSingle(id); return; }
    const ai = ly.objects.findIndex((o) => o.id === anchorId);
    const ti = ly.objects.findIndex((o) => o.id === id);
    if (ai < 0 || ti < 0) { selectSingle(id); return; }
    const [lo, hi] = ai <= ti ? [ai, ti] : [ti, ai];
    setSelected(new Set(ly.objects.slice(lo, hi + 1).map((o) => o.id)));
    revealLayer(ly.id);
  }, [map, anchorId, activeLayerId, selectSingle, revealLayer]);

  // RMB pick: plain = single, Ctrl = toggle. Empty click is a no-op.
  const onPick = useCallback((id: number | null, additive: boolean) => {
    if (id == null) return;
    if (additive) toggleSelect(id); else selectSingle(id);
  }, [toggleSelect, selectSingle]);

  const onObjectClick = useCallback((id: number, mods: { ctrl: boolean; shift: boolean }) => {
    if (mods.shift) selectRange(id);
    else if (mods.ctrl) toggleSelect(id);
    else selectSingle(id);
  }, [selectRange, toggleSelect, selectSingle]);

  // Marquee release: select active-layer objects whose rect intersects the box.
  const onMarquee = useCallback((loX: number, loY: number, hiX: number, hiY: number, additive: boolean) => {
    if (!map || activeLayerId == null) return;
    const ly = findLayer(map, activeLayerId);
    if (!ly) return;
    const hits = ly.objects
      .filter((o) => { const [x, y, w, h] = o.rect; return x <= hiX && x + w - 1 >= loX && y <= hiY && y + h - 1 >= loY; })
      .map((o) => o.id);
    setSelected((prev) => (additive ? new Set([...prev, ...hits]) : new Set(hits)));
    if (hits.length) setAnchorId(hits[0]);
  }, [map, activeLayerId]);

  const onMoveGroup = useCallback((ids: number[], dx: number, dy: number) => {
    if (map) run(moveObjectsCommand(map, ids, dx, dy));
  }, [map, run]);

  // --- layer panel actions ---
  const onToggleLayer = useCallback((layerId: number) => {
    if (map) run(toggleLayerEnabledCommand(map, layerId));
  }, [map, run]);

  const onToggleObject = useCallback((objectId: number) => {
    if (map) run(toggleObjectEnabledCommand(map, objectId));
  }, [map, run]);

  // --- props panel actions ---
  const onToggleLayerVisible = useCallback(() => {
    if (map && activeLayerId != null) run(toggleLayerEnabledCommand(map, activeLayerId));
  }, [map, activeLayerId, run]);

  const onSetObjectsVisible = useCallback((visible: boolean) => {
    if (map && selected.size) run(setObjectsEnabledCommand(map, [...selected], visible));
  }, [map, selected, run]);

  const onSetRectToMap = useCallback((id: number) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o) return;
    const beforeRect = [...o.rect] as Rect;
    const afterRect: Rect = [0, 0, map.width, map.height];
    if (rectEquals(beforeRect, afterRect)) return;
    const beforeTerrain = o.terrain ? cloneTerrainForRect(o.terrain) : undefined;
    const afterTerrain = o.terrain ? resizeTerrainToRect(o.terrain, afterRect) : undefined;
    run(setObjectRectCommand(map, id, beforeRect, afterRect, beforeTerrain, afterTerrain));
  }, [map, run]);

  const onSetRectToAabb = useCallback((id: number) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o) return;
    const beforeRect = [...o.rect] as Rect;
    const afterRect = o.terrain ? terrainAabb(o.terrain) : beforeRect;
    if (!afterRect || rectEquals(beforeRect, afterRect)) return;
    const beforeTerrain = o.terrain ? cloneTerrainForRect(o.terrain) : undefined;
    const afterTerrain = o.terrain ? resizeTerrainToRect(o.terrain, afterRect) : undefined;
    run(setObjectRectCommand(map, id, beforeRect, afterRect, beforeTerrain, afterTerrain));
  }, [map, run]);

  const commitRandomizeTerrain = useCallback((id: number, config: TerrainNoiseConfig, previewBase?: { before: TerrainSnapshot; beforeTags: Record<string, string> }) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o?.terrain || !(o.type === "TERRAIN_2_CORNER" || o.type === "TERRAIN_2_EDGE")) return;
    const before: TerrainSnapshot = previewBase?.before ?? { terrain: cloneTerrain(o.terrain), rect: [...o.rect] as Rect };
    const beforeTags = previewBase?.beforeTags ?? { ...o.tags };
    const after: TerrainSnapshot = { terrain: regenerateTerrainByNoise(before.terrain, config), rect: [...before.rect] as Rect };
    const afterTags = applyTerrainNoiseConfig(beforeTags, config);
    if (terrainMatrixEquals(before.terrain, after.terrain) && JSON.stringify(beforeTags) === JSON.stringify(afterTags)) return;
    run(randomizeTerrainCommand(map, id, before, after, beforeTags, afterTags));
  }, [map, run]);

  const onRandomizeTerrain = useCallback((id: number, config: TerrainNoiseConfig) => {
    terrainNoisePreview.current = null;
    commitRandomizeTerrain(id, config);
  }, [commitRandomizeTerrain]);

  const onPreviewTerrainNoise = useCallback((id: number, config: TerrainNoiseConfig) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o?.terrain || !(o.type === "TERRAIN_2_CORNER" || o.type === "TERRAIN_2_EDGE")) return;
    let preview = terrainNoisePreview.current;
    if (!preview || preview.id !== id) {
      preview = {
        id,
        before: { terrain: cloneTerrain(o.terrain), rect: [...o.rect] as Rect },
        beforeTags: { ...o.tags },
      };
      terrainNoisePreview.current = preview;
    }
    o.terrain = regenerateTerrainByNoise(preview.before.terrain, config);
    o.rect = [...preview.before.rect];
    o.tags = applyTerrainNoiseConfig(preview.beforeTags, config);
    setVersion((v) => v + 1);
  }, [map]);

  const onCancelTerrainNoisePreview = useCallback(() => {
    if (!map) return;
    const preview = terrainNoisePreview.current;
    if (!preview) return;
    const o = findObject(map, preview.id);
    terrainNoisePreview.current = null;
    if (!o) return;
    o.terrain = cloneTerrain(preview.before.terrain);
    o.rect = [...preview.before.rect];
    o.tags = { ...preview.beforeTags };
    setVersion((v) => v + 1);
  }, [map]);

  const onCommitTerrainNoisePreview = useCallback((id: number, config: TerrainNoiseConfig) => {
    const preview = terrainNoisePreview.current;
    terrainNoisePreview.current = null;
    if (preview && preview.id === id) {
      commitRandomizeTerrain(id, config, { before: preview.before, beforeTags: preview.beforeTags });
      return;
    }
    commitRandomizeTerrain(id, config);
  }, [commitRandomizeTerrain]);

  const onSetTerrainBorderAsConnected = useCallback((id: number, enabled: boolean) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o || !(o.type === "TERRAIN_2_CORNER" || o.type === "TERRAIN_2_EDGE")) return;
    const before = { ...o.tags };
    const after = { ...o.tags };
    if (enabled) after.borderAsConnected = "true";
    else delete after.borderAsConnected;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    run({
      label: "Border as connected",
      do: () => {
        const target = findObject(map, id);
        if (target) target.tags = { ...after };
      },
      undo: () => {
        const target = findObject(map, id);
        if (target) target.tags = { ...before };
      },
    });
  }, [map, run]);

  const onRunMorph = useCallback((id: number, mode: "dilate" | "erode" | "erode_dilate" | "dilate_erode", dilate: TerrainNoiseConfig, erode: TerrainNoiseConfig) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!isBitwiseSupported(o)) return;
    const before: TerrainSnapshot = { terrain: cloneTerrain(o.terrain), rect: [...o.rect] as Rect };
    const beforeTags = { ...o.tags };
    const connected = borderAsConnected(o);
    let nextTerrain = cloneTerrain(o.terrain);
    switch (mode) {
      case "dilate":
        nextTerrain = dilateTerrainMatrix(nextTerrain, dilate, connected);
        break;
      case "erode":
        nextTerrain = erodeTerrainMatrix(nextTerrain, erode, connected);
        break;
      case "erode_dilate":
        nextTerrain = erodeTerrainMatrix(nextTerrain, erode, connected);
        nextTerrain = dilateTerrainMatrix(nextTerrain, dilate, connected);
        break;
      case "dilate_erode":
        nextTerrain = dilateTerrainMatrix(nextTerrain, dilate, connected);
        nextTerrain = erodeTerrainMatrix(nextTerrain, erode, connected);
        break;
    }
    const afterTags = applyNoiseConfig(applyNoiseConfig(o.tags, "web.dilate", dilate), "web.erode", erode);
    if (terrainMatrixEquals(before.terrain, nextTerrain) && JSON.stringify(beforeTags) === JSON.stringify(afterTags)) return;
    const after: TerrainSnapshot = { terrain: nextTerrain, rect: [...o.rect] as Rect };
    const label = mode === "dilate" ? "Dilate"
      : mode === "erode" ? "Erode"
      : mode === "erode_dilate" ? "Erode then dilate"
      : "Dilate then erode";
    run(terrainMutationWithTagsCommand(map, id, before, after, beforeTags, afterTags, label));
  }, [map, run]);

  const onOpenBitwise = useCallback((id: number) => {
    if (!map) return;
    const target = findObject(map, id);
    if (!isBitwiseSupported(target)) return;
    setBitwiseTargetId(id);
  }, [map]);

  const onInitBitwise = useCallback((id: number, filled: boolean) => {
    if (!map) return;
    const target = findObject(map, id);
    if (!isBitwiseSupported(target)) return;
    const before: TerrainSnapshot = { terrain: cloneTerrain(target.terrain), rect: [...target.rect] as Rect };
    const afterTerrain = fillTerrainMatrix(target.terrain, filled);
    if (terrainMatrixEquals(before.terrain, afterTerrain)) return;
    const after: TerrainSnapshot = { terrain: afterTerrain, rect: [...target.rect] as Rect };
    run(bitwiseObjectCommand(map, id, before, after, filled ? "Init full" : "Init empty"));
  }, [map, run]);

  const onRunBitwiseQuickOp = useCallback((id: number, op: "keep_border" | "flip" | "remove_zero") => {
    if (!map) return;
    const target = findObject(map, id);
    if (!isBitwiseSupported(target)) return;
    const before: TerrainSnapshot = { terrain: cloneTerrain(target.terrain), rect: [...target.rect] as Rect };
    const afterTerrain = op === "keep_border"
      ? keepBorderTerrainMatrix(target.terrain)
      : op === "flip"
        ? flipTerrainMatrix(target.terrain)
        : removeZeroLikeDesktop(target.terrain, target.type, borderAsConnected(target));
    if (terrainMatrixEquals(before.terrain, afterTerrain)) return;
    const after: TerrainSnapshot = { terrain: afterTerrain, rect: [...target.rect] as Rect };
    const label = op === "keep_border" ? "Keep border" : op === "flip" ? "Flip" : "Remove zero";
    run(bitwiseObjectCommand(map, id, before, after, label));
  }, [map, run]);

  const onCloseBitwise = useCallback(() => {
    setBitwiseTargetId(null);
    setBitwiseSourceId(null);
  }, []);

  const onRename = useCallback((id: number, name: string) => {
    if (!map) return;
    const o = findObject(map, id);
    if (o) run(renameObjectCommand(map, id, o.tags["web.name"] ?? "", name));
  }, [map, run]);

  // convert a terrain object's autotile type (fix 2-edge/2-corner mislabels)
  const onSetObjectType = useCallback((id: number, type: LiteType) => {
    if (!map) return;
    const o = findObject(map, id);
    if (o && o.type !== type) run(setObjectTypeCommand(map, id, o.type, type));
  }, [map, run]);

  // manually pick (hash) or reset (null) the palette bound to an object
  const onSetPalette = useCallback((id: number, hash: string | null) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o) return;
    const before = o.tags["web.palette"];
    const after = hash ?? undefined;
    if (before !== after) run(setObjectPaletteCommand(map, id, before, after));
  }, [map, run]);

  const onAddFrgCell = useCallback((id: number, paletteHash: string) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o || o.type !== "FIXED_RECT_GROUP") return;
    const before = effectiveFrgCells(o);
    if (before.some((cell) => cell.palette === paletteHash)) return;
    const after = [...before, { palette: paletteHash, weight: 100 }];
    run(setFrgCellsCommand(map, id, before, after, "Add FRG cell"));
  }, [map, run, effectiveFrgCells]);

  const onRemoveFrgCell = useCallback((id: number, index: number) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o || o.type !== "FIXED_RECT_GROUP") return;
    const before = effectiveFrgCells(o);
    if (index < 0 || index >= before.length) return;
    const after = before.filter((_, i) => i !== index);
    run(setFrgCellsCommand(map, id, before, after, "Delete FRG cell"));
  }, [map, run, effectiveFrgCells]);

  const onSetFrgCellWeight = useCallback((id: number, index: number, weight: number) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o || o.type !== "FIXED_RECT_GROUP") return;
    const before = effectiveFrgCells(o);
    if (index < 0 || index >= before.length) return;
    const nextWeight = Math.max(0, Math.round(weight));
    if (before[index].weight === nextWeight) return;
    const after = before.map((cell, i) => (i === index ? { ...cell, weight: nextWeight } : cell));
    run(setFrgCellsCommand(map, id, before, after, "FRG cell weight"));
  }, [map, run, effectiveFrgCells]);

  const onSetFrgPlacementMode = useCallback((id: number, placementMode: FrgPlacementMode) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o || o.type !== "FIXED_RECT_GROUP") return;
    const before = effectiveFrgPlacementMode(o);
    if (before === placementMode) return;
    run(setFrgPlacementModeCommand(map, id, before, placementMode));
  }, [map, run, effectiveFrgPlacementMode]);

  const onApplyFrgNoise = useCallback((id: number, config: TerrainNoiseConfig) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o || o.type !== "FIXED_RECT_GROUP" || !o.terrain) return;
    const before: TerrainSnapshot = { terrain: cloneTerrain(o.terrain), rect: [...o.rect] as Rect };
    const beforeTags = { ...o.tags };
    const afterTags = applyNoiseConfig(o.tags, "web.frg", config);
    if (JSON.stringify(beforeTags) === JSON.stringify(afterTags)) return;
    const after: TerrainSnapshot = { terrain: cloneTerrain(o.terrain), rect: [...o.rect] as Rect };
    run(terrainMutationWithTagsCommand(map, id, before, after, beforeTags, afterTags, "FRG noise"));
  }, [map, run]);

  // --- house decoration drag (door/window/chimney within the house rect) ---
  const onHouseDecoStart = useCallback((id: number, index: number) => {
    if (!map) { decoDrag.current = null; return; }
    const o = findObject(map, id);
    decoDrag.current = o?.house?.decorations[index] ? { id, index, before: [...o.house.decorations[index].cell] as [number, number] } : null;
  }, [map]);

  const onHouseDecoMove = useCallback((id: number, index: number, cell: [number, number]) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o?.house?.decorations[index]) return;
    const cur = o.house.decorations[index].cell;
    if (cur[0] === cell[0] && cur[1] === cell[1]) return;
    o.house.decorations[index].cell = [...cell];
    setVersion((v) => v + 1); // live preview (also recompiles, but house bindings don't depend on cell)
  }, [map]);

  const onHouseDecoEnd = useCallback(() => {
    const d = decoDrag.current;
    decoDrag.current = null;
    if (!map || !d) return;
    const o = findObject(map, d.id);
    if (!o?.house?.decorations[d.index]) return;
    const after = [...o.house.decorations[d.index].cell] as [number, number];
    if (after[0] !== d.before[0] || after[1] !== d.before[1]) run(moveHouseDecoCommand(map, d.id, d.index, d.before, after));
  }, [map, run]);

  // --- house inspector: palettes, overlap, dynamic decorations ---
  const onSetHouseSlot = useCallback((id: number, slot: "wall" | "roof" | number, hash: string | null) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o?.house) return;
    const after = hash ?? undefined;
    if (slot === "wall" || slot === "roof") {
      if (o.house[slot] !== after) run(setHouseSlotPaletteCommand(map, id, slot, o.house[slot], after));
    } else {
      const before = o.house.decorations[slot]?.palette;
      if (before !== after) run(setHouseDecoPaletteCommand(map, id, slot, before, after));
    }
  }, [map, run]);

  const onSetWallHeight = useCallback((id: number, height: number) => {
    if (!map) return;
    const o = findObject(map, id);
    if (o?.house && o.house.wallHeight !== height) run(setWallHeightCommand(map, id, o.house.wallHeight, height));
  }, [map, run]);

  const onSetHouseOverlap = useCallback((id: number, overlap: number) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o?.house || o.house.overlap === overlap) return;
    run(setHouseOverlapCommand(map, id, o.house.overlap, overlap));
  }, [map, run]);

  const onAddHouseDecoration = useCallback((id: number, kind: HouseDecorationKind, palette?: string) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o?.house) return;
    const before = o.house.decorations.map((deco) => ({ ...deco, cell: [...deco.cell] as [number, number] }));
    const after = [...before, { kind, cell: [0, 0] as [number, number], ...(palette ? { palette } : {}) }];
    run(setHouseDecorationsCommand(map, id, before, after, "Add decoration"));
  }, [map, run]);

  const onRemoveHouseDecoration = useCallback((id: number, index: number) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o?.house?.decorations[index]) return;
    const before = o.house.decorations.map((deco) => ({ ...deco, cell: [...deco.cell] as [number, number] }));
    const after = before.filter((_, i) => i !== index);
    run(setHouseDecorationsCommand(map, id, before, after, "Remove decoration"));
  }, [map, run]);

  const onGenerateHouseDecorations = useCallback((id: number) => {
    if (!map) return;
    const o = findObject(map, id);
    if (!o?.house) return;
    const hb = bindings?.get(id);
    if (!hb || hb.kind !== "house") return;
    const before = o.house.decorations.map((deco) => ({ ...deco, cell: [...deco.cell] as [number, number] }));
    const seed = Math.floor(Math.random() * 0xffffffff);
    const after = generateDecorations(o.house, o.rect, hb.deco, seed);
    if (JSON.stringify(before) !== JSON.stringify(after)) run(setHouseDecorationsCommand(map, id, before, after, "Generate decorations"));
  }, [map, bindings, run]);

  const onObjectDragStart = useCallback((layerId: number, objectId: number) => (e: ReactDragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `${layerId}:${objectId}`);
    setDragging({ layerId, objectId });
    setDropTarget(null);
  }, []);

  const onObjectDragOver = useCallback((layerId: number, objectId: number) => (e: ReactDragEvent<HTMLDivElement>) => {
    if (!dragging || dragging.layerId !== layerId || dragging.objectId === objectId) return;
    e.preventDefault();
    const side = dropSideFromEvent(e);
    setDropTarget((prev) => (
      prev && prev.layerId === layerId && prev.targetId === objectId && prev.side === side
        ? prev
        : { layerId, targetId: objectId, side }
    ));
    e.dataTransfer.dropEffect = "move";
  }, [dragging]);

  const onObjectDrop = useCallback((layerId: number, objectId: number) => (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!map || !dragging || dragging.layerId !== layerId || dragging.objectId === objectId) return;
    const layer = findLayer(map, layerId);
    if (!layer) return;
    const before = layer.objects.map((o) => o.id);
    const after = reorderWithinLayer(before, dragging.objectId, objectId, dropSideFromEvent(e));
    if (!sameOrder(before, after)) run(reorderLayerObjectsCommand(map, layerId, before, after));
    setDragging(null);
    setDropTarget(null);
  }, [map, dragging, run]);

  const onObjectDragEnd = useCallback(() => {
    setDragging(null);
    setDropTarget(null);
  }, []);
  const nextObjectId = useCallback((cur: LiteTileMap) => {
    let maxId = -1;
    for (const layer of cur.layers) for (const obj of layer.objects) maxId = Math.max(maxId, obj.id);
    return maxId + 1;
  }, []);

  const collectActiveLayerSelection = useCallback(() => {
    if (!map || activeLayerId == null) return null;
    const layer = findLayer(map, activeLayerId);
    if (!layer) return null;
    const entries = layer.objects
      .map((obj, index) => ({ object: obj, index }))
      .filter((entry) => selected.has(entry.object.id));
    return entries.length > 0 ? { layer, entries } : null;
  }, [map, activeLayerId, selected]);

  const cloneSelectionIntoSnapshots = useCallback((
    layerId: number,
    entries: ClipboardEntry[],
    step: number,
    existingNames: Set<string>,
  ) => {
    if (!map) return { snapshots: [] as LayerObjectSnapshot[], ids: [] as number[] };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const entry of entries) {
      const obj = entry.object;
      minX = Math.min(minX, obj.rect[0]);
      minY = Math.min(minY, obj.rect[1]);
      maxX = Math.max(maxX, obj.rect[0] + obj.rect[2]);
      maxY = Math.max(maxY, obj.rect[1] + obj.rect[3]);
    }
    const unitDx = maxX < map.width ? 1 : minX > 0 ? -1 : 0;
    const unitDy = maxY < map.height ? 1 : minY > 0 ? -1 : 0;
    const dx = unitDx * Math.max(1, step);
    const dy = unitDy * Math.max(1, step);
    const insertAt = Math.max(...entries.map((entry) => entry.index)) + 1;
    let nextId = nextObjectId(map);
    const snapshots: LayerObjectSnapshot[] = [];
    const ids: number[] = [];
    entries.forEach((entry, offsetIndex) => {
      const clone = cloneObjectDeep(entry.object, nextId++);
      translateObject(clone, dx, dy);
      const baseName = clone.tags["web.baseName"] || clone.tags["blueprint.label"] || roleOf(clone) || clone.type;
      clone.tags["web.name"] = uniqueName(existingNames, baseName);
      snapshots.push({ layerId, index: insertAt + offsetIndex, object: clone });
      ids.push(clone.id);
    });
    return { snapshots, ids };
  }, [map, nextObjectId]);

  const onCopySelection = useCallback(() => {
    const active = collectActiveLayerSelection();
    if (!active) return;
    setClipboard({
      layerId: active.layer.id,
      layerName: active.layer.name,
      entries: active.entries.map((entry) => ({ index: entry.index, object: cloneObjectDeep(entry.object) })),
      pasteCount: 0,
    });
  }, [collectActiveLayerSelection]);

  const onDeleteSelection = useCallback(() => {
    if (!map || selected.size === 0) return;
    const snapshots: LayerObjectSnapshot[] = [];
    for (const layer of map.layers) {
      layer.objects.forEach((obj, index) => {
        if (selected.has(obj.id)) snapshots.push({ layerId: layer.id, index, object: cloneObjectDeep(obj) });
      });
    }
    if (snapshots.length === 0) return;
    run(deleteObjectsCommand(map, snapshots));
    setSelected(new Set());
    setAnchorId(null);
  }, [map, selected, run]);

  const onDuplicateSelection = useCallback(() => {
    const active = collectActiveLayerSelection();
    if (!active || !map) return;
    const existingNames = new Set<string>();
    for (const mapLayer of map.layers) for (const obj of mapLayer.objects) existingNames.add(displayName(obj));
    const clipboardEntries = active.entries.map((entry) => ({ index: entry.index, object: cloneObjectDeep(entry.object) }));
    const { snapshots, ids: newIds } = cloneSelectionIntoSnapshots(active.layer.id, clipboardEntries, 1, existingNames);
    if (snapshots.length === 0) return;
    run(createObjectsCommand(map, snapshots));
    setSelected(new Set(newIds));
    setAnchorId(newIds[0] ?? null);
  }, [collectActiveLayerSelection, cloneSelectionIntoSnapshots, map, run]);

  const canPaste = !!(map && activeLayerId != null && clipboard && clipboard.entries.length > 0 && clipboard.layerId === activeLayerId);
  const pasteTitle = !clipboard
    ? "没有可粘贴对象"
    : clipboard.layerId !== activeLayerId
      ? `只能粘贴回 ${clipboard.layerName} 层`
      : "粘贴当前剪贴板 (Cmd/Ctrl+V)";

  const onPasteClipboard = useCallback(() => {
    if (!map || activeLayerId == null || !clipboard || clipboard.layerId !== activeLayerId || clipboard.entries.length === 0) return;
    const existingNames = new Set<string>();
    for (const mapLayer of map.layers) for (const obj of mapLayer.objects) existingNames.add(displayName(obj));
    const { snapshots, ids: newIds } = cloneSelectionIntoSnapshots(
      activeLayerId,
      clipboard.entries.map((entry) => ({ index: entry.index, object: cloneObjectDeep(entry.object) })),
      clipboard.pasteCount + 1,
      existingNames,
    );
    if (snapshots.length === 0) return;
    run(createObjectsCommand(map, snapshots));
    setSelected(new Set(newIds));
    setAnchorId(newIds[0] ?? null);
    setClipboard((prev) => prev && prev.layerId === activeLayerId ? { ...prev, pasteCount: prev.pasteCount + 1 } : prev);
  }, [map, activeLayerId, clipboard, cloneSelectionIntoSnapshots, run]);

  const activeLayer = useMemo(() => (map && activeLayerId != null ? findLayer(map, activeLayerId) : null), [map, activeLayerId, version]);
  const activeRoot = activeLayer?.tags["role.root"] ?? "";
  const createPaletteChoices = useMemo(() => {
    if (!pack || !activeRoot) return [] as CreatePaletteChoice[];
    const out: CreatePaletteChoice[] = [];
    for (const palette of pack.palettes) {
      if (roleRoot(palette.role) !== activeRoot) continue;
      for (const kind of paletteCreateKinds(palette)) out.push({ kind, palette, role: palette.role });
    }
    return sortCreateChoices(out);
  }, [pack, activeRoot]);
  const houseWallChoices = useMemo(() => {
    if (!pack || activeRoot !== "building") return [] as CreatePaletteChoice[];
    const out: CreatePaletteChoice[] = [];
    for (const palette of pack.palettes) {
      if (!isStructureMode(palette.mode)) continue;
      if (palette.role !== HOUSE_WALL_ROLE && !(palette.role === HOUSE_CREATE_ROLE && palette.mode === PaletteMode.CLIFF)) continue;
      out.push({ kind: "house", palette, role: palette.role });
    }
    return sortCreateChoices(out);
  }, [pack, activeRoot]);
  const houseRoofChoices = useMemo(() => {
    if (!pack || activeRoot !== "building") return [] as CreatePaletteChoice[];
    const out: CreatePaletteChoice[] = [];
    for (const palette of pack.palettes) {
      if (!isStructureMode(palette.mode)) continue;
      if (palette.role !== HOUSE_ROOF_ROLE) continue;
      out.push({ kind: "house", palette, role: palette.role });
    }
    return sortCreateChoices(out);
  }, [pack, activeRoot]);
  const createKindOptions = useMemo(
    () => {
      const seen = new Set(createPaletteChoices.map((choice) => choice.kind));
      if (houseWallChoices.length > 0 && houseRoofChoices.length > 0) seen.add("house");
      const order = activeRoot === "building" ? BUILDING_KIND_ORDER : DEFAULT_KIND_ORDER;
      return order.filter((kind) => seen.has(kind));
    },
    [createPaletteChoices, houseWallChoices, houseRoofChoices, activeRoot],
  );
  const createPaletteOptions = useMemo(
    () => createPaletteChoices.filter((choice) => choice.kind === createKind),
    [createPaletteChoices, createKind],
  );
  const selectedCreateChoice = useMemo(
    () => createKind === "house" ? null : createPaletteOptions.find((choice) => choice.palette.hash === createPaletteHash) ?? null,
    [createKind, createPaletteOptions, createPaletteHash],
  );
  const selectedCreateHouseWall = useMemo(
    () => houseWallChoices.find((choice) => choice.palette.hash === createHouseWallHash) ?? null,
    [houseWallChoices, createHouseWallHash],
  );
  const selectedCreateHouseRoof = useMemo(
    () => houseRoofChoices.find((choice) => choice.palette.hash === createHouseRoofHash) ?? null,
    [houseRoofChoices, createHouseRoofHash],
  );

  useEffect(() => {
    if (createKindOptions.length === 0) {
      setCreateArmed(false);
      setCreatePaletteHash("");
      setCreateHouseWallHash("");
      setCreateHouseRoofHash("");
      return;
    }
    setCreateKind((prev) => (createKindOptions.includes(prev) ? prev : createKindOptions[0]));
  }, [createKindOptions]);

  useEffect(() => {
    if (createKind === "house") return;
    if (createPaletteOptions.length === 0) {
      setCreatePaletteHash("");
      setCreateArmed(false);
      setCreateModalOpen(false);
      return;
    }
    setCreatePaletteHash((prev) => createPaletteOptions.some((choice) => choice.palette.hash === prev) ? prev : createPaletteOptions[0].palette.hash);
  }, [createKind, createPaletteOptions]);

  useEffect(() => {
    if (createKind !== "house") return;
    if (houseWallChoices.length === 0 || houseRoofChoices.length === 0) {
      setCreateArmed(false);
      setCreateModalOpen(false);
      return;
    }
    setCreateHouseWallHash((prev) => houseWallChoices.some((choice) => choice.palette.hash === prev) ? prev : houseWallChoices[0].palette.hash);
    setCreateHouseRoofHash((prev) => houseRoofChoices.some((choice) => choice.palette.hash === prev) ? prev : houseRoofChoices[0].palette.hash);
  }, [createKind, houseWallChoices, houseRoofChoices]);

  useEffect(() => {
    if (createArmed) setMarquee(false);
  }, [createArmed]);

  useEffect(() => {
    if (!createArmed) return;
    if (createKind === "house") {
      if (!selectedCreateHouseWall || !selectedCreateHouseRoof) setCreateArmed(false);
      return;
    }
    if (!selectedCreateChoice) setCreateArmed(false);
  }, [createArmed, createKind, selectedCreateChoice, selectedCreateHouseWall, selectedCreateHouseRoof]);

  const openCreateModal = useCallback(() => {
    if (!activeLayer || createKindOptions.length === 0) return;
    setMarquee(false);
    setCreateArmed(false);
    setCreateModalOpen(true);
  }, [activeLayer, createKindOptions]);

  const createPickerRequest = useMemo<PaletteCreateRequest | null>(() => {
    if (!createModalOpen || !activeLayer || createKindOptions.length === 0) return null;
    return {
      mode: "create",
      title: "Create Object",
      subtitle: `${activeLayer.name} · ${activeRoot || "layer role"}`,
      kindOptions: createKindOptions.map((kind) => ({ kind, label: CREATE_KIND_LABEL[kind] })),
      selectedKind: createKind,
      onSelectKind: (kind) => setCreateKind(kind as CreateKind),
      onConfirm: () => {
        if (createKind === "house") {
          if (!selectedCreateHouseWall || !selectedCreateHouseRoof) return;
        } else if (!selectedCreateChoice) return;
        setCreateModalOpen(false);
        setCreateArmed(true);
      },
      ...(createKind === "house"
        ? {
            selectionMode: "house" as const,
            houseSlots: [
              {
                key: "wall",
                label: "Wall Palette",
                role: HOUSE_WALL_ROLE,
                currentHash: createHouseWallHash,
                choices: houseWallChoices.map((choice) => ({ kind: choice.kind, role: choice.role, palette: choice.palette })),
                onPick: (hash: string) => setCreateHouseWallHash(hash),
              },
              {
                key: "roof",
                label: "Roof Palette",
                role: HOUSE_ROOF_ROLE,
                currentHash: createHouseRoofHash,
                choices: houseRoofChoices.map((choice) => ({ kind: choice.kind, role: choice.role, palette: choice.palette })),
                onPick: (hash: string) => setCreateHouseRoofHash(hash),
              },
            ],
          }
        : {
            selectionMode: "single" as const,
            choices: createPaletteChoices.map((choice) => ({ kind: choice.kind, role: choice.role, palette: choice.palette })),
            currentHash: createPaletteHash,
            onPick: (hash: string) => setCreatePaletteHash(hash),
          }),
      confirmDisabled: createKind === "house" ? !selectedCreateHouseWall || !selectedCreateHouseRoof : !selectedCreateChoice,
      confirmLabel: "Place",
    };
  }, [createModalOpen, activeLayer, activeRoot, createKindOptions, createKind, createPaletteChoices, createPaletteHash, selectedCreateChoice, createHouseWallHash, createHouseRoofHash, houseWallChoices, houseRoofChoices, selectedCreateHouseWall, selectedCreateHouseRoof]);

  const onCreateAt = useCallback((tx: number, ty: number) => {
    if (!map || !activeLayer || !createKindOptions.includes(createKind)) return;
    const id = nextObjectId(map);
    const created = createKind === "house"
      ? (() => {
          if (!selectedCreateHouseWall || !selectedCreateHouseRoof) return null;
          const width = Math.max(2, selectedCreateHouseWall.palette.size[0], selectedCreateHouseRoof.palette.size[0]);
          const height = Math.max(2, selectedCreateHouseWall.palette.size[1] + selectedCreateHouseRoof.palette.size[1] - 1);
          return createObjectForRole(map, id, HOUSE_CREATE_ROLE, createKind, tx, ty, {
            houseWallHash: selectedCreateHouseWall.palette.hash,
            houseRoofHash: selectedCreateHouseRoof.palette.hash,
            size: [width, height],
            style: selectedCreateHouseRoof.palette.style || selectedCreateHouseWall.palette.style,
          });
        })()
      : (() => {
          if (!selectedCreateChoice) return null;
          return createObjectForRole(map, id, selectedCreateChoice.role, createKind, tx, ty, {
            paletteHash: selectedCreateChoice.palette.hash,
            size: selectedCreateChoice.palette.size,
            style: selectedCreateChoice.palette.style,
          });
        })();
    if (!created) return;
    run(createObjectCommand(map, activeLayer.id, created));
    setSelected(new Set([id]));
    setAnchorId(id);
    setCreateArmed(false);
  }, [map, activeLayer, selectedCreateChoice, selectedCreateHouseWall, selectedCreateHouseRoof, createKind, createKindOptions, nextObjectId, run]);

  const createPlacementLabel = useMemo(() => {
    if (createKind === "house") {
      if (!selectedCreateHouseWall || !selectedCreateHouseRoof) return "";
      const wall = selectedCreateHouseWall.palette.style || "wall";
      const roof = selectedCreateHouseRoof.palette.style || "roof";
      return `house (${wall} / ${roof})`;
    }
    return selectedCreateChoice ? (selectedCreateChoice.palette.style || selectedCreateChoice.role) : "";
  }, [createKind, selectedCreateChoice, selectedCreateHouseWall, selectedCreateHouseRoof]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) onRedo(); else onUndo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && selected.size > 0) {
        e.preventDefault();
        onCopySelection();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v" && canPaste) {
        e.preventDefault();
        onPasteClipboard();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && selected.size > 0) {
        e.preventDefault();
        onDuplicateSelection();
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selected.size > 0) {
        e.preventDefault();
        onDeleteSelection();
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && map) {
        const k = e.key.toLowerCase();
        if (k === "m") {
          e.preventDefault();
          setMarquee((m) => {
            const next = !m;
            setBrushConfig((prev) => ({ ...prev, tool: next ? "select" : "brush" }));
            return next;
          });
        } else if (k === "b") {
          e.preventDefault();
          onChangeBrushConfig({ tool: "brush" });
        } else if (k === "e") {
          e.preventDefault();
          onChangeBrushConfig({ tool: "eraser" });
        } else if (k === "u") {
          e.preventDefault();
          onChangeBrushConfig({ tool: "rect" });
        } else if (k === "g") {
          e.preventDefault();
          onChangeBrushConfig({ tool: "bucket" });
        } else if (k === "i") {
          e.preventDefault();
          onChangeBrushConfig({ tool: "eyedropper" });
        } else if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          const sizes = [1, 2, 3, 5, 7];
          setBrushConfig((prev) => {
            const idx = Math.max(0, sizes.indexOf(prev.size));
            const nextIdx = e.key === "[" ? Math.max(0, idx - 1) : Math.min(sizes.length - 1, idx + 1);
            return { ...prev, size: sizes[nextIdx] };
          });
        } else if (e.key === "Escape") {
          setMarquee(false);
          setCreateArmed(false);
          setCreateModalOpen(false);
          setNewMapOpen(false);
          setResizeMapOpen(false);
          onCloseBitwise();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onUndo, onRedo, map, selected.size, canPaste, onCopySelection, onPasteClipboard, onDuplicateSelection, onDeleteSelection, onCloseBitwise, onChangeBrushConfig]);

  const selObjs = useMemo(() => (map ? ([...selected].map((id) => findObject(map, id)).filter(Boolean) as LiteObject[]) : []), [map, selected, version]);
  const bitwiseTarget = useMemo(() => (map && bitwiseTargetId != null ? findObject(map, bitwiseTargetId) : null), [map, bitwiseTargetId, version]);
  const bitwiseSources = useMemo(() => {
    if (!map || !isBitwiseSupported(bitwiseTarget)) return [] as {
      id: number;
      label: string;
      layerId: number;
      layerName: string;
      type: LiteType;
      role: string;
      overlap: boolean;
      origin: [number, number];
      size: [number, number];
    }[];
    const out: {
      id: number;
      label: string;
      layerId: number;
      layerName: string;
      type: LiteType;
      role: string;
      overlap: boolean;
      origin: [number, number];
      size: [number, number];
    }[] = [];
    for (const layer of map.layers) {
      for (const obj of layer.objects) {
        if (obj.id === bitwiseTarget.id || !isBitwiseSupported(obj)) continue;
        out.push({
          id: obj.id,
          label: displayName(obj),
          layerId: layer.id,
          layerName: layer.name,
          type: obj.type,
          role: roleOf(obj),
          overlap: hasBitwiseOverlap(bitwiseTarget.terrain, obj.terrain),
          origin: [obj.rect[0], obj.rect[1]],
          size: [obj.rect[2], obj.rect[3]],
        });
      }
    }
    return out;
  }, [map, bitwiseTarget, version]);
  useEffect(() => {
    if (!bitwiseTargetId || bitwiseSources.length === 0) {
      setBitwiseSourceId(null);
      return;
    }
    if (bitwiseSourceId != null && bitwiseSources.some((source) => source.id === bitwiseSourceId)) return;
    setBitwiseSourceId(bitwiseSources.find((source) => source.overlap)?.id ?? bitwiseSources[0].id);
  }, [bitwiseTargetId, bitwiseSources, bitwiseSourceId]);
  const onApplyBitwise = useCallback((op: BitwiseObjectOp) => {
    if (!map || !isBitwiseSupported(bitwiseTarget) || bitwiseSourceId == null) return;
    const source = findObject(map, bitwiseSourceId);
    if (!isBitwiseSupported(source)) return;
    const before: TerrainSnapshot = { terrain: cloneTerrain(bitwiseTarget.terrain), rect: [...bitwiseTarget.rect] as Rect };
    const afterTerrain = applyBitwiseObjectOp(bitwiseTarget.terrain, source.terrain, op);
    if (terrainMatrixEquals(before.terrain, afterTerrain)) {
      onCloseBitwise();
      return;
    }
    const after: TerrainSnapshot = { terrain: afterTerrain, rect: [...bitwiseTarget.rect] as Rect };
    run(bitwiseObjectCommand(map, bitwiseTarget.id, before, after, `Bitwise ${op}`));
    onCloseBitwise();
  }, [map, bitwiseTarget, bitwiseSourceId, run, onCloseBitwise]);
  const bitwiseRequest = useMemo(() => {
    if (!map || !isBitwiseSupported(bitwiseTarget)) return null;
    const targetLayer = layerOfObject(map, bitwiseTarget.id);
    return {
      targetLabel: displayName(bitwiseTarget),
      targetLayerName: targetLayer?.name ?? "Unknown layer",
      targetType: bitwiseTarget.type,
      targetRole: roleOf(bitwiseTarget),
      sources: bitwiseSources,
      selectedSourceId: bitwiseSourceId,
      onSelectSource: (id: number) => setBitwiseSourceId(id),
      onApply: onApplyBitwise,
    };
  }, [map, bitwiseTarget, bitwiseSources, bitwiseSourceId, onApplyBitwise]);

  const brushRgb = useMemo(() => colorForRole(brushConfig.role), [brushConfig.role]);
  const brush: BrushState = {
    rgb: brushRgb,
    size: brushConfig.size,
    erase: brushConfig.tool === "eraser",
    ready: brushConfig.tool !== "select",
    tool: brushConfig.tool,
  };
  const canUndo = undo.current.canUndo;
  const canRedo = undo.current.canRedo;

  return (
    <div className="app">
      <header className="topbar">
        <strong>Blueprint Studio · HD-2D</strong>
        <button onClick={() => setNewMapOpen(true)} title={lang === "zh" ? "新建 7层结构空白地图" : "Create new 7-layer map"}>
          🗺️ {lang === "zh" ? "新建" : "New"}
        </button>
        <button onClick={() => fileInput.current?.click()}>
          📂 {lang === 'zh' ? '打开蓝图/存档…' : 'Open Blueprint/Save…'}
        </button>
        <input ref={fileInput} type="file" accept=".json" hidden
          onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
        {map && (
          <>
            <button onClick={() => setResizeMapOpen(true)} title={lang === "zh" ? "调整地图宽高尺寸 (9宫格锚点)" : "Resize Map Dimensions"}>
              📐 {map.width}×{map.height}
            </button>
            <button disabled={!canUndo} onClick={onUndo} title={lang === 'zh' ? "撤销 (Cmd/Ctrl+Z)" : "Undo (Cmd/Ctrl+Z)"}>↶ Undo</button>
            <button disabled={!canRedo} onClick={onRedo} title={lang === 'zh' ? "重做 (Shift+Cmd/Ctrl+Z)" : "Redo (Shift+Cmd/Ctrl+Z)"}>↷ Redo</button>
            <button onClick={onExport} title={lang === 'zh' ? "导出 adna-web-lite 存档 (支持直接再打开)" : "Export Save File"}>⤓ {lang === "zh" ? "保存" : "Save"}</button>
            <button disabled={selected.size === 0} onClick={onCopySelection} title={lang === 'zh' ? "复制当前对象/组到内部剪贴板 (Cmd/Ctrl+C)" : "Copy current object/group to clipboard (Cmd/Ctrl+C)"}>⧉ Copy</button>
            <button disabled={!canPaste} onClick={onPasteClipboard} title={pasteTitle}>⎘ Paste</button>
            <button disabled={selected.size === 0} onClick={onDeleteSelection} title={lang === 'zh' ? "删除当前对象/组 (Delete)" : "Delete current object/group (Delete)"}>⌫ Del</button>

            <span className="ts-sep" />
            <span className="ts-label">{lang === "zh" ? "视口" : "Viewports"}</span>
            <span className="seg">
              <button
                className={viewLayout === "triple" ? "active" : ""}
                onClick={() => setViewLayout("triple")}
                title={lang === "zh" ? "左: 2D TileMap 编辑 · 右上: 3D Scene 自由观察/选中 · 右下: 3D Game 锁定玩家视角" : "Left: 2D TileMap Edit · Top-Right: 3D Scene View · Bottom-Right: 3D Game View"}
              >
                {lang === "zh" ? "三视口 (TileMap + Scene + Game)" : "Triple (TileMap + Scene + Game)"}
              </button>
              <button
                className={viewLayout === "tilemap_game" ? "active" : ""}
                onClick={() => setViewLayout("tilemap_game")}
                title={lang === "zh" ? "左: 2D TileMap 编辑 · 右: 3D Game 玩家视角" : "Left: 2D TileMap Edit · Right: 3D Game View"}
              >
                TileMap + Game
              </button>
              <button
                className={viewLayout === "tilemap_scene" ? "active" : ""}
                onClick={() => setViewLayout("tilemap_scene")}
                title={lang === "zh" ? "左: 2D TileMap 编辑 · 右: 3D Scene 自由观察/选中" : "Left: 2D TileMap Edit · Right: 3D Scene View"}
              >
                TileMap + Scene
              </button>
              <button
                className={viewLayout === "2d" ? "active" : ""}
                onClick={() => setViewLayout("2d")}
                title={lang === "zh" ? "全屏 2D TileMap 平面编辑" : "Full-screen 2D TileMap Editor"}
              >
                {lang === "zh" ? "仅 2D TileMap" : "2D TileMap"}
              </button>
            </span>

            {pack && (
              <>
                <span className="ts-sep" />
                <span className="ts-label">Tiles</span>
                <span className="seg">
                  <button className={renderMode === "blueprint" ? "active" : ""} onClick={() => setRenderMode("blueprint")} title={lang === 'zh' ? "抽象示意图(role 颜色)" : "Abstract blueprint layout (role colors)"}>Overlay</button>
                  <button className={renderMode === "mixed" ? "active" : ""} onClick={() => setRenderMode("mixed")} title={lang === 'zh' ? "已绑定的画真实图块,其余示意" : "Mixed real tiles and blueprint layout representation"}>Mixed</button>
                  <button className={renderMode === "real" ? "active" : ""} onClick={() => setRenderMode("real")} title={lang === 'zh' ? "只画真实图块" : "Real tiles rendering only"}>Real</button>
                </span>
              </>
            )}
          </>
        )}
        <span className="spacer" />
        {map && <span className="stat">{map.name}{version > 0 && <em className="muted">{lang === 'zh' ? ' · 进度已存本地' : ' · Saved locally'}</em>}</span>}
        <button
          style={{
            marginLeft: '8px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            padding: '3px 8px',
            borderRadius: '4px',
            fontSize: '11px',
            cursor: 'pointer',
            color: 'var(--fg)'
          }}
          onClick={() => {
            const nextLang = lang === 'zh' ? 'en' : 'zh';
            setLang(nextLang);
            localStorage.setItem('adna_lang', nextLang);
          }}
        >
          🌐 {lang === 'zh' ? 'EN' : '中文'}
        </button>
      </header>

      {error && <div className="error">{error}</div>}

      {!map ? (
        <div className="dropzone">
          <div>{lang === 'zh' ? <>把 <code>blueprint.json</code> 或 <code>.adnaweb.json</code> 拖到这里，或点击上方「新建 / 打开」</> : <>Drag <code>blueprint.json</code> or <code>.adnaweb.json</code> here, or click "New / Open"</>}</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={loadSample}>{lang === 'zh' ? '试用村庄样例' : 'Try Village Sample'}</button>
            <button onClick={() => setNewMapOpen(true)}>{lang === 'zh' ? '新建空白 7层地图' : 'New Blank 7-Layer Map'}</button>
          </div>
        </div>
      ) : (
        <div className="main" style={{ "--layers-w": `${layersWidth}px`, "--props-w": `${propsWidth}px` } as CSSProperties}>
          <RoleTreeBrushPanel
            map={map}
            pack={pack}
            lang={lang}
            brushConfig={brushConfig}
            onChangeBrushConfig={onChangeBrushConfig}
            activeLayerId={activeLayerId}
            selected={selected}
            expandedLayers={expanded}
            onSelectLayer={(layerId) => setActiveLayerId(layerId)}
            onToggleExpandLayer={toggleExpand}
            onToggleLayerEnabled={onToggleLayer}
            onToggleObjectEnabled={onToggleObject}
            onObjectClick={onObjectClick}
            onOpenCreateModal={openCreateModal}
            onDuplicateSelection={onDuplicateSelection}
            onDeleteSelection={onDeleteSelection}
            draggingObjectId={dragging?.objectId ?? null}
            dropTarget={dropTarget}
            onObjectDragStart={onObjectDragStart}
            onObjectDragOver={onObjectDragOver}
            onObjectDrop={onObjectDrop}
            onObjectDragEnd={onObjectDragEnd}
          />
          <div className="resizer left-resizer" onMouseDown={startLayersResize} title="拖动调整左栏宽度" />

          <div
            ref={stageRef}
            className={`viewport-stage layout-${viewLayout}${resizingSplit !== "none" ? " is-resizing-views" : ""}`}
          >
            {createArmed && createPlacementLabel && (
              <div className="create-armed-banner">
                Click map to place <strong>{createPlacementLabel}</strong> · Press Esc to cancel
              </div>
            )}
            <div
              className="canvas-panel-wrap"
              style={{
                flex: viewLayout === "2d" ? "1 1 100%" : `0 0 ${viewSplitH * 100}%`,
                width: viewLayout === "2d" ? "100%" : undefined,
                minWidth: 0,
                height: "100%",
                display: "flex",
                position: "relative",
              }}
            >
              <CanvasView
                map={map}
                version={version}
                pack={pack}
                bindings={bindings}
                renderMode={renderMode}
                packVersion={packVersion}
                onHouseDecoStart={onHouseDecoStart}
                onHouseDecoMove={onHouseDecoMove}
                onHouseDecoEnd={onHouseDecoEnd}
                brush={brush}
                selected={selected}
                marqueeArmed={marquee || brushConfig.tool === "select"}
                createArmed={createArmed}
                playerPos={[player.x, player.z]}
                onPlacePlayer={onPlacePlayer}
                onPick={onPick}
                onCreateAt={onCreateAt}
                onCopySelection={onCopySelection}
                canPasteClipboard={canPaste}
                onPasteClipboard={onPasteClipboard}
                onDeleteSelection={onDeleteSelection}
                onMove={onMove}
                onMoveGroup={onMoveGroup}
                onResize={onResize}
                onToggleLock={onToggleLock}
                onStrokeStart={onStrokeStart}
                onStrokePaint={onStrokePaint}
                onStrokeEnd={onStrokeEnd}
                onRectFill={onRectFill}
                onBucketFill={onBucketFill}
                onEyedropper={onEyedropper}
                onMarquee={onMarquee}
                onMarqueeDone={() => setMarquee(false)}
              />
            </div>
            {viewLayout !== "2d" && (
              <>
                <div
                  className="view-resizer view-resizer-col"
                  onMouseDown={startViewHResize}
                  onDoubleClick={resetViewH}
                  title={lang === "zh" ? "左右拖动调整 2D 与 3D 视图宽度 (双击居中 50%)" : "Drag to resize 2D & 3D width (Double-click for 50%)"}
                />
                <div
                  ref={stackColRef}
                  className="hd2d-stack-column"
                  style={{ flex: 1, minWidth: 0, height: "100%" }}
                >
                  {(viewLayout === "triple" || viewLayout === "tilemap_scene") && (
                    <div
                      className="hd2d-panel-wrap scene-panel-wrap"
                      style={{
                        flex: viewLayout === "triple" ? `0 0 ${viewSplitV * 100}%` : "1 1 100%",
                        height: viewLayout === "triple" ? undefined : "100%",
                        minHeight: 0,
                        position: "relative",
                        display: "flex",
                      }}
                    >
                      <Hd2dView
                        viewRole="scene"
                        map={map}
                        version={version}
                        pack={pack}
                        bindings={bindings}
                        renderMode={renderMode}
                        packVersion={packVersion}
                        selected={selected}
                        player={player}
                        onChangePlayer={setPlayer}
                        onPickObject={onPick}
                        lang={lang}
                      />
                    </div>
                  )}
                  {viewLayout === "triple" && (
                    <div
                      className="view-resizer view-resizer-row"
                      onMouseDown={startViewVResize}
                      onDoubleClick={resetViewV}
                      title={lang === "zh" ? "上下拖动调整 Scene 与 Game 视图高度 (双击居中 50%)" : "Drag to resize Scene & Game height (Double-click for 50%)"}
                    />
                  )}
                  {(viewLayout === "triple" || viewLayout === "tilemap_game") && (
                    <div
                      className="hd2d-panel-wrap game-panel-wrap"
                      style={{
                        flex: 1,
                        minHeight: 0,
                        height: viewLayout === "tilemap_game" ? "100%" : undefined,
                        position: "relative",
                        display: "flex",
                      }}
                    >
                      <Hd2dView
                        viewRole="game"
                        map={map}
                        version={version}
                        pack={pack}
                        bindings={bindings}
                        renderMode={renderMode}
                        packVersion={packVersion}
                        selected={selected}
                        player={player}
                        onChangePlayer={setPlayer}
                        lang={lang}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="resizer right-resizer" onMouseDown={startPropsResize} title="拖动调整右栏宽度" />
          <PropsPanel
            layer={activeLayer}
            mapSize={[map.width, map.height]}
            objects={selObjs}
            pack={pack}
            bindings={bindings}
            onToggleLayerVisible={onToggleLayerVisible}
            onSetObjectsVisible={onSetObjectsVisible}
            onToggleLock={onToggleLock}
            onSetRectToMap={onSetRectToMap}
            onSetRectToAabb={onSetRectToAabb}
            onRandomizeTerrain={onRandomizeTerrain}
            onPreviewTerrainNoise={onPreviewTerrainNoise}
            onCommitTerrainNoisePreview={onCommitTerrainNoisePreview}
            onCancelTerrainNoisePreview={onCancelTerrainNoisePreview}
            onSetTerrainBorderAsConnected={onSetTerrainBorderAsConnected}
            onRunMorph={onRunMorph}
            onInitBitwise={onInitBitwise}
            onRunBitwiseQuickOp={onRunBitwiseQuickOp}
            onOpenBitwise={onOpenBitwise}
            onRename={onRename}
            onSetObjectType={onSetObjectType}
            onSetPalette={onSetPalette}
            onAddFrgCell={onAddFrgCell}
            onRemoveFrgCell={onRemoveFrgCell}
            onSetFrgCellWeight={onSetFrgCellWeight}
            onSetFrgPlacementMode={onSetFrgPlacementMode}
            onApplyFrgNoise={onApplyFrgNoise}
            onSetHouseSlot={onSetHouseSlot}
            onSetWallHeight={onSetWallHeight}
            onSetHouseOverlap={onSetHouseOverlap}
            onAddHouseDecoration={onAddHouseDecoration}
            onRemoveHouseDecoration={onRemoveHouseDecoration}
            onGenerateHouseDecorations={onGenerateHouseDecorations}
          />
          <PalettePickerModal pack={pack} request={createPickerRequest} onClose={() => setCreateModalOpen(false)} />
          <BitwiseObjectModal request={bitwiseRequest} onClose={onCloseBitwise} />
        </div>
      )}
      <NewMapModal
        open={newMapOpen}
        lang={lang}
        onClose={() => setNewMapOpen(false)}
        onCreate={onNewMap}
      />
      {map && (
        <ResizeMapModal
          open={resizeMapOpen}
          lang={lang}
          currentWidth={map.width}
          currentHeight={map.height}
          onClose={() => setResizeMapOpen(false)}
          onResize={onResizeMap}
        />
      )}
    </div>
  );
}
