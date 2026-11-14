import * as THREE from "three";
import { drawTile, type Atlases } from "./draw";
import type { Surface, WorldMap } from "./model";
import { readTerrain, triangleHeight } from "./worldTerrainData";

// This tile is the unpainted ocean cell in the exported AK debug atlas.
const AK_WATER_TILE = { tileset: "ak-debug", x: 32, y: 0 };

export class WorldTerrain {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private readonly canvas = document.createElement("canvas");
  private readonly cells: Array<number[] | undefined>;
  private readonly centres: Float32Array;
  private readonly replacements: Uint8Array;

  static async load(world: WorldMap, width: number, height: number) {
    const data = await readTerrain(world.terrain!);
    return new WorldTerrain(world, width, height, data);
  }

  private constructor(
    private readonly world: WorldMap,
    private readonly width: number,
    private readonly height: number,
    data: Awaited<ReturnType<typeof readTerrain>>,
  ) {
    const { origin: [x0, z0], metresPerTile: metres } = world;
    const positions = new Float32Array(data.positions.length);
    const uv = new Float32Array(positions.length / 3 * 2);
    for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
      positions[i] = (data.positions[i] - x0) / metres;
      positions[i + 1] = data.positions[i + 1] / metres;
      positions[i + 2] = (data.positions[i + 2] - z0) / metres;
      uv[j] = positions[i] / width;
      uv[j + 1] = 1 - positions[i + 2] / height;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();

    const map = new THREE.CanvasTexture(this.canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.minFilter = map.magFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    const material = new THREE.MeshLambertMaterial({ map, alphaTest: 0.02, flatShading: true, side: THREE.DoubleSide });
    material.onBeforeCompile = shader => {
      shader.uniforms.snowLimit = { value: [(-52 - x0) / metres, (4 - z0) / metres] };
      shader.vertexShader = "varying vec3 vTerrainPosition;\n" + shader.vertexShader.replace(
        "#include <begin_vertex>", "#include <begin_vertex>\nvTerrainPosition = position;",
      );
      shader.fragmentShader = "varying vec3 vTerrainPosition;\nuniform vec2 snowLimit;\n" + shader.fragmentShader.replace(
        "#include <map_fragment>", `#include <map_fragment>
        vec3 slope = normalize(cross(dFdx(vTerrainPosition), dFdy(vTerrainPosition)));
        float cliff = 1.0 - smoothstep(0.4, 0.85, abs(slope.y));
        float snowy = 1.0 - smoothstep(-0.5, 0.5, max(vTerrainPosition.x - snowLimit.x, vTerrainPosition.z - snowLimit.y));
        float grain = sin(vTerrainPosition.x * 9.0 + vTerrainPosition.z * 11.0) * 0.012;
        vec3 rock = mix(vec3(0.22, 0.17, 0.13), vec3(0.24, 0.39, 0.48), snowy) + grain;
        diffuseColor.rgb = mix(diffuseColor.rgb, rock, cliff * 0.94);`,
      );
    };
    this.mesh = new THREE.Mesh(geometry, material);
    this.cells = new Array(width * height);
    for (let i = 0; i < data.indices.length; i += 3) {
      const a = data.indices[i] * 3, b = data.indices[i + 1] * 3, c = data.indices[i + 2] * 3;
      const ax = positions[a], az = positions[a + 2];
      const bx = positions[b], bz = positions[b + 2];
      const cx = positions[c], cz = positions[c + 2];
      if (Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) < 1e-8) continue;
      const x1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx)));
      const z1 = Math.min(height - 1, Math.floor(Math.max(az, bz, cz)));
      for (let z = Math.max(0, Math.floor(Math.min(az, bz, cz))); z <= z1; z++) {
        for (let x = Math.max(0, Math.floor(Math.min(ax, bx, cx))); x <= x1; x++) {
          (this.cells[z * width + x] ??= []).push(a, b, c);
        }
      }
    }
    this.centres = new Float32Array(width * height);
    this.replacements = new Uint8Array(width * height);
    for (let i = 0; i < this.centres.length; i++) {
      this.centres[i] = this.nativeHeight(i % width + 0.5, Math.floor(i / width) + 0.5) ?? NaN;
    }
  }

  private nativeHeight(x: number, z: number) {
    if (x < 0 || x >= this.width || z < 0 || z >= this.height) return undefined;
    const triangles = this.cells[Math.floor(z) * this.width + Math.floor(x)];
    if (!triangles) return undefined;
    const p = this.mesh.geometry.getAttribute("position").array;
    let y = -Infinity;
    for (let i = 0; i < triangles.length; i += 3) {
      y = Math.max(y, triangleHeight(p, triangles[i], triangles[i + 1], triangles[i + 2], x, z));
    }
    return Number.isFinite(y) ? y : undefined;
  }

  update(surfaces: Array<Surface | undefined>, atlases: Atlases, seaEdits: Uint8Array) {
    const pixels = Math.min(16, Math.floor(4096 / Math.max(this.width, this.height)));
    this.canvas.width = this.width * pixels;
    this.canvas.height = this.height * pixels;
    const ctx = this.canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < surfaces.length; i++) {
      const surface = surfaces[i];
      const baseline = this.world.heights[i];
      const changed = surface && Math.abs(surface.height * this.world.metresPerTile - baseline) > 0.0005;
      const missingLand = Number.isNaN(this.centres[i]) && baseline > -2;
      const tile = surface?.tiles[0];
      const nativeWater = surface?.tiles.length === 1 && tile?.tileset === AK_WATER_TILE.tileset
        && tile.x === AK_WATER_TILE.x && tile.y === AK_WATER_TILE.y;
      const paintedSea = baseline === -2 && Number.isNaN(this.centres[i]) && !!surface && !nativeWater;
      seaEdits[i] = paintedSea ? 255 : 0;
      this.replacements[i] = changed || missingLand || paintedSea ? 1 : 0;
      if (!surface || changed) continue;
      const x = i % this.width * pixels, y = Math.floor(i / this.width) * pixels;
      for (const tile of surface.tiles) drawTile(ctx, atlases, tile, x, y, pixels, pixels);
    }
    this.mesh.material.map!.needsUpdate = true;
  }

  hasReplacement = (index: number) => this.replacements[index] !== 0;

  wallColor = (x: number, z: number) =>
    this.world.origin[0] + x * this.world.metresPerTile < -52
      && this.world.origin[1] + z * this.world.metresPerTile < 4 ? "#6b899c" : undefined;

  heightAt = (x: number, z: number) => {
    const index = Math.floor(z) * this.width + Math.floor(x);
    return this.hasReplacement(index) ? undefined : this.nativeHeight(x, z);
  };

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.map?.dispose();
    this.mesh.material.dispose();
  }
}
