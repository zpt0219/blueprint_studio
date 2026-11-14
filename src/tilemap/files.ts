import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { decodeMappingMatrix } from "../reroll/pack/decode";
import { decodeAtlas } from "../reroll/pack/loadPack";
import { PaletteMode as DesktopMode } from "../reroll/pack/types";
import {
  GAME_MATERIALS, MAX_HEIGHT, MAX_LAYERS, MAX_MAP_SIDE, newId, paletteTileCount,
  type Cell, type Palette, type PaletteMode, type Point, type TileMap, type Tileset, type WorldTexture,
} from "./model";

import { readWorld } from "./world";
import { readTerrain } from "./worldTerrainData";

const FORMAT = "blueprint-tilemap";
const VERSION = 1;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 96 * 1024 * 1024;
const MAX_ATLAS_SIDE = 4096;
const MAX_TILE_SIZE = 128;
const TERRAIN_FILE = "world/terrain.bin";
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

type Atlas = ImageBitmap | HTMLImageElement;
const images = new WeakMap<Blob, Promise<Atlas>>();

export function tilesetImage(png: Blob): Promise<Atlas> {
  let image = images.get(png);
  if (!image) {
    image = decodeAtlas(png);
    images.set(png, image);
  }
  return image;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(value);
}

function name(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function point(value: unknown, tileset: Tileset): value is Point {
  return Array.isArray(value) && value.length === 2
    && integer(value[0], 0, tileset.width - 1) && integer(value[1], 0, tileset.height - 1)
    && value[0] % tileset.tileSize === 0 && value[1] % tileset.tileSize === 0;
}

async function readTileset(png: Blob, filename: string, tileSize: number, assetId = newId()): Promise<Tileset> {
  if (png.size > MAX_PNG_BYTES) throw new Error("单张图集最多 32 MB。");
  if (!integer(tileSize, 1, MAX_TILE_SIZE)) throw new Error("格子尺寸须在 1–128 px 之间。");
  const header = new Uint8Array(await png.slice(0, 24).arrayBuffer());
  if (header.length < 24 || !pngSignature.every((byte, index) => header[index] === byte)
    || String.fromCharCode(...header.subarray(12, 16)) !== "IHDR") throw new Error("请选择有效的 PNG 图集。");
  const view = new DataView(header.buffer);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!integer(width, 1, MAX_ATLAS_SIDE) || !integer(height, 1, MAX_ATLAS_SIDE)
    || width % tileSize || height % tileSize) {
    throw new Error("图集宽高须小于等于 4096 px，并且能被格子尺寸整除。");
  }
  const image = await tilesetImage(png);
  if (image.width !== width || image.height !== height) throw new Error("PNG 图集的尺寸无效。");
  return { id: assetId, name: filename, tileSize, width, height, png };
}

function desktopMode(mode: unknown, width: unknown, height: unknown): PaletteMode | undefined {
  if (mode === DesktopMode.CLIFF && width === 4 && height === 5) return "cliff";
  if (mode === DesktopMode.TWO_EDGE && width === 4 && height === 4) return "edge";
  if (mode === DesktopMode.TWO_CORNER && width === 4 && height === 4) return "corner";
  if (mode === DesktopMode.FIXED_RECT && width === 1 && height === 1) return "single";
}

const terrainNames: Record<string, string> = {
  grass: "草地", dirt: "泥地", sand: "沙地", water: "水面", snow: "雪地", rock: "岩地",
};

function readDesktopPalettes(input: unknown[], tileset: Tileset) {
  const palettes: Palette[] = [];
  let unsupported = 0;
  const skippedLayouts = new Set<string>();
  for (const item of input) {
    const matrix = record(item) && item.mappingMatrix;
    if (!record(item) || !record(matrix)) { unsupported++; continue; }
    const mode = desktopMode(item.mode, matrix.width, matrix.height);
    if (!mode && typeof item.mode === "number") {
      skippedLayouts.add(DesktopMode[item.mode] ?? String(item.mode));
    }
    if (!mode || typeof matrix.data_b64 !== "string" || matrix.data_b64.length > 256
      || (item.tileResolution !== undefined && item.tileResolution !== tileset.tileSize)) {
      unsupported++;
      continue;
    }

    let tiles: Array<Point | null>;
    try {
      const { cells } = decodeMappingMatrix({
        width: Number(matrix.width), height: Number(matrix.height), data_b64: matrix.data_b64,
      });
      if (cells.length !== paletteTileCount(mode) * 2) { unsupported++; continue; }
      tiles = Array.from({ length: cells.length / 2 }, (_, index) => {
        const tile: Point = [cells[index * 2], cells[index * 2 + 1]];
        return point(tile, tileset) ? tile : null;
      });
    } catch {
      unsupported++;
      continue;
    }
    if (!tiles.some(Boolean)) { unsupported++; continue; }

    const tags = record(item.tags) ? item.tags : {};
    const role = typeof tags["blueprint.role"] === "string" ? tags["blueprint.role"] : "";
    const style = typeof tags["blueprint.style"] === "string" ? tags["blueprint.style"] : "";
    const label = role.split("/").pop() || "素材";
    const terrain = Object.prototype.hasOwnProperty.call(terrainNames, label) ? terrainNames[label] : label;
    const suffix = mode === "cliff" ? "高台" : "";
    palettes.push({
      id: newId(),
      name: (terrain + suffix + (style ? " · " + style : "")).slice(0, 128),
      tileset: tileset.id, mode, tiles, height: mode === "cliff" ? 1 : 0,
      usage: mode === "cliff" ? "platform" : "ground", material: "texture",
      wall: mode === "cliff" ? tiles[13] ?? undefined : undefined,
    });
  }
  return { palettes, unsupported, skippedLayouts: [...skippedLayouts] };
}

