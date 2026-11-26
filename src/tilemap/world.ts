import { type Cell, type TileMap, type WorldMap, type WorldPoint, WORLD_DETAIL_COLORS, resolveSurfaces, cardPosition, gridPosition, worldPosition } from "./model";

export const AK_PROJECT_URL = `${import.meta.env.BASE_URL}sample/ak-world.bptilemap`;
export const AK_PREVIEW_VERSION = 7;

export function readWorld(value: unknown, width: number, height: number): WorldMap {
  const finite = (number: unknown) => typeof number === "number" && Number.isFinite(number);
  const vector = (value: unknown, length: number) =>
    Array.isArray(value) && value.length === length && value.every(finite);
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(value) || typeof value.id !== "string" || typeof value.revision !== "string"
    || !vector(value.origin, 2) || typeof value.metresPerTile !== "number"
    || value.metresPerTile <= 0 || value.metresPerTile > 128
    || !vector(value.heights, width * height) || !Array.isArray(value.markers) || !Array.isArray(value.proxies)
    || !value.markers.every(item => object(item) && typeof item.id === "string"
      && typeof item.name === "string" && vector(item.position, 3))
    || !value.proxies.every(item => object(item) && vector(item.position, 3) && vector(item.size, 3)
      && (item.size as number[]).every(size => size > 0))
    || (value.wallColliders !== undefined && (!Array.isArray(value.wallColliders) || !value.wallColliders.every(item =>
      object(item) && vector(item.position, 3) && vector(item.size, 3) && finite(item.yaw)
      && (item.size as number[]).every(size => size > 0))))
    || (value.elevations !== undefined && (!object(value.elevations)
      || !Object.entries(value.elevations).every(([key, metres]) => {
        const index = Number(key);
        return Number.isInteger(index) && String(index) === key && index >= 0 && index < width * height && finite(metres);
      })))
    || (value.terrain !== undefined && !(value.terrain instanceof Blob))
    || (value.previewVersion !== undefined && !Number.isInteger(value.previewVersion))
    || (value.lavaCells !== undefined && (!Array.isArray(value.lavaCells)
      || !value.lavaCells.every(index => Number.isInteger(index) && index >= 0 && index < width * height)))
    || (value.testPoint !== undefined && !vector(value.testPoint, 3))) {
    throw new Error("世界坐标或高程数据无效。");
  }
  if (value.details !== undefined && (!Array.isArray(value.details) || !value.details.every(detail => {
    if (!object(detail) || typeof detail.kind !== "string" || !Object.prototype.hasOwnProperty.call(WORLD_DETAIL_COLORS, detail.kind)
      || !Array.isArray(detail.vertices) || detail.vertices.length % 3 || !detail.vertices.every(finite)
      || !Array.isArray(detail.triangles) || detail.triangles.length % 3) return false;
    const count = detail.vertices.length / 3;
    return detail.triangles.every(index => Number.isInteger(index) && index >= 0 && index < count);
  }))) throw new Error("场景几何数据无效。");
  const textures = new Map<string, { width: number; height: number }>();
  if (value.textures !== undefined) {
    if (!Array.isArray(value.textures)) throw new Error("面片贴图数据无效。");
    for (const texture of value.textures) {
      if (!object(texture) || typeof texture.id !== "string" || textures.has(texture.id)
        || !Number.isInteger(texture.width) || !Number.isInteger(texture.height)
        || typeof texture.width !== "number" || typeof texture.height !== "number"
        || texture.width <= 0 || texture.height <= 0 || !(texture.png instanceof Blob)) {
        throw new Error("面片贴图缺失或无效。");
      }
      textures.set(texture.id, { width: texture.width, height: texture.height });
    }
  }
  if (value.cards !== undefined) {
    const ids = new Set<string>();
    if (!Array.isArray(value.cards) || !value.cards.every(card => {
      if (!object(card) || typeof card.texture !== "string" || !vector(card.position, 3)
        || !vector(card.size, 2) || !vector(card.offset, 2) || !vector(card.region, 4)
        || !vector(card.color, 4) || typeof card.flipH !== "boolean" || typeof card.flipV !== "boolean"
        || typeof card.threshold !== "number" || !Number.isFinite(card.threshold)
        || card.threshold < 0 || card.threshold > 1) return false;
      if (card.id !== undefined) {
        if (typeof card.id !== "string" || !card.id || ids.has(card.id)) return false;
        ids.add(card.id);
      }
      if (card.name !== undefined && typeof card.name !== "string") return false;
      const texture = textures.get(card.texture);
      const [x, y, w, h] = card.region as number[];
      return texture && x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= texture.width && y + h <= texture.height
        && (card.size as number[]).every(size => size > 0)
        && (card.color as number[]).every(channel => channel >= 0 && channel <= 1);
    })) throw new Error("面片尺寸或图集区域无效。");
  }
  return value as unknown as WorldMap;
}

export function worldPreviewSurfaces(surfaces: ReturnType<typeof resolveSurfaces>, lavaCells?: number[]) {
  if (!lavaCells?.length) return surfaces;
  const preview = surfaces.slice();
  for (const index of lavaCells) {
    const surface = surfaces[index];
    const tile = surface?.tiles[0];
    if (surface && tile?.tileset === "ak-debug" && tile.x === 96 && tile.y === 0) {
      // The native lava geometry supplies the liquid. Its banks use the rock tile.
      preview[index] = { ...surface, tiles: [{ ...tile, x: 48 }, ...surface.tiles.slice(1)] };
    }
  }
  return preview;
}

