import { afterEach, describe, expect, it, vi } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { decodeProject, encodeProject } from "./files";
import { changeHistory, makeHistory } from "./history";
import { buildWorldPatch, readWorld } from "./world";
import { canWalk, worldWallTest } from "./worldWalk";
import { terrainHeightAt } from "./worldTerrainData";
import { cardPosition, deleteCard, moveCard, elevationSides, makeLayer, makeMap, paint, paintElevation, resolveSurfaces, type Palette, type Point, type WorldCard } from "./model";

const coords = Array.from({ length: 16 }, (_, index): Point => [index % 4, Math.floor(index / 4)]);
const grass = { tileset: "atlas", x: 1, y: 0 };
const hill: Palette = { id: "hill", name: "草地高台", tileset: "atlas", mode: "corner", tiles: coords, height: 1, wall: [3, 3] };

describe("tilemap grid", () => {
  it("interpolates fast strokes and commits only one undo entry", () => {
    const map = makeMap(10, 5);
    const layer = map.layers[0].id;
    let state = makeHistory(map);
    state = changeHistory(state, { type: "stroke", apply: doc => paint(doc, layer, [1, 2], [6, 2], 1, grass) });
    state = changeHistory(state, { type: "stroke", apply: doc => paint(doc, layer, [6, 2], [8, 2], 1, grass) });
    state = changeHistory(state, { type: "finish" });
    expect(Object.keys(state.present.layers[0].cells).map(Number)).toEqual([21, 22, 23, 24, 25, 26, 27, 28]);
    expect(state.past).toHaveLength(1);
    state = changeHistory(state, { type: "undo" });
    expect(state.present).toBe(map);
    state = changeHistory(state, { type: "redo" });
    expect(Object.keys(state.present.layers[0].cells)).toHaveLength(8);
  });

  it("resolves corners by same-layer neighbors and takes height only in occupied cells", () => {
    let map = makeMap(5, 5);
    const base = map.layers[0].id;
    const upper = makeLayer("高台");
    const path = makeLayer("路径");
    map = { ...map, palettes: [hill], layers: [...map.layers, upper, path] };
    map = paint(map, base, [0, 2], [4, 2], 1, grass);
    map = paint(map, upper.id, [2, 2], [2, 2], 3, { palette: hill.id });
    map = paint(map, path.id, [2, 2], [2, 2], 1, grass);
    const surfaces = resolveSurfaces(map);
    expect(surfaces[12]?.height).toBe(1);
    expect(surfaces[12]?.tiles).toEqual([grass, { tileset: "atlas", x: 2, y: 1 }, grass]);
    expect(surfaces[10]?.height).toBe(0);
    expect(surfaces[12]?.wall).toEqual({ tileset: "atlas", x: 3, y: 3 });
    expect(elevationSides(surfaces, 5, 5, 1, 1)).toEqual([0, 1, 1, 0]);

    map = { ...map, palettes: [{ ...hill, name: "新名称", height: 2 }] };
    expect(resolveSurfaces(map)[12]?.height).toBe(2);
    expect(resolveSurfaces(map)[10]?.height).toBe(0);
    map = paint(map, upper.id, [3, 3], [3, 3], 1, null);
    expect(resolveSurfaces(map)[12]?.tiles[1]).not.toEqual(surfaces[12]?.tiles[1]);
    map = { ...map, layers: map.layers.map(layer => layer.id === upper.id ? { ...layer, visible: false } : layer) };
    expect(resolveSurfaces(map)[12]).toEqual({ tiles: [grass, grass], height: 0 });
  });
});

