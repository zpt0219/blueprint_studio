import { useEffect, useRef, useState, type FormEvent } from "react";
import { downloadBlob } from "../download";
import { DEFAULT_TILE_RESOLUTION } from "../model";
import { createTilesetSource, exportTilesetPack, importTilesetPack, type LoadedTileset, type TilesetSource } from "../pack/tilesets";
import { PaletteMode, type Palette } from "../pack/types";
import { PaletteSwatch } from "./PaletteSwatch";

type Lang = "zh" | "en";
const stem = (file: File) => file.name.replace(/\.[^.]+$/, "");
const isPng = (file: File) => /\.png$/i.test(file.name);
const isSidecar = (file: File) => /\.adnapalettes$/i.test(file.name);
const isPack = (file: File) => /\.adnapalettepack$/i.test(file.name);

function GridPreview({ file, resolution, lang }: { file: File; resolution: number; lang: Lang }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    let cancelled = false;
    image.src = url;
    void image.decode().then(() => {
      const canvas = ref.current;
      if (cancelled || !canvas) return;
      const scale = Math.min(1, 440 / image.width, 200 / image.height);
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (!Number.isInteger(resolution) || resolution < 1 || resolution * scale < 2) return;
      ctx.strokeStyle = "rgba(255,255,255,.55)";
      ctx.beginPath();
      for (let x = resolution; x < image.width; x += resolution) {
        const screenX = Math.round(x * scale) + 0.5;
        ctx.moveTo(screenX, 0);
        ctx.lineTo(screenX, canvas.height);
      }
      for (let y = resolution; y < image.height; y += resolution) {
        const screenY = Math.round(y * scale) + 0.5;
        ctx.moveTo(0, screenY);
        ctx.lineTo(canvas.width, screenY);
      }
      ctx.stroke();
    }).catch(() => {});
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
  }, [file, resolution]);
  return <canvas ref={ref} className="tileset-grid-preview" aria-label={lang === "zh" ? "切格预览" : "Tile grid preview"} />;
}

export function TilesetImportDialog({ lang, onClose, onImport }: {
  lang: Lang;
  onClose: () => void;
  onImport: (sources: TilesetSource[]) => Promise<string>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [resolution, setResolution] = useState(DEFAULT_TILE_RESOLUTION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const images = files.filter(isPng);
  const configs = files.filter(isSidecar);
  const packs = files.filter(isPack);
  const rawImage = images.find((image) => !configs.some((config) => stem(config) === stem(image)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !files.length) return;
    setBusy(true);
    setError("");
    try {
      if (packs.length) {
        if (packs.length !== 1 || files.length !== 1) throw new Error(lang === "zh" ? "请单独选择一个素材包。" : "Select one pack on its own.");
        await onImport(await importTilesetPack(packs[0]));
      } else {
        if (!images.length || images.length + configs.length !== files.length ||
            configs.some((config) => !images.some((image) => stem(image) === stem(config)))) {
          throw new Error(lang === "zh" ? "请选择 PNG，并同时选中同名的 .adnapalettes（如有）。" : "Select PNGs with their matching .adnapalettes files, if available.");
        }
        const sources = await Promise.all(images.map(async (image) => {
          const config = configs.find((file) => stem(file) === stem(image));
          return createTilesetSource(image, resolution, await config?.text());
        }));
        await onImport(sources);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <form className="modal-card lifecycle-modal" role="dialog" aria-modal="true" aria-labelledby="tileset-import-title"
        onSubmit={submit} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title" id="tileset-import-title">{lang === "zh" ? "添加 Tileset" : "Add Tileset"}</div>
        </div>
        <div className="lifecycle-form">
          <label className="lf-field">
            <span>{lang === "zh" ? "选文件" : "Choose files"}</span>
            <input type="file" multiple accept=".png,.adnapalettes,.adnapalettepack" disabled={busy}
              onChange={(event) => { setFiles(Array.from(event.currentTarget.files ?? [])); setError(""); }} />
          </label>
          <div className="muted">{lang === "zh"
            ? "同时选中 PNG 和同名 .adnapalettes，或单独选择一个 .adnapalettepack。"
            : "Select a PNG with its matching .adnapalettes file, or select an .adnapalettepack on its own."}</div>
          {files.length > 0 && <div className="tileset-files">{files.map((file) => file.name).join(" · ")}</div>}
          {rawImage && (
            <>
              <label className="lf-field">
                <span>{lang === "zh" ? "单格边长（像素）" : "Tile size (px)"}</span>
                <input type="number" min={1} max={256} value={resolution} disabled={busy}
                  onChange={(event) => setResolution(Number(event.currentTarget.value))} />
              </label>
              <GridPreview file={rawImage} resolution={resolution} lang={lang} />
            </>
          )}
          {error && <div className="error" role="alert">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" onClick={onClose} disabled={busy}>{lang === "zh" ? "取消" : "Cancel"}</button>
          <button type="submit" className="active" disabled={!files.length || busy}>
            {busy ? (lang === "zh" ? "导入中…" : "Importing…") : (lang === "zh" ? "导入" : "Import")}
          </button>
        </div>
      </form>
    </div>
  );
}

const isAutotile = (palette: Palette) => palette.mode === PaletteMode.TWO_CORNER || palette.mode === PaletteMode.TWO_EDGE;

function RawTilesetGrid({ tileset, activeHash, lang, onSelect }: {
  tileset: LoadedTileset;
  activeHash: string | null;
  lang: Lang;
  onSelect: (palette: Palette) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [cursor, setCursor] = useState(0);
  const { image, palettes, source } = tileset;
  const tr = source.tileResolution;
  const cols = image.width / tr, rows = image.height / tr;
  const activeIndex = palettes.findIndex((palette) => palette.hash === activeHash);
  const scale = Math.max(1, 14 / tr);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, image.width, image.height);
    ctx.drawImage(image, 0, 0);
    if (tr >= 4) {
      ctx.beginPath();
      ctx.strokeStyle = "rgba(160,180,200,.42)";
      for (let x = tr; x < image.width; x += tr) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, image.height); }
      for (let y = tr; y < image.height; y += tr) { ctx.moveTo(0, y + 0.5); ctx.lineTo(image.width, y + 0.5); }
      ctx.stroke();
    }
    const outline = (index: number, color: string) => {
      if (index < 0) return;
      ctx.strokeStyle = color;
      ctx.strokeRect((index % cols) * tr + 0.5, Math.floor(index / cols) * tr + 0.5, tr - 1, tr - 1);
    };
    outline(cursor, "white");
    outline(activeIndex, "#6aa0ff");
  }, [image, tr, cols, activeIndex, cursor]);

  return (
    <div className="raw-tileset-grid">
      <canvas ref={ref} width={image.width} height={image.height} style={{ width: image.width * scale }}
        tabIndex={0} role="button"
        aria-label={lang === "zh" ? `选择图块 ${palettes[cursor].label}，方向键移动，回车选择` : `Tile ${palettes[cursor].label}. Use arrows to move and Enter to select.`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const col = Math.min(cols - 1, Math.floor((event.clientX - rect.left) / rect.width * cols));
          const row = Math.min(rows - 1, Math.floor((event.clientY - rect.top) / rect.height * rows));
          const index = row * cols + col;
          if (!palettes[index]) return;
          setCursor(index);
          onSelect(palettes[index]);
        }}
        onKeyDown={(event) => {
          const col = cursor % cols, row = Math.floor(cursor / cols);
          switch (event.key) {
            case "ArrowLeft": setCursor(row * cols + Math.max(0, col - 1)); break;
            case "ArrowRight": setCursor(row * cols + Math.min(cols - 1, col + 1)); break;
            case "ArrowUp": setCursor(Math.max(0, row - 1) * cols + col); break;
            case "ArrowDown": setCursor(Math.min(rows - 1, row + 1) * cols + col); break;
            case "Enter":
            case " ": onSelect(palettes[cursor]); break;
            default: return;
          }
          event.preventDefault();
          event.stopPropagation();
        }} />
    </div>
  );
}

