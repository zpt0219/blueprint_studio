import { useEffect, useRef } from "react";
import { mappingCell, type Palette, type PackRuntime } from "../pack/types";

// Cropped preview of one palette from the shared atlas.
export function PaletteSwatch({ pack, palette, px = 40 }: { pack: Pick<PackRuntime, "atlas">; palette: Palette; px?: number }) {
  const { atlas } = pack;
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const [bx, by] = mappingCell(palette.mapping, 0, 0);
    const tr = palette.tileResolution;
    const sw = palette.size[0] * tr;
    const sh = palette.size[1] * tr;
    const f = Math.min(px / sw, px / sh);
    const dw = Math.max(1, Math.round(sw * f));
    const dh = Math.max(1, Math.round(sh * f));
    ctx.clearRect(0, 0, px, px);
    ctx.imageSmoothingEnabled = false;
    const left = Math.floor((px - dw) / 2), top = Math.floor((px - dh) / 2);
    if (!palette.tilesetId) {
      ctx.drawImage(atlas, bx, by, sw, sh, left, top, dw, dh);
      return;
    }
    const [cols, rows] = palette.size;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const [x, y] = mappingCell(palette.mapping, col, row);
        if (x < 0 || y < 0) continue;
        const x0 = Math.round(col * dw / cols), y0 = Math.round(row * dh / rows);
        const w = Math.round((col + 1) * dw / cols) - x0, h = Math.round((row + 1) * dh / rows) - y0;
        if (w && h) ctx.drawImage(atlas, x, y, tr, tr, left + x0, top + y0, w, h);
      }
    }
  }, [atlas, palette, px]);
  return <canvas ref={ref} width={px} height={px} className="pal-sw" />;
}