describe("portable tilemap project", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps native terrain in the project archive and rejects invalid mesh indices", async () => {
    const map = makeMap(2, 2);
    const header = new Uint32Array([9, 3]);
    const positions = new Float32Array([0, 0, 0, 1, 1, 0, 0, 0, 1]);
    const indices = new Uint32Array([0, 1, 2]);
    const terrain = new Blob([header, positions, indices]);
    map.world = { id: "test", revision: "v1", origin: [0, 0], metresPerTile: 4,
      heights: [0, 0, 0, 0], markers: [], proxies: [], terrain };
    const bytes = await encodeProject(map);
    const restored = await decodeProject(bytes);
    expect(await restored.world?.terrain?.arrayBuffer()).toEqual(await terrain.arrayBuffer());
    expect(await terrainHeightAt(restored.world!.terrain!, 0.25, 0.25)).toBeCloseTo(0.25);

    const files = unzipSync(bytes);
    delete files["world/terrain.bin"];
    await expect(decodeProject(zipSync(files))).rejects.toThrow("原场景地形文件缺失");
    indices[2] = 3;
    files["world/terrain.bin"] = new Uint8Array(await new Blob([header, positions, indices]).arrayBuffer());
    await expect(decodeProject(zipSync(files))).rejects.toThrow("原场景地形网格无效");
  });

  it("round-trips original PNG bytes, stable palette references, and height", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1 }));
    const png = new Blob([Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=",
    ), ch => ch.charCodeAt(0))], { type: "image/png" });
    const map = makeMap(3, 3);
    map.tilesets = [{ id: "atlas", name: "tiles.png", width: 1, height: 1, tileSize: 1, png }];
    map.palettes = [{ ...hill, mode: "single", tiles: [[0, 0]], height: 2, wall: [0, 0], usage: "platform", material: "texture", blocked: true, decorationSize: [1, 2] }];
    map.world = {
      id: "test", revision: "v1", origin: [0, 0], metresPerTile: 1,
      heights: Array(9).fill(0), markers: [], proxies: [],
      textures: [{ id: "forest", width: 1, height: 1, png }],
      cards: [{
        texture: "forest", position: [1, 2, 1], size: [2, 3], offset: [0, 0],
        region: [0, 0, 1, 1], flipH: true, flipV: false, color: [0.8, 1, 0.8, 1], threshold: 0.42,
      }],
    };
    const painted = paint(map, map.layers[0].id, [1, 1], [1, 1], 1, { palette: hill.id });
    const bytes = await encodeProject(painted);
    const restored = await decodeProject(bytes);
    expect(restored.layers).toEqual(painted.layers);
    expect(restored.palettes).toEqual(painted.palettes);
    expect(await restored.tilesets[0].png.arrayBuffer()).toEqual(await png.arrayBuffer());
    expect(resolveSurfaces(restored)[4]?.height).toBe(2);
    expect(restored.world?.cards).toEqual(map.world.cards);
    expect(await restored.world!.textures![0].png.arrayBuffer()).toEqual(await png.arrayBuffer());

    const missingTexture = unzipSync(bytes);
    delete missingTexture["decorations/forest.png"];
    await expect(decodeProject(zipSync(missingTexture))).rejects.toThrow("面片贴图缺失");
    const invalidWorld = {
      ...restored.world, cards: [{ ...restored.world!.cards![0], region: [0, 0, 2, 1] }],
    };
    expect(() => readWorld(invalidWorld, 3, 3)).toThrow("图集区域无效");

    const files = unzipSync(bytes);
    delete files["tilesets/atlas.png"];
    await expect(decodeProject(zipSync(files))).rejects.toThrow("图集缺失");
    files["project.json"] = strToU8(JSON.stringify({ version: 999 }));
    await expect(decodeProject(zipSync(files))).rejects.toThrow("版本不受支持");
  });
});


