import { useEffect, useRef, useState, type ReactNode } from "react";
import { drawTile, type Atlases } from "./draw";
import { importTileset } from "./files";
import { AtlasGrid } from "./Materials";
import { MAX_HEIGHT, MAX_MAP_SIDE, newId, paletteTileCount, paletteTop, type Palette, type PaletteMode, type Point, type Tileset, type GameMaterial } from "./model";

export function Dialog({ title, onDismiss, children }: { title: string; onDismiss: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
  }, []);
  return <dialog ref={ref} className="tm-dialog" aria-label={title} onCancel={event => {
    event.preventDefault();
    onDismiss();
  }}>
    <h2>{title}</h2>
    {children}
  </dialog>;
}

export function NewMapDialog({ onDismiss, onCreate }: {
  onDismiss: () => void; onCreate: (width: number, height: number) => void;
}) {
  return <Dialog title="新建地图" onDismiss={onDismiss}>
    <form onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      onCreate(Number(data.get("width")), Number(data.get("height")));
    }}>
      <div className="tm-field-row">
        <label>宽度（格）<input name="width" type="number" min={1} max={MAX_MAP_SIDE} defaultValue={48} required /></label>
        <label>高度（格）<input name="height" type="number" min={1} max={MAX_MAP_SIDE} defaultValue={36} required /></label>
      </div>
      <p>新地图会替换当前本地草稿。需要留存时，可以先下载项目。</p>
      <div className="tm-dialog-actions">
        <button type="button" onClick={onDismiss}>取消</button>
        <button className="tm-primary" type="submit">创建地图</button>
      </div>
    </form>
  </Dialog>;
}

export function UploadDialog({ onDismiss, onImport }: {
  onDismiss: () => void; onImport: (result: Awaited<ReturnType<typeof importTileset>>) => void;
}) {
  const [png, setPng] = useState<File>();
  const [sidecar, setSidecar] = useState<File>();
  const [size, setSize] = useState("16");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog title="上传图集" onDismiss={() => { if (!busy) onDismiss(); }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (!png || busy) return;
      setBusy(true);
      setError("");
      try { onImport(await importTileset(png, Number(size), sidecar)); }
      catch (err) { setError(err instanceof Error ? err.message : "导入失败。"); }
      finally { setBusy(false); }
    }}>
      <label>PNG 图集<input type="file" accept=".png,image/png" disabled={busy} required
        onChange={event => setPng(event.target.files?.[0])} /></label>
      <label>桌面 Palette 文件（可选）<input type="file" accept=".adnapalettes" disabled={busy}
        onChange={event => setSidecar(event.target.files?.[0])} /></label>
      <label>格子尺寸（px）<input type="number" min={1} max={128} required disabled={busy || !!sidecar}
        value={size} onChange={event => setSize(event.target.value)} /></label>
      {sidecar && <p>格子尺寸取自 .adnapalettes 文件。</p>}
      {error && <p role="alert" className="tm-error">{error}</p>}
      <div className="tm-dialog-actions">
        <button type="button" disabled={busy} onClick={onDismiss}>取消</button>
        <button className="tm-primary" type="submit" disabled={busy || !png}>{busy ? "导入中…" : "导入"}</button>
      </div>
    </form>
  </Dialog>;
}

function RulePreview({ palette, atlases }: { palette: Palette; atlases: Atlases }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current!.getContext("2d")!;
    ctx.clearRect(0, 0, 120, 96);
    ctx.imageSmoothingEnabled = false;
    const has = (x: number, y: number) => x >= 0 && x < 5 && y >= 0 && y < 4 && (x < 3 || y > 0);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 5; x++) {
        if (!has(x, y)) continue;
        const top = paletteTop(palette, has, x, y);
        if (top) drawTile(ctx, atlases, { tileset: palette.tileset, x: top[0], y: top[1] }, x * 24, y * 24, 24);
      }
    }
  }, [palette, atlases]);
  return <canvas ref={ref} width={120} height={96} className="tm-rule-preview" aria-label="拼接预览" />;
}

