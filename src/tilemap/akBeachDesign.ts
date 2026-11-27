import { decodeProject } from "./files";
import { gridPosition, type Cell, type TileMap } from "./model";
import { AK_DESIGNED_PROJECT_URL, AK_PREVIEW_VERSION } from "./world";

export const AK_COAST_TILESET_ID = "ak-coast";
export const AK_COAST_LAYER_ID = "ak-coast-deco";
export const AK_COAST_KIT_URL = `${import.meta.env.BASE_URL}sample/ak-coast-kit.bppalette`;

const AK_WIDTH = 200;
const AK_HEIGHT = 160;
const LEGACY_SE_SCALE: Record<number, number> = { 4.5: 3.5, 6: 4, 7.5: 4.5, 9: 5 };

function isSeDesertTile(index: number): boolean {
  const tx = index % AK_WIDTH;
  const tz = Math.floor(index / AK_WIDTH);
  return tx >= 135 && tz >= 111;
}

function isLakeTempleTile(index: number): boolean {
  const tx = index % AK_WIDTH;
  const tz = Math.floor(index / AK_WIDTH);
  return tx >= 107 && tx <= 124 && tz >= 81 && tz <= 92;
}

function samePalette(cell: Cell | undefined, paletteId: string): boolean {
  return !!cell && "palette" in cell && cell.palette === paletteId;
}

export function needsAkSceneHydration(document: TileMap): boolean {
  const world = document.world;
  if (world?.id !== "ak-world-v1") return false;
  const hasCardIds = !!world.cards && world.cards.every(card => !!card.id);
  return !hasCardIds || !world.terrain || !world.wallColliders || !world.lavaCells
    || (world.cards !== undefined && !world.textures)
    || (world.previewVersion ?? 0) < 2;
}

/**
 * Hydrates read-only native Godot scene preview metadata (terrain mesh, building details,
 * wall colliders, lava mask, missing native card IDs/markers) from the baseline snapshot.
 * Never mutates user layers, palettes, elevations, or previewVersion.
 */
export function hydrateAkSceneDetails(document: TileMap, baseline: TileMap): TileMap {
  const world = document.world;
  const original = baseline.world;
  if (world?.id !== "ak-world-v1" || !original || original.id !== world.id
    || original.revision !== world.revision || baseline.width !== document.width
    || baseline.height !== document.height || original.metresPerTile !== world.metresPerTile
    || !original.origin.every((value, index) => value === world.origin[index])) {
    return document;
  }
  const hasCardIds = !!world.cards && world.cards.every(card => !!card.id);
  return {
    ...document,
    world: {
      ...world,
      cards: hasCardIds ? world.cards : world.cards?.map((card, i) => ({
        ...card,
        id: card.id ?? original.cards?.[i]?.id,
        name: card.name ?? original.cards?.[i]?.name,
      })) ?? original.cards,
      textures: world.textures ?? original.textures,
      proxies: original.proxies,
      details: original.details ?? world.details,
      terrain: original.terrain,
      lavaCells: original.lavaCells,
      wallColliders: original.wallColliders,
      markers: [
        ...world.markers,
        ...original.markers.filter(marker => !world.markers.some(old => old.id === marker.id)),
      ],
    },
  };
}

export function needsLegacyAkMigration(document: TileMap): boolean {
  const world = document.world;
  return world?.id === "ak-world-v1"
    && document.width === AK_WIDTH && document.height === AK_HEIGHT
    && document.layers.some(layer => layer.id === AK_COAST_LAYER_ID)
    && (world.previewVersion ?? 0) < AK_PREVIEW_VERSION;
}

/**
 * One-time non-destructive upgrade for legacy browser IndexedDB drafts saved before v8.
 * Reads all design data from the standalone designed .bptilemap project (zero hardcoded map arrays)
 * and checks each region independently so drafts falsely stamped v5/v7 by the prior previewVersion bug
 * still receive missing SE desert highland fixes, Lake Temple alignment, and the 8-row 3D Scene Kit.
 */
