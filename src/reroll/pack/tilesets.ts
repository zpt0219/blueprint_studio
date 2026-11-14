import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { contentId } from "../contentId";
import { eachObject, type LiteTileMap } from "../model";
import { isMatrixAutotile } from "./autotile";
import { decodeMappingMatrix } from "./decode";
import { decodeAtlas } from "./loadPack";
import { isStructureMode } from "./slice";
import { PaletteMode, type PackManifest, type PackRuntime, type Palette, type PaletteRecord } from "./types";

const TILESET_PREFIX = "tileset:";
const PACK_KIND = "adna.studio_tilesets";
const MAX_ATLAS_SIDE = 8192;
const MAX_ATLAS_PIXELS = 32 * 1024 * 1024;
const MAX_RAW_TILES = 4096;

export interface TilesetSource {
  id: string;
  name: string;
  png: Blob;
  tileResolution: number;
  sidecar?: string;
}

export interface LoadedTileset {
  source: TilesetSource;
  image: ImageBitmap | HTMLImageElement;
  palettes: Palette[];
  unsupported: number;
}

type SidecarPalette = PaletteRecord & { stratum?: string };

function validResolution(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 256;
}

function readSidecar(sidecar: string) {
  const data = JSON.parse(sidecar) as { version: number; tileResolution: number; palettes: SidecarPalette[] };
  if (data?.version !== 1 || !validResolution(data.tileResolution) || !Array.isArray(data.palettes)) {
    throw new Error("Invalid .adnapalettes file");
  }
  return data;
}

export async function createTilesetSource(png: File, tileResolution: number, sidecar?: string): Promise<TilesetSource> {
  if (sidecar !== undefined) tileResolution = readSidecar(sidecar).tileResolution;
  if (!validResolution(tileResolution)) throw new Error("Tile size must be between 1 and 256 px");
  const name = png.name.replace(/\.png$/i, "");
  const imageHash = contentId(new Uint8Array(await png.arrayBuffer()));
  const configHash = sidecar === undefined ? String(tileResolution) : contentId(strToU8(sidecar));
  return { id: `${encodeURIComponent(name)}~${imageHash}~${configHash}`, name, png, tileResolution, sidecar };
}

export async function loadTileset(source: TilesetSource): Promise<LoadedTileset> {
  if (!validResolution(source.tileResolution)) throw new Error(`${source.name}: invalid tile size`);
  const header = new Uint8Array(await source.png.slice(0, 8).arrayBuffer());
  if (header.join(",") !== "137,80,78,71,13,10,26,10") throw new Error(`${source.name}: expected a PNG image`);
  const image = await decodeAtlas(source.png);
  try {
    const { width, height } = image;
    if (width > MAX_ATLAS_SIDE || height > MAX_ATLAS_SIDE || width * height > MAX_ATLAS_PIXELS) {
      throw new Error(`${source.name}: image is too large`);
    }
    const prefix = TILESET_PREFIX + source.id + ":";
    const palettes: Palette[] = [];
    let unsupported = 0;
    if (source.sidecar !== undefined) {
      const records = readSidecar(source.sidecar).palettes;
      const hashes = new Set<string>();
      for (const [index, record] of records.entries()) {
        if (!record || typeof record.hash !== "string" || !record.hash || hashes.has(record.hash)) {
          throw new Error(`${source.name}: invalid or duplicate palette ID at #${index + 1}`);
        }
        hashes.add(record.hash);
        if (!isMatrixAutotile(record.mode) && !isStructureMode(record.mode) && record.mode !== PaletteMode.FIXED_RECT) {
          unsupported++;
          continue;
        }
        const w = record.size?.[0];
        const h = record.size?.[1];
        const tr = record.tileResolution;
        const mm = record.mappingMatrix;
        if (!Number.isSafeInteger(w) || w < 1 || !Number.isSafeInteger(h) || h < 1 ||
            w * h > MAX_RAW_TILES || !validResolution(tr) || mm?.width !== w || mm.height !== h ||
            typeof mm.data_b64 !== "string" || (isMatrixAutotile(record.mode) && (w !== 4 || h !== 4))) {
          throw new Error(`${source.name}: invalid tile mapping at #${index + 1}`);
        }
        const mapping = decodeMappingMatrix(mm);
        if (mapping.cells.length !== w * h * 2) throw new Error(`${source.name}: truncated tile mapping at #${index + 1}`);
        for (let i = 0; i < mapping.cells.length; i += 2) {
          const x = mapping.cells[i], y = mapping.cells[i + 1];
          if (x === -1 && y === -1) continue;
          if (x < 0 || y < 0 || x + tr > width || y + tr > height) {
            throw new Error(`${source.name}: palette #${index + 1} points outside the image`);
          }
        }
        const role = record.tags?.["blueprint.role"];
        const style = record.tags?.["blueprint.style"];
        const fallbackRole = record.stratum === "vertical" ? "outdoor_prop/tiles" : "terrain/tiles";
        palettes.push({
          hash: prefix + record.hash,
          tilesetId: source.id,
          label: record.tags?.["web.name"] || `#${index + 1}`,
          role: typeof role === "string" && role ? role : fallbackRole,
          style: typeof style === "string" ? style : "",
          size: [w, h],
          tileResolution: tr,
          edge: Array.isArray(record.edge) ? record.edge : [-1, -1],
          mode: record.mode,
          mapping,
        });
      }
    } else {
      const tr = source.tileResolution;
      const cols = width / tr, rows = height / tr;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols * rows > MAX_RAW_TILES) {
        throw new Error(`${source.name}: the grid must fit the PNG exactly and contain at most ${MAX_RAW_TILES} tiles`);
      }
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          palettes.push({
            hash: `${prefix}${col},${row}`,
            tilesetId: source.id,
            rawTile: true,
            label: `${col + 1}, ${row + 1}`,
            role: "terrain/tiles",
            style: "",
            size: [1, 1],
            tileResolution: tr,
            edge: [-1, -1],
            mode: PaletteMode.FIXED_RECT,
            mapping: { width: 1, height: 1, cells: Int32Array.of(col * tr, row * tr) },
          });
        }
      }
    }
    return { source, image, palettes, unsupported };
  } catch (error) {
    if ("close" in image) image.close();
    throw error;
  }
}

