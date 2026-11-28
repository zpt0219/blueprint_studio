import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Dialog, NewMapDialog, PaletteDialog, UploadDialog, TilesetDialog } from "./Dialogs";
import type { Atlases } from "./draw";
import { decodeProject, encodeProject, MAX_PROJECT_BYTES, readDraft, tilesetImage, writeDraft } from "./files";
import { changeHistory, makeHistory, type Edit } from "./history";
import Layers from "./Layers";
import MapCanvas from "./MapCanvas";
import Materials from "./Materials";
import {
  cardPosition, deleteCard, deleteEncounter, fillElevationRect, fillRect, flattenElevationRect,
  floodFill, moveCard, moveEncounter, cellReferences, gridPosition, makeMap, newId, paint,
  paintElevation, paintElevationDelta, pickCell, resolveSurfaces, upsertEncounter, worldPosition,
  type Cell, type EncounterKind, type Palette, type Point, type TileMap,
} from "./model";
import { mergePack, replaceTileset } from "./assets";
import { hydrateAkSceneDetails, migrateLegacyAkDraft, needsAkSceneHydration, needsLegacyAkMigration, readAkDesignedProject } from "./akBeachDesign";
import { buildPortablePatch } from "./patchAssets";
import { copySelection, clearSelection, moveSelection, pasteSelection, type Selection, type Clipboard } from "./selection";
import { AK_PROJECT_URL, worldPreviewSurfaces } from "./world";
import { materializeDeltaProject, packDeltaProject, rebaseWorldSnapshot } from "./worldRebase";
import { terrainHeightAt } from "./worldTerrainData";
import "./tilemap.css";

const MapPreview = lazy(() => import("./MapPreview"));

type Modal =
  | { type: "tileset" | "recover" | "game" | "new" | "upload" | "palette" | "remove-asset" | "remove-palette" | "remove-layer" | "ak" }
  | { type: "open"; file: File }
  | { type: "rebase"; doc: TileMap; baseline: TileMap; filename: string };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "文件操作失败。";
}

function hasContent(map: TileMap) {
  return !!map.world || map.tilesets.length > 0 || map.layers.length > 1 || Object.keys(map.layers[0].cells).length > 0
    || map.width !== 48 || map.height !== 36 || map.layers[0].name !== "图层 1" || !map.layers[0].visible;
}