export function migrateLegacyAkDraft(draft: TileMap, designed: TileMap): TileMap {
  if (!needsLegacyAkMigration(draft) || designed.world?.id !== "ak-world-v1") return draft;
  const world = draft.world!;
  const designedWorld = designed.world;

  // 1. Upgrade ak-coast tileset (e.g. 5-row -> 8-row PNG) and register any missing Scene Kit palettes.
  const designedCoast = designed.tilesets.find(item => item.id === AK_COAST_TILESET_ID);
  const existingCoast = draft.tilesets.find(item => item.id === AK_COAST_TILESET_ID);
  const needsTilesetUpdate = !!designedCoast && (
    !existingCoast || existingCoast.height < designedCoast.height || existingCoast.png.size < 1000
  );
  const tilesets = !needsTilesetUpdate ? draft.tilesets
    : existingCoast
      ? draft.tilesets.map(item => item.id === AK_COAST_TILESET_ID ? designedCoast! : item)
      : [...draft.tilesets, designedCoast!];

  const designedCoastPalettes = designed.palettes.filter(item => item.tileset === AK_COAST_TILESET_ID);
  const paletteMap = new Map(draft.palettes.map(item => [item.id, item]));
  for (const palette of designedCoastPalettes) {
    if (!paletteMap.has(palette.id) || needsTilesetUpdate) {
      paletteMap.set(palette.id, palette);
    }
  }
  const palettes = Array.from(paletteMap.values());

  const designedGround = designed.layers.find(layer => layer.id === "ak-ground");
  const designedDeco = designed.layers.find(layer => layer.id === AK_COAST_LAYER_ID);
  const draftGround = draft.layers.find(layer => layer.id === "ak-ground");
  const designedElevs = designedWorld.elevations ?? {};
  const elevations: Record<number, number> = { ...(world.elevations ?? {}) };

  // 2. SE Desert Highlands block (tx >= 135, tz >= 111):
  //    - Missing altogether (v3/v4 drafts skipped by prior previewVersion bug) -> fill from designed.
  //    - Legacy v5 9m peaks -> rescale { 4.5->3.5, 6->4, 7.5->4.5, 9->5 } and fill any gaps.
  const designedSeEntries = Object.entries(designedElevs).filter(([key]) => isSeDesertTile(Number(key)));
  let existingSeCount = 0;
  for (const [key] of designedSeEntries) {
    if (elevations[Number(key)] !== undefined) existingSeCount++;
  }
  const hasLegacy9mSe = Object.entries(elevations).some(
    ([key, metres]) => isSeDesertTile(Number(key)) && metres === 9,
  );
  const fixSeDesert = existingSeCount < 100 || hasLegacy9mSe;
  if (hasLegacy9mSe) {
    for (const [key, metres] of Object.entries(elevations)) {
      const idx = Number(key);
      if (isSeDesertTile(idx) && metres in LEGACY_SE_SCALE) {
        elevations[idx] = LEGACY_SE_SCALE[metres];
      }
    }
  }
  if (fixSeDesert) {
    for (const [key, metres] of designedSeEntries) {
      const idx = Number(key);
      if (elevations[idx] === undefined) elevations[idx] = metres;
    }
  }

  // 3. Lake Temple Ruins block (tx 107..124, tz 81..92):
  const ruinGroundIds = new Set(
    designedCoastPalettes.filter(palette => palette.usage !== "decoration").map(palette => palette.id),
  );
  const ruinDecoIds = new Set(
    designedCoastPalettes.filter(palette => palette.usage === "decoration" && palette.id.startsWith("ruin-")).map(palette => palette.id),
  );
  const designedAltarIndices = designedGround
    ? Object.entries(designedGround.cells)
      .filter(([, cell]) => samePalette(cell, "ruin-altar-rune"))
      .map(([key]) => Number(key))
    : [];
  const designedAltarSet = new Set(designedAltarIndices);
  const hasCurrentAltar = designedAltarIndices.length > 0 && designedAltarIndices.every(
    idx => samePalette(draftGround?.cells[idx], "ruin-altar-rune") && elevations[idx] === designedElevs[idx],
  );
  let hasAnyRuinInLake = false;
  let hasStaleRuinInLake = elevations[17114] === 3.7 || elevations[16708] === 5.1;
  if (draftGround) {
    for (const [key, cell] of Object.entries(draftGround.cells)) {
      const idx = Number(key);
      if (!isLakeTempleTile(idx) || !("palette" in cell)) continue;
      if (ruinGroundIds.has(cell.palette)) hasAnyRuinInLake = true;
      if (cell.palette === "ruin-altar-rune" && !designedAltarSet.has(idx)) hasStaleRuinInLake = true;
    }
  }
  const upgradeLakeTemple = !hasCurrentAltar && (hasStaleRuinInLake || !hasAnyRuinInLake);

  if (upgradeLakeTemple) {
    for (const key of Object.keys(elevations)) {
      const idx = Number(key);
      if (isLakeTempleTile(idx)) delete elevations[idx];
    }
    for (const [key, metres] of Object.entries(designedElevs)) {
      const idx = Number(key);
      if (isLakeTempleTile(idx)) elevations[idx] = metres;
    }
  }

  const layers = draft.layers.map(layer => {
    if (layer.id === "ak-ground" && designedGround && (fixSeDesert || upgradeLakeTemple)) {
      const cells: Record<number, Cell> = { ...layer.cells };
      if (fixSeDesert) {
        for (const [key, designedCell] of Object.entries(designedGround.cells)) {
          const idx = Number(key);
          if (isSeDesertTile(idx) && samePalette(designedCell, "sand") && samePalette(cells[idx], "rock")) {
            cells[idx] = designedCell;
          }
        }
      }
      if (upgradeLakeTemple) {
        for (const [key, cell] of Object.entries(cells)) {
          const idx = Number(key);
          if (isLakeTempleTile(idx) && "palette" in cell && ruinGroundIds.has(cell.palette)) {
            if (designedGround.cells[idx]) cells[idx] = designedGround.cells[idx];
            else delete cells[idx];
          }
        }
        for (const [key, designedCell] of Object.entries(designedGround.cells)) {
          const idx = Number(key);
          if (isLakeTempleTile(idx) && "palette" in designedCell && ruinGroundIds.has(designedCell.palette)) {
            cells[idx] = designedCell;
          }
        }
      }
      return { ...layer, cells };
    }
    if (layer.id === AK_COAST_LAYER_ID && designedDeco && upgradeLakeTemple) {
      const cells: Record<number, Cell> = { ...layer.cells };
      for (const [key, cell] of Object.entries(cells)) {
        const idx = Number(key);
        if (!isLakeTempleTile(idx) || !("palette" in cell)) continue;
        if (ruinDecoIds.has(cell.palette) || !designedDeco.cells[idx]) {
          delete cells[idx];
        }
      }
      for (const [key, designedCell] of Object.entries(designedDeco.cells)) {
        const idx = Number(key);
        if (isLakeTempleTile(idx)) cells[idx] = designedCell;
      }
      return { ...layer, cells };
    }
    return layer;
  });

  let cards = world.cards;
  if (upgradeLakeTemple && cards && designedWorld.cards) {
    const designedCardIds = new Set(designedWorld.cards.map(card => card.id).filter(Boolean));
    cards = cards.filter(card => {
      if (!card.id || designedCardIds.has(card.id)) return true;
      const [gx, gz] = gridPosition(world, card.position[0], card.position[2]);
      return !(gx >= 102 && gx <= 128 && gz >= 78 && gz <= 96);
    });
  }

  return {
    ...draft,
    tilesets,
    palettes,
    layers,
    world: { ...world, cards, elevations, previewVersion: AK_PREVIEW_VERSION },
  };
}

export async function readAkDesignedProject(): Promise<TileMap> {
  const response = await fetch(AK_DESIGNED_PROJECT_URL);
  if (!response.ok) throw new Error("无法读取 AK 设计地图项目包。");
  return decodeProject(new Uint8Array(await response.arrayBuffer()));
}

/**
 * Compatibility entry point for external scripts (such as asterfell-scene's
 * tools/studio/export_from_blueprint_studio.mjs when invoked without --bptilemap).
 * The editor itself loads public/sample/ak-world-designed.bptilemap directly.
 */
export async function applyAkBeachDesign(map?: TileMap): Promise<TileMap> {
  if (map && (map.world?.id !== "ak-world-v1" || map.width !== AK_WIDTH || map.height !== AK_HEIGHT)) {
    return map;
  }
  const designed = await readAkDesignedProject();
  if (map && needsLegacyAkMigration(map)) {
    return migrateLegacyAkDraft(map, designed);
  }
  return designed;
}
