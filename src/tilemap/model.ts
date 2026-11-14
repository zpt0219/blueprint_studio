import { cornerMask, edgeMask, TWO_CORNER_MATRIX, TWO_EDGE_MATRIX } from "../shared/tileNeighbors";

export const MAX_MAP_SIDE = 256;
export const MAX_HEIGHT = 16;
export const MAX_LAYERS = 16;

export type Point = [number, number];
export type PaletteMode = "single" | "edge" | "corner" | "cliff";
export type Tile = { tileset: string; x: number; y: number };
export type Cell = Tile | { palette: string };

export interface Tileset {
  id: string;
  name: string;
  tileSize: number;
  width: number;
  height: number;
  png: Blob;
}

export const GAME_MATERIALS = ["texture", "grass", "snow", "road", "sand", "rock"] as const;
export type GameMaterial = typeof GAME_MATERIALS[number];

export interface Palette {
  id: string;
  name: string;
  tileset: string;
  mode: PaletteMode;
  tiles: Array<Point | null>;
  height: number;
  wall?: Point;
  usage?: "ground" | "platform" | "decoration";
  material?: GameMaterial;
  blocked?: boolean;
  decorationSize?: Point;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  cells: Record<number, Cell>;
}

export type WorldPoint = [number, number, number];

export interface WorldMarker {
  id: string;
  name: string;
  position: WorldPoint;
}

export interface WorldProxy {
  position: WorldPoint;
  size: WorldPoint;
}

export interface WorldWallCollider extends WorldProxy {
  yaw: number;
}

export const WORLD_DETAIL_COLORS = {
  frost: "#c2e3eb", ice: "#74b8ce", sea: "#568b9f", tide: "#67aab5",
  lava: "#e67c43", embers: "#f6b55a", wall: "#776e63", building: "#b19a80",
  roof: "#795745", bridge: "#9c744e", wood: "#795437", stone: "#96958a",
};

export interface WorldDetail {
  kind: keyof typeof WORLD_DETAIL_COLORS;
  vertices: number[];
  triangles: number[];
}

export interface WorldTexture {
  id: string;
  width: number;
  height: number;
  png: Blob;
}

export interface WorldCard {
  id?: string;
  name?: string;
  texture: string;
  position: WorldPoint;
  size: Point;
  offset: Point;
  region: [number, number, number, number];
  flipH: boolean;
  flipV: boolean;
  color: [number, number, number, number];
  threshold: number;
}

export interface WorldMap {
  id: string;
  revision: string;
  origin: Point;
  metresPerTile: number;
  heights: number[];
  markers: WorldMarker[];
  proxies: WorldProxy[];
  wallColliders?: WorldWallCollider[];
  previewVersion?: number;
  details?: WorldDetail[];
  terrain?: Blob;
  lavaCells?: number[];
  cards?: WorldCard[];
  textures?: WorldTexture[];
  elevations?: Record<number, number>;
  testPoint?: WorldPoint;
}

export function gridPosition(world: WorldMap, x: number, z: number): Point {
  return [(x - world.origin[0]) / world.metresPerTile, (z - world.origin[1]) / world.metresPerTile];
}

function groundIndex(world: WorldMap, width: number, x: number, z: number): number {
  const col = Math.floor((x - world.origin[0]) / world.metresPerTile);
  const row = Math.floor((z - world.origin[1]) / world.metresPerTile);
  return col >= 0 && col < width && row >= 0 && row < world.heights.length / width ? row * width + col : -1;
}

function nativeGround(world: WorldMap, width: number, x: number, z: number): number {
  return world.heights[groundIndex(world, width, x, z)] ?? 0;
}

export function cardHeight(world: WorldMap, width: number, card: WorldCard, surfaces: Array<Surface | undefined>): number {
  const tile = groundIndex(world, width, card.position[0], card.position[2]);
  const ground = world.heights[tile];
  if (ground === undefined) return card.position[1];
  const surface = surfaces[tile];
  const height = surface ? surface.height * world.metresPerTile : world.elevations?.[tile] ?? ground;
  return card.position[1] + height - ground;
}

export function cardPosition(world: WorldMap, width: number, card: WorldCard, surfaces: Array<Surface | undefined>): WorldPoint {
  return [card.position[0], cardHeight(world, width, card, surfaces), card.position[2]];
}

