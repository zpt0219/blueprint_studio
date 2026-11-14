export const TWO_EDGE_MATRIX = [
  [4, 6, 14, 12],
  [5, 7, 15, 13],
  [1, 3, 11, 9],
  [0, 2, 10, 8],
];

export const TWO_CORNER_MATRIX = [
  [4, 3, 14, 6],
  [10, 7, 15, 13],
  [1, 9, 11, 12],
  [0, 2, 5, 8],
];

type HasCell = (x: number, y: number) => boolean;

export function edgeMask(has: HasCell, x: number, y: number): number {
  return Number(has(x, y - 1)) | (Number(has(x + 1, y)) << 1)
    | (Number(has(x, y + 1)) << 2) | (Number(has(x - 1, y)) << 3);
}

export function cornerMask(has: HasCell, x: number, y: number): number {
  const edges = edgeMask(has, x, y);
  let mask = 0;
  if ((edges & 3) === 3 && has(x + 1, y - 1)) mask |= 1;
  if ((edges & 6) === 6 && has(x + 1, y + 1)) mask |= 2;
  if ((edges & 12) === 12 && has(x - 1, y + 1)) mask |= 4;
  if ((edges & 9) === 9 && has(x - 1, y - 1)) mask |= 8;
  return mask;
}
