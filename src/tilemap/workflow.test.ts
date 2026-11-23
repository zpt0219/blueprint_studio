import { describe, expect, it } from "vitest";
import { makeMap, makeLayer, paint, resolveSurfaces, type Palette, type Tileset } from "./model";
import { clearSelection, copySelection, moveSelection, pasteSelection } from "./selection";
import { mergePack, replaceTileset } from "./assets";
import { applyAkBeachDesign, AK_COAST_LAYER_ID, AK_COAST_TILESET_ID } from "./akBeachDesign";
import { buildWorldPatch } from "./world";
import { changeHistory, makeHistory } from "./history";

const asset: Tileset = { id: "custom", name: "我的图集", tileSize: 16, width: 64, height: 64, png: new Blob() };
const palette: Palette = { id: "flowers", name: "花", tileset: asset.id, mode: "single", tiles: [[16, 32]], height: 0, material: "texture" };

function fixture() {
  const map = makeMap(4, 3);
  map.tilesets = [asset]; map.palettes = [palette];
  map.world = { id: "ak-world-v1", revision: "test", origin: [0, 0], metresPerTile: 4, heights: Array(12).fill(3), markers: [], proxies: [] };
  return paint(map, map.layers[0].id, [0, 0], [1, 0], 1, { palette: palette.id });
}

describe("editing workflow", () => {
  it("moves overlapping selections once and undo restores source and overwritten destination", () => {
    const map = fixture(), layer = map.layers[0].id;
    const state = changeHistory(makeHistory(map), { type: "edit", apply: doc => moveSelection(doc, layer, { x: 0, y: 0, width: 2, height: 1 }, [1, 0]) });
    expect(Object.keys(state.present.layers[0].cells)).toEqual(["1", "2"]);
    expect(changeHistory(state, { type: "undo" }).present).toBe(map);
  });

  it("preserves empty cells on copy/paste and clips at map boundaries without wrapping rows", () => {
    const map = fixture(), layer = map.layers[0].id;
    const clip = copySelection(map, layer, { x: 0, y: 0, width: 3, height: 1 });
    const pasted = pasteSelection(map, layer, clip, [3, 1]);
    expect(Object.keys(pasted.layers[0].cells)).toEqual(["0", "1", "7"]);
    expect(Object.keys(clearSelection(map, layer, { x: 0, y: 0, width: 2, height: 1 }).layers[0].cells)).toHaveLength(0);
    const hidden = { ...map, layers: [{ ...map.layers[0], visible: false }] };
    expect(pasteSelection(hidden, layer, clip, [0, 0])).toBe(hidden);
  });

  it("keeps palette selections by column and row when changing tile size, rejects destructive shrink", () => {
    const map = fixture();
    const edited = replaceTileset(map, asset, { ...asset, tileSize: 8, width: 32, height: 32 });
    expect(edited.palettes[0].tiles).toEqual([[8, 16]]);
    expect(edited.layers).toEqual(map.layers);
    expect(() => replaceTileset(map, asset, { ...asset, width: 16, height: 16 })).toThrow("已有选区");
    expect(map.palettes[0].tiles).toEqual([[16, 32]]);
  });

  it("merges packs without changing existing ids or replacing assets", () => {
    const map = fixture(), merged = mergePack(map, map);
    expect(merged.tilesets).toHaveLength(2);
    expect(merged.tilesets[0]).toBe(asset);
    expect(merged.tilesets[1].id).not.toBe(asset.id);
    expect(merged.palettes[1].tileset).toBe(merged.tilesets[1].id);
    expect(merged.palettes[1].material).toBe("texture");
    expect(merged.layers).toBe(map.layers);
  });

  it("detects palette-only edits, layer visibility and autotile appearance changes", () => {
    const base = fixture();
    const changed = { ...base, palettes: [{ ...palette, material: "snow" as const }] };
    expect(buildWorldPatch(changed, base).paint).toEqual([{ tile: [0, 0], palette: "snow" }, { tile: [1, 0], palette: "snow" }]);
    const hidden = { ...base, layers: [{ ...base.layers[0], visible: false }] };
    expect(buildWorldPatch(hidden, base).paint.map(row => row.palette)).toEqual([null, null]);
    const side = { ...base, palettes: [{ ...palette, wall: [0, 0] as [number, number] }] };
    expect(buildWorldPatch(side, base).changes).toHaveLength(2);
  });

  it("previews native material mappings using the corresponding imported ground tile", () => {
    const map = fixture();
    map.palettes = [{ ...palette, material: "snow" }, { ...palette, id: "snow", tiles: [[32, 0]] }];
    expect(resolveSurfaces(map)[0]?.tiles).toEqual([{ tileset: "custom", x: 32, y: 0 }]);
    expect(buildWorldPatch(map, fixture()).paint[0].palette).toBe("snow");
  });

  it("places decorations above the floor without turning them into raised terrain", () => {
    const map = fixture();
    map.layers.push({ ...makeLayer("装饰"), cells: { 0: { palette: "prop" } } });
    map.palettes.push({ ...palette, id: "prop", usage: "decoration", height: 8, blocked: true, decorationSize: [1, 2] });
    const surface = resolveSurfaces(map)[0]!;
    expect(surface.height).toBe(0.75);
    expect(surface.tiles).toHaveLength(1);
    expect(surface.decorations).toEqual([{ tile: { tileset: "custom", x: 16, y: 32 }, size: [1, 2], blocked: true }]);
  });

  it("applies the AK beach design with roads, oases, rocky reefs, and coastal decorations", async () => {
    const base = makeMap(200, 160);
    base.layers = [
      { id: "ak-ground", name: "地面", visible: true, cells: {} },
      { id: "ak-roads", name: "道路", visible: true, cells: {} },
    ];
    base.palettes = [
      { id: "grass", name: "草地", tileset: asset.id, mode: "single", tiles: [[0, 0]], height: 0 },
      { id: "sand", name: "沙地", tileset: asset.id, mode: "single", tiles: [[16, 0]], height: 0 },
      { id: "rock", name: "岩地", tileset: asset.id, mode: "single", tiles: [[32, 0]], height: 0 },
      { id: "road", name: "道路", tileset: asset.id, mode: "single", tiles: [[48, 0]], height: 0 },
    ];
    base.world = {
      id: "ak-world-v1", revision: "test", origin: [-400, -320], metresPerTile: 4,
      heights: Array(200 * 160).fill(1), markers: [], proxies: [],
    };
    const designed = await applyAkBeachDesign(base);
    expect(designed.tilesets.some(item => item.id === AK_COAST_TILESET_ID)).toBe(true);
    const decoLayer = designed.layers.find(item => item.id === AK_COAST_LAYER_ID);
    expect(decoLayer).toBeDefined();
    expect(Object.keys(decoLayer!.cells).length).toBeGreaterThan(280);
    expect(Object.keys(designed.layers[1].cells).length).toBeGreaterThan(350);
    expect(Object.keys(designed.layers[0].cells).length).toBeGreaterThan(500);
    expect(designed.layers[0].cells[86 * 200 + 114]).toEqual({ palette: "ruin-altar-rune" });
    expect(designed.world?.elevations?.[86 * 200 + 114]).toBe(3.7);
    const patch = buildWorldPatch(designed, base);
    expect(patch.changes.length).toBeGreaterThan(800);
    expect(patch.elevations.length).toBeGreaterThan(120);
  });
});
