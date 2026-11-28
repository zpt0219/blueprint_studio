import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteEncounter, fillElevationRect, fillRect, flattenElevationRect, floodFill,
  makeMap, makeLayer, moveEncounter, paint, paintElevationDelta, pickCell,
  resolveSurfaces, upsertEncounter, type Palette, type TileMap, type Tileset,
} from "./model";
import { clearSelection, copySelection, moveSelection, pasteSelection } from "./selection";
import { mergePack, replaceTileset } from "./assets";
import {
  AK_COAST_LAYER_ID, AK_COAST_TILESET_ID, hydrateAkSceneDetails,
  migrateLegacyAkDraft, needsAkSceneHydration, needsLegacyAkMigration,
} from "./akBeachDesign";
import { decodeProject, encodeProject } from "./files";
import { AK_PREVIEW_VERSION, buildWorldPatch } from "./world";
import { materializeDeltaProject, packDeltaProject, rebaseWorldSnapshot } from "./worldRebase";
import { changeHistory, makeHistory } from "./history";

const asset: Tileset = { id: "custom", name: "我的图集", tileSize: 16, width: 64, height: 64, png: new Blob() };
const palette: Palette = { id: "flowers", name: "花", tileset: asset.id, mode: "single", tiles: [[16, 32]], height: 0, material: "texture" };

function stubPngBitmap() {
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
    const view = new DataView(await blob.slice(0, 24).arrayBuffer());
    return { width: view.getUint32(16), height: view.getUint32(20) };
  });
}

function readSampleBytes(filename: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.resolve(process.cwd(), "public/sample", filename)));
}

function fixture() {
  const map = makeMap(4, 3);
  map.tilesets = [asset]; map.palettes = [palette];
  map.world = { id: "ak-world-v1", revision: "test", origin: [0, 0], metresPerTile: 4, heights: Array(12).fill(3), markers: [], proxies: [] };
  return paint(map, map.layers[0].id, [0, 0], [1, 0], 1, { palette: palette.id });
}

