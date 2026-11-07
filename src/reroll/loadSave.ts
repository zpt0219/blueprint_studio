// loadSave.ts — deserialize `adna-web-lite` save files back into `LiteTileMap`
// (100% round-trip with saveFormat.ts `liteToWebSave`), plus blank map creation
// with the 7 authoritative top-level Role categories.

import {
  DEFAULT_FRG_PLACEMENT_MODE,
  assignUniqueObjectNames,
  type FrgPlacementMode,
  type HouseDecorationKind,
  type Layer,
  type LiteObject,
  type LiteTileMap,
  type Rect,
  type TerrainMatrix,
} from "./model";
import { WEB_SAVE_FORMAT, type WebSaveFile, type WebSaveLayer, type WebSaveObject } from "./saveFormat";
import { applyNoiseConfig } from "./terrainNoise";
import { stratumForRole, topRoleNode, topRoleOrder } from "./roleTree";
import type { Vec2 } from "./types";

export function isWebSaveFile(data: unknown): data is WebSaveFile {
  if (!data || typeof data !== "object") return false;
  const rec = data as Record<string, unknown>;
  return rec.format === WEB_SAVE_FORMAT && Array.isArray(rec.layers);
}

function buildTerrainFromCells(rect: Rect, cells: Vec2[] | undefined): TerrainMatrix {
  const [ox, oy, w, h] = [
    Math.round(rect[0]),
    Math.round(rect[1]),
    Math.max(1, Math.round(rect[2])),
    Math.max(1, Math.round(rect[3])),
  ];
  const data = new Int16Array(w * h).fill(-1);
  for (const cell of cells ?? []) {
    if (!Array.isArray(cell) || cell.length < 2) continue;
    const cx = Math.round(cell[0]) - ox;
    const cy = Math.round(cell[1]) - oy;
    if (cx >= 0 && cy >= 0 && cx < w && cy < h) {
      data[cy * w + cx] = 0;
    }
  }
  return { ox, oy, w, h, data };
}

function restoreObject(src: WebSaveObject, id: number): LiteObject {
  const rect: Rect = [
    Math.round(src.rect[0]),
    Math.round(src.rect[1]),
    Math.max(1, Math.round(src.rect[2])),
    Math.max(1, Math.round(src.rect[3])),
  ];
  let tags: Record<string, string> = src.tags ? { ...src.tags } : {};

  const obj: LiteObject = {
    id,
    type: src.type,
    rect,
    enabled: src.enabled !== false,
    tags,
  };

  switch (src.type) {
    case "TERRAIN_2_CORNER":
    case "TERRAIN_2_EDGE":
    case "FIXED_RECT_GROUP": {
      obj.terrain = buildTerrainFromCells(rect, src.cells);
      if (src.type === "FIXED_RECT_GROUP" && src.frg) {
        if (src.frg.noise) {
          tags = applyNoiseConfig(tags, "web.frg", {
            seed: src.frg.noise.seed,
            scale: src.frg.noise.scale,
            range: [src.frg.noise.range[0], src.frg.noise.range[1]],
          });
          obj.tags = tags;
        }
        obj.frg = {
          placementMode: (src.frg.placementMode as FrgPlacementMode) ?? DEFAULT_FRG_PLACEMENT_MODE,
          cells: (src.frg.cells ?? []).map((c) => ({ palette: c.palette, weight: c.weight })),
        };
      }
      break;
    }
    case "DUNGEON": {
      if (src.points && src.points.length > 0) {
        obj.borderPoints = src.points.map((p) => [p[0], p[1]] as Vec2);
      }
      break;
    }
    case "HOUSE": {
      if (src.house) {
        obj.house = {
          wallHeight: src.house.wallHeight,
          overlap: src.house.overlap,
          ...(src.house.wall ? { wall: src.house.wall } : {}),
          ...(src.house.roof ? { roof: src.house.roof } : {}),
          decorations: (src.house.decorations ?? []).map((d) => ({
            kind: d.kind as HouseDecorationKind,
            cell: [d.cell[0], d.cell[1]] as [number, number],
            ...(d.palette ? { palette: d.palette } : {}),
          })),
        };
      }
      break;
    }
    case "FIXED_RECT":
      break;
  }

  return obj;
}

function restoreLayer(src: WebSaveLayer, id: number, allocObj: () => number): Layer {
  const tags: Record<string, string> = src.tags ? { ...src.tags } : {};
  const root = tags["role.root"] || src.name;
  const stratum = tags["role.stratum"] || stratumForRole(root);
  delete tags["adna.kind"];
  return {
    id,
    name: src.name,
    enabled: src.enabled !== false,
    vertical: stratum === "vertical",
    tags,
    objects: (src.objects ?? []).map((o) => restoreObject(o, allocObj())),
  };
}

/** Deserialize an `adna-web-lite` save object into a live `LiteTileMap`. */
export function webSaveToLite(save: WebSaveFile): LiteTileMap {
  if (!isWebSaveFile(save)) {
    throw new Error(`Invalid save format: expected "${WEB_SAVE_FORMAT}"`);
  }
  let nextObj = 0;
  let nextLayer = 0;
  const isBlueprint = save.layers.some((l) => l.tags?.["adna.kind"] === "blueprint");
  const layers = save.layers.map((l) => restoreLayer(l, nextLayer++, () => nextObj++));
  return {
    name: save.name || "untitled",
    layers,
    isBlueprint,
    width: Math.max(1, Math.round(save.width || 64)),
    height: Math.max(1, Math.round(save.height || 64)),
    sizeInferred: false,
  };
}

/** Create a standard empty category layer for one of the 7 top-level Role roots. */
export function createCategoryLayer(root: string, id: number, objects: LiteObject[] = []): Layer {
  const node = topRoleNode(root);
  const stratum = node?.stratum ?? stratumForRole(root);
  return {
    id,
    name: root,
    enabled: true,
    vertical: stratum === "vertical",
    tags: {
      "role.root": root,
      ...(node?.label ? { "role.label": node.label } : {}),
      ...(node?.object_type ? { "role.object_type": node.object_type } : {}),
      ...(stratum ? { "role.stratum": stratum } : {}),
    },
    objects,
  };
}

/** Create a new blank map with all 7 authoritative top-level Role layers and an optional base terrain fill. */
export function createBlankMap(
  name: string,
  width: number,
  height: number,
  baseTerrainRole: string | null = "terrain/grass",
): LiteTileMap {
  const w = Math.max(4, Math.min(512, Math.round(width)));
  const h = Math.max(4, Math.min(512, Math.round(height)));
  let nextLayer = 0;
  const layers: Layer[] = topRoleOrder.map((root) => createCategoryLayer(root, nextLayer++, []));

  if (baseTerrainRole) {
    const terrainLayer = layers.find((l) => l.name === "terrain") ?? layers[0];
    if (terrainLayer) {
      const baseName = baseTerrainRole.split("/").slice(-1)[0] || "grass";
      terrainLayer.objects.push({
        id: 0,
        type: "TERRAIN_2_CORNER",
        rect: [0, 0, w, h],
        enabled: true,
        tags: {
          "blueprint.role": baseTerrainRole,
          "web.name": baseName,
          "web.baseName": baseName,
        },
        terrain: {
          ox: 0,
          oy: 0,
          w,
          h,
          data: new Int16Array(w * h).fill(0),
        },
      });
    }
  }

  const map: LiteTileMap = {
    name: name.trim() || "new_map",
    layers,
    isBlueprint: true,
    width: w,
    height: h,
    sizeInferred: false,
  };
  assignUniqueObjectNames(map);
  return map;
}