// The current renderers share one atlas. Pack source images into rows and
// translate mappings while keeping their palette IDs independent of packing.
export function combineTilesets(base: PackRuntime | null, tilesets: LoadedTileset[]): PackRuntime | null {
  if (!tilesets.length) return base;
  const images: { image: PackRuntime["atlas"]; palettes: Palette[] }[] = tilesets.map(({ image, palettes }) => ({ image, palettes }));
  if (base) images.unshift({ image: base.atlas, palettes: base.palettes });
  const atlas = document.createElement("canvas");
  let x = 0, y = 0, rowHeight = 0, width = 0;
  const regions = images.map(({ image, palettes }) => {
    if (x + image.width > MAX_ATLAS_SIDE) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const region = { x, y, image, palettes };
    x += image.width;
    rowHeight = Math.max(rowHeight, image.height);
    width = Math.max(width, x);
    return region;
  });
  const height = y + rowHeight;
  if (width > MAX_ATLAS_SIDE || height > MAX_ATLAS_SIDE || width * height > MAX_ATLAS_PIXELS) {
    throw new Error("Combined tilesets are too large to render");
  }
  atlas.width = width;
  atlas.height = height;
  const ctx = atlas.getContext("2d");
  if (!ctx) throw new Error("Could not create the tileset atlas");
  const palettes = regions.flatMap(({ x, y, image, palettes }) => {
    ctx.drawImage(image, x, y);
    if (x === 0 && y === 0) return palettes;
    return palettes.map((palette) => {
      const cells = palette.mapping.cells.slice();
      for (let i = 0; i < cells.length; i += 2) {
        if (cells[i] < 0 || cells[i + 1] < 0) continue;
        cells[i] += x;
        cells[i + 1] += y;
      }
      return { ...palette, lut: undefined, mapping: { ...palette.mapping, cells } };
    });
  });
  return {
    reference: base?.reference ?? { id: "studio-tilesets", name: "My Tilesets" },
    tileResolution: base?.tileResolution ?? tilesets[0].source.tileResolution,
    atlas,
    palettes,
  };
}

export function tilesetIdForPalette(hash?: string | null): string | undefined {
  if (!hash?.startsWith(TILESET_PREFIX)) return undefined;
  const end = hash.indexOf(":", TILESET_PREFIX.length);
  return end < 0 ? undefined : hash.slice(TILESET_PREFIX.length, end);
}

export function usedTilesetIds(map: LiteTileMap): Set<string> {
  const used = new Set<string>();
  for (const object of eachObject(map)) {
    const hashes = [object.tags["web.palette"], object.house?.wall, object.house?.roof,
      ...(object.frg?.cells.map((cell) => cell.palette) ?? []),
      ...(object.house?.decorations.map((cell) => cell.palette) ?? [])];
    for (const hash of hashes) {
      const id = tilesetIdForPalette(hash);
      if (id) used.add(id);
    }
  }
  return used;
}

export function tilesetName(id: string): string {
  try { return decodeURIComponent(id.split("~").slice(0, -2).join("~")); } catch { return id; }
}

