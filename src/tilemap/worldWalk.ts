import { gridPosition, type Point, type WorldMap } from "./model";

export function worldWallTest(world: WorldMap) {
  const metres = world.metresPerTile;
  const radius = 0.4 / metres;
  const walls = (world.wallColliders ?? []).map(({ position, size, yaw }) => {
    const [x, z] = gridPosition(world, position[0], position[2]);
    const [w, h, d] = size.map(value => value / metres / 2);
    return { x, z, w, d, bottom: position[1] / metres - h, top: position[1] / metres + h,
      cos: Math.cos(yaw), sin: Math.sin(yaw) };
  });
  return (x: number, y: number, z: number) => walls.some(wall => {
    if (y + 0.05 / metres >= wall.top || y + 1.6 / metres <= wall.bottom) return false;
    const dx = x - wall.x, dz = z - wall.z;
    const localX = Math.max(0, Math.abs(dx * wall.cos - dz * wall.sin) - wall.w);
    const localZ = Math.max(0, Math.abs(dx * wall.sin + dz * wall.cos) - wall.d);
    return localX * localX + localZ * localZ < radius * radius;
  });
}

export function canWalk(
  from: Point,
  to: Point,
  metres: number,
  heightAt: (x: number, z: number) => number | undefined,
  wallAt: (x: number, y: number, z: number) => boolean,
) {
  const current = heightAt(...from);
  const next = heightAt(...to);
  if (next === undefined || (current !== undefined && (next - current) * metres > 0.351)) return false;
  return !wallAt(to[0], next, to[1]);
}
