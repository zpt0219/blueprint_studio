import { DEFAULT_FRG_PLACEMENT_MODE, createMapAlignedTerrain, type LiteObject, type LiteTileMap } from "./model";
import { makeHouse } from "./house";

export type CreateKind = "terrain_area" | "terrain_line" | "fixed_rect" | "fixed_rect_group" | "house";
interface CreateOptions {
  paletteHash?: string;
  size?: [number, number];
  style?: string;
  houseWallHash?: string;
  houseRoofHash?: string;
}

function nextName(map: LiteTileMap, role: string): string {
  const parts = role.split("/");
  const base = parts[parts.length - 1] || "object";
  let count = 0;
  for (const layer of map.layers) {
    for (const obj of layer.objects) {
      if ((obj.tags["web.name"] ?? "").startsWith(base)) count++;
    }
  }
  return count > 0 ? `${base} #${count + 1}` : base;
}

export function createObjectForRole(
  map: LiteTileMap,
  id: number,
  role: string,
  kind: CreateKind,
  x: number,
  y: number,
  options: CreateOptions = {},
): LiteObject {
  const [pw, ph] = options.size ?? [1, 1];
  const tags: Record<string, string> = {
    "blueprint.role": role,
    "web.name": nextName(map, role),
    "web.baseName": role.split("/").slice(-1)[0] || role,
  };
  if (options.style) tags["blueprint.style"] = options.style;
  if (options.paletteHash && kind !== "house" && kind !== "fixed_rect_group") tags["web.palette"] = options.paletteHash;
  if (kind === "terrain_area" || kind === "terrain_line") {
    const geometry = createMapAlignedTerrain(map);
    if (x >= 0 && y >= 0 && x < map.width && y < map.height) {
      geometry.terrain.data[y * map.width + x] = 0;
    }
    return {
      id,
      type: kind === "terrain_area" ? "TERRAIN_2_CORNER" : "TERRAIN_2_EDGE",
      enabled: true,
      tags,
      ...geometry,
    };
  }
  if (kind === "fixed_rect_group") {
    const w = Math.max(1, pw);
    const h = Math.max(1, ph);
    return {
      id,
      type: "FIXED_RECT_GROUP",
      rect: [x, y, w, h],
      enabled: true,
      tags,
      ...(options.paletteHash ? { frg: { cells: [{ palette: options.paletteHash, weight: 100 }], placementMode: DEFAULT_FRG_PLACEMENT_MODE } } : {}),
      terrain: { ox: x, oy: y, w, h, data: new Int16Array(w * h) },
    };
  }
  if (kind === "house") {
    const rect: [number, number, number, number] = [x, y, Math.max(2, pw), Math.max(2, ph)];
    const house = makeHouse(rect[2], rect[3]);
    if (options.houseWallHash) house.wall = options.houseWallHash;
    if (options.houseRoofHash) house.roof = options.houseRoofHash;
    return {
      id,
      type: "HOUSE",
      rect,
      enabled: true,
      tags,
      house,
    };
  }
  return {
    id,
    type: "FIXED_RECT",
    rect: [x, y, Math.max(1, pw), Math.max(1, ph)],
    enabled: true,
    tags,
  };
}
