import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMap, makeLayer, paint, resolveSurfaces, type Palette, type TileMap, type Tileset } from "./model";
import { clearSelection, copySelection, moveSelection, pasteSelection } from "./selection";
import { mergePack, replaceTileset } from "./assets";
import {
  AK_COAST_LAYER_ID, AK_COAST_TILESET_ID, hydrateAkSceneDetails,
  migrateLegacyAkDraft, needsAkSceneHydration, needsLegacyAkMigration,
} from "./akBeachDesign";
import { decodeProject, encodeProject } from "./files";
import { AK_PREVIEW_VERSION, buildWorldPatch } from "./world";
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

  it("loads standalone AK designed .bptilemap and .bppalette with full round-trip and baseline patch diff", async () => {
    stubPngBitmap();
    const baseline = await decodeProject(readSampleBytes("ak-world.bptilemap"));
    const designed = await decodeProject(readSampleBytes("ak-world-designed.bptilemap"));
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
    expect(Object.keys(decoLayer!.cells).length).toBeGreaterThan(280);
    expect(Object.keys(designed.layers[1].cells).length).toBeGreaterThan(1600);
    expect(designed.layers[0].cells[88 * 200 + 114]).toEqual({ palette: "ruin-altar-rune" });
    expect(designed.world?.elevations?.[88 * 200 + 114]).toBe(3.9);

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

    // Round-trip encodeProject -> decodeProject succeeds including fractional ruin-wall-block height.
    const roundTripped = await decodeProject(await encodeProject(designed));
    expect(roundTripped.palettes.find(p => p.id === "ruin-wall-block")?.height).toBe(0.4);

    // Patch against unmodified Godot baseline includes beach, temple, SE desert, and custom Scene Kit edits.
    const patch = buildWorldPatch(designed, baseline);
    expect(patch.changes.length).toBeGreaterThan(800);
    expect(patch.elevations.length).toBeGreaterThan(1300);
    expect(patch.decorations.length).toBeGreaterThan(40);

    const withKit = paint(designed, AK_COAST_LAYER_ID, [10, 10], [10, 10], 1, { palette: "scene-camp-tent" });
    const kitPatch = buildWorldPatch(withKit, baseline);
    expect(kitPatch.changes.some(c => c.tile[0] === 10 && c.tile[1] === 10 && c.cell && "palette" in c.cell && c.cell.palette === "scene-camp-tent")).toBe(true);
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
    // Crucial regression guard for Bug #1: previewVersion must NOT be prematurely bumped before migration!
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
    const designed = await decodeProject(readSampleBytes("ak-world-designed.bptilemap"));
    const oldCoastTileset = { ...designed.tilesets.find(t => t.id === AK_COAST_TILESET_ID)!, height: 640 };

    // Case 1: v4 draft falsely stamped previewVersion=5 (or 7) with old Lake Temple & missing SE desert fix.
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
        previewVersion: 7, // Simulates the old Bug #1 falsely stamping v7 before upgrading!
        elevations: { 17114: 3.7, 16708: 5.1, 120: 7.5 },
      },
    };
    const migratedV4 = migrateLegacyAkDraft(v4Draft, designed);
    expect(migratedV4.world?.previewVersion).toBe(AK_PREVIEW_VERSION);
    // SE desert highlands applied & sand fix restored
    expect(migratedV4.world?.elevations?.[26335]).toBe(5);
    expect(migratedV4.layers[0].cells[25767]).toEqual({ palette: "sand" });
    // Lake Temple upgraded to v7 without leaving empty ground holes where old v5 altar sat
    expect(migratedV4.layers[0].cells[88 * 200 + 114]).toEqual({ palette: "ruin-altar-rune" });
    expect(migratedV4.world?.elevations?.[88 * 200 + 114]).toBe(3.9);
    expect(migratedV4.layers[0].cells[16714]).toBeDefined();
    expect(migratedV4.world?.elevations?.[16708]).toBeUndefined();
    // 8-row ak-coast tileset + 3D Scene Kit palettes added
    expect(migratedV4.tilesets.find(t => t.id === AK_COAST_TILESET_ID)?.height).toBe(1024);
    expect(migratedV4.palettes.some(p => p.id === "scene-camp-tent")).toBe(true);
    // Unrelated user edits outside SE desert & Lake Temple are preserved untouched!
    expect(migratedV4.layers[0].cells[120]).toEqual({ palette: "snow" });
    expect(migratedV4.layers[1].cells[55]).toEqual({ palette: "road" });
    expect(migratedV4.world?.elevations?.[120]).toBe(7.5);
    expect(migratedV4.layers.find(l => l.id === AK_COAST_LAYER_ID)?.cells[23062]).toEqual({ palette: "coast-palm-left" });

    // Case 2: v5 draft with legacy 9m SE highlands falsely stamped previewVersion=7 -> rescaled to 5m.
    const v5Draft: TileMap = {
      ...designed,
      world: {
        ...designed.world!,
        previewVersion: 7,
        elevations: {
          ...designed.world!.elevations!,
          26335: 9,
          27138: 7.5,
          27338: 6,
          27538: 4.5,
        },
      },
    };
    const migratedV5 = migrateLegacyAkDraft(v5Draft, designed);
    expect(migratedV5.world?.elevations?.[26335]).toBe(5);
    expect(migratedV5.world?.elevations?.[27138]).toBe(4.5);
    expect(migratedV5.world?.elevations?.[27338]).toBe(4);
    expect(migratedV5.world?.elevations?.[27538]).toBe(3.5);
    expect(migratedV5.world?.previewVersion).toBe(AK_PREVIEW_VERSION);

    // Case 3: Once at AK_PREVIEW_VERSION (v8), subsequent user edits are NEVER overwritten!
    const customized = {
      ...migratedV5,
      world: { ...migratedV5.world!, elevations: { ...migratedV5.world!.elevations!, 26335: 8.2 } },
    };
    expect(needsLegacyAkMigration(customized)).toBe(false);
    expect(migrateLegacyAkDraft(customized, designed)).toBe(customized);

    // Case 4: Raw baseline draft without ak-coast-deco is NEVER silently mutated!
    expect(needsLegacyAkMigration(baseline)).toBe(false);
    expect(migrateLegacyAkDraft(baseline, designed)).toBe(baseline);
  });
});
