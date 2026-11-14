import type { Cell, Point, TileMap } from "./model";

export type Selection = { x: number; y: number; width: number; height: number };
export type Clipboard = { width: number; height: number; cells: Record<number, Cell> };

export function rectangle(a: Point, b: Point): Selection {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]) + 1, height: Math.abs(a[1] - b[1]) + 1 };
}

export function copySelection(map: TileMap, layerId: string, area: Selection): Clipboard {
  const layer = map.layers.find(item => item.id === layerId);
  const cells: Record<number, Cell> = {};
  for (let y = 0; y < area.height; y++) for (let x = 0; x < area.width; x++) {
    const cell = layer?.cells[(y + area.y) * map.width + x + area.x];
    if (cell) cells[y * area.width + x] = cell;
  }
  return { width: area.width, height: area.height, cells };
}

export function clearSelection(map: TileMap, layerId: string, area: Selection): TileMap {
  const layer = map.layers.find(item => item.id === layerId && item.visible);
  if (!layer) return map;
  const cells = { ...layer.cells };
  for (let y = area.y; y < area.y + area.height; y++) for (let x = area.x; x < area.x + area.width; x++) {
    delete cells[y * map.width + x];
  }
  return { ...map, layers: map.layers.map(item => item === layer ? { ...item, cells } : item) };
}

export function pasteSelection(map: TileMap, layerId: string, clip: Clipboard, at: Point): TileMap {
  const layer = map.layers.find(item => item.id === layerId && item.visible);
  if (!layer) return map;
  const cells = { ...layer.cells };
  for (let y = 0; y < clip.height; y++) for (let x = 0; x < clip.width; x++) {
    const tx = at[0] + x, ty = at[1] + y;
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) continue;
    const cell = clip.cells[y * clip.width + x];
    if (cell) cells[ty * map.width + tx] = cell;
    else delete cells[ty * map.width + tx];
  }
  return { ...map, layers: map.layers.map(item => item === layer ? { ...item, cells } : item) };
}

export function moveSelection(map: TileMap, layerId: string, area: Selection, at: Point): TileMap {
  if (area.x === at[0] && area.y === at[1]) return map;
  return pasteSelection(clearSelection(map, layerId, area), layerId, copySelection(map, layerId, area), at);
}
