import type { Tile } from "./model";

export interface Atlas {
  image: CanvasImageSource;
  tileSize: number;
}

export type Atlases = ReadonlyMap<string, Atlas>;

export function drawTile(ctx: CanvasRenderingContext2D, atlases: Atlases, tile: Tile, x: number, y: number, size: number, height = size) {
  const atlas = atlases.get(tile.tileset);
  if (!atlas) return;
  ctx.drawImage(atlas.image, tile.x, tile.y, atlas.tileSize, atlas.tileSize, x, y, size, height);
}