export async function importTileset(png: File, tileSize: number, sidecar?: File) {
  let input: unknown[] = [];
  if (sidecar) {
    if (sidecar.size > 8 * 1024 * 1024) throw new Error("Palette 文件过大。");
    const parsed: unknown = JSON.parse(await sidecar.text());
    if (!record(parsed) || parsed.version !== 1 || !Array.isArray(parsed.palettes)
      || !integer(parsed.tileResolution, 1, MAX_TILE_SIZE)) {
      throw new Error("无法读取此 .adnapalettes 文件。");
    }
    input = parsed.palettes;
    tileSize = parsed.tileResolution;
  }
  const tileset = await readTileset(png, png.name.slice(0, 128), tileSize);
  return { tileset, ...readDesktopPalettes(input, tileset) };
}

export async function encodeProject(map: TileMap): Promise<Uint8Array> {
  const json = {
    ...map, format: FORMAT, version: VERSION,
    tilesets: map.tilesets.map(({ id, name, tileSize }) => ({ id, name, tileSize })),
    world: map.world && { ...map.world, terrain: map.world.terrain ? true : undefined,
      textures: map.world.textures?.map(({ id }) => ({ id })) },
  };
  const metadata = strToU8(JSON.stringify(json));
  const textures = map.world?.textures ?? [];
  const terrain = map.world?.terrain;
  const total = metadata.length + (terrain?.size ?? 0) + [...map.tilesets, ...textures].reduce((bytes, asset) => bytes + asset.png.size, 0);
  if (total > MAX_PROJECT_BYTES || metadata.length > MAX_PNG_BYTES || (terrain?.size ?? 0) > MAX_PNG_BYTES) {
    throw new Error("项目过大，请先移除暂时用不到的图集。");
  }
  const files: Zippable = { "project.json": metadata };
  if (terrain) files[TERRAIN_FILE] = new Uint8Array(await terrain.arrayBuffer());
  for (const { png, id } of map.tilesets) {
    files[`tilesets/${id}.png`] = [new Uint8Array(await png.arrayBuffer()), { level: 0 }];
  }
  for (const { png, id } of textures) {
    files[`decorations/${id}.png`] = [new Uint8Array(await png.arrayBuffer()), { level: 0 }];
  }
  const bytes = zipSync(files);
  if (bytes.length > MAX_PROJECT_BYTES) throw new Error("项目包最多 96 MB。");
  return bytes;
}

