import * as THREE from "three";
import { drawTile, type Atlases } from "./draw";
import { elevationSides, type Surface, type Tile } from "./model";

const CHUNK = 16;
const sideCorners = [[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 0, 1], [0, 1, 0, 0]];
type Position = [number, number, number];

class Quads {
  positions: number[] = [];
  uvs: number[] = [];
  indices: number[] = [];

  add(points: Position[], u0: number, v0: number, u1: number, v1: number) {
    const start = this.positions.length / 3;
    for (const point of points) this.positions.push(...point);
    this.uvs.push(u0, v0, u0, v1, u1, v1, u1, v0);
    this.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  geometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    return geometry;
  }
}

function makeTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

export function buildMesh(surfaces: Array<Surface | undefined>, width: number, height: number, atlases: Atlases, world = false,
  native?: { hasReplacement: (index: number) => boolean; heightAt: (x: number, z: number) => number | undefined;
    wallColor: (x: number, z: number) => string | undefined }) {
  const group = new THREE.Group();
  // Cap the full map's composited textures at 64 MiB before GPU upload.
  const maxPixels = Math.floor(Math.sqrt(16_777_216 / (width * height)));
  const pixels = Math.min(maxPixels, Math.max(16, ...Array.from(atlases.values(), atlas => atlas.tileSize)));
  const wallGroups = new Map<string, { quads: Quads; tile?: Tile; color?: string }>();
  for (let y0 = 0; y0 < height; y0 += CHUNK) {
    for (let x0 = 0; x0 < width; x0 += CHUNK) {
      const cols = Math.min(CHUNK, width - x0), rows = Math.min(CHUNK, height - y0);
      const tops = new Quads();
      let canvas: HTMLCanvasElement | undefined;
      let ctx: CanvasRenderingContext2D | undefined;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = x0 + col, z = y0 + row;
          const surface = surfaces[z * width + x];
          if (!surface || (native && !native.hasReplacement(z * width + x))) continue;
          if (!ctx) {
            canvas = document.createElement("canvas");
            canvas.width = cols * pixels;
            canvas.height = rows * pixels;
            ctx = canvas.getContext("2d")!;
            ctx.imageSmoothingEnabled = false;
          }
          for (const tile of surface.tiles) drawTile(ctx, atlases, tile, col * pixels, row * pixels, pixels);
          const y = surface.height;
          tops.add([[x, y, z], [x, y, z + 1], [x + 1, y, z + 1], [x + 1, y, z]],
            col / cols, 1 - row / rows, (col + 1) / cols, 1 - (row + 1) / rows);
          if (y <= 0 && !world) continue;
          const levels = elevationSides(surfaces, width, height, x, z);
          levels.forEach((bottom, index) => {
            const [ax, az, bx, bz] = sideCorners[index];
            const wallTile = surface.wall;
            const color = wallTile ? undefined : native?.wallColor(x, z);
            const key = wallTile ? JSON.stringify([wallTile.tileset, wallTile.x, wallTile.y]) : color ?? "";
            const dx = (ax + bx - 1) * 0.005, dz = (az + bz - 1) * 0.005;
            const xAt = (t: number) => x + ax + (bx - ax) * t;
            const zAt = (t: number) => z + az + (bz - az) * t;
            const edge = (t: number) => {
              const inside = Math.min(0.999, Math.max(0.001, t));
              return native?.heightAt(xAt(inside) + dx, zAt(inside) + dz);
            };
            const segments = native ? 4 : 1;
            let heightA = edge(0);
            for (let segment = 0; segment < segments; segment++) {
              const start = segment / segments, end = (segment + 1) / segments;
              const heightB = edge(end);
              const edgeA = heightA ?? bottom, edgeB = heightB ?? bottom;
              const adjacentNative = heightA !== undefined || heightB !== undefined;
              heightA = heightB;
              if (!adjacentNative && bottom >= y) continue;
              if (Math.abs(edgeA - y) < 0.0001 && Math.abs(edgeB - y) < 0.0001) continue;
              let entry = wallGroups.get(key);
              if (!entry) {
                entry = { quads: new Quads(), tile: wallTile, color };
                wallGroups.set(key, entry);
              }
              entry.quads.add([[xAt(start), y, zAt(start)], [xAt(start), edgeA, zAt(start)],
                [xAt(end), edgeB, zAt(end)], [xAt(end), y, zAt(end)]], start, 1, end, 0);
            }
          });
        }
      }
      if (canvas) {
        const material = new THREE.MeshLambertMaterial({ map: makeTexture(canvas), alphaTest: 0.02 });
        group.add(new THREE.Mesh(tops.geometry(), material));
      }
    }
  }

  for (const { quads, tile, color } of wallGroups.values()) {
    const atlas = tile && atlases.get(tile.tileset);
    let map: THREE.CanvasTexture | undefined;
    if (tile && atlas) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = atlas.tileSize;
      drawTile(canvas.getContext("2d")!, atlases, tile, 0, 0, atlas.tileSize);
      map = makeTexture(canvas);
    }
    const material = new THREE.MeshLambertMaterial({
      map, color: map ? 0xffffff : color ?? 0xa28871, side: THREE.DoubleSide, alphaTest: 0.02,
    });
    group.add(new THREE.Mesh(quads.geometry(), material));
  }
  const decorationMaterials = new Map<string, THREE.MeshLambertMaterial>();
  surfaces.forEach((surface, index) => {
    for (const decoration of surface?.decorations ?? []) {
      const key = `${decoration.tile.tileset}:${decoration.tile.x}:${decoration.tile.y}`;
      let material = decorationMaterials.get(key);
      if (!material) {
        const pixels = atlases.get(decoration.tile.tileset)?.tileSize ?? 16;
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = pixels;
        drawTile(canvas.getContext("2d")!, atlases, decoration.tile, 0, 0, pixels);
        const texture = makeTexture(canvas);
        if (pixels > 32) {
          texture.magFilter = THREE.LinearFilter;
          texture.minFilter = THREE.LinearFilter;
        }
        material = new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide, alphaTest: 0.42 });
        decorationMaterials.set(key, material);
      }
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...decoration.size), material);
      const x = index % width + 0.5, z = Math.floor(index / width) + 0.5;
      mesh.position.set(x, (native && !native.hasReplacement(index) ? native.heightAt(x, z) : undefined) ?? surface!.height, z);
      mesh.position.y += decoration.size[1] / 2;
      mesh.userData.billboard = true;
      group.add(mesh);
    }
  });
  return group;
}

export function disposeMesh(group: THREE.Group) {
  for (const mesh of group.children as Array<THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>>) {
    mesh.geometry.dispose();
    mesh.material.map?.dispose();
    mesh.material.dispose();
  }
}