export function TilesetMaterials({ tileset, activeHash, lang, onSelect }: {
  tileset: LoadedTileset;
  activeHash: string | null;
  lang: Lang;
  onSelect: (palette: Palette) => void;
}) {
  const [query, setQuery] = useState("");
  const sourcePack = { atlas: tileset.image };
  const term = query.trim().toLowerCase();
  const palettes = tileset.palettes.filter((palette) =>
    !term || [palette.role, palette.style, palette.label].some((value) => value?.toLowerCase().includes(term)));
  if (tileset.source.sidecar === undefined) {
    return <RawTilesetGrid tileset={tileset} activeHash={activeHash} lang={lang} onSelect={onSelect} />;
  }

  return (
    <>
      <input type="search" className="tileset-search" value={query} onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder={lang === "zh" ? "搜索材质（如 grass）" : "Find a palette (e.g. grass)"}
        aria-label={lang === "zh" ? "搜索 Tileset 材质" : "Find a tileset palette"} />
      {tileset.unsupported > 0 && <div className="muted">
        {lang === "zh" ? `${tileset.unsupported} 款桌面模式暂未在网页启用` : `${tileset.unsupported} desktop palettes are unavailable in Studio`}
      </div>}
      <div className="tileset-palette-grid">
        {palettes.map((palette) => {
          const label = palette.style || (palette.role.endsWith("/tiles") ? palette.label : palette.role.split("/").pop());
          const name = [label, palette.label === label ? "" : palette.label].filter(Boolean).join(" ");
          return (
            <button type="button" key={palette.hash} onClick={() => onSelect(palette)} aria-label={name}
              aria-pressed={activeHash === palette.hash} title={`${name} · ${palette.size.join("×")} · ${palette.role}`}>
              <PaletteSwatch pack={sourcePack} palette={palette} px={32} />
              <span>{label}</span>
              {isAutotile(palette) && <small>{lang === "zh" ? "拼接" : "Auto"}</small>}
            </button>
          );
        })}
      </div>
      {!palettes.length && <div className="muted">{lang === "zh" ? "没有可用的材质" : "No matching palettes"}</div>}
    </>
  );
}

export async function downloadTilesetPack(tilesets: LoadedTileset[]): Promise<void> {
  downloadBlob("my-tilesets.adnapalettepack", await exportTilesetPack(tilesets));
}