export function moveCard(map: TileMap, id: string, x: number, z: number): TileMap {
  const world = map.world;
  const card = world?.cards?.find(item => item.id === id);
  if (!world || !card) return map;
  x = Math.round(Math.max(world.origin[0], Math.min(world.origin[0] + map.width * world.metresPerTile - 0.001, x)) * 1000) / 1000;
  z = Math.round(Math.max(world.origin[1], Math.min(world.origin[1] + map.height * world.metresPerTile - 0.001, z)) * 1000) / 1000;
  if (card.position[0] === x && card.position[2] === z) return map;
  const y = card.position[1] + nativeGround(world, map.width, x, z)
    - nativeGround(world, map.width, card.position[0], card.position[2]);
  return { ...map, world: { ...world, cards: world.cards!.map(item =>
    item === card ? { ...card, position: [x, Math.round(y * 1000) / 1000, z] } : item) } };
}

export function deleteCard(map: TileMap, id: string): TileMap {
  const world = map.world;
  if (!world?.cards?.some(card => card.id === id)) return map;
  return { ...map, world: { ...world, cards: world.cards.filter(card => card.id !== id) } };
}

export function worldPosition(world: WorldMap, x: number, z: number): Point {
  return [world.origin[0] + x * world.metresPerTile, world.origin[1] + z * world.metresPerTile];
}

export interface TileMap {
  width: number;
  height: number;
  tilesets: Tileset[];
  palettes: Palette[];
  layers: Layer[];
  world?: WorldMap;
}

export interface SurfaceDecoration { tile: Tile; size: Point; blocked: boolean }

export interface Surface {
  tiles: Tile[];
  height: number;
  wall?: Tile;
  decorations?: SurfaceDecoration[];
  blocked?: boolean;
}

export function newId(): string {
  return crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join("-");
}

export function makeLayer(name: string): Layer {
  return { id: newId(), name, visible: true, cells: {} };
}

export function makeMap(width = 48, height = 36): TileMap {
  return { width, height, layers: [makeLayer("图层 1")], tilesets: [], palettes: [] };
}

function equalCell(a: Cell | undefined, b: Cell | null): boolean {
  if (!a || !b) return !a && !b;
  if ("palette" in a) return "palette" in b && a.palette === b.palette;
  return "tileset" in b && a.tileset === b.tileset && a.x === b.x && a.y === b.y;
}

function* strokeCells(width: number, height: number, from: Point, to: Point, size: number): Generator<number> {
  let [x, y] = from;
  const dx = Math.abs(to[0] - x);
  const dy = -Math.abs(to[1] - y);
  const sx = x < to[0] ? 1 : -1;
  const sy = y < to[1] ? 1 : -1;
  const radius = Math.floor(size / 2);
  let error = dx + dy;
  for (;;) {
    for (let row = Math.max(0, y - radius); row <= Math.min(height - 1, y + radius); row++) {
      for (let col = Math.max(0, x - radius); col <= Math.min(width - 1, x + radius); col++) {
        yield row * width + col;
      }
    }
    if (x === to[0] && y === to[1]) break;
    const doubled = 2 * error;
    if (doubled >= dy) { error += dy; x += sx; }
    if (doubled <= dx) { error += dx; y += sy; }
  }
}

export function paint(map: TileMap, layerId: string, from: Point, to: Point, size: number, cell: Cell | null): TileMap {
  const layer = map.layers.find(candidate => candidate.id === layerId && candidate.visible);
  if (!layer) return map;
  let cells = layer.cells;
  for (const index of strokeCells(map.width, map.height, from, to, size)) {
    if (equalCell(cells[index], cell)) continue;
    if (cells === layer.cells) cells = { ...cells };
    if (cell) cells[index] = cell;
    else delete cells[index];
  }
  return cells === layer.cells ? map : {
    ...map,
    layers: map.layers.map(candidate => candidate === layer ? { ...layer, cells } : candidate),
  };
}

export function paintElevation(map: TileMap, from: Point, to: Point, size: number, metres: number): TileMap {
  const world = map.world;
  if (!world) return map;
  let elevations = world.elevations;
  for (const index of strokeCells(map.width, map.height, from, to, size)) {
    if (elevations?.[index] === metres) continue;
    if (elevations === world.elevations) elevations = { ...elevations };
    elevations![index] = metres;
  }
  return elevations === world.elevations ? map : { ...map, world: { ...world, elevations } };
}

