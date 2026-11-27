import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Dialog, NewMapDialog, PaletteDialog, UploadDialog, TilesetDialog } from "./Dialogs";
import type { Atlases } from "./draw";
import { decodeProject, encodeProject, MAX_PROJECT_BYTES, readDraft, tilesetImage, writeDraft } from "./files";
import { changeHistory, makeHistory, type Edit } from "./history";
import Layers from "./Layers";
import MapCanvas from "./MapCanvas";
import Materials from "./Materials";
import { cardPosition, deleteCard, moveCard, cellReferences, gridPosition, makeMap, paint, paintElevation, resolveSurfaces, worldPosition, type Cell, type Palette, type Point, type TileMap } from "./model";
import { mergePack, replaceTileset } from "./assets";
import { hydrateAkSceneDetails, migrateLegacyAkDraft, needsAkSceneHydration, needsLegacyAkMigration, readAkDesignedProject } from "./akBeachDesign";
import { buildPortablePatch } from "./patchAssets";
import { copySelection, clearSelection, moveSelection, pasteSelection, type Selection, type Clipboard } from "./selection";
import { AK_PROJECT_URL, worldPreviewSurfaces } from "./world";
import { terrainHeightAt } from "./worldTerrainData";
import "./tilemap.css";

const MapPreview = lazy(() => import("./MapPreview"));

type Modal =
  | { type: "tileset" | "recover" | "game" | "new" | "upload" | "palette" | "remove-asset" | "remove-palette" | "remove-layer" | "ak" }
  | { type: "open"; file: File };

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
  const [tool, setTool] = useState<"brush" | "eraser" | "elevation" | "select" | "area">("brush");
  const [selection, setSelection] = useState<Selection | null>(null);
  const clipboard = useRef<Clipboard | null>(null);
  const [savedMap, setSavedMap] = useState<TileMap>();
  const [savePending, setSavePending] = useState(false);
  const packInput = useRef<HTMLInputElement>(null);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [brushSize, setBrushSize] = useState(1);
  const [elevation, setElevation] = useState("3");
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
      } else if (key === "v" && map.world?.cards) setTool("select");
      else if (event.code === "Space" && !target?.closest("button, summary")) {
        event.preventDefault();
        setPanKey(true);
      } else if (key === "b") setTool("brush");
      else if (key === "e") setTool("eraser");
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
  }, [busy, modal, ready, tool, selectedCard, map, selection, activeLayer.id, focusedTile]);

  const dismiss = () => setModal(null);
  const edit = (apply: Edit) => dispatch({ type: "edit", apply });

  function reset(next: TileMap) {
    dispatch({ type: "reset", map: next });
    setLayerId(next.layers[0].id);
    setAssetId(next.tilesets[0]?.id ?? "");
    setSelected(null);
    setSelectedCard(null);
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
      reset(await withAkSceneDetails(await decodeProject(new Uint8Array(await file.arrayBuffer()))));
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
    if (needsAkSceneHydration(current)) {
      try {
        current = hydrateAkSceneDetails(current, await readAkProject());
      } catch {
        setNotice("AK 场景素材读取失败，可以稍后重新打开项目。");
      }
    }
    if (options?.migrateDraft && needsLegacyAkMigration(current)) {
      try {
        current = migrateLegacyAkDraft(current, await readAkDesignedProject());
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
      if (mode === "baseline") {
        reset(await readAkProject());
        setNotice("已打开 AK 原始快照。");
      } else {
        let project = await readAkDesignedProject();
        const local = await readLocalAkBaseline();
        if (local) project = hydrateAkSceneDetails(project, local);
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
      const bytes = await encodeProject(map);
      saveFile(new Blob([bytes as BlobPart], { type: "application/zip" }), world ? "ak-world.bptilemap" : "tilemap.bptilemap");
      setNotice("项目包已生成。");
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
      const metres = Number(elevation);
      if (elevation.trim() && Number.isFinite(metres) && metres >= -20 && metres <= 100) {
        dispatch({ type: "stroke", apply: current => paintElevation(current, from, to, brushSize, metres) });
      }
      return;
    }
    const cell = tool === "eraser" ? null : brush;
    if (tool === "brush" && !cell) return;
    dispatch({ type: "stroke", apply: current => paint(current, activeLayer.id, from, to, brushSize, cell) });
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
          brushSize={brushSize} canPaint={!busy && tool !== "area" && tool !== "select" && (tool === "elevation" || (activeLayer.visible && (tool === "eraser" || !!brush)))} panKey={panKey}
          onPaint={draw} onCommit={() => dispatch({ type: "finish" })} world={world} focus={world || show3D ? previewFocus : undefined} jump={jump}
          onFocus={world || show3D ? focusAt : undefined} onTestPoint={world && !busy ? setTestPoint : undefined}
          selectArea={!busy && tool === "area"} selection={selection} onSelection={setSelection}
          onMoveSelection={(area, at) => {
            if (!activeLayer.visible) { setSelection(area); setNotice("当前图层已隐藏，请先显示图层。"); return; }
            edit(current => moveSelection(current, activeLayer.id, area, at));
          }}
          selectCards={!busy && tool === "select"} selectedCard={selectedCard} onSelectCard={setSelectedCard}
          onDragCard={(id, x, z) => dispatch({ type: "stroke", apply: current => moveCard(current, id, x, z) })}
          showElevation={tool === "elevation"} />
        <div className="tm-tools">
          <button type="button" aria-pressed={tool === "brush"} title="画笔 (B)" onClick={() => setTool("brush")}>画笔</button>
          <button type="button" aria-pressed={tool === "eraser"} title="橡皮 (E)" onClick={() => setTool("eraser")}>橡皮</button>
          {!!world?.cards?.length && <button type="button" aria-pressed={tool === "select"} title="选择面片 (V)"
            onClick={() => setTool("select")}>选择</button>}
          <button type="button" aria-pressed={tool === "area"} title="框选当前图层 (R)" onClick={() => setTool("area")}>框选</button>
          <button type="button" disabled={!history.past.length && !history.strokeStart} title="Ctrl+Z" onClick={() => dispatch({ type: "undo" })}>撤销</button>
          <button type="button" disabled={!history.future.length} title="Ctrl+Shift+Z" onClick={() => dispatch({ type: "redo" })}>重做</button>
          {world && <button type="button" aria-pressed={tool === "elevation"} onClick={() => setTool("elevation")}>高程</button>}
          {world && tool === "elevation" && <label className="tm-elevation"><input type="number" min={-20} max={100}
            step={0.01} aria-label="高程（米）" value={elevation} onChange={event => setElevation(event.target.value)} /> 米</label>}
          <select aria-label="笔刷大小" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))}>
            {[1, 3, 5, 9].map(size => <option key={size} value={size}>{size} 格</option>)}
          </select>
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
        <div className="tm-map-hint">
          {tool === "area" && <span>框选当前图层 · 拖动移动 · Ctrl+C/X/V · Delete 清除 · Esc 取消</span>}
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
  </div>;
}