function tileRange(mode: PaletteMode, origin: Point, asset: Tileset): Array<Point | null> {
  const stride = mode === "single" ? 1 : 4;
  return Array.from({ length: paletteTileCount(mode) }, (_, index) => {
    const x = origin[0] + (index % stride) * asset.tileSize;
    const y = origin[1] + Math.floor(index / stride) * asset.tileSize;
    return x >= 0 && y >= 0 && x < asset.width && y < asset.height ? [x, y] : null;
  });
}

export function PaletteDialog({ asset, atlases, initial, source, onDismiss, onSave, onRemove }: {
  asset: Tileset; atlases: Atlases; initial?: Palette; source: Point; onDismiss: () => void;
  onSave: (palette: Palette) => void; onRemove: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? `素材 ${source[0] / asset.tileSize + 1}, ${source[1] / asset.tileSize + 1}`);
  const [mode, setMode] = useState<PaletteMode>(initial?.mode ?? "single");
  const [height, setHeight] = useState(String(initial?.height ?? 0));
  const [usage, setUsage] = useState<NonNullable<Palette["usage"]>>(initial?.usage ?? (initial?.height ? "platform" : "ground"));
  const [material, setMaterial] = useState<GameMaterial>(initial?.material ?? (["grass", "snow", "road", "sand", "rock"].includes(initial?.id ?? "") ? initial!.id as GameMaterial : "texture"));
  const [blocked, setBlocked] = useState(initial?.blocked ?? false);
  const [size, setSize] = useState<Point>(initial?.decorationSize ?? [1, 1]);
  const [origin, setOrigin] = useState<Point>(source);
  const [wall, setWall] = useState<Point | undefined>(initial?.wall);
  const [pick, setPick] = useState<"origin" | "wall" | null>(null);
  const [error, setError] = useState("");
  const unchanged = initial && mode === initial.mode && origin[0] === source[0] && origin[1] === source[1];
  const tiles = unchanged ? initial.tiles : tileRange(mode, origin, asset);
  const preview: Palette = { id: initial?.id ?? "", name, mode, tiles, tileset: asset.id, height: usage === "decoration" ? 0 : Number(height), wall, usage, material, blocked, decorationSize: size };
  return <Dialog title={initial ? "Palette 属性" : "创建 Palette"} onDismiss={onDismiss}>
    <form onSubmit={event => {
      event.preventDefault();
      const duplicate = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "duplicate";
      if (!name.trim() || (!unchanged && tiles.some(tile => !tile))) {
        setError("请输入名称，并选一个能容纳整个拼接布局的图集起始格。");
        return;
      }
      onSave({
        ...preview,
        id: !duplicate && initial ? initial.id : newId(),
        name: duplicate && name === initial?.name ? `${name.slice(0, 124)} 副本` : name.trim(),
      });
    }}>
      <label>名称<input required maxLength={128} value={name} onChange={event => setName(event.target.value)} /></label>
      <div className="tm-field-row">
        <label>用途<select aria-label="用途" value={usage} onChange={event => {
          const next = event.target.value as typeof usage; setUsage(next);
          if (next === "platform" && Number(height) === 0) setHeight("1");
          if (next === "ground") setHeight("0");
        }}>
          <option value="ground">地表</option><option value="platform">高台</option><option value="decoration">面片装饰</option>
        </select></label>
        <label>游戏外观<select aria-label="游戏外观" value={material} disabled={usage === "decoration"} onChange={event => setMaterial(event.target.value as GameMaterial)}>
          <option value="texture">使用此图集</option><option value="grass">原版草地</option><option value="snow">原版雪地</option>
          <option value="road">原版道路</option><option value="sand">原版沙地</option><option value="rock">原版岩地</option>
        </select></label>
      </div>
      <label><input type="checkbox" checked={blocked} onChange={event => setBlocked(event.target.checked)} /> 阻挡通行</label>
      {usage === "decoration" && <div className="tm-field-row">{["宽度（格）", "高度（格）"].map((label, i) =>
        <label key={label}>{label}<input type="number" min={0.1} max={16} step={0.1} required value={size[i]}
          onChange={event => setSize(current => current.map((v, k) => k === i ? Number(event.target.value) : v) as Point)} /></label>)}</div>}
      <div className="tm-field-row">
        <label>拼接方式<select value={mode} onChange={event => {
          const next = event.target.value as PaletteMode;
          setMode(next);
          if (next === "cliff" && usage !== "decoration") { setUsage("platform"); if (Number(height) === 0) setHeight("1"); }
          if (next === "cliff" && !wall) setWall(tileRange(next, origin, asset)[13] ?? undefined);
        }}>
          <option value="single">单格</option><option value="edge">按边（4×4）</option>
          <option value="corner">按角（4×4）</option><option value="cliff">高台（4×5）</option>
        </select></label>
        <label>地表抬高（格）<input disabled={usage === "decoration"} required type="number" min={0} max={MAX_HEIGHT} step="any" value={height}
          onChange={event => setHeight(event.target.value)} /></label>
      </div>
      <div className="tm-palette-settings">
        <RulePreview palette={preview} atlases={atlases} />
        <div>
          <button type="button" aria-pressed={pick === "origin"} onClick={() => setPick(pick === "origin" ? null : "origin")}>
            选择起始格
          </button>
          <span>列 {origin[0] / asset.tileSize + 1}，行 {origin[1] / asset.tileSize + 1}</span>
          <button type="button" aria-pressed={pick === "wall"} onClick={() => setPick(pick === "wall" ? null : "wall")}>
            选择侧面格
          </button>
          <span>{wall ? `列 ${wall[0] / asset.tileSize + 1}，行 ${wall[1] / asset.tileSize + 1}` : "默认侧面颜色"}</span>
          {wall && <button type="button" onClick={() => setWall(undefined)}>恢复默认侧面</button>}
        </div>
      </div>
      {pick && <div className="tm-picker"><AtlasGrid asset={asset} atlas={atlases.get(asset.id)}
        selected={pick === "origin" ? origin : wall} onPick={point => {
          if (pick === "origin") setOrigin(point);
          else setWall(point);
          setPick(null);
          setError("");
        }} /></div>}
      {error && <p role="alert" className="tm-error">{error}</p>}
      <div className="tm-dialog-actions">
        {initial && <button type="button" className="tm-danger" onClick={onRemove}>删除</button>}
        {initial && <button type="submit" value="duplicate">另存为副本</button>}
        <button type="button" onClick={onDismiss}>取消</button>
        <button className="tm-primary" type="submit">应用</button>
      </div>
    </form>
  </Dialog>;
}

