const terrainData = new WeakMap<Blob, Promise<{ positions: Float32Array; indices: Uint32Array }>>();

export function readTerrain(blob: Blob) {
  let data = terrainData.get(blob);
  if (!data) {
    data = blob.arrayBuffer().then(buffer => {
      const invalid = () => new Error("原场景地形网格无效。");
      if (buffer.byteLength < 8) throw invalid();
      const header = new DataView(buffer);
      const positionsLength = header.getUint32(0, true);
      const indicesLength = header.getUint32(4, true);
      if (!positionsLength || !indicesLength || positionsLength % 3 || indicesLength % 3
        || 8 + 4 * (positionsLength + indicesLength) !== buffer.byteLength) throw invalid();
      const positions = new Float32Array(buffer, 8, positionsLength);
      const indices = new Uint32Array(buffer, 8 + positionsLength * 4, indicesLength);
      if (!positions.every(Number.isFinite) || !indices.every(index => index < positionsLength / 3)) throw invalid();
      return { positions, indices };
    });
    terrainData.set(blob, data);
  }
  return data;
}

export function triangleHeight(p: ArrayLike<number>, a: number, b: number, c: number, x: number, z: number) {
  const ux = p[b] - p[a], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vz = p[c + 2] - p[a + 2];
  const dx = x - p[a], dz = z - p[a + 2];
  const determinant = ux * vz - vx * uz;
  if (Math.abs(determinant) < 1e-8) return -Infinity;
  const u = (dx * vz - vx * dz) / determinant;
  const v = (ux * dz - dx * uz) / determinant;
  return u >= -1e-5 && v >= -1e-5 && u + v <= 1.00001
    ? p[a + 1] * (1 - u - v) + p[b + 1] * u + p[c + 1] * v
    : -Infinity;
}

export async function terrainHeightAt(blob: Blob, x: number, z: number) {
  const { positions, indices } = await readTerrain(blob);
  let y = -Infinity;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    if (x < Math.min(positions[a], positions[b], positions[c]) || x > Math.max(positions[a], positions[b], positions[c])
      || z < Math.min(positions[a + 2], positions[b + 2], positions[c + 2])
      || z > Math.max(positions[a + 2], positions[b + 2], positions[c + 2])) continue;
    y = Math.max(y, triangleHeight(positions, a, b, c, x, z));
  }
  return Number.isFinite(y) ? y : undefined;
}
