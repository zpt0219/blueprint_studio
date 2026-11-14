import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { drawTile, type Atlas, type Atlases } from "./draw";
import { type Cell, type Palette, type Point, type Tileset } from "./model";

export const modeNames = { single: "单格", edge: "按边", corner: "按角", cliff: "高台 4×5" };

export function Swatch({ atlases, palette }: { atlases: Atlases; palette: Palette }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current!.getContext("2d")!;
    ctx.clearRect(0, 0, 32, 32);
    ctx.imageSmoothingEnabled = false;
    const point = palette.tiles[palette.mode === "cliff" ? 5 : palette.mode === "single" ? 0 : 6]
      ?? palette.tiles.find(Boolean);
    if (point) drawTile(ctx, atlases, { tileset: palette.tileset, x: point[0], y: point[1] }, 0, 0, 32);
  }, [atlases, palette]);
  return <canvas ref={ref} width={32} height={32} aria-hidden="true" />;
}

export function AtlasGrid({ asset, atlas, selected, onPick }: {
  asset: Tileset; atlas?: Atlas; selected?: Point; onPick: (point: Point) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [focus, setFocus] = useState<Point>([0, 0]);
  const [keyboard, setKeyboard] = useState(false);
  const size = asset.tileSize;
  useEffect(() => {
    const ctx = ref.current!.getContext("2d")!;
    ctx.clearRect(0, 0, asset.width, asset.height);
    if (atlas) ctx.drawImage(atlas.image, 0, 0);
    if (size >= 6) {
      ctx.beginPath();
      for (let x = size; x < asset.width; x += size) { ctx.moveTo(x, 0); ctx.lineTo(x, asset.height); }
      for (let y = size; y < asset.height; y += size) { ctx.moveTo(0, y); ctx.lineTo(asset.width, y); }
      ctx.strokeStyle = "#172e3266";
      ctx.stroke();
    }
    if (selected || keyboard) {
      const [x, y] = keyboard ? focus : selected!;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, size - 2, size - 2);
      ctx.strokeStyle = "#176f54";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    }
  }, [asset, atlas, selected, size, keyboard, focus]);

  function onKeyDown(event: KeyboardEvent) {
    const [x, y] = keyboard ? focus : selected ?? [0, 0];
    const offsets: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const offset = offsets[event.key];
    if (offset) {
      event.preventDefault();
      setKeyboard(true);
      setFocus([
        Math.max(0, Math.min(asset.width - size, x + offset[0] * size)),
        Math.max(0, Math.min(asset.height - size, y + offset[1] * size)),
      ]);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onPick([x, y]);
    }
  }

  return <canvas ref={ref} width={asset.width} height={asset.height} tabIndex={0} aria-label="图集网格"
    style={{ width: asset.width * Math.max(1, Math.min(3, 24 / size)) }}
    className="tm-atlas" onKeyDown={onKeyDown} onBlur={() => setKeyboard(false)}
    onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = Math.floor((event.clientX - rect.left) / rect.width * asset.width / size) * size;
      const y = Math.floor((event.clientY - rect.top) / rect.height * asset.height / size) * size;
      if (x >= 0 && x < asset.width && y >= 0 && y < asset.height) {
        setKeyboard(false);
        onPick([x, y]);
      }
    }} />;
}

interface Props {
  tilesets: Tileset[];
  palettes: Palette[];
  atlases: Atlases;
  asset?: Tileset;
  brush: Cell | null;
  mode: "atlas" | "palette";
  setMode: (mode: "atlas" | "palette") => void;
  onUpload: () => void;
  onAsset: (id: string) => void;
  onPick: (cell: Cell) => void;
  onProperties: () => void;
  onRemoveAsset: () => void;
  onAssetProperties: () => void;
  onImportPack: () => void;
  onExportPack: () => void;
}

export default function Materials({ tilesets, palettes, atlases, asset, brush, mode, setMode, onUpload, onAsset,
  onPick, onProperties, onRemoveAsset, onAssetProperties, onImportPack, onExportPack }: Props) {
  const [query, setQuery] = useState("");
  const filtered = palettes.filter(palette => palette.tileset === asset?.id && palette.name.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedPalette = brush && "palette" in brush ? palettes.find(palette => palette.id === brush.palette) : undefined;
  const selectedTile: Point | undefined = brush && "tileset" in brush && brush.tileset === asset?.id
    ? [brush.x, brush.y] : undefined;

  return <section className="tm-materials" aria-label="素材">
    <div className="tm-material-head">
      <strong>Palette Pack</strong>
      {asset && <>
        <select aria-label="图集" value={asset.id} onChange={event => onAsset(event.target.value)}>
          {tilesets.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>
        <div className="tm-segments" aria-label="素材类型">
          <button type="button" aria-pressed={mode === "atlas"} onClick={() => setMode("atlas")}>图集</button>
          <button type="button" aria-pressed={mode === "palette"} onClick={() => setMode("palette")}>Palette</button>
        </div>
        {mode === "palette" && <input type="search" aria-label="搜索 Palette" placeholder="搜索 Palette"
          value={query} onChange={event => setQuery(event.target.value)} />}
      </>}
      <div className="tm-material-actions">
        {asset && <button type="button" disabled={selectedPalette?.tileset !== asset.id && !selectedTile}
          onClick={onProperties}>{selectedPalette?.tileset === asset.id ? "Palette 属性" : "创建 Palette"}</button>}
        {asset && <button type="button" onClick={onAssetProperties}>图集属性</button>}
        <details className="tm-pack-menu"><summary>素材包</summary><div>
          <button type="button" onClick={onImportPack}>导入素材包</button>
          <button type="button" disabled={!asset} onClick={onExportPack}>导出素材包</button>
        </div></details>
        {asset && <button type="button" onClick={onRemoveAsset}>移除图集</button>}
        <button type="button" className="tm-primary" onClick={onUpload}>上传图集</button>
      </div>
    </div>
    {asset ? <div className="tm-material-body">
      {mode === "atlas" ? <AtlasGrid key={asset.id} asset={asset} atlas={atlases.get(asset.id)} selected={selectedTile}
        onPick={([x, y]) => onPick({ tileset: asset.id, x, y })} />
        : filtered.length ? <div className="tm-palette-grid">
          {filtered.map(palette => <button type="button" key={palette.id} title={palette.name}
            className="tm-palette" aria-pressed={selectedPalette?.id === palette.id}
            onClick={() => onPick({ palette: palette.id })}>
            <Swatch atlases={atlases} palette={palette} />
            <span><strong>{palette.name}</strong><small>{modeNames[palette.mode]}{palette.height ? ` · 高度 ${palette.height}` : ""}</small></span>
          </button>)}
        </div> : <p className="tm-material-empty">{query ? "没有匹配的 Palette。" : "从图集选格后可以创建 Palette。"}</p>}
    </div> : <p className="tm-material-empty">上传 PNG 图集，选中一格就可以绘制。可以一并导入桌面 Palette 文件。</p>}
  </section>;
}