describe("editing workflow", () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it("supports eyedropper, flood fill, rect fill, relative/flatten elevation, and encounter triggers", () => {
    const map = fixture(), layer = map.layers[0].id;
    expect(pickCell(map, layer, [0, 0])).toEqual({ palette: palette.id });
    expect(pickCell(map, layer, [3, 2])).toBeNull();

    const filled = floodFill(map, layer, [2, 0], { tileset: asset.id, x: 0, y: 0 });
    expect(Object.keys(filled.layers[0].cells)).toHaveLength(12);
    expect(filled.layers[0].cells[0]).toEqual({ palette: palette.id });
    expect(filled.layers[0].cells[2]).toEqual({ tileset: asset.id, x: 0, y: 0 });

    const rected = fillRect(map, layer, [1, 1], [2, 2], { palette: palette.id });
    expect([5, 6, 9, 10].every(i => rected.layers[0].cells[i])).toBe(true);

    const visited = new Set<number>();
    let raised = paintElevationDelta(map, [0, 0], [1, 0], 1, 0.5, visited);
    // Painting over the same tile in the same stroke must not compound twice.
    raised = paintElevationDelta(raised, [0, 0], [0, 0], 1, 0.5, visited);
    expect(raised.world?.elevations?.[0]).toBe(3.5);
    expect(raised.world?.elevations?.[1]).toBe(3.5);

    const shifted = fillElevationRect(raised, [0, 0], [1, 1], "delta", 1);
    expect(shifted.world?.elevations?.[0]).toBe(4.5);
    expect(shifted.world?.elevations?.[4]).toBe(4);
    const flattened = flattenElevationRect(shifted, [0, 0], [1, 1]);
    expect(flattened.world?.elevations?.[0]).toBe(4.25);
    expect(flattened.world?.elevations?.[4]).toBe(4.25);

    let withEnc = upsertEncounter(map, { id: "boss-1", name: "神殿 Boss", kind: "boss", position: [2, 3, 2], radius: 12, tag: "lake_boss" });
    withEnc = moveEncounter(withEnc, "boss-1", 6, 6);
    expect(withEnc.world?.encounters?.[0].position).toEqual([6, 3, 6]);
    expect(buildWorldPatch(withEnc, map).encounters).toEqual(withEnc.world?.encounters);
    expect(deleteEncounter(withEnc, "boss-1").world?.encounters).toBeUndefined();
  });

  it("loads compact delta AK designed .bptilemap and .bppalette with Boss trigger, beach landmarks, and baseline patch", async () => {
    stubPngBitmap();
    const designedRawBytes = readSampleBytes("ak-world-designed.bptilemap");
    // Compact delta project stays under 1 MB (vs ~9.2 MB duplicated full snapshot).
    expect(designedRawBytes.length).toBeLessThan(1_000_000);

    const baseline = await decodeProject(readSampleBytes("ak-world.bptilemap"));
    const designedDelta = await decodeProject(designedRawBytes);
    expect(designedDelta.world?.delta).toBe(true);
    const designed = materializeDeltaProject(designedDelta, baseline);
    const kit = await decodeProject(readSampleBytes("ak-coast-kit.bppalette"));

    expect(needsAkSceneHydration(designed)).toBe(false);
    expect(needsLegacyAkMigration(designed)).toBe(false);
    expect(needsLegacyAkMigration(baseline)).toBe(false);

    const coastTileset = designed.tilesets.find(item => item.id === AK_COAST_TILESET_ID);
    expect(coastTileset).toBeDefined();
    expect([coastTileset!.width, coastTileset!.height]).toEqual([512, 1024]);
    expect(coastTileset!.png.size).toBeGreaterThan(100_000);

    const decoLayer = designed.layers.find(item => item.id === AK_COAST_LAYER_ID);
    expect(decoLayer).toBeDefined();
    expect(Object.keys(decoLayer!.cells).length).toBeGreaterThan(295);
    // Verify southern beach 3D landmarks & Lake Temple Boss Altar
    expect(decoLayer!.cells[149 * 200 + 41]).toEqual({ palette: "scene-camp-tent" });
    expect(decoLayer!.cells[149 * 200 + 81]).toEqual({ palette: "ruin-watchtower" });
    expect(decoLayer!.cells[147 * 200 + 13]).toEqual({ palette: "scene-stone-well" });
    expect(decoLayer!.cells[147 * 200 + 16]).toEqual({ palette: "ruin-arch" });
    expect(designed.layers[0].cells[88 * 200 + 114]).toEqual({ palette: "ruin-altar-rune" });
    expect(designed.world?.elevations?.[88 * 200 + 114]).toBe(3.9);
    expect(designed.world?.encounters?.some(e => e.id === "lake-temple-boss" && e.kind === "boss")).toBe(true);

    const seHeights = Object.entries(designed.world?.elevations ?? {})
      .filter(([key]) => Number(key) >= 22200)
      .map(([, metres]) => metres);
    expect(seHeights.length).toBeGreaterThan(1000);
    expect(Math.max(...seHeights)).toBe(5);

    const expectedKitIds = [
      "ruin-flagstone", "ruin-moss-stone", "ruin-altar-rune", "ruin-wall-block",
      "ruin-pillar", "ruin-broken-pillar", "ruin-fallen-column", "ruin-stele",
      "ruin-arch", "ruin-watchtower", "ruin-gate", "scene-mine-entrance",
      "scene-stone-fence", "scene-wood-fence", "scene-brazier", "scene-lamp-post",
      "scene-camp-tent", "scene-supply-crates", "scene-stone-well", "scene-signpost",
    ];
    const paletteIds = new Set(designed.palettes.map(p => p.id));
    const kitIds = new Set(kit.palettes.map(p => p.id));
    for (const id of expectedKitIds) {
      expect(paletteIds.has(id)).toBe(true);
      expect(kitIds.has(id)).toBe(true);
    }
    expect(designed.palettes.find(p => p.id === "ruin-wall-block")?.height).toBe(0.4);
    expect(kit.palettes).toHaveLength(32);

    // Round-trip compact delta pack -> encode -> decode -> materialize produces identical patch!
    const repackedBytes = await encodeProject(packDeltaProject(designed, baseline));
    const rematerialized = materializeDeltaProject(await decodeProject(repackedBytes), baseline);
    const patch = buildWorldPatch(designed, baseline);
    const patchFromDelta = buildWorldPatch(rematerialized, baseline);
    expect(patchFromDelta).toEqual(patch);
    expect(patch.changes.length).toBeGreaterThan(800);
    expect(patch.elevations.length).toBeGreaterThan(1300);
    expect(patch.decorations.length).toBeGreaterThan(40);
    expect(patch.encounters).toHaveLength(1);
  });

  it("rebases both delta and full AK projects onto a newer baseline revision while preserving edits", async () => {
    stubPngBitmap();
    const oldBaseline = await decodeProject(readSampleBytes("ak-world.bptilemap"));
    const designedDelta = await decodeProject(readSampleBytes("ak-world-designed.bptilemap"));
    const designedFull = materializeDeltaProject(designedDelta, oldBaseline);

    // Simulate a newly exported Godot snapshot with a new revision and one extra native card.
    const extraCard = { ...oldBaseline.world!.cards![0], id: "Vegetation/NewTree/Card" };
    const newBaseline: TileMap = {
      ...oldBaseline,
      world: {
        ...oldBaseline.world!,
        revision: "new-godot-snapshot-rev-999",
        cards: [...oldBaseline.world!.cards!, extraCard],
      },
    };

    const fromDelta = rebaseWorldSnapshot(designedDelta, newBaseline);
    expect(fromDelta.map.world?.revision).toBe("new-godot-snapshot-rev-999");
    expect(fromDelta.map.world?.cards?.some(c => c.id === "Vegetation/NewTree/Card")).toBe(true);
    expect(fromDelta.map.world?.encounters).toHaveLength(1);
    expect(fromDelta.report.deletedCards).toBe(42);
    // Rebased project can immediately build a valid patch against newBaseline!
    expect(buildWorldPatch(fromDelta.map, newBaseline).revision).toBe("new-godot-snapshot-rev-999");

    const fromFullWithOld = rebaseWorldSnapshot(designedFull, newBaseline, oldBaseline);
    expect(fromFullWithOld.map.world?.revision).toBe("new-godot-snapshot-rev-999");
    expect(fromFullWithOld.report.adoptedCards).toBe(1);
    expect(buildWorldPatch(fromFullWithOld.map, newBaseline).elevations.length).toBeGreaterThan(1300);
  });

  it("hydrates native scene details without overwriting previewVersion or mutating layers/elevations", async () => {
    stubPngBitmap();
    const baseline = await decodeProject(readSampleBytes("ak-world.bptilemap"));
    const legacyDraft: TileMap = {
      ...baseline,
      layers: baseline.layers.map((layer, i) => i === 1 ? { ...layer, cells: { ...layer.cells, 42: { palette: "road" } } } : layer),
      world: {
        ...baseline.world!,
        previewVersion: 4,
        terrain: undefined,
        wallColliders: undefined,
        cards: baseline.world!.cards!.slice(0, 10).map(({ id: _id, ...rest }) => rest),
      },
    };
    expect(needsAkSceneHydration(legacyDraft)).toBe(true);
    const hydrated = hydrateAkSceneDetails(legacyDraft, baseline);
    expect(hydrated.world?.previewVersion).toBe(4);
    expect(hydrated.world?.terrain).toBe(baseline.world?.terrain);
    expect(hydrated.world?.wallColliders).toBe(baseline.world?.wallColliders);
    expect(hydrated.world?.cards).toHaveLength(10);
    expect(hydrated.world?.cards?.every(card => !!card.id)).toBe(true);
    expect(hydrated.layers).toBe(legacyDraft.layers);
  });

  it("migrates legacy v4/v5 drafts even if previously stamped v5/v7, while preserving unrelated user edits", async () => {
    stubPngBitmap();
    const baseline = await decodeProject(readSampleBytes("ak-world.bptilemap"));
    const designed = materializeDeltaProject(await decodeProject(readSampleBytes("ak-world-designed.bptilemap")), baseline);
    const oldCoastTileset = { ...designed.tilesets.find(t => t.id === AK_COAST_TILESET_ID)!, height: 640 };

    const v4Draft: TileMap = {
      ...baseline,
      tilesets: [...baseline.tilesets, oldCoastTileset],
      palettes: [...baseline.palettes, ...designed.palettes.filter(p => p.id.startsWith("coast-") || p.id.startsWith("ruin-")).slice(0, 16)],
      layers: [
        { ...baseline.layers[0], cells: { ...baseline.layers[0].cells, 16714: { palette: "ruin-altar-rune" }, 17114: { palette: "ruin-altar-rune" }, 25767: { palette: "rock" }, 120: { palette: "snow" } } },
        { ...baseline.layers[1], cells: { ...baseline.layers[1].cells, 55: { palette: "road" } } },
        { id: AK_COAST_LAYER_ID, name: "海岸与遗迹", visible: true, cells: { 16711: { palette: "ruin-pillar" }, 23062: { palette: "coast-palm-left" } } },
      ],
      world: {
        ...baseline.world!,
        previewVersion: 7,
        elevations: { 17114: 3.7, 16708: 5.1, 120: 7.5 },
      },
    };
    const migratedV4 = migrateLegacyAkDraft(v4Draft, designed);
    expect(migratedV4.world?.previewVersion).toBe(AK_PREVIEW_VERSION);
    expect(migratedV4.world?.elevations?.[26335]).toBe(5);
    expect(migratedV4.layers[0].cells[25767]).toEqual({ palette: "sand" });
    expect(migratedV4.layers[0].cells[88 * 200 + 114]).toEqual({ palette: "ruin-altar-rune" });
    expect(migratedV4.world?.elevations?.[88 * 200 + 114]).toBe(3.9);
    expect(migratedV4.layers[0].cells[16714]).toBeDefined();
    expect(migratedV4.world?.elevations?.[16708]).toBeUndefined();
    expect(migratedV4.tilesets.find(t => t.id === AK_COAST_TILESET_ID)?.height).toBe(1024);
    expect(migratedV4.palettes.some(p => p.id === "scene-camp-tent")).toBe(true);
    expect(migratedV4.layers[0].cells[120]).toEqual({ palette: "snow" });
    expect(migratedV4.layers[1].cells[55]).toEqual({ palette: "road" });
    expect(migratedV4.world?.elevations?.[120]).toBe(7.5);
    expect(migratedV4.layers.find(l => l.id === AK_COAST_LAYER_ID)?.cells[23062]).toEqual({ palette: "coast-palm-left" });

    const v5Draft: TileMap = {
      ...designed,
      world: {
        ...designed.world!,
        previewVersion: 7,
        elevations: { ...designed.world!.elevations!, 26335: 9, 27138: 7.5, 27338: 6, 27538: 4.5 },
      },
    };
    const migratedV5 = migrateLegacyAkDraft(v5Draft, designed);
    expect(migratedV5.world?.elevations?.[26335]).toBe(5);
    expect(migratedV5.world?.elevations?.[27138]).toBe(4.5);
    expect(migratedV5.world?.elevations?.[27338]).toBe(4);
    expect(migratedV5.world?.elevations?.[27538]).toBe(3.5);
    expect(migratedV5.world?.previewVersion).toBe(AK_PREVIEW_VERSION);

    const customized = {
      ...migratedV5,
      world: { ...migratedV5.world!, elevations: { ...migratedV5.world!.elevations!, 26335: 8.2 } },
    };
    expect(needsLegacyAkMigration(customized)).toBe(false);
    expect(migrateLegacyAkDraft(customized, designed)).toBe(customized);
    expect(needsLegacyAkMigration(baseline)).toBe(false);
    expect(migrateLegacyAkDraft(baseline, designed)).toBe(baseline);
  });
});
