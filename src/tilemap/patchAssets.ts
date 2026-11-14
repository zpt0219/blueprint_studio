import { buildWorldPatch } from "./world";
import { resolveSurfaces, type TileMap, type Tile } from "./model";
import { tilesetImage } from "./files";
import { drawTile, type Atlases } from "./draw";

// Portable patch: resolved autotile variants and composited layers travel with the JSON.
// Native code only needs a cell-to-atlas lookup and never guesses the browser's autotile rules.
export async function buildPortablePatch(map: TileMap, baseline: TileMap) {
  const patch = buildWorldPatch(map, baseline);
  const surfaces = resolveSurfaces(map);
  const atlases: Atlases = new Map(await Promise.all(map.tilesets.map(async asset =>
    [asset.id, { image: await tilesetImage(asset.png), tileSize: asset.tileSize }] as const)));
  const entries: Tile[][] = [];
  const slots = new Map<string, number>();
  const register = (tiles: Tile[]) => {
    if (!tiles.length) return 0;
    const key = JSON.stringify(tiles);
    let id = slots.get(key);
    if (id === undefined) { id = entries.length + 1; slots.set(key, id); entries.push(tiles); }
    return id;
  };
  const native = new Set(["grass", "snow", "road", "sand", "rock", "water", "ice", "lava"]);
  const textures = patch.paint.flatMap(row => {
    const surface = surfaces[row.tile[1] * map.width + row.tile[0]];
    if (!surface) return [];
    const top = row.palette && !native.has(row.palette) ? register(surface.tiles) : 0;
    const side = surface.wall ? register([surface.wall]) : 0;
    return top || side ? [{ tile: row.tile, top, side }] : [];
  });
  const props = surfaces.flatMap((surface, index) => (surface?.decorations ?? []).map(decoration => ({
    tile: [index % map.width, Math.floor(index / map.width)],
    texture: register([decoration.tile]), size: decoration.size, blocked: decoration.blocked,
  })));
  const blocked = surfaces.flatMap((surface, index) => surface?.blocked ? [[index % map.width, Math.floor(index / map.width)]] : []);
  const pixels = Math.max(16, ...map.tilesets.map(asset => asset.tileSize));
  const columns = Math.min(32, Math.max(1, entries.length));
  const rows = Math.ceil(entries.length / columns);
  if (rows * pixels > 4096) throw new Error("补丁中的不同贴图组合过多，请减少素材组合后再导出。");
  let atlas: { png: string; pixels: number; columns: number; count: number } | undefined;
  if (entries.length) {
    const canvas = document.createElement("canvas");
    canvas.width = columns * pixels; canvas.height = rows * pixels;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    entries.forEach((tiles, index) => tiles.forEach(tile => {
      if (!atlases.has(tile.tileset)) throw new Error("补丁引用了缺失的图集。");
      drawTile(ctx, atlases, tile, index % columns * pixels, Math.floor(index / columns) * pixels, pixels);
    }));
    atlas = { png: canvas.toDataURL("image/png").split(",")[1], pixels, columns, count: entries.length };
  }
  return { ...patch, atlas, textures, props, blocked };
}