export async function decodeProject(bytes: Uint8Array): Promise<TileMap> {
  if (bytes.length > MAX_PROJECT_BYTES) throw new Error("项目包最多 96 MB。");
  let total = 0;
  const files = unzipSync(bytes, {
    filter: file => {
      if (file.name !== "project.json" && file.name !== TERRAIN_FILE
        && !/^(tilesets|decorations)\/[a-zA-Z0-9-]{1,100}\.png$/.test(file.name)) return false;
      total += file.originalSize;
      if (total > MAX_PROJECT_BYTES || file.originalSize > MAX_PNG_BYTES) throw new Error("项目包内容过大。");
      return true;
    },
  });
  if (!files["project.json"]) throw new Error("找不到项目数据。");
  const json: unknown = JSON.parse(strFromU8(files["project.json"]));
  if (!record(json) || json.format !== FORMAT || json.version !== VERSION
    || !integer(json.width, 1, MAX_MAP_SIDE) || !integer(json.height, 1, MAX_MAP_SIDE)
    || !Array.isArray(json.tilesets) || !Array.isArray(json.palettes)
    || !Array.isArray(json.layers) || !integer(json.layers.length, 1, MAX_LAYERS)) {
    throw new Error("项目格式或版本不受支持。");
  }
  const { width, height } = json;
  const assets = new Map<string, Tileset>();
  for (const item of json.tilesets) {
    if (!record(item) || !id(item.id) || !name(item.name) || !integer(item.tileSize, 1, MAX_TILE_SIZE)
      || assets.has(item.id) || !files[`tilesets/${item.id}.png`]) throw new Error("项目中的图集缺失或无效。");
    const png = new Blob([files[`tilesets/${item.id}.png`] as BlobPart], { type: "image/png" });
    assets.set(item.id, await readTileset(png, item.name, item.tileSize, item.id));
  }

  const palettes = new Map<string, Palette>();
  for (const item of json.palettes) {
    const tileset = record(item) && typeof item.tileset === "string" ? assets.get(item.tileset) : undefined;
    if (!record(item) || !id(item.id) || !name(item.name) || !tileset || palettes.has(item.id)
      || !integer(item.height, 0, MAX_HEIGHT) || !Array.isArray(item.tiles)
      || (item.mode !== "single" && item.mode !== "edge" && item.mode !== "corner" && item.mode !== "cliff")
      || item.tiles.length !== paletteTileCount(item.mode) || !item.tiles.some(Boolean)
      || !item.tiles.every(tile => tile === null || point(tile, tileset))
      || (item.usage !== undefined && !["ground", "platform", "decoration"].includes(String(item.usage)))
      || (item.material !== undefined && !GAME_MATERIALS.includes(item.material as typeof GAME_MATERIALS[number]))
      || (item.blocked !== undefined && typeof item.blocked !== "boolean")
      || (item.decorationSize !== undefined && (!Array.isArray(item.decorationSize) || item.decorationSize.length !== 2
        || !item.decorationSize.every(v => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 16)))
      || (item.wall !== undefined && !point(item.wall, tileset))) throw new Error("项目中有无效的 Palette。");
    palettes.set(item.id, {
      id: item.id, name: item.name, tileset: tileset.id, mode: item.mode,
      tiles: item.tiles, height: item.height, wall: item.wall,
      usage: item.usage as Palette["usage"], material: item.material as Palette["material"],
      blocked: item.blocked as boolean | undefined, decorationSize: item.decorationSize as Point | undefined,
    });
  }

  let worldData: unknown = json.world;
  if (record(json.world) && json.world.textures !== undefined) {
    if (!Array.isArray(json.world.textures)) throw new Error("面片贴图列表无效。");
    const textures: WorldTexture[] = [];
    const ids = new Set<string>();
    for (const item of json.world.textures) {
      if (!record(item) || !id(item.id) || ids.has(item.id) || !files[`decorations/${item.id}.png`]) {
        throw new Error("面片贴图缺失或无效。");
      }
      ids.add(item.id);
      const png = new Blob([files[`decorations/${item.id}.png`] as BlobPart], { type: "image/png" });
      const texture = await readTileset(png, item.id, 1, item.id);
      textures.push({ id: item.id, png, width: texture.width, height: texture.height });
    }
    worldData = { ...json.world, textures };
  }
  if (record(worldData) && worldData.terrain !== undefined) {
    const bytes = files[TERRAIN_FILE];
    if (worldData.terrain !== true || !bytes) throw new Error("原场景地形文件缺失。");
    const terrain = new Blob([bytes as BlobPart]);
    await readTerrain(terrain);
    worldData = { ...worldData, terrain };
  }

  const layerIds = new Set<string>();
  const layers = json.layers.map(item => {
    if (!record(item) || !id(item.id) || !name(item.name) || typeof item.visible !== "boolean"
      || !record(item.cells) || layerIds.has(item.id)) throw new Error("项目中有无效的图层。");
    layerIds.add(item.id);
    const cells: Record<number, Cell> = {};
    for (const [key, cell] of Object.entries(item.cells)) {
      const index = Number(key);
      if (String(index) !== key || !integer(index, 0, width * height - 1) || !record(cell)) {
        throw new Error("项目中有无效的格子。");
      }
      if (typeof cell.palette === "string" && palettes.has(cell.palette)) {
        cells[index] = { palette: cell.palette };
      } else if (typeof cell.tileset === "string") {
        const tileset = assets.get(cell.tileset);
        const tile = [cell.x, cell.y];
        if (!tileset || !point(tile, tileset)) throw new Error("格子引用了无效的图集坐标。");
        cells[index] = { tileset: tileset.id, x: tile[0], y: tile[1] };
      } else {
        throw new Error("格子引用的 Palette 缺失。");
      }
    }
    return { id: item.id, name: item.name, visible: item.visible, cells };
  });
  return {
    width, height, layers, palettes: [...palettes.values()], tilesets: [...assets.values()],
    world: worldData === undefined ? undefined : readWorld(worldData, width, height),
  };
}

function openDraft(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("blueprint-tilemap-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("draft");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readDraft(key = "active"): Promise<TileMap | undefined> {
  const db = await openDraft();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("draft");
    const request = tx.objectStore("draft").get(key);
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export async function writeDraft(map: TileMap): Promise<void> {
  const db = await openDraft();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("draft", "readwrite");
    const store = tx.objectStore("draft");
    const current = store.get("active");
    current.onsuccess = () => {
      if (current.result) store.put(current.result, "previous");
      store.put(map, "active");
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