export function paletteTileCount(mode: PaletteMode): number {
  if (mode === "single") return 1;
  return mode === "cliff" ? 20 : 16;
}

const edgeSlots = TWO_EDGE_MATRIX.flat();
const cornerSlots = TWO_CORNER_MATRIX.flat();

function cliffSlot(has: (x: number, y: number) => boolean, x: number, y: number): number {
  const north = has(x, y - 1), south = has(x, y + 1);
  const west = has(x - 1, y), east = has(x + 1, y);
  // Desktop's 4×5 layout has a 3×3 top, a transition column and two wall rows.
  const row = north === south ? 1 : north ? 2 : 0;
  const col = west === east ? 1 : west ? 2 : 0;
  if (north && south && east && west) {
    const corners = cornerMask(has, x, y);
    if (corners === 11) return 11;
    if (corners === 13) return 7;
  }
  return row * 4 + col;
}

export function paletteTop(palette: Palette, has: (x: number, y: number) => boolean, x: number, y: number): Point | null {
  if (palette.mode === "single") return palette.tiles[0];
  if (palette.mode === "cliff") return palette.tiles[cliffSlot(has, x, y)];
  if (palette.mode === "corner") return palette.tiles[cornerSlots.indexOf(cornerMask(has, x, y))];
  return palette.tiles[edgeSlots.indexOf(edgeMask(has, x, y))];
}

export function resolveSurfaces(map: TileMap): Array<Surface | undefined> {
  const { width, height, world } = map;
  const surfaces = new Array<Surface | undefined>(width * height);
  const palettes = new Map(map.palettes.map(palette => [palette.id, palette]));
  for (const layer of map.layers) {
    if (!layer.visible) continue;
    for (const [key, cell] of Object.entries(layer.cells)) {
      const index = Number(key);
      if (!("palette" in cell)) {
        const surface = surfaces[index] ??= { tiles: [], height: 0 };
        surface.tiles.push(cell);
        continue;
      }
      const palette = palettes.get(cell.palette);
      if (!palette) continue;
      const has = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return false;
        const neighbor = layer.cells[y * width + x];
        return !!neighbor && "palette" in neighbor && neighbor.palette === palette.id;
      };
      const top = paletteTop(palette, has, index % width, Math.floor(index / width));
      if (!top) continue;
      const surface = surfaces[index] ??= { tiles: [], height: 0 };
      const tile = { tileset: palette.tileset, x: top[0], y: top[1] };
      if (palette.usage === "decoration") {
        (surface.decorations ??= []).push({ tile, size: palette.decorationSize ?? [1, 1], blocked: !!palette.blocked });
        continue;
      }
      const mapped = world && palette.material && palette.material !== "texture" ? palettes.get(palette.material) : undefined;
      const mappedTop = mapped && paletteTop(mapped, has, index % width, Math.floor(index / width));
      surface.tiles.push(mapped && mappedTop ? { tileset: mapped.tileset, x: mappedTop[0], y: mappedTop[1] } : tile);
      if (palette.blocked) surface.blocked = true;
      if (palette.height >= surface.height) {
        surface.height = palette.height;
        surface.wall = palette.wall && { tileset: palette.tileset, x: palette.wall[0], y: palette.wall[1] };
      }
    }
  }
  if (world) {
    for (const [index, metres] of world.heights.entries()) {
      const surface = surfaces[index];
      if (!surface) continue;
      const override = world.elevations?.[index];
      surface.height = override === undefined
        ? surface.height + metres / world.metresPerTile
        : override / world.metresPerTile;
    }
  }
  return surfaces;
}

export function elevationSides(surfaces: Array<Surface | undefined>, width: number, height: number, x: number, y: number): number[] {
  const north = y > 0 ? surfaces[(y - 1) * width + x] : undefined;
  const east = x + 1 < width ? surfaces[y * width + x + 1] : undefined;
  const south = y + 1 < height ? surfaces[(y + 1) * width + x] : undefined;
  const west = x > 0 ? surfaces[y * width + x - 1] : undefined;
  return [north, east, south, west].map(neighbor => neighbor?.height ?? 0);
}

export function cellReferences(cell: Cell, tileset: string | undefined, palettes: ReadonlySet<string>): boolean {
  return "palette" in cell ? palettes.has(cell.palette) : cell.tileset === tileset;
}