function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  if (!a || !b) return a === b;
  return "palette" in a ? "palette" in b && a.palette === b.palette
    : "tileset" in b && a.tileset === b.tileset && a.x === b.x && a.y === b.y;
}

export function buildWorldPatch(map: TileMap, baseline: TileMap) {
  const world = map.world;
  if (!world || !baseline.world || world.id !== baseline.world.id || world.revision !== baseline.world.revision
    || map.width !== baseline.width || map.height !== baseline.height
    || world.metresPerTile !== baseline.world.metresPerTile
    || world.origin.some((coordinate, i) => coordinate !== baseline.world!.origin[i])) {
    throw new Error("找不到此地图版本的原始快照。");
  }
  const paletteNames = new Map(map.palettes.map(palette => [palette.id, palette.name]));
  const layers = new Map(map.layers.map(layer => [layer.id, layer]));
  const originals = new Map(baseline.layers.map(layer => [layer.id, layer]));
  const changes: Array<{
    layer: string; tile: number[]; xz: number[]; cell: Cell | null; material: string | null;
  }> = [];
  for (const id of new Set([...originals.keys(), ...layers.keys()])) {
    const cells = layers.get(id)?.cells ?? {};
    const original = originals.get(id)?.cells ?? {};
    for (const key of new Set([...Object.keys(original), ...Object.keys(cells)])) {
      const index = Number(key);
      const cell = cells[index];
      if (sameCell(cell, original[index])) continue;
      const tile = [index % map.width, Math.floor(index / map.width)];
      changes.push({
        layer: id, tile, xz: worldPosition(world, tile[0] + 0.5, tile[1] + 0.5),
        cell: cell ?? null,
        material: cell && "palette" in cell ? paletteNames.get(cell.palette) ?? null : null,
      });
    }
  }
  const surfaces = resolveSurfaces(map);
  const originalSurfaces = resolveSurfaces(baseline);
  const changedIndices = new Set(changes.map(row => row.tile[1] * map.width + row.tile[0]));
  const appearance = (document: TileMap, index: number, surface: typeof surfaces[number]) => {
    const materials = document.layers.filter(layer => layer.visible).map(layer => {
      const cell = layer.cells[index];
      return cell && "palette" in cell ? document.palettes.find(p => p.id === cell.palette)?.material : undefined;
    }).filter(Boolean);
    return JSON.stringify([surface?.tiles, surface?.wall, surface?.decorations, surface?.blocked, materials]);
  };
  for (let index = 0; index < map.width * map.height; index++) {
    if (changedIndices.has(index) || appearance(map, index, surfaces[index]) === appearance(baseline, index, originalSurfaces[index])) continue;
    const tile = [index % map.width, Math.floor(index / map.width)];
    changes.push({ layer: "appearance", tile, xz: worldPosition(world, tile[0] + 0.5, tile[1] + 0.5), cell: null, material: null });
  }
  const visibleLayers = map.layers.filter(layer => layer.visible).reverse();
  const paintedIndices = new Set(changes.map(({ tile: [x, z] }) => z * map.width + x));
  const paint = Array.from(paintedIndices, index => {
    const top = visibleLayers.map(layer => layer.cells[index]).find(cell => cell &&
      (!("palette" in cell) || map.palettes.find(p => p.id === cell.palette)?.usage !== "decoration"));
    const palette = top && "palette" in top ? map.palettes.find(p => p.id === top.palette) : undefined;
    return {
      tile: [index % map.width, Math.floor(index / map.width)],
      palette: !top ? null : palette?.material ?? ("palette" in top ? top.palette : "texture"),
    };
  });
  const elevations: Array<{ tile: number[]; position: WorldPoint; originalHeight: number }> = [];
  for (const [index, originalHeight] of baseline.world.heights.entries()) {
    const surface = surfaces[index];
    const y = surface ? Number((surface.height * world.metresPerTile).toFixed(3))
      : world.elevations?.[index] ?? originalHeight;
    if (y === originalHeight) continue;
    const tile = [index % map.width, Math.floor(index / map.width)];
    const [x, z] = worldPosition(world, tile[0] + 0.5, tile[1] + 0.5);
    elevations.push({ tile, position: [x, y, z], originalHeight });
  }
  if (baseline.world.cards?.length && (world.cards === undefined || world.cards.some(card => !card.id))) {
    throw new Error("面片的原场景绑定尚未补齐，请重新打开当前项目。");
  }
  const currentCards = new Map((world.cards ?? []).filter(card => card.id).map(card => [card.id, card]));
  const decorations: Array<{ id: string; originalPosition: WorldPoint; position: WorldPoint | null }> = [];
  for (const original of baseline.world.cards ?? []) {
    if (!original.id) continue;
    const card = currentCards.get(original.id);
    const position = card ? cardPosition(world, map.width, card, surfaces)
      .map(value => Math.round(value * 1000) / 1000) as WorldPoint : null;
    if (!position || position.some((value, i) => value !== original.position[i])) {
      decorations.push({ id: original.id, originalPosition: original.position, position });
    }
  }
  let testPoint = world.testPoint;
  if (testPoint) {
    const [x, z] = gridPosition(world, testPoint[0], testPoint[2]);
    const changedHeight = elevations.find(({ tile }) => tile[0] === Math.floor(x) && tile[1] === Math.floor(z));
    if (changedHeight) testPoint = [testPoint[0], changedHeight.position[1], testPoint[2]];
  }
  return {
    format: "blueprint-world-patch", version: 1, world: world.id, revision: world.revision,
    origin: world.origin, metresPerTile: world.metresPerTile, changes, paint, elevations, decorations, testPoint,
  };
}
