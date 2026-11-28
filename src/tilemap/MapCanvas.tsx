import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { rectangle, type Selection } from "./selection";
import { tilesetImage } from "./files";
import type { WorldImages } from "./worldCards";
import { drawTile, type Atlases } from "./draw";
import { gridPosition, WORLD_DETAIL_COLORS, type EncounterKind, type Point, type Surface, type WorldCard, type WorldEncounter, type WorldMap } from "./model";

const ENCOUNTER_COLORS: Record<EncounterKind, { stroke: string; fill: string }> = {
  boss: { stroke: "#dc2626", fill: "rgba(220, 38, 38, 0.16)" },
  encounter: { stroke: "#d97706", fill: "rgba(217, 119, 6, 0.15)" },
  trigger: { stroke: "#0284c7", fill: "rgba(2, 132, 199, 0.15)" },
};

interface Props {
  width: number;
  height: number;
  atlases: Atlases;
  surfaces: Array<Surface | undefined>;
  brushSize: number;
  canPaint: boolean;
  panKey: boolean;
  onPaint: (from: Point, to: Point) => void;
  onCommit: () => void;
  world?: WorldMap;
  focus?: Point;
  jump?: { point?: Point };
  onFocus?: (point: Point, picked?: boolean) => void;
  onTestPoint?: (point: Point) => void;
  selectArea?: boolean;
  selection?: Selection | null;
  onSelection?: (area: Selection) => void;
  onMoveSelection?: (area: Selection, at: Point) => void;
  selectCards?: boolean;
  selectedCard?: string | null;
  onSelectCard?: (id: string | null) => void;
  onDragCard?: (id: string, x: number, z: number) => void;
  showElevation?: boolean;
  eyedropper?: boolean;
  onPickTile?: (at: Point) => void;
  fillMode?: boolean;
  onFill?: (at: Point) => void;
  rectMode?: boolean;
  onRect?: (from: Point, to: Point) => void;
  selectEncounters?: boolean;
  selectedEncounter?: string | null;
  onSelectEncounter?: (id: string | null) => void;
  onPlaceEncounter?: (x: number, z: number) => void;
  onDragEncounter?: (id: string, x: number, z: number) => void;
}

type Gesture = { id: number } & (
  { kind: "paint"; last: Point } | { kind: "pan"; x: number; y: number }
  | { kind: "area"; start: Point } | { kind: "move-area"; start: Point; area: Selection; at: Point }
  | { kind: "rect"; start: Point; end: Point }
  | { kind: "card"; card: string; start: Point; original: Point }
  | { kind: "encounter"; encounter: string; start: Point; original: Point }
  | { kind: "focus" }
);

