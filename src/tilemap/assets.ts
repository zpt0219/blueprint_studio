import { newId, type TileMap, type Tileset, type Point } from "./model";

export function replaceTileset(map: TileMap, original: Tileset, replacement: Tileset): TileMap {
  const convert = (point: Point): Point => {
    const result: Point = point.map(v => v / original.tileSize * replacement.tileSize) as Point;
    if (result[0] + replacement.tileSize > replacement.width || result[1] + replacement.tileSize > replacement.height) {
      throw new Error("新图集容纳不了已有选区。请保留已使用的行列，或先清除对应引用。");
    }
    return result;
  };
  return {
    ...map,
    tilesets: map.tilesets.map(item => item.id === original.id ? { ...replacement, id: original.id } : item),
    palettes: map.palettes.map(item => item.tileset !== original.id ? item : {
      ...item, tiles: item.tiles.map(tile => tile && convert(tile)), wall: item.wall && convert(item.wall),
    }),
    layers: map.layers.map(layer => ({ ...layer, cells: Object.fromEntries(Object.entries(layer.cells).map(([index, cell]) => {
      if (!("tileset" in cell) || cell.tileset !== original.id) return [index, cell];
      const [x, y] = convert([cell.x, cell.y]);
      return [index, { ...cell, x, y }];
    })) })),
  };
}

export function mergePack(map: TileMap, pack: TileMap): TileMap {
  const ids = new Map(pack.tilesets.map(asset => [asset.id, newId()]));
  return { ...map, tilesets: [...map.tilesets, ...pack.tilesets.map(asset => ({ ...asset, id: ids.get(asset.id)! }))],
    palettes: [...map.palettes, ...pack.palettes.map(palette => ({ ...palette, id: newId(), tileset: ids.get(palette.tileset)! }))] };
}