export function TilesetDialog({ asset, onDismiss, onSave }: {
  asset: Tileset; onDismiss: () => void; onSave: (asset: Tileset) => void;
}) {
  const [name, setName] = useState(asset.name);
  const [size, setSize] = useState(asset.tileSize);
  const [png, setPng] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog title="图集属性" onDismiss={() => { if (!busy) onDismiss(); }}>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError("");
      try {
        const imported = await importTileset(png ?? new File([asset.png], asset.name, { type: "image/png" }), size);
        onSave({ ...imported.tileset, id: asset.id, name: name.trim() });
      } catch (err) { setError(err instanceof Error ? err.message : "图集更新失败。"); }
      finally { setBusy(false); }
    }}>
      <label>名称<input required maxLength={128} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>格子尺寸（px）<input type="number" min={1} max={128} required value={size} onChange={event => setSize(Number(event.target.value))} /></label>
      <label>替换 PNG（可选）<input type="file" accept=".png,image/png" onChange={event => setPng(event.target.files?.[0])} /></label>
      <p>已有选区保持行列位置。改动可撤销。</p>
      {error && <p className="tm-error" role="alert">{error}</p>}
      <div className="tm-dialog-actions"><button type="button" disabled={busy} onClick={onDismiss}>取消</button>
        <button type="submit" disabled={busy}>应用</button></div>
    </form>
  </Dialog>;
}
