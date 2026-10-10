import { describe, it, expect } from "vitest";
import {
  applyBitwiseObjectOp,
  fillTerrainMatrix,
  flipTerrainMatrix,
  keepBorderTerrainMatrix,
  dilateTerrainMatrix,
  erodeTerrainMatrix,
  hasBitwiseOverlap,
} from "../bitwise";
import { DEFAULT_MORPH_NOISE_CONFIG } from "../terrainNoise";
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

describe("Bitwise & Morphology Operations", () => {
  it("computes overlap correctly", () => {
    const a = createMatrix(0, 0, 4, 4);
    const b = createMatrix(2, 2, 4, 4);
    const c = createMatrix(10, 10, 2, 2);

    expect(hasBitwiseOverlap(a, b)).toBe(true);
    expect(hasBitwiseOverlap(a, c)).toBe(false);
  });

  it("handles fillTerrainMatrix and flipTerrainMatrix", () => {
    const m = createMatrix(0, 0, 3, 3, -1);
    const filled = fillTerrainMatrix(m, true);
    expect(Array.from(filled.data)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);

    const flipped = flipTerrainMatrix(filled);
    expect(Array.from(flipped.data)).toEqual([-1, -1, -1, -1, -1, -1, -1, -1, -1]);
  });

  it("applies bitwise boolean operations", () => {
    // 3x3 target and source
    const target = createMatrix(0, 0, 3, 3, -1);
    target.data[0] = 0; // (0,0) is filled
    target.data[1] = 0; // (1,0) is filled

    const source = createMatrix(0, 0, 3, 3, -1);
    source.data[1] = 0; // (1,0) is filled
    source.data[2] = 0; // (2,0) is filled

    // OR
    const orResult = applyBitwiseObjectOp(target, source, "OR");
    expect(orResult.data[0]).toBe(0);
    expect(orResult.data[1]).toBe(0);
    expect(orResult.data[2]).toBe(0);
    expect(orResult.data[3]).toBe(-1);

    // AND
    const andResult = applyBitwiseObjectOp(target, source, "AND");
    expect(andResult.data[0]).toBe(-1);
    expect(andResult.data[1]).toBe(0);
    expect(andResult.data[2]).toBe(-1);

    // SUBTRACT (target - source)
    const subResult = applyBitwiseObjectOp(target, source, "SUBTRACT");
    expect(subResult.data[0]).toBe(0);
    expect(subResult.data[1]).toBe(-1);
    expect(subResult.data[2]).toBe(-1);
  });

  it("detects borders via keepBorderTerrainMatrix", () => {
    // 3x3 filled square: center (1,1) has 8 filled neighbors, so it is interior
    const target = createMatrix(0, 0, 3, 3, 0);
    const bordered = keepBorderTerrainMatrix(target);

    // Outer cells remain 0, center cell (1,1) should become -1
    expect(bordered.data[4]).toBe(-1); // index 4 is (1,1)
    expect(bordered.data[0]).toBe(0);
    expect(bordered.data[1]).toBe(0);
    expect(bordered.data[2]).toBe(0);
  });

  it("dilates and erodes properly", () => {
    // Single isolated center dot in 3x3
    const target = createMatrix(0, 0, 3, 3, -1);
    target.data[4] = 0; // center is filled

    const dilated = dilateTerrainMatrix(target, DEFAULT_MORPH_NOISE_CONFIG, false);
    // Center's 8 neighbors should be dilated to 0
    expect(Array.from(dilated.data)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);

    // Solid 3x3 eroding with borderAsConnected=false
    const solid = createMatrix(0, 0, 3, 3, 0);
    const eroded = erodeTerrainMatrix(solid, DEFAULT_MORPH_NOISE_CONFIG, false);
    // All edge cells have out-of-bounds neighbors (empty), so only center has 8 solid neighbors
    expect(eroded.data[4]).toBe(0);
    expect(eroded.data[0]).toBe(-1);
  });
});