export default function MapCanvas({
  width, height, atlases, surfaces, brushSize, canPaint, panKey, onPaint, onCommit,
  world, focus, jump, onFocus, onTestPoint, selectCards, selectedCard, onSelectCard, onDragCard,
  selectArea, selection, onSelection, onMoveSelection, showElevation,
  eyedropper, onPickTile, fillMode, onFill, rectMode, onRect,
  selectEncounters, selectedEncounter, onSelectEncounter, onPlaceEncounter, onDragEncounter,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<Point | null>(null);
  const [hoverFocus, setHoverFocus] = useState(false);
  const [draftRect, setDraftRect] = useState<Selection | null>(null);
  const [images, setImages] = useState<WorldImages>(new Map());
  const textures = world?.textures;
  const cards = useMemo(() => [...(world?.cards ?? [])].sort((a, b) => a.position[2] - b.position[2]), [world?.cards]);
  const detailData = world?.details;
  const originX = world?.origin[0], originZ = world?.origin[1], metres = world?.metresPerTile;
  const details = useMemo(() => {
    if (!detailData || originX === undefined || originZ === undefined || !metres) return;
    const pixels = Math.min(16, Math.floor(4096 / Math.max(width, height)));
    const image = document.createElement("canvas");
    image.width = width * pixels;
    image.height = height * pixels;
    const ctx = image.getContext("2d")!;
    ctx.scale(pixels / metres, pixels / metres);
    ctx.translate(-originX, -originZ);
    for (const { kind, vertices, triangles } of detailData) {
      if (kind === "sea" || kind === "embers") continue;
      ctx.fillStyle = kind === "building" ? "#786b5d" : WORLD_DETAIL_COLORS[kind];
      // Fill small batches so dense, overlapping building triangles stay cheap to rasterize.
      const batch = kind === "ice" || kind === "frost" ? triangles.length : 384;
      for (let start = 0; start < triangles.length; start += batch) {
        ctx.beginPath();
        for (let i = start; i < Math.min(start + batch, triangles.length); i += 3) {
          const a = triangles[i] * 3, b = triangles[i + 1] * 3, c = triangles[i + 2] * 3;
          const ax = vertices[a], az = vertices[a + 2];
          const bx = vertices[b], bz = vertices[b + 2];
          const cx = vertices[c], cz = vertices[c + 2];
          const area = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
          if (area === 0) continue;
          ctx.moveTo(ax, az);
          ctx.lineTo(area > 0 ? bx : cx, area > 0 ? bz : cz);
          ctx.lineTo(area > 0 ? cx : bx, area > 0 ? cz : bz);
          ctx.closePath();
        }
        ctx.fill();
      }
    }
    return image;
  }, [detailData, originX, originZ, metres, width, height]);

  const relief = useMemo(() => {
    const scale = metres ?? 4;
    let hasElevation = false;
    for (const s of surfaces) {
      if (s && s.height !== 0) { hasElevation = true; break; }
    }
    if (!hasElevation) return;
    const cell = Math.min(12, Math.max(8, Math.floor(2400 / Math.max(width, height))));
    const image = document.createElement("canvas");
    image.width = width * cell;
    image.height = height * cell;
    const ctx = image.getContext("2d");
    if (!ctx) return;

    const heightAt = (x: number, y: number): number | undefined => {
      if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
      const s = surfaces[y * width + x];
      if (!s) return undefined;
      const h = s.height * scale;
      return world && h <= -1.5 ? undefined : h;
    };

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const h = heightAt(x, y);
        if (h === undefined) continue;
        const px = x * cell, py = y * cell;

        // 1. Hypsometric height darkening: higher elevations get deeper tone
        if (h > 1.5) {
          const baseNorm = Math.min(1, Math.max(0, (h - 2.0) / 24.0));
          const subStep = h > 3.0 && h < 6.0 ? ((h - 3.0) / 3.0) * 0.08 : 0;
          const alpha = Math.min(0.42, Math.round(baseNorm * 16) / 16 * 0.38 + subStep);
          if (alpha > 0.01) {
            ctx.fillStyle = `rgba(16, 24, 30, ${alpha.toFixed(3)})`;
            ctx.fillRect(px, py, cell, cell);
          }
        }

        const hN = heightAt(x, y - 1) ?? h;
        const hS = heightAt(x, y + 1) ?? h;
        const hW = heightAt(x - 1, y) ?? h;
        const hE = heightAt(x + 1, y) ?? h;

        // 2. Walkable ramp / stair slope detection & tread stripes
        const rampNS = (hN > h + 0.18 && h > hS + 0.18 && hN - h <= 2.8 && h - hS <= 2.8)
          || (hS > h + 0.18 && h > hN + 0.18 && hS - h <= 2.8 && h - hN <= 2.8);
        const rampEW = !rampNS && ((hW > h + 0.18 && h > hE + 0.18 && hW - h <= 2.8 && h - hE <= 2.8)
          || (hE > h + 0.18 && h > hW + 0.18 && hE - h <= 2.8 && h - hW <= 2.8));

        if (rampNS) {
          for (let ty = 2; ty <= cell - 3; ty += 3) {
            ctx.fillStyle = "rgba(255, 252, 238, 0.42)";
            ctx.fillRect(px + 1, py + ty, cell - 2, 1);
            ctx.fillStyle = "rgba(18, 24, 28, 0.48)";
            ctx.fillRect(px + 1, py + ty + 1, cell - 2, 1);
          }
        } else if (rampEW) {
          for (let tx = 2; tx <= cell - 3; tx += 3) {
            ctx.fillStyle = "rgba(255, 252, 238, 0.42)";
            ctx.fillRect(px + tx, py + 1, 1, cell - 2);
            ctx.fillStyle = "rgba(18, 24, 28, 0.48)";
            ctx.fillRect(px + tx + 1, py + 1, 1, cell - 2);
          }
        }

        // 3. Cliff contour edges, northwest sunlit rim highlights & southeast drop shadows
        const dhN = h - hN, dhW = h - hW, dhS = h - hS, dhE = h - hE;

        if (dhN > 0.12 && !(rampNS && dhN <= 2.8)) {
          if (dhN > 0.36) {
            const sev = Math.min(1, (dhN - 0.36) / 6.0);
            ctx.fillStyle = `rgba(20, 26, 30, ${(0.55 + sev * 0.3).toFixed(2)})`;
            ctx.fillRect(px, py, cell, 1);
            ctx.fillStyle = `rgba(255, 252, 235, ${(0.45 + sev * 0.35).toFixed(2)})`;
            ctx.fillRect(px, py + 1, cell, 1.5);
          } else {
            ctx.fillStyle = "rgba(255, 252, 235, 0.48)";
            ctx.fillRect(px, py, cell, 1);
          }
        }
        if (dhW > 0.12 && !(rampEW && dhW <= 2.8)) {
          if (dhW > 0.36) {
            const sev = Math.min(1, (dhW - 0.36) / 6.0);
            ctx.fillStyle = `rgba(20, 26, 30, ${(0.55 + sev * 0.3).toFixed(2)})`;
            ctx.fillRect(px, py, 1, cell);
            ctx.fillStyle = `rgba(255, 252, 235, ${(0.45 + sev * 0.35).toFixed(2)})`;
            ctx.fillRect(px + 1, py, 1.5, cell);
          } else {
            ctx.fillStyle = "rgba(255, 252, 235, 0.48)";
            ctx.fillRect(px, py, 1, cell);
          }
        }
        if (dhS > 0.12 && !(rampNS && dhS <= 2.8)) {
          if (dhS > 0.36) {
            const sev = Math.min(1, (dhS - 0.36) / 6.0);
            const band = dhS > 2.5 ? 2 : 1.5;
            ctx.fillStyle = `rgba(16, 20, 24, ${(0.68 + sev * 0.25).toFixed(2)})`;
            ctx.fillRect(px, py + cell - band, cell, band);
            if (y + 1 < height) {
              const sh = dhS > 2.5 ? 3 : 2;
              ctx.fillStyle = `rgba(14, 20, 26, ${(0.24 + sev * 0.2).toFixed(2)})`;
              ctx.fillRect(px, py + cell, cell, sh);
            }
          } else {
            ctx.fillStyle = "rgba(20, 26, 30, 0.52)";
            ctx.fillRect(px, py + cell - 1, cell, 1);
          }
        }
        if (dhE > 0.12 && !(rampEW && dhE <= 2.8)) {
          if (dhE > 0.36) {
            const sev = Math.min(1, (dhE - 0.36) / 6.0);
            const band = dhE > 2.5 ? 2 : 1.5;
            ctx.fillStyle = `rgba(16, 20, 24, ${(0.68 + sev * 0.25).toFixed(2)})`;
            ctx.fillRect(px + cell - band, py, band, cell);
            if (x + 1 < width) {
              const sh = dhE > 2.5 ? 3 : 2;
              ctx.fillStyle = `rgba(14, 20, 26, ${(0.24 + sev * 0.2).toFixed(2)})`;
              ctx.fillRect(px + cell, py, sh, cell);
            }
          } else {
            ctx.fillStyle = "rgba(20, 26, 30, 0.52)";
            ctx.fillRect(px + cell - 1, py, 1, cell);
          }
        }
      }
    }
    return image;
  }, [surfaces, width, height, metres, world]);
  function cardRect(card: WorldCard) {
    const [x, z] = gridPosition(world!, card.position[0], card.position[2]);
    const w = Math.max(8, card.size[0] / world!.metresPerTile * size);
    const h = Math.max(8, card.size[1] / world!.metresPerTile * size);
    return { x: left + x * size, y: top + z * size, w, h };
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all((textures ?? []).map(async texture => [texture.id, await tilesetImage(texture.png)] as const))
      .then(entries => { if (!cancelled) setImages(new Map(entries)); })
      .catch(() => { if (!cancelled) setImages(new Map()); });
    return () => { cancelled = true; };
  }, [textures]);
  const fitted = Math.max(0.1, Math.min(32, (viewport.width - 40) / width, (viewport.height - 40) / height));
  const size = fitted * view.zoom;
  const left = (viewport.width - width * size) / 2 + view.x;
  const top = (viewport.height - height * size) / 2 + view.y;

  useEffect(() => {
    const element = canvas.current!;
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!jump) return;
    const zoom = jump.point ? 5 : 1;
    setView({
      zoom,
      x: jump.point ? (width / 2 - jump.point[0]) * fitted * zoom : 0,
      y: jump.point ? (height / 2 - jump.point[1]) * fitted * zoom : 0,
    });
  }, [jump, width, height, fitted]);

  useEffect(() => {
    const element = canvas.current!;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(viewport.width * ratio));
    const pixelHeight = Math.max(1, Math.round(viewport.height * ratio));
    if (element.width !== pixelWidth) element.width = pixelWidth;
    if (element.height !== pixelHeight) element.height = pixelHeight;
    const ctx = element.getContext("2d")!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#f4f1e8";
    ctx.fillRect(left, top, width * size, height * size);
    const x0 = Math.max(0, Math.floor(-left / size));
    const y0 = Math.max(0, Math.floor(-top / size));
    const x1 = Math.min(width, Math.ceil((viewport.width - left) / size));
    const y1 = Math.min(height, Math.ceil((viewport.height - top) / size));
    const pixelEdge = (value: number) => Math.round(value * ratio) / ratio;
    for (let y = y0; y < y1; y++) {
      const topEdge = pixelEdge(top + y * size);
      const bottomEdge = pixelEdge(top + (y + 1) * size);
      for (let x = x0; x < x1; x++) {
        const surface = surfaces[y * width + x];
        if (!surface) continue;
        const leftEdge = pixelEdge(left + x * size);
        const rightEdge = pixelEdge(left + (x + 1) * size);
        for (const tile of surface.tiles) {
          drawTile(ctx, atlases, tile, leftEdge, topEdge, rightEdge - leftEdge, bottomEdge - topEdge);
        }
      }
    }
    if (relief) ctx.drawImage(relief, left, top, width * size, height * size);
    if (details) ctx.drawImage(details, left, top, width * size, height * size);
    if ((showElevation && size >= 12) || size >= 28) {
      const scale = metres ?? 1;
      ctx.save();
      ctx.font = `600 ${Math.min(12, Math.max(9, Math.floor(size * 0.34)))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const s = surfaces[y * width + x];
          if (!s) continue;
          const h = s.height * scale;
          if (world && h <= -1.5) continue;
          if (!showElevation && h === 0) continue;
          const label = Number.isInteger(Number(h.toFixed(1))) ? `${Math.round(h)}` : `${Number(h.toFixed(2))}`;
          const cx = left + (x + 0.5) * size, cy = top + (y + 0.5) * size;
          ctx.strokeStyle = "rgba(20, 28, 24, 0.78)";
          ctx.lineWidth = 2.5;
          ctx.strokeText(label, cx, cy);
          ctx.fillStyle = "#f7faf7";
          ctx.fillText(label, cx, cy);
        }
      }
      ctx.restore();
    }
    ctx.strokeStyle = "rgba(35, 37, 30, 0.18)";
    ctx.lineWidth = 1 / ratio;
    ctx.strokeRect(left, top, width * size, height * size);
    if (size >= 7) {
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        ctx.moveTo(left + x * size, top);
        ctx.lineTo(left + x * size, top + height * size);
      }
      for (let y = y0; y <= y1; y++) {
        ctx.moveTo(left, top + y * size);
        ctx.lineTo(left + width * size, top + y * size);
      }
      ctx.stroke();
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const decorations = surfaces[y * width + x]?.decorations;
        if (!decorations?.length) continue;
        const cx = left + (x + 0.5) * size;
        const cy = top + (y + 0.5) * size;
        for (const decoration of decorations) {
          if (!world || size >= 5) {
            const w = Math.max(8, decoration.size[0] * size);
            const h = Math.max(8, decoration.size[1] * size);
            drawTile(ctx, atlases, decoration.tile, cx - w / 2, cy - h / 2, w, h);
          } else {
            ctx.beginPath();
            ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
            ctx.fillStyle = "#305539";
            ctx.fill();
          }
        }
      }
    }
    if (world) {
      if (size >= 5) {
        ctx.fillStyle = "#26332ab5";
        for (const proxy of world.proxies) {
          const [x, y] = gridPosition(world, proxy.position[0] - proxy.size[0] / 2, proxy.position[2] - proxy.size[2] / 2);
          ctx.fillRect(left + x * size, top + y * size,
            proxy.size[0] / world.metresPerTile * size, proxy.size[2] / world.metresPerTile * size);
        }
      }
      for (const card of cards) {
        const rect = cardRect(card);
        if (rect.x + rect.w / 2 < 0 || rect.x - rect.w / 2 > viewport.width
          || rect.y + rect.h / 2 < 0 || rect.y - rect.h / 2 > viewport.height) continue;
        const image = images.get(card.texture);
        if (image && size >= 5) {
          ctx.save();
          ctx.translate(rect.x, rect.y);
          ctx.scale(card.flipH ? -1 : 1, card.flipV ? -1 : 1);
          ctx.drawImage(image, ...card.region, -rect.w / 2, -rect.h / 2, rect.w, rect.h);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(rect.x, rect.y, selectCards ? 2.5 : 1.5, 0, Math.PI * 2);
          ctx.fillStyle = "#305539";
          ctx.fill();
        }
        if (card.id && card.id === selectedCard) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 3;
          ctx.strokeRect(rect.x - rect.w / 2 - 2, rect.y - rect.h / 2 - 2, rect.w + 4, rect.h + 4);
          ctx.strokeStyle = "#a34d15";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(rect.x - rect.w / 2 - 2, rect.y - rect.h / 2 - 2, rect.w + 4, rect.h + 4);
        }
      }
      function mark(point: [number, number, number], color: string, radius: number) {
        const [x, y] = gridPosition(world!, point[0], point[2]);
        ctx.beginPath();
        ctx.arc(left + x * size, top + y * size, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }
      for (const marker of world.markers) mark(marker.position, "#173e53", 3);
      for (const enc of world.encounters ?? []) {
        const [gx, gz] = gridPosition(world, enc.position[0], enc.position[2]);
        const cx = left + gx * size;
        const cy = top + gz * size;
        const pxRadius = Math.max(8, (enc.radius / world.metresPerTile) * size);
        const colors = ENCOUNTER_COLORS[enc.kind];
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, pxRadius, 0, Math.PI * 2);
        ctx.fillStyle = colors.fill;
        ctx.fill();
        ctx.lineWidth = enc.id === selectedEncounter ? 3 : 2;
        ctx.strokeStyle = colors.stroke;
        ctx.setLineDash(enc.kind === "boss" ? [6, 3] : [4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(cx, cy, enc.id === selectedEncounter ? 6.5 : 5, 0, Math.PI * 2);
        ctx.fillStyle = colors.stroke;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = enc.id === selectedEncounter ? "#facc15" : "#ffffff";
        ctx.stroke();
        if (size >= 3 || enc.id === selectedEncounter) {
          ctx.font = "600 11px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.strokeStyle = "rgba(18, 22, 26, 0.85)";
          ctx.lineWidth = 3;
          ctx.strokeText(enc.name, cx, cy - 9);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(enc.name, cx, cy - 9);
        }
        ctx.restore();
      }
      if (world.testPoint) mark(world.testPoint, "#bc4b23", 6);
    }
    if (selection && selectArea) {
      ctx.fillStyle = "#21877822";
      ctx.fillRect(left + selection.x * size, top + selection.y * size, selection.width * size, selection.height * size);
      ctx.strokeStyle = "#126950"; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
      ctx.strokeRect(left + selection.x * size, top + selection.y * size, selection.width * size, selection.height * size);
      ctx.setLineDash([]);
    }
    if (draftRect) {
      ctx.fillStyle = showElevation ? "rgba(217, 119, 6, 0.2)" : "rgba(20, 92, 70, 0.22)";
      ctx.fillRect(left + draftRect.x * size, top + draftRect.y * size, draftRect.width * size, draftRect.height * size);
      ctx.strokeStyle = showElevation ? "#b45309" : "#145c46";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(left + draftRect.x * size, top + draftRect.y * size, draftRect.width * size, draftRect.height * size);
      ctx.setLineDash([]);
    }
    if (hover && (canPaint || eyedropper || fillMode || rectMode) && !panKey && !hoverFocus && !draftRect) {
      const span = (eyedropper || fillMode || rectMode) ? 1 : brushSize;
      const radius = Math.floor(span / 2);
      const startX = Math.max(0, hover[0] - radius), startY = Math.max(0, hover[1] - radius);
      const endX = Math.min(width, hover[0] + radius + 1), endY = Math.min(height, hover[1] + radius + 1);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      ctx.strokeRect(left + startX * size, top + startY * size, (endX - startX) * size, (endY - startY) * size);
      ctx.strokeStyle = eyedropper ? "#0284c7" : "#125d48";
      ctx.lineWidth = 1;
      ctx.strokeRect(left + startX * size, top + startY * size, (endX - startX) * size, (endY - startY) * size);
    }
    if (focus) {
      const fx = left + focus[0] * size;
      const fy = top + focus[1] * size;
      if (size >= 6) {
        const tx = left + Math.floor(focus[0]) * size;
        const ty = top + Math.floor(focus[1]) * size;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
        ctx.lineWidth = 2;
        ctx.strokeRect(tx, ty, size, size);
      }
      ctx.save();
      ctx.beginPath();
      ctx.arc(fx, fy, 12, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 213, 120, 0.32)";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(20, 35, 30, 0.65)";
      ctx.stroke();
      ctx.lineWidth = 1.75;
      ctx.strokeStyle = "#ffd578";
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(fx, fy, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = "#e11d48";
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "#14231e";
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(fx, fy, 2, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.restore();
    }
  }, [atlases, surfaces, viewport, width, height, size, left, top, hover, hoverFocus, brushSize, canPaint, panKey, world, focus, cards, details, relief, showElevation, metres, images, selectedCard, selectCards, selection, selectArea, draftRect, eyedropper, fillMode, rectMode, selectedEncounter]);

  useEffect(() => {
    const element = canvas.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      setView(current => {
        const zoom = Math.max(0.25, Math.min(12, current.zoom * Math.exp(-delta * 0.0014)));
        const factor = zoom / current.zoom;
        return { zoom, x: x - (x - current.x) * factor, y: y - (y - current.y) * factor };
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  function precisePoint(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return [(event.clientX - rect.left - left) / size, (event.clientY - rect.top - top) / size];
  }

  function point(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const [x, z] = precisePoint(event);
    return [Math.floor(x), Math.floor(z)];
  }

  function hitFocus(event: ReactPointerEvent<HTMLCanvasElement>): boolean {
    if (!focus || !onFocus) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    return Math.hypot(mx - (left + focus[0] * size), my - (top + focus[1] * size)) <= 14;
  }

  function clampFocus([x, z]: Point): Point {
    const clamp = (value: number, max: number) =>
      Math.round(Math.max(0.01, Math.min(max - 0.01, value)) * 1000) / 1000;
    return [clamp(x, width), clamp(z, height)];
  }

  function onDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (gesture.current || (event.button !== 0 && event.button !== 1)) return;
    event.currentTarget.focus({ preventScroll: true });
    if (panKey || event.button === 1) {
      gesture.current = { kind: "pan", id: event.pointerId, x: event.clientX, y: event.clientY };
    } else if (!event.shiftKey && hitFocus(event)) {
      gesture.current = { kind: "focus", id: event.pointerId };
      setHover(null);
      setHoverFocus(true);
    } else {
      const tile = point(event);
      if (tile[0] < 0 || tile[1] < 0 || tile[0] >= width || tile[1] >= height) return;
      if (event.shiftKey && onTestPoint) {
        onTestPoint(precisePoint(event));
        return;
      }
      if ((event.altKey || eyedropper) && onPickTile) {
        onPickTile(tile);
        return;
      }
      if (selectEncounters && world) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const mx = event.clientX - bounds.left, my = event.clientY - bounds.top;
        let hitEnc: WorldEncounter | undefined;
        let bestDist = Infinity;
        for (const enc of world.encounters ?? []) {
          const [gx, gz] = gridPosition(world, enc.position[0], enc.position[2]);
          const d = Math.hypot(mx - (left + gx * size), my - (top + gz * size));
          if (d <= 14 && d < bestDist) { hitEnc = enc; bestDist = d; }
        }
        if (hitEnc) {
          onSelectEncounter?.(hitEnc.id);
          gesture.current = {
            kind: "encounter", id: event.pointerId, encounter: hitEnc.id,
            start: precisePoint(event), original: [hitEnc.position[0], hitEnc.position[2]],
          };
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        const [gx, gz] = precisePoint(event);
        onPlaceEncounter?.(world.origin[0] + gx * world.metresPerTile, world.origin[1] + gz * world.metresPerTile);
        return;
      }
      if (fillMode && onFill) {
        onFill(tile);
        return;
      }
      if (rectMode && onRect) {
        gesture.current = { kind: "rect", id: event.pointerId, start: tile, end: tile };
        setDraftRect(rectangle(tile, tile));
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      if (selectArea) {
        if (selection && tile[0] >= selection.x && tile[0] < selection.x + selection.width && tile[1] >= selection.y && tile[1] < selection.y + selection.height) {
          gesture.current = { kind: "move-area", id: event.pointerId, start: tile, area: selection, at: [selection.x, selection.y] };
        } else {
          gesture.current = { kind: "area", id: event.pointerId, start: tile };
          onSelection?.(rectangle(tile, tile));
        }
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); return;
      }
      if (selectCards && world) {
        const bounds = event.currentTarget.getBoundingClientRect();
        const mx = event.clientX - bounds.left, my = event.clientY - bounds.top;
        let nearest: WorldCard | undefined;
        let distance = Infinity;
        for (const card of cards) {
          if (!card.id) continue;
          const rect = cardRect(card);
          if (Math.abs(mx - rect.x) > Math.max(6, rect.w / 2)
            || Math.abs(my - rect.y) > Math.max(6, rect.h / 2)) continue;
          const d = Math.hypot(mx - rect.x, my - rect.y);
          if (d < distance) { nearest = card; distance = d; }
        }
        onSelectCard?.(nearest?.id ?? null);
        if (!nearest?.id) return;
        gesture.current = {
          kind: "card", id: event.pointerId, card: nearest.id, start: precisePoint(event),
          original: [nearest.position[0], nearest.position[2]],
        };
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      if (!canPaint) return;
      gesture.current = { kind: "paint", id: event.pointerId, last: tile };
      onPaint(tile, tile);
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const active = gesture.current;
    if (active && active.id !== event.pointerId) return;
    if (active?.kind === "pan") {
      const dx = event.clientX - active.x, dy = event.clientY - active.y;
      setView(current => ({ ...current, x: current.x + dx, y: current.y + dy }));
      active.x = event.clientX;
      active.y = event.clientY;
      return;
    }
    if (active?.kind === "focus") {
      onFocus?.(clampFocus(precisePoint(event)), true);
      return;
    }
    if (active?.kind === "card" && world) {
      const next = precisePoint(event);
      onDragCard?.(active.card, active.original[0] + (next[0] - active.start[0]) * world.metresPerTile,
        active.original[1] + (next[1] - active.start[1]) * world.metresPerTile);
      return;
    }
    if (active?.kind === "encounter" && world) {
      const next = precisePoint(event);
      onDragEncounter?.(active.encounter, active.original[0] + (next[0] - active.start[0]) * world.metresPerTile,
        active.original[1] + (next[1] - active.start[1]) * world.metresPerTile);
      return;
    }
    const tile = point(event);
    if (active?.kind === "rect") {
      tile[0] = Math.max(0, Math.min(width - 1, tile[0]));
      tile[1] = Math.max(0, Math.min(height - 1, tile[1]));
      active.end = tile;
      setDraftRect(rectangle(active.start, tile));
      return;
    }
    if (active?.kind === "area" || active?.kind === "move-area") {
      tile[0] = Math.max(0, Math.min(width - 1, tile[0]));
      tile[1] = Math.max(0, Math.min(height - 1, tile[1]));
      if (active.kind === "area") onSelection?.(rectangle(active.start, tile));
      else {
        active.at = [Math.max(0, Math.min(width - active.area.width, active.area.x + tile[0] - active.start[0])),
          Math.max(0, Math.min(height - active.area.height, active.area.y + tile[1] - active.start[1]))];
        onSelection?.({ ...active.area, x: active.at[0], y: active.at[1] });
      }
      return;
    }
    if (!active) {
      setHoverFocus(!panKey && hitFocus(event));
    }
    const inside = tile[0] >= 0 && tile[1] >= 0 && tile[0] < width && tile[1] < height;
    setHover(current => {
      if (!inside) return null;
      return current?.[0] === tile[0] && current[1] === tile[1] ? current : tile;
    });
    if (active?.kind === "paint") {
      tile[0] = Math.max(0, Math.min(width - 1, tile[0]));
      tile[1] = Math.max(0, Math.min(height - 1, tile[1]));
      if (tile[0] !== active.last[0] || tile[1] !== active.last[1]) {
        onPaint(active.last, tile);
        active.last = tile;
      }
    }
  }

  function onEnd(event: ReactPointerEvent<HTMLCanvasElement>) {
    const active = gesture.current;
    if (active?.id !== event.pointerId) return;
    gesture.current = null;
    if (active.kind === "move-area") {
      if (event.type === "pointercancel") onSelection?.(active.area);
      else onMoveSelection?.(active.area, active.at);
    }
    if (active.kind === "rect") {
      setDraftRect(null);
      if (event.type !== "pointercancel") onRect?.(active.start, active.end);
      return;
    }
    if (active.kind === "paint" || active.kind === "card" || active.kind === "encounter") onCommit();
  }

  return <canvas ref={canvas} className={panKey || hoverFocus ? "tm-map tm-pan" : "tm-map"} aria-label="2D 地图" tabIndex={0}
    onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onEnd} onPointerCancel={onEnd}
    onLostPointerCapture={onEnd} onPointerLeave={() => { setHover(null); setHoverFocus(false); }} />;
}