export default function TilemapEditor() {
  const [history, dispatch] = useReducer(changeHistory, undefined, () => makeHistory(makeMap()));
  const map = history.present;
  const [ready, setReady] = useState(false);
  const [atlases, setAtlases] = useState<Atlases>(new Map());
  const [layerId, setLayerId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [selected, setSelected] = useState<Cell | null>(null);
  const [materialsMode, setMaterialsMode] = useState<"atlas" | "palette">("atlas");
  const [tool, setTool] = useState<"brush" | "eraser" | "eyedropper" | "fill" | "rect" | "elevation" | "select" | "area" | "encounter">("brush");
  const [elevationMode, setElevationMode] = useState<"set" | "delta" | "flatten">("set");
  const [elevationShape, setElevationShape] = useState<"brush" | "rect">("brush");
  const [selection, setSelection] = useState<Selection | null>(null);
  const clipboard = useRef<Clipboard | null>(null);
  const [savedMap, setSavedMap] = useState<TileMap>();
  const [savePending, setSavePending] = useState(false);
  const packInput = useRef<HTMLInputElement>(null);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [selectedEncounter, setSelectedEncounter] = useState<string | null>(null);
  const [brushSize, setBrushSize] = useState(1);
  const [elevation, setElevation] = useState("3");
  const elevationVisited = useRef<Set<number>>(new Set());
  const flattenTarget = useRef<number | null>(null);
  const [show3D, setShow3D] = useState(false);
  const [focus, setFocus] = useState<Point>();
  const [pointFocus, setPointFocus] = useState<Point>();
  const [jump, setJump] = useState<{ point?: Point }>();
  const [location, setLocation] = useState("");
  const focusAt = useCallback((next: Point, precise = false) => {
    if (precise) {
      const tile: Point = [Math.floor(next[0]), Math.floor(next[1])];
      setLocation("");
      setPointFocus(previous => previous?.[0] === next[0] && previous?.[1] === next[1] ? previous : next);
      setFocus(previous => previous?.[0] === tile[0] && previous?.[1] === tile[1] ? previous : tile);
      return;
    }
    setFocus(previous => previous?.[0] === next[0] && previous?.[1] === next[1] ? previous : next);
  }, []);
  const defaultFocus = useMemo<Point>(() => [Math.floor(map.width / 2) + 0.5, Math.floor(map.height / 2) + 0.5], [map.width, map.height]);
  const previewFocus = useMemo<Point | undefined>(() =>
    pointFocus ?? (focus ? [focus[0] + 0.5, focus[1] + 0.5] : (map.world || show3D ? defaultFocus : undefined)),
  [pointFocus, focus, map.world, show3D, defaultFocus]);
  const focusedTile = useMemo<Point | undefined>(() =>
    previewFocus ? [Math.floor(previewFocus[0]), Math.floor(previewFocus[1])] : focus, [previewFocus, focus]);
  const [panKey, setPanKey] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState(false);
  const openInput = useRef<HTMLInputElement>(null);
  const lastQueued = useRef<TileMap>();
  const saveQueue = useRef(Promise.resolve());
  const pointRequest = useRef(0);

  const activeLayer = map.layers.find(layer => layer.id === layerId) ?? map.layers[0];
  const activeAsset = map.tilesets.find(asset => asset.id === assetId) ?? map.tilesets[0];
  const activePalette = selected && "palette" in selected
    ? map.palettes.find(palette => palette.id === selected.palette) : undefined;
  const rawBrush = selected && "tileset" in selected && map.tilesets.some(asset => asset.id === selected.tileset)
    ? selected : null;
  const brush = activePalette ? selected : rawBrush;
  const surfaces = useMemo(() => resolveSurfaces(map), [
    map.width, map.height, map.layers, map.palettes,
    map.world?.heights, map.world?.elevations, map.world?.metresPerTile,
  ]);
  const settledMap = history.strokeStart ?? map;
  const world = map.world;
  const previewSurfaces = useMemo(() => worldPreviewSurfaces(surfaces, world?.lavaCells), [surfaces, world?.lavaCells]);
  const activeCard = world?.cards?.find(card => card.id === selectedCard);
  const activeCardPosition = world && activeCard && cardPosition(world, map.width, activeCard, surfaces);
  const activeEncounter = world?.encounters?.find(enc => enc.id === selectedEncounter);
  const focusPosition = world && previewFocus && worldPosition(world, ...previewFocus).map(value => Number(value.toFixed(3)));
  const focusIndex = focusedTile && focusedTile[1] * map.width + focusedTile[0];
  const focusSurface = focusIndex === undefined ? undefined : surfaces[focusIndex];
  const tileHeight = (focusSurface?.height ?? 0) * (world?.metresPerTile ?? 1);
  const savedPoint = world?.testPoint;
  const markerPoint = world?.markers.find(marker => marker.id === location)?.position;
  const anchor = pointFocus && focusPosition && [savedPoint, markerPoint].find(at =>
    at && Math.abs(at[0] - focusPosition[0]) < 0.001 && Math.abs(at[2] - focusPosition[1]) < 0.001);
  const focusHeight = focusIndex !== undefined && tileHeight === world?.heights[focusIndex] && anchor
    ? anchor[1] : tileHeight;

  useEffect(() => {
    let cancelled = false;
    readDraft().then(async saved => {
      const draft = saved && await withAkSceneDetails(saved, { migrateDraft: true });
      if (!cancelled && draft) {
        const unchanged = draft === saved;
        lastQueued.current = unchanged ? draft : saved;
        setSavedMap(unchanged ? draft : undefined);
        dispatch({ type: "reset", map: draft });
        if (draft.palettes.some(palette => palette.tileset === draft.tilesets[0]?.id)) setMaterialsMode("palette");
      }
    }).catch(() => {
      if (!cancelled) setNotice("本地草稿读取失败。可以通过项目包恢复。");
    }).finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready || lastQueued.current === settledMap) return;
    lastQueued.current = settledMap;
    setSavePending(true);
    saveQueue.current = saveQueue.current.then(() => writeDraft(settledMap))
      .then(() => { setSaveError(false); setSavedMap(settledMap); setSavePending(false); }, () => { setSaveError(true); setSavePending(false); });
  }, [ready, settledMap]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(map.tilesets.map(async asset => {
      try {
        return [asset.id, { image: await tilesetImage(asset.png), tileSize: asset.tileSize }] as const;
      } catch {
        if (!cancelled) setNotice(`无法读取图集 ${asset.name}。`);
        return null;
      }
    })).then(entries => {
      if (!cancelled) setAtlases(new Map(entries.filter(entry => entry !== null)));
    });
    return () => { cancelled = true; };
  }, [map.tilesets]);

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (ready && (savedMap !== map || saveError)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [ready, savedMap, map, saveError]);

  useEffect(() => {
    const clearPan = () => setPanKey(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (modal || busy || !ready) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, select, textarea, [contenteditable=true]")) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey) {
        if (key === "s") { event.preventDefault(); void download(); return; }
        if ((key === "c" || key === "x") && selection && tool === "area") {
          event.preventDefault(); clipboard.current = copySelection(map, activeLayer.id, selection);
          if (key === "x") edit(current => clearSelection(current, activeLayer.id, selection));
          setNotice("已复制当前图层选区，点击目标格后 Ctrl+V 粘贴。"); return;
        }
        if (key === "v" && clipboard.current) {
          event.preventDefault();
          const clip = clipboard.current;
          const at: Point = selection ? [selection.x, selection.y] : focusedTile ?? [0, 0];
          edit(current => pasteSelection(current, activeLayer.id, clip, at));
          setSelection({ x: at[0], y: at[1], width: Math.min(clip.width, map.width - at[0]), height: Math.min(clip.height, map.height - at[1]) });
          setTool("area"); return;
        }
        if (key !== "z" && key !== "y") return;
        event.preventDefault();
        dispatch({ type: key === "y" || event.shiftKey ? "redo" : "undo" });
      } else if (tool === "area" && selection && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault(); edit(current => clearSelection(current, activeLayer.id, selection));
      } else if (event.key === "Escape" && tool === "area") { setSelection(null);
      } else if (key === "r") { setTool("area");
      } else if (tool === "select" && (event.key === "Delete" || event.key === "Backspace") && selectedCard) {
        event.preventDefault();
        dispatch({ type: "edit", apply: current => deleteCard(current, selectedCard) });
      } else if (event.key === "Escape" && tool === "select") {
        setSelectedCard(null);
      } else if (tool === "encounter" && (event.key === "Delete" || event.key === "Backspace") && selectedEncounter) {
        event.preventDefault();
        dispatch({ type: "edit", apply: current => deleteEncounter(current, selectedEncounter) });
        setSelectedEncounter(null);
      } else if (event.key === "Escape" && tool === "encounter") {
        setSelectedEncounter(null);
      } else if (key === "v" && map.world?.cards) setTool("select");
      else if (key === "t" && map.world) setTool("encounter");
      else if (event.code === "Space" && !target?.closest("button, summary")) {
        event.preventDefault();
        setPanKey(true);
      } else if (key === "b") setTool("brush");
      else if (key === "e") setTool("eraser");
      else if (key === "i") setTool("eyedropper");
      else if (key === "g") setTool("fill");
      else if (key === "u") setTool("rect");
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === "Space") clearPan(); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearPan);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearPan);
    };
  }, [busy, modal, ready, tool, selectedCard, selectedEncounter, map, selection, activeLayer.id, focusedTile]);

  const dismiss = () => setModal(null);
  const edit = (apply: Edit) => dispatch({ type: "edit", apply });

  function reset(next: TileMap) {
    dispatch({ type: "reset", map: next });
    setLayerId(next.layers[0].id);
    setAssetId(next.tilesets[0]?.id ?? "");
    setSelected(null);
    setSelectedCard(null);
    setSelectedEncounter(null);
    setSelection(null);
    clipboard.current = null;
    setMaterialsMode(next.palettes.some(palette => palette.tileset === next.tilesets[0]?.id) ? "palette" : "atlas");
    setTool("brush");
    pointRequest.current++;
    setFocus(undefined);
    setPointFocus(undefined);
    setJump(undefined);
    setLocation("");
    setRevision(value => value + 1);
    dismiss();
  }

  async function openProject(file: File) {
    dismiss();
    setBusy(true);
    try {
      if (file.size > MAX_PROJECT_BYTES) throw new Error("项目包最多 96 MB。");
      const decoded = await decodeProject(new Uint8Array(await file.arrayBuffer()));
      if (decoded.world?.id === "ak-world-v1") {
        try {
          const baseline = await readAkProject();
          if (baseline.world && decoded.world.revision !== baseline.world.revision) {
            setModal({ type: "rebase", doc: decoded, baseline, filename: file.name });
            return;
          }
          const materialized = decoded.world.delta ? materializeDeltaProject(decoded, baseline) : decoded;
          reset(needsAkSceneHydration(materialized) ? hydrateAkSceneDetails(materialized, baseline) : materialized);
          setNotice(`已打开 ${file.name}。`);
          return;
        } catch {
          if (decoded.world.delta) throw new Error("无法读取 AK 基线快照，无法展开增量项目包。");
        }
      }
      reset(await withAkSceneDetails(decoded));
      setNotice(`已打开 ${file.name}。`);
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function readLocalAkBaseline(): Promise<TileMap | undefined> {
    if (!import.meta.env.DEV) return undefined;
    try {
      const local = await fetch(`${import.meta.env.BASE_URL}ak-world.bptilemap.local`);
      if (local.ok && !local.headers.get("content-type")?.includes("text/html")) {
        return decodeProject(new Uint8Array(await local.arrayBuffer()));
      }
    } catch {
      // Fall back to the bundled baseline snapshot.
    }
    return undefined;
  }

  async function readAkProject(): Promise<TileMap> {
    const local = await readLocalAkBaseline();
    if (local) return local;
    const response = await fetch(AK_PROJECT_URL);
    if (!response.ok) throw new Error("无法读取 AK 地图快照。");
    return decodeProject(new Uint8Array(await response.arrayBuffer()));
  }

  async function withAkSceneDetails(document: TileMap, options?: { migrateDraft?: boolean }): Promise<TileMap> {
    if (document.world?.id !== "ak-world-v1") return document;
    let current = document;
    let baseline: TileMap | undefined;
    if (current.world?.delta || needsAkSceneHydration(current)) {
      try {
        baseline = await readAkProject();
        if (current.world?.delta) current = materializeDeltaProject(current, baseline);
        if (needsAkSceneHydration(current)) current = hydrateAkSceneDetails(current, baseline);
      } catch {
        setNotice("AK 场景素材读取失败，可以稍后重新打开项目。");
      }
    }
    if (options?.migrateDraft && needsLegacyAkMigration(current)) {
      try {
        current = migrateLegacyAkDraft(current, await readAkDesignedProject(baseline));
      } catch {
        setNotice("AK 旧草稿升级数据读取失败，保留当前草稿内容。");
      }
    }
    return current;
  }

  async function openAkProject(mode: "designed" | "baseline" = "designed") {
    dismiss();
    setBusy(true);
    try {
      const baseline = await readAkProject();
      if (mode === "baseline") {
        reset(baseline);
        setNotice("已打开 AK 原始快照。");
      } else {
        const project = await readAkDesignedProject(baseline);
        reset(project);
        setNotice("已打开 AK 设计地图。");
      }
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function saveFile(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadPatch() {
    setBusy(true);
    try {
      const patch = await buildPortablePatch(map, await readAkProject());
      saveFile(new Blob([JSON.stringify(patch, null, 2)], { type: "application/json" }), "ak-world-patch.json");
      setNotice(`已下载补丁 · ${patch.changes.length} 格素材 · ${patch.elevations.length} 格高程 · ${patch.decorations.length} 个面片。`);
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    try {
      let target = map;
      let compact = false;
      if (map.world?.id === "ak-world-v1") {
        try {
          const baseline = await readAkProject();
          if (baseline.world?.revision === map.world.revision) {
            target = packDeltaProject(map, baseline);
            compact = true;
          }
        } catch {
          // Fall back to full standalone archive if baseline is unreachable.
        }
      }
      const bytes = await encodeProject(target);
      saveFile(new Blob([bytes as BlobPart], { type: "application/zip" }), world ? "ak-world.bptilemap" : "tilemap.bptilemap");
      setNotice(compact ? `增量项目包已生成（${Math.round(bytes.length / 1024)} KB）。` : "项目包已生成。");
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function selectBrush(cell: Cell) {
    setSelected(cell);
    setTool("brush");
  }

  function savePalette(palette: Palette) {
    edit(current => ({
      ...current,
      palettes: current.palettes.some(item => item.id === palette.id)
        ? current.palettes.map(item => item.id === palette.id ? palette : item)
        : [...current.palettes, palette],
    }));
    selectBrush({ palette: palette.id });
    setMaterialsMode("palette");
    dismiss();
  }

  function removeMaterial(asset: boolean) {
    const tileset = asset ? activeAsset?.id : undefined;
    const paletteIds = new Set(map.palettes.filter(item =>
      asset ? item.tileset === tileset : item.id === activePalette?.id).map(item => item.id));
    const affected = map.layers.map(layer => ({
      layer, count: Object.values(layer.cells).filter(cell => cellReferences(cell, tileset, paletteIds)).length,
    })).filter(item => item.count > 0);
    const name = asset ? activeAsset?.name : activePalette?.name;
    return <Dialog title={asset ? "移除图集" : "删除 Palette"} onDismiss={dismiss}>
      <p>移除「{name}」。{affected.length > 0 && "以下图层中的引用会一并清空。"}</p>
      {affected.length > 0 && <ul>{affected.map(({ layer, count }) => <li key={layer.id}>{layer.name} · {count} 格</li>)}</ul>}
      <div className="tm-dialog-actions">
        <button type="button" onClick={dismiss}>取消</button>
        <button type="button" className="tm-danger" onClick={() => {
          edit(current => ({
            ...current,
            tilesets: current.tilesets.filter(item => item.id !== tileset),
            palettes: current.palettes.filter(item => !paletteIds.has(item.id)),
            layers: current.layers.map(layer => {
              const entries = Object.entries(layer.cells);
              const kept = entries.filter(([, cell]) => !cellReferences(cell, tileset, paletteIds));
              return kept.length === entries.length ? layer : { ...layer, cells: Object.fromEntries(kept) };
            }),
          }));
          dismiss();
        }}>{affected.length > 0 ? "清空引用并移除" : "移除"}</button>
      </div>
    </Dialog>;
  }

  function draw(from: Point, to: Point) {
    if (tool === "elevation") {
      if (elevationMode === "flatten") {
        if (flattenTarget.current === null && world) {
          const idx = from[1] * map.width + from[0];
          flattenTarget.current = world.elevations?.[idx] ?? world.heights[idx] ?? 0;
        }
        if (flattenTarget.current !== null) {
          const target = flattenTarget.current;
          dispatch({ type: "stroke", apply: current => paintElevation(current, from, to, brushSize, target) });
        }
        return;
      }
      const value = Number(elevation);
      if (!elevation.trim() || !Number.isFinite(value)) return;
      if (elevationMode === "delta") {
        if (value >= -40 && value <= 40 && value !== 0) {
          dispatch({ type: "stroke", apply: current => paintElevationDelta(current, from, to, brushSize, value, elevationVisited.current) });
        }
        return;
      }
      if (value >= -20 && value <= 100) {
        dispatch({ type: "stroke", apply: current => paintElevation(current, from, to, brushSize, value) });
      }
      return;
    }
    const cell = tool === "eraser" ? null : brush;
    if (tool === "brush" && !cell) return;
    dispatch({ type: "stroke", apply: current => paint(current, activeLayer.id, from, to, brushSize, cell) });
  }

  function finishStroke() {
    elevationVisited.current.clear();
    flattenTarget.current = null;
    dispatch({ type: "finish" });
  }

  function pickAt(tile: Point) {
    const idx = tile[1] * map.width + tile[0];
    if (tool === "elevation" && world) {
      const metres = world.elevations?.[idx] ?? world.heights[idx];
      if (metres !== undefined) {
        const rounded = Number(metres.toFixed(2));
        setElevation(String(rounded));
        setNotice(`已吸取高程 ${rounded} 米。`);
      }
      return;
    }
    const picked = pickCell(map, activeLayer.id, tile);
    if (!picked) {
      setNotice("该格没有可吸取的素材。");
      return;
    }
    setSelected(picked);
    if ("palette" in picked) {
      const pal = map.palettes.find(item => item.id === picked.palette);
      if (pal) {
        setAssetId(pal.tileset);
        setMaterialsMode("palette");
        setNotice(`已吸取素材「${pal.name}」。`);
      }
    } else {
      setAssetId(picked.tileset);
      setMaterialsMode("atlas");
      setNotice("已吸取图集格。");
    }
    if (tool === "eyedropper") setTool("brush");
  }

  function fillAt(tile: Point) {
    if (!activeLayer.visible) { setNotice("当前图层已隐藏，请先显示图层。"); return; }
    if (!brush) { setNotice("请先选择一个素材再填充。"); return; }
    edit(current => floodFill(current, activeLayer.id, tile, brush));
  }

  function rectDraw(from: Point, to: Point) {
    if (tool === "elevation") {
      if (elevationMode === "flatten") {
        edit(current => flattenElevationRect(current, from, to));
        return;
      }
      const value = Number(elevation);
      if (!elevation.trim() || !Number.isFinite(value)) return;
      if (elevationMode === "delta" && value >= -40 && value <= 40 && value !== 0) {
        edit(current => fillElevationRect(current, from, to, "delta", value));
      } else if (elevationMode === "set" && value >= -20 && value <= 100) {
        edit(current => fillElevationRect(current, from, to, "set", value));
      }
      return;
    }
    if (!activeLayer.visible) { setNotice("当前图层已隐藏，请先显示图层。"); return; }
    if (!brush) { setNotice("请先选择一个素材再矩形填充。"); return; }
    edit(current => fillRect(current, activeLayer.id, from, to, brush));
  }

  function placeEncounter(worldX: number, worldZ: number) {
    if (!world) return;
    const [gx, gz] = gridPosition(world, worldX, worldZ);
    const idx = Math.floor(gz) * map.width + Math.floor(gx);
    const y = Number((world.elevations?.[idx] ?? world.heights[idx] ?? 0).toFixed(3));
    const encounter = {
      id: newId(),
      name: `遭遇点 ${(world.encounters?.length ?? 0) + 1}`,
      kind: "encounter" as EncounterKind,
      position: [Number(worldX.toFixed(3)), y, Number(worldZ.toFixed(3))] as [number, number, number],
      radius: 10,
      tag: "",
    };
    edit(current => upsertEncounter(current, encounter));
    setSelectedEncounter(encounter.id);
    setNotice(`已放置触发区「${encounter.name}」。`);
  }

  async function setTestPoint([x, z]: Point) {
    if (!world) return;
    const request = ++pointRequest.current;
    const [worldX, worldZ] = worldPosition(world, x, z).map(value => Number(value.toFixed(3)));
    const index = Math.floor(z) * map.width + Math.floor(x);
    const baseline = world.heights[index];
    const height = (surfaces[index]?.height ?? (world.elevations?.[index] ?? baseline) / world.metresPerTile)
      * world.metresPerTile;
    const nextFocus = gridPosition(world, worldX, worldZ);
    setPointFocus(nextFocus);
    setFocus([Math.floor(nextFocus[0]), Math.floor(nextFocus[1])]);
    const nativeHeight = world.terrain && Math.abs(height - baseline) < 0.0005
      ? await terrainHeightAt(world.terrain, worldX, worldZ).catch(() => undefined) : undefined;
    if (request !== pointRequest.current) return;
    const metres = Number((nativeHeight ?? height).toFixed(3));
    edit(current => current.world ? {
      ...current, world: { ...current.world, testPoint: [worldX, metres, worldZ] },
    } : current);
    setNotice(`测试落点 X ${worldX} · Y ${metres.toFixed(2)} · Z ${worldZ}`);
  }

  const paletteSource = activePalette?.tiles.find(Boolean)
    ?? (rawBrush ? [rawBrush.x, rawBrush.y] as Point : null);

  if (!ready) return <div className="tm-loading">正在打开本地草稿…</div>;

  return <div className="tm-shell">
    <header className="tm-header">
      <div className="tm-brand">
        <div className="tm-mark" aria-hidden="true"><i /><i /><i /><i /></div>
        <div><strong>Blueprint Studio</strong><small>Tilemap</small></div>
      </div>
      <div className="tm-header-actions">
        <button type="button" disabled={busy} onClick={() => setModal({ type: "new" })}>新建</button>
        <button type="button" disabled={busy} onClick={() => openInput.current?.click()}>打开</button>
        <input ref={openInput} hidden type="file" accept=".bptilemap,.zip" onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (hasContent(map)) setModal({ type: "open", file });
          else void openProject(file);
        }} />
        <button type="button" disabled={busy} onClick={download}>下载</button>
        <button type="button" disabled={busy} onClick={() => {
          if (hasContent(map)) setModal({ type: "ak" });
          else void openAkProject();
        }}>打开 AK 大地图</button>
        {world && <button type="button" disabled={busy} onClick={() => setModal({ type: "game" })}>用于游戏</button>}
      </div>
      <button type="button" className="tm-view-switch" aria-pressed={show3D} onClick={() => setShow3D(value => !value)}>3D 预览</button>
    </header>

    <main className={show3D ? "tm-workspace tm-split" : "tm-workspace"}>
      <section className="tm-editor" aria-label="地图编辑区">
        <MapCanvas key={`map-${revision}`} width={map.width} height={map.height} atlases={atlases} surfaces={previewSurfaces}
          brushSize={brushSize}
          canPaint={!busy && (tool === "brush" || tool === "eraser" || (tool === "elevation" && elevationShape === "brush"))
            && (tool === "elevation" || (activeLayer.visible && (tool === "eraser" || !!brush)))}
          panKey={panKey}
          onPaint={draw} onCommit={finishStroke} world={world} focus={world || show3D ? previewFocus : undefined} jump={jump}
          onFocus={world || show3D ? focusAt : undefined} onTestPoint={world && !busy ? setTestPoint : undefined}
          selectArea={!busy && tool === "area"} selection={selection} onSelection={setSelection}
          onMoveSelection={(area, at) => {
            if (!activeLayer.visible) { setSelection(area); setNotice("当前图层已隐藏，请先显示图层。"); return; }
            edit(current => moveSelection(current, activeLayer.id, area, at));
          }}
          selectCards={!busy && tool === "select"} selectedCard={selectedCard} onSelectCard={setSelectedCard}
          onDragCard={(id, x, z) => dispatch({ type: "stroke", apply: current => moveCard(current, id, x, z) })}
          showElevation={tool === "elevation"}
          eyedropper={!busy && tool === "eyedropper"} onPickTile={!busy ? pickAt : undefined}
          fillMode={!busy && tool === "fill"} onFill={!busy ? fillAt : undefined}
          rectMode={!busy && (tool === "rect" || (tool === "elevation" && elevationShape === "rect"))}
          onRect={!busy ? rectDraw : undefined}
          selectEncounters={!busy && tool === "encounter"} selectedEncounter={selectedEncounter}
          onSelectEncounter={setSelectedEncounter} onPlaceEncounter={!busy ? placeEncounter : undefined}
          onDragEncounter={(id, x, z) => dispatch({ type: "stroke", apply: current => moveEncounter(current, id, x, z) })} />
        <div className="tm-tools">
          <button type="button" aria-pressed={tool === "brush"} title="画笔 (B)" onClick={() => setTool("brush")}>画笔</button>
          <button type="button" aria-pressed={tool === "eraser"} title="橡皮 (E)" onClick={() => setTool("eraser")}>橡皮</button>
          <button type="button" aria-pressed={tool === "eyedropper"} title="吸管 (I / Alt+点击)" onClick={() => setTool("eyedropper")}>吸管</button>
          <button type="button" aria-pressed={tool === "fill"} title="油漆桶填充 (G)" onClick={() => setTool("fill")}>填充</button>
          <button type="button" aria-pressed={tool === "rect"} title="矩形填充 (U)" onClick={() => setTool("rect")}>矩形</button>
          {!!world?.cards?.length && <button type="button" aria-pressed={tool === "select"} title="选择面片 (V)"
            onClick={() => setTool("select")}>选择</button>}
          <button type="button" aria-pressed={tool === "area"} title="框选当前图层 (R)" onClick={() => setTool("area")}>框选</button>
          {world && tool === "area" && selection && <button type="button" title="将框选区高程拉平到均值" onClick={() => {
            edit(current => flattenElevationRect(current, [selection.x, selection.y], [selection.x + selection.width - 1, selection.y + selection.height - 1]));
            setNotice("已平整选区高程。");
          }}>平整选区</button>}
          {world && <button type="button" aria-pressed={tool === "encounter"} title="遭遇点 / Boss 触发区 (T)"
            onClick={() => setTool("encounter")}>触发区</button>}
          <button type="button" disabled={!history.past.length && !history.strokeStart} title="Ctrl+Z" onClick={() => dispatch({ type: "undo" })}>撤销</button>
          <button type="button" disabled={!history.future.length} title="Ctrl+Shift+Z" onClick={() => dispatch({ type: "redo" })}>重做</button>
          {world && <button type="button" aria-pressed={tool === "elevation"} onClick={() => setTool("elevation")}>高程</button>}
          {world && tool === "elevation" && <>
            <select aria-label="高程模式" value={elevationMode} onChange={event => {
              const next = event.target.value as "set" | "delta" | "flatten";
              setElevationMode(next);
              if (next === "delta" && Number(elevation) > 5) setElevation("0.5");
            }}>
              <option value="set">绝对</option>
              <option value="delta">相对 ±</option>
              <option value="flatten">平整</option>
            </select>
            <select aria-label="高程形状" value={elevationShape} onChange={event => setElevationShape(event.target.value as "brush" | "rect")}>
              <option value="brush">画笔</option>
              <option value="rect">矩形</option>
            </select>
            {elevationMode !== "flatten" && <label className="tm-elevation"><input type="number"
              min={elevationMode === "delta" ? -40 : -20} max={elevationMode === "delta" ? 40 : 100}
              step={elevationMode === "delta" ? 0.25 : 0.01} aria-label={elevationMode === "delta" ? "相对高差（米）" : "高程（米）"}
              value={elevation} onChange={event => setElevation(event.target.value)} /> 米</label>}
          </>}
          {(tool === "brush" || tool === "eraser" || (tool === "elevation" && elevationShape === "brush")) && <select aria-label="笔刷大小" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))}>
            {[1, 3, 5, 9].map(size => <option key={size} value={size}>{size} 格</option>)}
          </select>}
        </div>
        <Layers key={`layers-${revision}`} layers={map.layers} active={activeLayer} onSelect={id => { setLayerId(id); setSelection(null); }} onEdit={edit}
          onRemove={() => setModal({ type: "remove-layer" })} />
        {world && <select className="tm-locations" aria-label="地图定位" value={location} onChange={event => {
          const id = event.target.value;
          const marker = world.markers.find(item => item.id === id);
          const point = marker && gridPosition(world, marker.position[0], marker.position[2]);
          setLocation(id);
          if (point) {
            setPointFocus(point);
            setFocus([Math.floor(point[0]), Math.floor(point[1])]);
          }
          setJump({ point });
        }}>
          <option value="" disabled>定位到…</option>
          <option value="overview">全图</option>
          {world.markers.map(marker => <option key={marker.id} value={marker.id}>{marker.name}</option>)}
        </select>}
        {activeCard && activeCardPosition && tool === "select" && <div className="tm-card-inspector">
          <span>{activeCard.name || "面片"} · X {activeCardPosition[0].toFixed(2)} · Y {activeCardPosition[1].toFixed(2)} · Z {activeCardPosition[2].toFixed(2)}</span>
          <button type="button" className="tm-danger" onClick={() => edit(current => deleteCard(current, activeCard.id!))}>删除面片</button>
        </div>}
        {activeEncounter && tool === "encounter" && <div className="tm-card-inspector tm-encounter-inspector">
          <input type="text" aria-label="触发区名称" value={activeEncounter.name}
            onChange={event => edit(current => upsertEncounter(current, { ...activeEncounter, name: event.target.value }))} />
          <select aria-label="触发区类型" value={activeEncounter.kind}
            onChange={event => edit(current => upsertEncounter(current, { ...activeEncounter, kind: event.target.value as EncounterKind }))}>
            <option value="boss">Boss 战</option>
            <option value="encounter">遭遇点</option>
            <option value="trigger">事件触发区</option>
          </select>
          <label>半径 <input type="number" min={1} max={128} step={0.5} aria-label="触发半径（米）" value={activeEncounter.radius}
            onChange={event => {
              const r = Number(event.target.value);
              if (Number.isFinite(r) && r > 0 && r <= 128) edit(current => upsertEncounter(current, { ...activeEncounter, radius: r }));
            }} /> 米</label>
          <input type="text" aria-label="Godot 标签" placeholder="标签（如 lake_temple_boss）" value={activeEncounter.tag ?? ""}
            onChange={event => edit(current => upsertEncounter(current, { ...activeEncounter, tag: event.target.value || undefined }))} />
          <span>X {activeEncounter.position[0].toFixed(1)} · Y {activeEncounter.position[1].toFixed(1)} · Z {activeEncounter.position[2].toFixed(1)}</span>
          <button type="button" className="tm-danger" onClick={() => {
            edit(current => deleteEncounter(current, activeEncounter.id));
            setSelectedEncounter(null);
          }}>删除</button>
        </div>}
        <div className="tm-map-hint">
          {tool === "area" && <span>框选当前图层 · 拖动移动 · Ctrl+C/X/V · Delete 清除 · Esc 取消</span>}
          {tool === "encounter" && <span>点击空地放置触发区 · 拖动圆心移动 · Delete 删除</span>}
          {tool === "eyedropper" && <span>点击格吸取素材（或任意工具按住 Alt+点击）</span>}
          {tool === "fill" && <span>点击连续同材质区域进行油漆桶填充</span>}
          {(tool === "rect" || (tool === "elevation" && elevationShape === "rect")) && <span>按住拖动矩形区域批量填充</span>}
          <span>{map.width} × {map.height}{world ? ` · ${world.metresPerTile} 米/格` : ""}</span>
          {world && focusPosition && <span>X {focusPosition[0]} · Y {focusHeight.toFixed(2)} · Z {focusPosition[1]}</span>}
          {world && <span>Shift+点击标记测试点</span>}
          {activeLayer.visible ? <span>滚轮缩放 · 空格拖动</span> : <span>当前图层已隐藏</span>}
        </div>
      </section>
      {show3D && <Suspense fallback={<div className="tm-preview tm-loading">正在打开 3D 预览…</div>}>
        <MapPreview key={revision} width={map.width} height={map.height} atlases={atlases} surfaces={previewSurfaces} world={world} focus={previewFocus} onFocus={point => focusAt(point, true)} />
      </Suspense>}
    </main>

    <Materials key={revision + "-" + (activeAsset?.id ?? "")} tilesets={map.tilesets} palettes={map.palettes} atlases={atlases}
      asset={activeAsset} brush={brush} mode={materialsMode} setMode={setMaterialsMode}
      onUpload={() => setModal({ type: "upload" })} onAsset={id => {
        setAssetId(id);
        setSelected(null);
        setMaterialsMode(map.palettes.some(item => item.tileset === id) ? "palette" : "atlas");
      }} onPick={selectBrush} onProperties={() => setModal({ type: "palette" })}
      onRemoveAsset={() => setModal({ type: "remove-asset" })} onAssetProperties={() => setModal({ type: "tileset" })}
      onImportPack={() => packInput.current?.click()} onExportPack={async () => {
        try { const bytes = await encodeProject({ ...makeMap(1, 1), tilesets: map.tilesets, palettes: map.palettes });
          saveFile(new Blob([bytes as BlobPart], { type: "application/zip" }), "materials.bppalette");
        } catch (error) { setNotice(errorText(error)); }
      }} />
    <input hidden ref={packInput} type="file" accept=".bppalette" onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      setBusy(true);
      try {
        if (file.size > MAX_PROJECT_BYTES) throw new Error("素材包最多 96 MB。");
        const pack = await decodeProject(new Uint8Array(await file.arrayBuffer()));
        edit(current => mergePack(current, pack)); setNotice("已合并素材包，可撤销。");
      } catch (error) { setNotice(errorText(error)); } finally { setBusy(false); }
    }} />
    <footer className="tm-status" aria-live="polite">
      <span title={notice}>{busy ? "正在处理项目…" : notice}</span><span>{saveError ? "草稿保存失败，请下载项目。" : savePending || savedMap !== map ? "正在保存草稿…" : "草稿已保存"}
        <button type="button" disabled={busy} onClick={() => setModal({ type: "recover" })}>恢复上一份</button></span>
    </footer>

    {modal?.type === "game" && <Dialog title="用于 AK 游戏" onDismiss={dismiss}>
      <p>先下载补丁。在 Blueprint Studio 目录运行下列命令。正式启用后，桌面游戏每次启动会加载修改，沿用已有游戏进度。</p>
      <pre>./scripts/ak-world.sh play ~/Downloads/ak-world-patch.json{"\n"}./scripts/ak-world.sh install ~/Downloads/ak-world-patch.json</pre>
      <p>恢复原版：<code>./scripts/ak-world.sh disable</code><br />回退上一版：<code>./scripts/ak-world.sh restore</code></p>
      <p>完整编辑资料请另存项目包。补丁用于运行游戏，启用或停用后需重启游戏。</p>
      <div className="tm-dialog-actions"><button type="button" onClick={dismiss}>关闭</button>
        <button type="button" disabled={busy} onClick={downloadPatch}>下载补丁</button></div>
    </Dialog>}
    {modal?.type === "recover" && <Dialog title="恢复上一份草稿" onDismiss={dismiss}>
      <p>恢复上一次成功自动保存的内容。当前修改可用撤销找回。</p>
      <div className="tm-dialog-actions"><button type="button" onClick={dismiss}>取消</button>
        <button type="button" onClick={async () => {
          setBusy(true);
          try { await saveQueue.current; const previous = await readDraft("previous");
            if (previous) { edit(() => previous); clipboard.current = null; setSelection(null); setRevision(value => value + 1); setNotice("已恢复上一份草稿。"); }
            else setNotice("还没有上一份草稿。");
          } catch (error) { setNotice(errorText(error)); } finally { setBusy(false); dismiss(); }
        }}>恢复</button></div>
    </Dialog>}
    {modal?.type === "tileset" && activeAsset && <TilesetDialog asset={activeAsset} onDismiss={dismiss} onSave={asset => {
      const next = replaceTileset(map, activeAsset, asset);
      edit(() => next); setSelected(null); dismiss();
    }} />}
    {modal?.type === "new" && <NewMapDialog onDismiss={dismiss} onCreate={(width, height) => {
      reset(makeMap(width, height));
      setNotice("已创建空白地图。");
    }} />}
    {modal?.type === "upload" && <UploadDialog onDismiss={dismiss} onImport={({ tileset, palettes, unsupported, skippedLayouts }) => {
      edit(current => ({ ...current, tilesets: [...current.tilesets, tileset], palettes: [...current.palettes, ...palettes] }));
      setAssetId(tileset.id);
      setSelected(null);
      setMaterialsMode(palettes.length ? "palette" : "atlas");
      const skipped = unsupported ? ` · 跳过 ${unsupported} 个 Palette` : "";
      const layouts = skippedLayouts.length ? `（${skippedLayouts.join("、")}）` : "";
      setNotice(`已导入 ${tileset.name} · ${palettes.length} 个 Palette${skipped}${layouts}。`);
      dismiss();
    }} />}
    {modal?.type === "palette" && activeAsset && paletteSource && <PaletteDialog
      asset={activeAsset} atlases={atlases} initial={activePalette} source={paletteSource} onDismiss={dismiss}
      onSave={savePalette} onRemove={() => setModal({ type: "remove-palette" })} />}
    {modal?.type === "remove-asset" && removeMaterial(true)}
    {modal?.type === "remove-palette" && removeMaterial(false)}
    {modal?.type === "remove-layer" && <Dialog title="删除图层" onDismiss={dismiss}>
      <p>删除「{activeLayer.name}」和其中的 {Object.keys(activeLayer.cells).length} 格内容。可用撤销恢复。</p>
      <div className="tm-dialog-actions">
        <button type="button" onClick={dismiss}>取消</button>
        <button type="button" className="tm-danger" onClick={() => {
          edit(current => ({ ...current, layers: current.layers.filter(layer => layer.id !== activeLayer.id) }));
          dismiss();
        }}>删除</button>
      </div>
    </Dialog>}
    {modal?.type === "ak" && <Dialog title="打开 AK 大地图" onDismiss={dismiss}>
      <p>加载 AK 项目包会替换当前本地草稿。可以先下载当前项目。</p>
      <div className="tm-dialog-actions">
        <button type="button" onClick={dismiss}>取消</button>
        <button type="button" onClick={() => void openAkProject("baseline")}>打开原始快照</button>
        <button type="button" className="tm-primary" onClick={() => void openAkProject("designed")}>打开 AK 设计地图</button>
      </div>
    </Dialog>}
    {modal?.type === "open" && <Dialog title="打开项目" onDismiss={dismiss}>
      <p>打开「{modal.file.name}」会替换当前本地草稿。需要留存时，可以先下载当前项目。</p>
      <div className="tm-dialog-actions">
        <button type="button" onClick={dismiss}>取消</button>
        <button type="button" className="tm-primary" onClick={() => void openProject(modal.file)}>打开项目</button>
      </div>
    </Dialog>}
    {modal?.type === "rebase" && <Dialog title="迁移到新版 AK 快照" onDismiss={dismiss}>
      <p>「{modal.filename}」基于旧快照 <code>{modal.doc.world?.revision.slice(0, 10)}</code>，当前内置快照为 <code>{modal.baseline.world?.revision.slice(0, 10)}</code>。迁移会保留你的图层改动、高程、面片删移与触发区，同时替换为新版地形和版本号，以便导出 Godot 补丁。</p>
      <div className="tm-dialog-actions">
        <button type="button" onClick={dismiss}>取消</button>
        {!modal.doc.world?.delta && <button type="button" onClick={() => {
          const doc = modal.doc;
          reset(doc);
          setNotice(`已按原版本打开 ${modal.filename}（导出补丁前需迁移快照）。`);
        }}>保持原样打开</button>}
        <button type="button" className="tm-primary" onClick={() => {
          const { map: migrated, report } = rebaseWorldSnapshot(modal.doc, modal.baseline);
          reset(migrated);
          setNotice(`已迁移至新快照 ${report.toRevision.slice(0, 8)} · 保留 ${report.preservedChangedCells} 格改动 · ${report.preservedElevations} 格高程 · ${report.preservedEncounters} 个触发区。`);
        }}>迁移到最新快照</button>
      </div>
    </Dialog>}
  </div>;
}