describe("AK world coordinates", () => {
  const world = {
    id: "ak-world-v1", revision: "test", origin: [-400, -320] as Point, metresPerTile: 4,
    heights: [3.08, 3.08, -2, 9], markers: [], proxies: [],
  };

  it("keeps imported ground height when changing a surface and exports height edits in metres", () => {
    const map = makeMap(2, 2);
    map.world = world;
    map.palettes = [hill];
    const layer = map.layers[0].id;
    const baseline = paint(map, layer, [0, 0], [1, 0], 1, grass);
    let edited = paint(baseline, layer, [0, 0], [0, 0], 1, { ...grass, x: 2 });
    expect(resolveSurfaces(edited)[0]?.height).toBeCloseTo(3.08 / 4);
    edited = paint(edited, layer, [1, 0], [1, 0], 1, { palette: hill.id });
    expect(resolveSurfaces(edited)[1]?.height).toBeCloseTo(7.08 / 4);
    edited = paintElevation(edited, [0, 0], [0, 0], 1, 6);
    edited = paintElevation(edited, [1, 0], [1, 0], 1, 3.08);
    const patch = buildWorldPatch(edited, baseline);
    expect(patch.elevations).toEqual([{ tile: [0, 0], position: [-398, 6, -318], originalHeight: 3.08 }]);
    expect(patch.changes.map(change => change.xz)).toEqual([[-398, -318], [-394, -318]]);
  });

  it("exports a moved card at its edited ground height and preserves its native identity on deletion", () => {
    const card: WorldCard = {
      id: "Vegetation/Oak/Card", texture: "forest", position: [-398, 5.08, -318],
      size: [4, 5], offset: [0, 0], region: [0, 0, 32, 32], flipH: false, flipV: false,
      color: [1, 1, 1, 1], threshold: 0.42,
    };
    const baseline = { ...makeMap(2, 2), world: { ...world, cards: [card] } };
    const moved = moveCard(baseline, card.id!, -394, -314);
    expect(moved.world!.cards![0].position).toEqual([-394, 11, -314]);
    const raised = paintElevation(moved, [1, 1], [1, 1], 1, 12);
    expect(cardPosition(raised.world!, 2, raised.world!.cards![0], resolveSurfaces(raised))).toEqual([-394, 14, -314]);
    expect(buildWorldPatch(raised, baseline).decorations).toEqual([
      { id: card.id, originalPosition: card.position, position: [-394, 14, -314] },
    ]);
    expect(buildWorldPatch(deleteCard(raised, card.id!), baseline).decorations).toEqual([
      { id: card.id, originalPosition: card.position, position: null },
    ]);
    expect(() => buildWorldPatch({ ...baseline, world }, baseline)).toThrow("原场景绑定");
  });

  it("exports the top visible material for a changed native cell", () => {
    const base = makeLayer("地面"), roads = makeLayer("道路");
    const ground = { palette: "grass" }, road = { palette: "road" }, snow = { palette: "snow" };
    const baseline = { ...makeMap(2, 2), world, layers: [
      { ...base, cells: { 0: ground } }, { ...roads, cells: { 0: road } },
    ] };
    const changed = paint(baseline, base.id, [0, 0], [0, 0], 1, snow);
    expect(buildWorldPatch(changed, baseline).paint).toEqual([{ tile: [0, 0], palette: "road" }]);
    const uncovered = paint(changed, roads.id, [0, 0], [0, 0], 1, null);
    expect(buildWorldPatch(uncovered, baseline).paint).toEqual([{ tile: [0, 0], palette: "snow" }]);
  });

  it("stops at high steps, water and the solid parts of native walls", () => {
    const wall = worldWallTest({ ...world, wallColliders: [
      { position: [-394, 4, -314], size: [0.5, 2, 4], yaw: 0 },
    ] });
    const height = (x: number) => x < 1 ? 3 / 4 : x < 2 ? 3.2 / 4 : x < 3 ? 3.65 / 4 : undefined;
    expect(canWalk([0.99, 0], [1.01, 0], 4, height, wall)).toBe(true);
    expect(canWalk([1.99, 0], [2.01, 0], 4, height, wall)).toBe(false);
    expect(canWalk([2.99, 0], [3.01, 0], 4, height, wall)).toBe(false);
    expect(canWalk([1.3, 1.5], [1.38, 1.5], 4, height, wall)).toBe(false);
  });

  it("validates the sample count and rejects a different source revision", () => {
    expect(readWorld(world, 2, 2)).toBe(world);
    expect(() => readWorld(world, 3, 2)).toThrow("高程数据无效");
    const baseline = { ...makeMap(2, 2), world };
    expect(() => buildWorldPatch({ ...baseline, world: { ...world, revision: "old" } }, baseline))
      .toThrow("原始快照");
  });
});
