import { describe, it, expect } from "vitest";
import { terrainNeighborBits, isMatrixAutotile } from "../pack/autotile";
import { PaletteMode } from "../pack/types";
import type { TerrainMatrix } from "../model";

function createMatrix(ox: number, oy: number, w: number, h: number, init: number = -1): TerrainMatrix {
  return {
    ox,
    oy,
    w,
    h,
    data: new Int16Array(w * h).fill(init),
  };
}

describe("Autotile Neighbor Logic", () => {
  it("checks supported matrix autotile modes", () => {
    expect(isMatrixAutotile(PaletteMode.TWO_CORNER)).toBe(true);
    expect(isMatrixAutotile(PaletteMode.TWO_EDGE)).toBe(true);
    expect(isMatrixAutotile(PaletteMode.FIXED_RECT)).toBe(false);
  });

  it("calculates TWO_EDGE 4-direction neighbor bitmask correctly", () => {
    // UP = 1, RIGHT = 2, DOWN = 4, LEFT = 8
    const m = createMatrix(0, 0, 3, 3, -1);
    m.data[4] = 0; // center (1,1)

    // Center has no neighbors
    expect(terrainNeighborBits("TERRAIN_2_EDGE", m, 1, 1, false)).toBe(0);

    // Add UP neighbor (1, 0) -> bits |= 1
    m.data[1] = 0;
    expect(terrainNeighborBits("TERRAIN_2_EDGE", m, 1, 1, false)).toBe(1);

    // Add RIGHT neighbor (2, 1) -> bits |= 2 -> 3
    m.data[5] = 0;
    expect(terrainNeighborBits("TERRAIN_2_EDGE", m, 1, 1, false)).toBe(3);

    // Add DOWN neighbor (1, 2) -> bits |= 4 -> 7
    m.data[7] = 0;
    expect(terrainNeighborBits("TERRAIN_2_EDGE", m, 1, 1, false)).toBe(7);

    // Add LEFT neighbor (0, 1) -> bits |= 8 -> 15
    m.data[3] = 0;
    expect(terrainNeighborBits("TERRAIN_2_EDGE", m, 1, 1, false)).toBe(15);
  });

  it("honors borderAsConnected for out-of-bounds cells", () => {
    // 1x1 matrix: (0,0) is filled
    const m = createMatrix(0, 0, 1, 1, 0);

    // With borderAsConnected = false, all out-of-bounds cells are empty (0)
    expect(terrainNeighborBits("TERRAIN_2_EDGE", m, 0, 0, false)).toBe(0);

    // With borderAsConnected = true, all 4 out-of-bounds directions are filled (1|2|4|8 = 15)
    expect(terrainNeighborBits("TERRAIN_2_EDGE", m, 0, 0, true)).toBe(15);
  });
});