export async function exportTilesetPack(tilesets: LoadedTileset[]): Promise<Blob> {
  const packed = combineTilesets(null, tilesets);
  if (!packed || !(packed.atlas instanceof HTMLCanvasElement) || !packed.palettes.length) {
    throw new Error("There are no drawable palettes to export");
  }
  const atlas = packed.atlas;
  const files: Record<string, Uint8Array> = {};
  const entries = await Promise.all(tilesets.map(async ({ source: { png, sidecar, ...source } }, index) => {
    const path = `tilesets/${index}`;
    files[path + ".png"] = new Uint8Array(await png.arrayBuffer());
    if (sidecar !== undefined) files[path + ".adnapalettes"] = strToU8(sidecar);
    return { ...source, path };
  }));
  files["tilesets.json"] = strToU8(JSON.stringify({ kind: PACK_KIND, version: 1, entries }));
  const originalRecords = new Map<string, SidecarPalette>();
  for (const { source } of tilesets) {
    if (source.sidecar === undefined) continue;
    for (const palette of readSidecar(source.sidecar).palettes) {
      originalRecords.set(`${TILESET_PREFIX}${source.id}:${palette.hash}`, palette);
    }
  }
  const manifest: PackManifest = {
    kind: "adna.adna_palette_pack",
    packId: "studio-" + contentId(strToU8(entries.map(({ id }) => id).join("|"))),
    packVersion: 1,
    name: "My Tilesets",
    atlas: { path: "atlas.png", width: atlas.width, height: atlas.height, tileResolution: packed.tileResolution },
    paletteCount: packed.palettes.length,
    palettes: packed.palettes.map(({ hash, mode, role, style, size, tileResolution, mapping }, index) => ({
      index, hash, originalHash: originalRecords.get(hash)?.hash, mode, role, style,
      rect: { x: mapping.cells[0], y: mapping.cells[1], w: size[0] * tileResolution, h: size[1] * tileResolution },
    })),
  };
  const records = packed.palettes.map(({ hash, mode, role, style, size, tileResolution, edge, mapping }) => {
    const original = originalRecords.get(hash);
    const view = new DataView(new ArrayBuffer(mapping.cells.length * 4));
    mapping.cells.forEach((value, i) => view.setInt32(i * 4, value, true));
    const data_b64 = btoa(String.fromCharCode(...new Uint8Array(view.buffer)));
    return {
      ...original, hash, mode, size, tileResolution, edge,
      mappingMatrix: { width: mapping.width, height: mapping.height, data_b64 },
      tags: { ...original?.tags, "blueprint.role": role, "blueprint.style": style },
    };
  });
  const atlasPng = await new Promise<Blob>((resolve, reject) => {
    atlas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not export the atlas image")), "image/png");
  });
  files["atlas.png"] = new Uint8Array(await atlasPng.arrayBuffer());
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  files["palettes.json"] = strToU8(JSON.stringify({ palettes: records }));
  return new Blob([zipSync(files) as BlobPart], { type: "application/zip" });
}

export async function importTilesetPack(file: File): Promise<TilesetSource[]> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  if (!files["tilesets.json"]) {
    if (!files["manifest.json"] || !files["palettes.json"]) throw new Error("Invalid Adna palette pack");
    const manifest = JSON.parse(strFromU8(files["manifest.json"])) as PackManifest;
    const png = files[manifest.atlas?.path];
    if (!png || !["adna.adna_palette_pack", "adna.style_pack"].includes(manifest.kind)) throw new Error("Invalid Adna palette pack");
    const { palettes } = JSON.parse(strFromU8(files["palettes.json"])) as { palettes: SidecarPalette[] };
    const metadata = new Map(manifest.palettes.map((palette) => [palette.hash, palette]));
    const records = palettes.map((palette) => {
      const entry = metadata.get(palette.hash);
      if (!entry) return palette;
      return {
        ...palette,
        mode: entry.mode,
        tags: { ...palette.tags, "blueprint.role": entry.role, "blueprint.style": entry.style },
      };
    });
    const tileResolution = manifest.atlas.tileResolution;
    const image = new File([png as BlobPart], file.name.replace(/\.adnapalettepack$/i, ".png"), { type: "image/png" });
    return [await createTilesetSource(image, tileResolution, JSON.stringify({ version: 1, tileResolution, palettes: records }))];
  }
  const data = JSON.parse(strFromU8(files["tilesets.json"])) as {
    kind: string; version: number; entries: (Omit<TilesetSource, "png" | "sidecar"> & { path: string })[];
  };
  if (data.kind !== PACK_KIND || data.version !== 1 || !Array.isArray(data.entries) || !data.entries.length) {
    throw new Error("Invalid Studio tileset pack");
  }
  return Promise.all(data.entries.map(async ({ id, name, tileResolution, path }) => {
    const bytes = files[path + ".png"];
    if (!bytes || typeof name !== "string" || !name) throw new Error("Tileset pack is missing a source PNG");
    const config = files[path + ".adnapalettes"];
    const source = await createTilesetSource(
      new File([bytes as BlobPart], name + ".png", { type: "image/png" }),
      tileResolution,
      config ? strFromU8(config) : undefined,
    );
    if (source.id !== id) throw new Error(`${name}: source files do not match the pack ID`);
    return source;
  }));
}

async function openTilesetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("blueprint-studio-tilesets", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("tilesets", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readTilesetSources(): Promise<TilesetSource[]> {
  const db = await openTilesetDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("tilesets").objectStore("tilesets").getAll();
      request.onsuccess = () => resolve(request.result as TilesetSource[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function writeTilesetSources(sources: TilesetSource[], removeId?: string): Promise<void> {
  const db = await openTilesetDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("tilesets", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      const store = transaction.objectStore("tilesets");
      for (const source of sources) store.put(source);
      if (removeId) store.delete(removeId);
    });
  } finally {
    db.close();
  }
}
