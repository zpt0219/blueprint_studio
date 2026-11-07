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
});
