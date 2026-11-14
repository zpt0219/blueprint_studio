import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBlueprint } from "../blueprint";
import { blueprintToLite } from "../convert";
import { normalizeToCategories } from "../normalize";
import { liteToWebSave } from "../saveFormat";
import { createBlankMap, isWebSaveFile, webSaveToLite } from "../loadSave";
import { UndoStack, resizeMapCommand } from "../commands";
import {
  bresenhamLine,
  brushFootprint,
  floodFillObjectTerrain,
  inspectTileStack,
  objectCoversTile,
  resolveOrCreateBrushTarget,
  targetLiteTypeForRole,
} from "../fastBrush";
import { setTerrainCell } from "../model";
import { topRoleOrder } from "../roleTree";
import { compileMap } from "../pack/compile";
import { PaletteMode, type PackRuntime, type Palette } from "../pack/types";
import { usedTilesetIds } from "../pack/tilesets";
import { createObjectForRole } from "../objectFactory";

const SAMPLE_PATH = resolve(__dirname, "../../../public/sample/test_village_strict.blueprint.json");

describe("7-layer role tree + Fast Brush + Save/Load round-trip", () => {
  it("createBlankMap initializes all 7 authoritative top-level Role category layers", () => {
    const map = createBlankMap("demo_world", 32, 24, "terrain/grass");
    expect(map.width).toBe(32);
    expect(map.height).toBe(24);
    expect(map.layers.map((l) => l.name)).toEqual(topRoleOrder);
    expect(map.layers[0].objects).toHaveLength(1);
    expect(objectCoversTile(map.layers[0].objects[0], 0, 0)).toBe(true);
    expect(objectCoversTile(map.layers[0].objects[0], 31, 23)).toBe(true);
  });

  it("round-trips LiteTileMap -> WebSaveFile -> LiteTileMap losslessly", () => {
    const raw = readFileSync(SAMPLE_PATH, "utf8");
    const original = normalizeToCategories(blueprintToLite(parseBlueprint("sample", raw)));
    const saved = liteToWebSave(original);
    expect(isWebSaveFile(saved)).toBe(true);

    const restored = webSaveToLite(saved);
    expect(restored.width).toBe(original.width);
    expect(restored.height).toBe(original.height);
    expect(restored.layers.map((l) => l.name)).toEqual(original.layers.map((l) => l.name));

    // Re-exporting the restored map produces an identical WebSaveFile
    const savedAgain = liteToWebSave(restored);
    expect(savedAgain).toEqual(saved);
  });

  it("preserves v4 map identity, resolution, expected pack, and FRG defaults", () => {
    const map = createBlankMap("demo_world", 16, 16, null, 32);
    map.id = "demo-id";
    const tree = resolveOrCreateBrushTarget(map, "nature_prop/tree", null, "brush", new Set()).object;
    tree.frg = { placementMode: "free", cells: [{ palette: "tree", weight: 100 }] };
    setTerrainCell(tree, 5, 5, true);
    const pack = { id: "retro@1", name: "Retro" };

    const saved = liteToWebSave(map, pack);
    expect(saved).toMatchObject({ version: 4, id: "demo-id", tileResolution: 32, pack });
    const restored = webSaveToLite(saved);
    expect(liteToWebSave(restored, { id: "fallback@1", name: "Fallback" })).toEqual(saved);
  });

  it.each([1, 2, 3])("upgrades a v%i save without requiring pack metadata", (version) => {
    const legacy = { ...liteToWebSave(createBlankMap("old", 16, 16, null)), version, tileResolution: 24 };
    const restored = webSaveToLite(legacy);
    expect(restored.id).toBeUndefined();
    expect(restored.pack).toBeUndefined();
    expect(liteToWebSave(restored)).toEqual({ ...legacy, version: 4 });
  });

  it("supports multi-image stacking on the same tile across categories and within categories", () => {
    const map = createBlankMap("stack_test", 16, 16, "terrain/grass");
    const selected = new Set<number>();

    // Paint a road in terrain_decoration at (5, 5)
    const roadTarget = resolveOrCreateBrushTarget(
      map,
      "terrain_decoration/path/road/area_path",
      null,
      "brush",
      selected,
    );
    expect(roadTarget.created).toBe(true);
    setTerrainCell(roadTarget.object, 5, 5, true);

    // Paint flowers in terrain_decoration at (5, 5) (stacked on top of road and grass!)
    const flowerTarget = resolveOrCreateBrushTarget(
      map,
      "terrain_decoration/ground_prop/flora",
      null,
      "brush",
      selected,
    );
    expect(flowerTarget.created).toBe(true);
    setTerrainCell(flowerTarget.object, 5, 5, true);

    // Paint a tree in nature_prop (vertical stratum) at (5, 5)
    const treeTarget = resolveOrCreateBrushTarget(
      map,
      "nature_prop/tree",
      null,
      "brush",
      selected,
    );
    expect(treeTarget.created).toBe(true);
    expect(treeTarget.object.type).toBe("FIXED_RECT_GROUP");
    setTerrainCell(treeTarget.object, 5, 5, true);

    const stack = inspectTileStack(map, 5, 5);
    expect(stack.map((s) => s.role)).toEqual([
      "terrain/grass",
      "terrain_decoration/path/road/area_path",
      "terrain_decoration/ground_prop/flora",
      "nature_prop/tree",
    ]);
    expect(stack.map((s) => s.stratum)).toEqual(["ground", "ground", "ground", "vertical"]);
  });

  it("interpolates strokes with bresenhamLine and flood-fills connected regions", () => {
    const line = bresenhamLine(2, 2, 6, 4);
    expect(line[0]).toEqual([2, 2]);
    expect(line[line.length - 1]).toEqual([6, 4]);
    expect(line.length).toBe(5);

    const fpCircle = brushFootprint(5, 5, 3, "circle", 16, 16);
    expect(fpCircle.length).toBe(9);

    const map = createBlankMap("fill_test", 10, 10, null);
    const target = resolveOrCreateBrushTarget(map, "terrain/sand", null, "brush", new Set());
    const changed = floodFillObjectTerrain(map, target.object, 3, 3, true);
    expect(changed).toBe(true);
    expect(objectCoversTile(target.object, 0, 0)).toBe(true);
    expect(objectCoversTile(target.object, 9, 9)).toBe(true);
  });

  it("resizes map dimensions with anchor offset and supports undo/redo", () => {
    const map = createBlankMap("resize_test", 10, 10, null);
    const target = resolveOrCreateBrushTarget(map, "terrain/dirt", null, "brush", new Set());
    setTerrainCell(target.object, 2, 3, true);

    const undo = new UndoStack();
    // Expand to 14x12 anchored at top-left (-1, -1) -> offset (0, 0)
    undo.push(resizeMapCommand(map, 14, 12, -1, -1));
    expect(map.width).toBe(14);
    expect(map.height).toBe(12);
    expect(objectCoversTile(target.object, 2, 3)).toBe(true);

    undo.undo();
    expect(map.width).toBe(10);
    expect(map.height).toBe(10);
    expect(objectCoversTile(target.object, 2, 3)).toBe(true);
  });

  it("maps roles to appropriate LiteTypes for fast brushing vs structural placement", () => {
    expect(targetLiteTypeForRole("terrain/grass")).toBe("TERRAIN_2_CORNER");
    expect(targetLiteTypeForRole("boundary/fence")).toBe("TERRAIN_2_EDGE");
    expect(targetLiteTypeForRole("nature_prop/tree", "brush")).toBe("FIXED_RECT_GROUP");
    expect(targetLiteTypeForRole("nature_prop/tree", "stamp")).toBe("FIXED_RECT");
    expect(targetLiteTypeForRole("terrain_decoration/path/bridge/wooden_bridge")).toBe("FIXED_RECT");
    expect(targetLiteTypeForRole("building/house")).toBe("HOUSE");
  });

  it.each(["terrain_area", "terrain_line"] as const)("aligns a placed %s to the map and paints only the clicked cell", (kind) => {
    const map = createBlankMap("terrain", 16, 12, null);
    const placed = createObjectForRole(map, 0, "terrain/grass", kind, 15, 11);
    map.layers[0].objects.push(placed);

    expect(placed.rect).toEqual([0, 0, 16, 12]);
    expect(placed.terrain).toMatchObject({ ox: 0, oy: 0, w: 16, h: 12 });
    expect(liteToWebSave(map).layers[0].objects[0].cells).toEqual([[15, 11]]);
  });

  it("reopens explicitly painted tileset palettes without remapping legacy or missing materials", () => {
    const map = createBlankMap("mixed", 16, 12, "terrain/grass");
    const builtIn: Palette = {
      hash: "builtin-grass", role: "terrain/grass", style: "", mode: PaletteMode.TWO_CORNER,
      size: [4, 4], tileResolution: 16, edge: [-1, -1],
      mapping: { width: 4, height: 4, cells: new Int32Array(32) },
    };
    const imported: Palette = {
      ...builtIn, hash: "tileset:world~png~sidecar:road", tilesetId: "world~png~sidecar",
      mode: PaletteMode.TWO_EDGE,
    };
    const drawn = resolveOrCreateBrushTarget(map, imported.role, imported, "brush", new Set(), false, [7, 4]).object;
    setTerrainCell(drawn, 7, 4, true);
    const reopened = webSaveToLite(liteToWebSave(map));
    const [legacy, painted] = reopened.layers[0].objects;
    expect(painted.type).toBe("TERRAIN_2_EDGE");
    expect(painted.rect).toEqual([0, 0, 16, 12]);
    expect(painted.terrain).toMatchObject({ ox: 0, oy: 0, w: 16, h: 12 });
    expect(objectCoversTile(painted, 7, 4)).toBe(true);
    expect(objectCoversTile(painted, 0, 0)).toBe(false);
    expect([...usedTilesetIds(reopened)]).toEqual([imported.tilesetId]);

    const pack: PackRuntime = {
      atlas: {} as HTMLCanvasElement, tileResolution: 16,
      reference: { id: "test", name: "Test" }, palettes: [builtIn, imported],
    };
    const bindings = compileMap(reopened, pack);
    expect(bindings.get(legacy.id)).toMatchObject({ palette: { hash: builtIn.hash } });
    expect(bindings.get(painted.id)).toMatchObject({ palette: { hash: imported.hash } });
    expect(compileMap(reopened, { ...pack, palettes: [builtIn] }).has(painted.id)).toBe(false);
  });
});
