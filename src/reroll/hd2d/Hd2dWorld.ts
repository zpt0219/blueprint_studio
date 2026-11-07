// Hd2dWorld.ts — Three.js HD-2D 3D TileMap renderer built directly on LiteTileMap.
// Powers both:
// 1. 3D Scene View (free camera, 3D object picking, selection highlight boxes,
//    Game Camera frustum gizmo, and Stack Gap multi-image explosion inspector).
// 2. 3D Game View (locked player-follow HD-2D camera, pure in-game presentation,
//    and real-time WASD walk/collision testing).

import * as THREE from "three";
import { findObject, roleOf, type HouseData, type LiteObject, type LiteTileMap, type Rect } from "../model";
import { colorForRole, rgbaCss } from "../generated/roleColors";
import { type Palette, type PackRuntime } from "../pack/types";
import type { Bindings } from "../pack/compile";
import { autotileCellAtlas, drawAutotile } from "../pack/autotile";
import { blitFixedRect, blitTile } from "../pack/blit";
import { blitNineSlice } from "../pack/slice";
import { effectiveDecorationCell } from "../house";
import type { RenderMode } from "../render";
import { inspectTileStack } from "../fastBrush";

export interface Hd2dRenderOptions {
  renderMode: RenderMode;
  /** Vertical spacing multiplier between stacked ground layers (1 = tight 0.014, up to 18 = exploded view). */
  stackExplode: number;
  /** Whether vertical sprites rotate around Y to face the camera. */
  billboardSprites: boolean;
  /** Show subtle 3D tile grid overlay (Scene View only). */
  showGrid: boolean;
}

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  facing: 1 | -1;
  walkPhase: number;
}

function makeCrispCanvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function makeSmoothCanvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Draw a single object's footprint into an offscreen canvas of size (rect.w * s, rect.h * s) in local coords. */
function renderObjectLocalCanvas(
  o: LiteObject,
  s: number,
  pack: PackRuntime | null,
  bindings: Bindings | null,
  renderMode: RenderMode,
): HTMLCanvasElement | null {
  const [rx, ry, rw, rh] = o.rect;
  if (rw <= 0 || rh <= 0) return null;
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, rw * s);
  cv.height = Math.max(1, rh * s);
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;

  const b = pack && bindings && renderMode !== "blueprint" ? bindings.get(o.id) : undefined;
  const atlas = pack?.atlas;

  ctx.save();
  ctx.translate(-rx * s, -ry * s);

  if (b && atlas) {
    const borderConn = o.tags["borderAsConnected"] === "true";
    if (b.kind === "auto" && o.terrain) {
      drawAutotile(ctx, atlas, b.palette, o.terrain, s, null, borderConn);
      ctx.restore();
      return cv;
    }
    if (b.kind === "fixed") {
      blitFixedRect(ctx, atlas, b.palette, rx, ry, s);
      ctx.restore();
      return cv;
    }
    if (b.kind === "slice") {
      blitNineSlice(ctx, atlas, b.palette, o.rect, s);
      ctx.restore();
      return cv;
    }
    if (b.kind === "frg" && o.terrain) {
      const t = o.terrain;
      for (let r = 0; r < t.h; r++) {
        for (let c = 0; c < t.w; c++) {
          const vi = b.cellVariant[r * t.w + c];
          if (vi < 0) continue;
          const v = b.variants[vi];
          if (!v) continue;
          const bx = t.ox + c;
          const by = t.oy + r - v.size[1] + 1;
          blitFixedRect(ctx, atlas, v, bx, by, s);
        }
      }
      ctx.restore();
      return cv;
    }
  }

  if (renderMode === "real" && pack) {
    ctx.restore();
    return null;
  }

  // Fallback blueprint role color rendering
  const rgb = colorForRole(roleOf(o));
  if (o.terrain) {
    const t = o.terrain;
    ctx.fillStyle = rgbaCss(rgb, o.type === "FIXED_RECT_GROUP" ? 0.55 : 0.92);
    for (let r = 0; r < t.h; r++) {
      for (let c = 0; c < t.w; c++) {
        if (t.data[r * t.w + c] < 0) continue;
        ctx.fillRect((t.ox + c) * s, (t.oy + r) * s, s, s);
      }
    }
  } else {
    ctx.fillStyle = rgbaCss(rgb, 0.8);
    ctx.fillRect(rx * s, ry * s, rw * s, rh * s);
  }
  ctx.restore();
  return cv;
}

/** Extract a single Palette (fixed rect) into a canvas. */
function renderPaletteSpriteCanvas(atlas: CanvasImageSource, palette: Palette, s: number): HTMLCanvasElement {
  const [pw, ph] = palette.size;
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, pw * s);
  cv.height = Math.max(1, ph * s);
  const ctx = cv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  blitFixedRect(ctx, atlas, palette, 0, 0, s);
  return cv;
}

/** Extract a single autotile cell (1x1) into a canvas. */
function renderSingleTileCanvas(atlas: CanvasImageSource, ax: number, ay: number, tr: number, s: number): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = s;
  cv.height = s;
  const ctx = cv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  blitTile(ctx, atlas, ax, ay, tr, 0, 0, s);
  return cv;
}

/** Render composite house facade for 3D cottage (clean walls without top overlap rows). */
function renderHouseTextures(
  rect: Rect,
  house: HouseData,
  wall: Palette | null,
  roof: Palette | null,
  deco: (Palette | null)[],
  atlas: CanvasImageSource | null,
  s: number,
  _roleRgb: [number, number, number],
): { facadeCanvas: HTMLCanvasElement; roofCanvas: HTMLCanvasElement } {
  const [, , w, h] = rect;
  const wallH = Math.max(1, Math.min(h - 1, house.wallHeight));
  const roofH = Math.max(1, h - wallH);

  const facadeCanvas = document.createElement("canvas");
  facadeCanvas.width = Math.max(1, w * s);
  facadeCanvas.height = Math.max(1, wallH * s);
  const fctx = facadeCanvas.getContext("2d")!;
  fctx.imageSmoothingEnabled = false;

  const roofCanvas = document.createElement("canvas");
  roofCanvas.width = Math.max(1, w * s);
  roofCanvas.height = Math.max(1, roofH * s);
  const rctx = roofCanvas.getContext("2d")!;
  rctx.imageSmoothingEnabled = false;

  if (atlas && (wall || roof)) {
    if (wall) {
      const localWallRect: Rect = [0, 0, w, wallH];
      blitNineSlice(fctx, atlas, wall, localWallRect, s);
    } else {
      fctx.fillStyle = "#d4c3a3";
      fctx.fillRect(0, 0, facadeCanvas.width, facadeCanvas.height);
    }
    if (roof) {
      const localRoofRect: Rect = [0, 0, w, roofH];
      blitNineSlice(rctx, atlas, roof, localRoofRect, s);
    } else {
      rctx.fillStyle = "#8d5b4c";
      rctx.fillRect(0, 0, roofCanvas.width, roofCanvas.height);
    }
    for (let i = 0; i < house.decorations.length; i++) {
      const p = deco[i];
      if (!p) continue;
      const [cx, cy] = effectiveDecorationCell(house, rect, i, p);
      const wallStartRow = h - wallH;
      if (cy >= wallStartRow) {
        blitFixedRect(fctx, atlas, p, cx, cy - wallStartRow, s);
      } else {
        blitFixedRect(rctx, atlas, p, cx, cy, s);
      }
    }
  } else {
    // Elegant procedural cottage facade in blueprint mode
    fctx.fillStyle = "#d8c8a8";
    fctx.fillRect(0, 0, facadeCanvas.width, facadeCanvas.height);
    // Timber vertical framing
    fctx.fillStyle = "#5c3c24";
    fctx.fillRect(0, 0, 4, facadeCanvas.height);
    fctx.fillRect(facadeCanvas.width - 4, 0, 4, facadeCanvas.height);
    // Base plinth line
    fctx.fillStyle = "#4a4237";
    fctx.fillRect(0, facadeCanvas.height - 4, facadeCanvas.width, 4);

    // Front door
    const doorW = Math.max(12, Math.floor(facadeCanvas.width * 0.28));
    const doorH = Math.max(18, Math.floor(facadeCanvas.height * 0.65));
    const doorX = Math.floor((facadeCanvas.width - doorW) / 2);
    const doorY = facadeCanvas.height - doorH;
    fctx.fillStyle = "#422613";
    fctx.fillRect(doorX - 2, doorY - 2, doorW + 4, doorH + 2);
    fctx.fillStyle = "#693e20";
    fctx.fillRect(doorX, doorY, doorW, doorH);
    fctx.fillStyle = "#eab308";
    fctx.fillRect(doorX + doorW - 4, doorY + Math.floor(doorH * 0.52), 2, 2);

    // Left window
    const winW = Math.floor(doorW * 0.7);
    const winH = Math.floor(doorH * 0.55);
    const winY = doorY + 4;
    if (doorX > winW + 6) {
      const winX = Math.floor((doorX - winW) / 2);
      fctx.fillStyle = "#422613";
      fctx.fillRect(winX - 1, winY - 1, winW + 2, winH + 2);
      fctx.fillStyle = "#fef08a";
      fctx.fillRect(winX, winY, winW, winH);
      fctx.fillStyle = "#422613";
      fctx.fillRect(winX + Math.floor(winW / 2), winY, 1, winH);
      fctx.fillRect(winX, winY + Math.floor(winH / 2), winW, 1);
    }
    // Right window
    const rightSpace = facadeCanvas.width - (doorX + doorW);
    if (rightSpace > winW + 6) {
      const winX = doorX + doorW + Math.floor((rightSpace - winW) / 2);
      fctx.fillStyle = "#422613";
      fctx.fillRect(winX - 1, winY - 1, winW + 2, winH + 2);
      fctx.fillStyle = "#fef08a";
      fctx.fillRect(winX, winY, winW, winH);
      fctx.fillStyle = "#422613";
      fctx.fillRect(winX + Math.floor(winW / 2), winY, 1, winH);
      fctx.fillRect(winX, winY + Math.floor(winH / 2), winW, 1);
    }

    rctx.fillStyle = "#8a4f3d";
    rctx.fillRect(0, 0, roofCanvas.width, roofCanvas.height);
  }

  return { facadeCanvas, roofCanvas };
}

/** Procedural rock cliff canvas with horizontal sediment strata lines and lush top grass lip. */
function generateCliffCanvas(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 256;
  const ctx = cv.getContext("2d")!;

  // Base rock
  ctx.fillStyle = "#5c4f42";
  ctx.fillRect(0, 0, 256, 256);

  // Horizontal strata sedimentary layers
  const strataColors = ["#4a3e33", "#6b5c4d", "#776757", "#44392e", "#635547", "#54473b", "#726253", "#3d3229"];
  for (let y = 32; y < 256; y += 12) {
    ctx.fillStyle = strataColors[(y * 7) % strataColors.length];
    ctx.fillRect(0, y, 256, 6 + (y % 4));
  }

  // Vertical subtle chiseled fractures
  ctx.fillStyle = "rgba(35, 28, 20, 0.4)";
  for (let x = 16; x < 256; x += 32) {
    ctx.fillRect(x, 24, 3, 232);
    ctx.fillRect(x + 7, 54, 2, 110);
  }

  // Top grass overhang rim (top 32 pixels in canvas, which maps to V=1 top of cliff wall)
  ctx.fillStyle = "#557f49";
  ctx.fillRect(0, 0, 256, 22);
  ctx.fillStyle = "#699a5c";
  ctx.fillRect(0, 0, 256, 10);
  // Drooping grass tufts
  ctx.fillStyle = "#4a703f";
  for (let x = 0; x < 256; x += 6) {
    const tuftH = 8 + ((x * 11) % 14);
    ctx.fillRect(x, 22, 5, tuftH);
  }

  return cv;
}

/** Procedural terracotta roof shingles texture. */
function generateRoofCanvas(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = 128;
  cv.height = 128;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#8a4f3d";
  ctx.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 16) {
    ctx.fillStyle = y % 32 === 0 ? "#784133" : "#985845";
    ctx.fillRect(0, y, 128, 14);
    ctx.fillStyle = "#5c2e22";
    ctx.fillRect(0, y + 14, 128, 2);
    ctx.fillStyle = "#4e271c";
    const xOffset = (y / 16) % 2 === 0 ? 0 : 16;
    for (let x = xOffset; x < 128; x += 32) {
      ctx.fillRect(x, y, 2, 14);
    }
  }
  return cv;
}

/** Procedural cream plaster wall with dark timber half-framing. */
function generateTimberWallCanvas(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = 64;
  cv.height = 64;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#d8ccb8";
  ctx.fillRect(0, 0, 64, 64);
  // Half-timber vertical beams
  ctx.fillStyle = "#543721";
  ctx.fillRect(0, 0, 5, 64);
  ctx.fillRect(59, 0, 5, 64);
  ctx.fillRect(29, 0, 6, 64);
  // Top and bottom horizontal wall plates
  ctx.fillRect(0, 0, 64, 5);
  ctx.fillRect(0, 59, 64, 5);
  return cv;
}

/** Soft radial contact shadow decal for grounding props and characters. */
function generateRadialShadowCanvas(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = 64;
  cv.height = 64;
  const ctx = cv.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  grad.addColorStop(0, "rgba(0, 0, 0, 0.48)");
  grad.addColorStop(0.5, "rgba(0, 0, 0, 0.24)");
  grad.addColorStop(0.85, "rgba(0, 0, 0, 0.06)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return cv;
}

export class Hd2dWorld {
  readonly scene = new THREE.Scene();
  private worldRoot = new THREE.Group();
  private verticalPickables: THREE.Object3D[] = [];
  private groundPickables: THREE.Object3D[] = [];
  private gridGroup = new THREE.Group();
  private hoverGroup = new THREE.Group();
  private selectionGroup = new THREE.Group();
  private frustumGroup = new THREE.Group();
  private actorGroup = new THREE.Group();
  private billboardMeshes: THREE.Object3D[] = [];
  private disposableTextures: THREE.Texture[] = [];
  private disposableGeometries: THREE.BufferGeometry[] = [];
  private disposableMaterials: THREE.Material[] = [];

  private sun: THREE.DirectionalLight;
  private hemisphereLight: THREE.HemisphereLight;
  private cliffTex: THREE.Texture;
  private roofTex: THREE.Texture;
  private timberWallTex: THREE.Texture;
  private contactShadowMat: THREE.MeshBasicMaterial;

  private elevationGrid: Float32Array = new Float32Array(0);
  private blockedGrid: Uint8Array = new Uint8Array(0);
  private mapW = 1;
  private mapH = 1;

  constructor() {
    // Atmosphere & Sky benchmark: exact tilemap-hd2d-world palette
    this.scene.background = new THREE.Color("#c4dfe8");
    this.scene.fog = new THREE.FogExp2("#c4dfe8", 0.0032);

    this.hemisphereLight = new THREE.HemisphereLight("#c5e3ed", "#7c7653", 1.35);
    this.scene.add(this.hemisphereLight);

    this.sun = new THREE.DirectionalLight("#fff1d5", 2.0);
    this.sun.position.set(24, 72, 50);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.width = 2048;
    this.sun.shadow.mapSize.height = 2048;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 300;
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const fill = new THREE.DirectionalLight("#9ab8ff", 0.4);
    fill.position.set(-24, 30, -20);
    this.scene.add(fill);

    // Common procedural shared textures
    this.cliffTex = makeSmoothCanvasTexture(generateCliffCanvas());
    this.cliffTex.wrapS = THREE.RepeatWrapping;
    this.cliffTex.wrapT = THREE.ClampToEdgeWrapping;

    this.roofTex = makeSmoothCanvasTexture(generateRoofCanvas());
    this.roofTex.wrapS = THREE.RepeatWrapping;
    this.roofTex.wrapT = THREE.RepeatWrapping;

    this.timberWallTex = makeCrispCanvasTexture(generateTimberWallCanvas());
    this.timberWallTex.wrapS = THREE.RepeatWrapping;
    this.timberWallTex.wrapT = THREE.RepeatWrapping;

    const shadowTex = makeSmoothCanvasTexture(generateRadialShadowCanvas());
    this.contactShadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.scene.add(this.worldRoot);
    this.scene.add(this.gridGroup);
    this.scene.add(this.hoverGroup);
    this.scene.add(this.selectionGroup);
    this.scene.add(this.frustumGroup);
    this.scene.add(this.actorGroup);
    this.actorGroup.visible = true;
    this.initActorMesh();
  }

  private initActorMesh(): void {
    const cv = document.createElement("canvas");
    cv.width = 32;
    cv.height = 48;
    const ctx = cv.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    // Cloak/body
    ctx.fillStyle = "#2b5b84";
    ctx.fillRect(8, 20, 16, 16);
    ctx.fillStyle = "#d94e4e";
    ctx.fillRect(7, 22, 18, 8);
    // Boots
    ctx.fillStyle = "#4a3222";
    ctx.fillRect(9, 36, 5, 7);
    ctx.fillRect(18, 36, 5, 7);
    // Head & hair
    ctx.fillStyle = "#f5cfa6";
    ctx.fillRect(9, 8, 14, 12);
    ctx.fillStyle = "#5c3c24";
    ctx.fillRect(8, 5, 16, 6);
    ctx.fillRect(7, 8, 3, 7);
    ctx.fillRect(22, 8, 3, 7);
    // Eyes
    ctx.fillStyle = "#1b1b1b";
    ctx.fillRect(12, 13, 2, 3);
    ctx.fillRect(18, 13, 2, 3);

    const tex = makeCrispCanvasTexture(cv);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.DoubleSide,
      roughness: 0.8,
    });
    const geo = new THREE.PlaneGeometry(1.1, 1.65);
    geo.translate(0, 0.825, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "WalkActorSprite";
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    this.actorGroup.add(mesh);

    // Foot contact shadow decal
    const footShadowGeo = new THREE.PlaneGeometry(1.1, 1.1);
    footShadowGeo.rotateX(-Math.PI / 2);
    const footShadow = new THREE.Mesh(footShadowGeo, this.contactShadowMat);
    footShadow.position.y = 0.012;
    footShadow.name = "ActorFootShadow";
    this.actorGroup.add(footShadow);

    // Foot beacon ring
    const ringGeo = new THREE.RingGeometry(0.32, 0.48, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.035;
    this.actorGroup.add(ring);
  }

  private clearWorldResources(): void {
    this.worldRoot.clear();
    this.gridGroup.clear();
    this.verticalPickables = [];
    this.groundPickables = [];
    this.billboardMeshes = [];
    for (const t of this.disposableTextures) t.dispose();
    for (const g of this.disposableGeometries) g.dispose();
    for (const m of this.disposableMaterials) m.dispose();
    this.disposableTextures = [];
    this.disposableGeometries = [];
    this.disposableMaterials = [];
  }

  private trackTex(t: THREE.Texture): THREE.Texture {
    this.disposableTextures.push(t);
    return t;
  }
  private trackGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.disposableGeometries.push(g);
    return g;
  }
  private trackMat<T extends THREE.Material>(m: T): T {
    this.disposableMaterials.push(m);
    return m;
  }

  elevationAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) return 0;
    return this.elevationGrid[ty * this.mapW + tx] ?? 0;
  }

  isBlockedAt(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) return true;
    return this.blockedGrid[ty * this.mapW + tx] !== 0;
  }

  findNearestWalkableTile(startX: number, startZ: number): [number, number] {
    const sx = Math.max(0, Math.min(this.mapW - 1, Math.floor(startX)));
    const sz = Math.max(0, Math.min(this.mapH - 1, Math.floor(startZ)));
    if (!this.isBlockedAt(sx, sz)) return [sx, sz];
    for (let rad = 1; rad < Math.max(this.mapW, this.mapH); rad++) {
      for (let dz = -rad; dz <= rad; dz++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const nx = sx + dx, nz = sz + dz;
          if (!this.isBlockedAt(nx, nz)) return [nx, nz];
        }
      }
    }
    return [sx, sz];
  }

  /** Build a complete procedural 3D cottage with foundation, timber walls, pitched gable roof, and chimney. */
  private buildProceduralHouse(
    o: LiteObject,
    _map: LiteTileMap,
    pack: PackRuntime | null,
    bindings: Bindings | null,
    opts: Hd2dRenderOptions,
  ): THREE.Group {
    const [rx, ry, rw, rh] = o.rect;
    const baseElev = this.elevationAt(rx + Math.floor(rw / 2), ry + Math.floor(rh / 2));
    const group = new THREE.Group();
    group.position.set(rx + rw / 2, baseElev, ry + rh / 2);

    const b = pack && bindings && opts.renderMode !== "blueprint" ? bindings.get(o.id) : undefined;
    const hb = b && b.kind === "house" ? b : null;
    const rgb = colorForRole(roleOf(o));
    const s = pack ? pack.tileResolution : 16;
    const { facadeCanvas } = renderHouseTextures(
      o.rect,
      o.house ?? { wallHeight: 2, overlap: 1, wall: "", roof: "", decorations: [] },
      hb?.wall ?? null,
      hb?.roof ?? null,
      hb?.deco ?? [],
      pack?.atlas ?? null,
      s,
      rgb,
    );
    const facadeTex = this.trackTex(makeCrispCanvasTexture(facadeCanvas));

    // 1. Foundation Plinth
    const plinthH = 0.22;
    const plinthGeo = this.trackGeo(new THREE.BoxGeometry(rw + 0.16, plinthH, rh + 0.16));
    const plinthMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x544e45, roughness: 0.95 }));
    const plinthMesh = new THREE.Mesh(plinthGeo, plinthMat);
    plinthMesh.position.y = plinthH / 2;
    plinthMesh.castShadow = true;
    plinthMesh.receiveShadow = true;
    plinthMesh.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(plinthMesh);
    group.add(plinthMesh);

    // 2. Timber Wall Body
    const wallH = Math.max(1.8, Math.min(2.8, (rh - 0.5) * 0.85));
    const frontMat = this.trackMat(new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 0.9 }));
    const sideMat = this.trackMat(new THREE.MeshStandardMaterial({ map: this.timberWallTex, roughness: 0.92 }));
    const bodyGeo = this.trackGeo(new THREE.BoxGeometry(rw, wallH, rh));
    // BoxGeometry material array: [+X, -X, +Y, -Y, +Z (Front), -Z (Back)]
    const bodyMesh = new THREE.Mesh(bodyGeo, [sideMat, sideMat, sideMat, sideMat, frontMat, sideMat]);
    bodyMesh.position.y = plinthH + wallH / 2;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    bodyMesh.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(bodyMesh);
    group.add(bodyMesh);

    // 4 Corner Timber Studs
    const studMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x482d18, roughness: 0.9 }));
    const studGeo = this.trackGeo(new THREE.BoxGeometry(0.18, wallH + 0.04, 0.18));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const stud = new THREE.Mesh(studGeo, studMat);
        stud.position.set(sx * (rw / 2), plinthH + wallH / 2, sz * (rh / 2));
        stud.castShadow = true;
        stud.receiveShadow = true;
        stud.userData = { objectId: o.id, tile: [rx, ry] };
        this.verticalPickables.push(stud);
        group.add(stud);
      }
    }

    // 3. Pitched Gable Roof (Triangular slope roof facing +Z / -Z, gables on East/West)
    // Always use procedural terracotta shingle texture for authentic HD-2D look without black culling
    const roofPeakH = Math.max(1.3, rh * 0.55);
    const eaves = 0.28;
    const roofW = rw + eaves * 2;
    const roofD = rh + eaves * 2;
    const halfD = roofD / 2;
    const slopeLen = Math.hypot(halfD, roofPeakH) + 0.08;
    const pitchAngle = Math.atan2(roofPeakH, halfD);
    const roofMat = this.trackMat(new THREE.MeshStandardMaterial({ map: this.roofTex, roughness: 0.85, metalness: 0.05 }));

    // South slope
    const slopeGeo = this.trackGeo(new THREE.BoxGeometry(roofW, 0.09, slopeLen));
    const southSlope = new THREE.Mesh(slopeGeo, roofMat);
    southSlope.position.set(0, plinthH + wallH + roofPeakH / 2, halfD / 2);
    southSlope.rotation.x = -pitchAngle;
    southSlope.castShadow = true;
    southSlope.receiveShadow = true;
    southSlope.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(southSlope);
    group.add(southSlope);

    // North slope
    const northSlope = new THREE.Mesh(slopeGeo, roofMat);
    northSlope.position.set(0, plinthH + wallH + roofPeakH / 2, -halfD / 2);
    northSlope.rotation.x = pitchAngle;
    northSlope.castShadow = true;
    northSlope.receiveShadow = true;
    northSlope.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(northSlope);
    group.add(northSlope);

    // Ridge Beam
    const ridgeGeo = this.trackGeo(new THREE.BoxGeometry(roofW + 0.08, 0.15, 0.15));
    const ridgeBeam = new THREE.Mesh(ridgeGeo, studMat);
    ridgeBeam.position.set(0, plinthH + wallH + roofPeakH + 0.03, 0);
    ridgeBeam.castShadow = true;
    ridgeBeam.receiveShadow = true;
    ridgeBeam.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(ridgeBeam);
    group.add(ridgeBeam);

    // Gable triangular end walls on East (+X) and West (-X) with DoubleSide to prevent hollow view
    const gableMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        map: this.timberWallTex,
        roughness: 0.92,
        side: THREE.DoubleSide,
      }),
    );
    const buildGableGeo = (xSign: number): THREE.BufferGeometry => {
      const gx = xSign * (rw / 2);
      const by = plinthH + wallH;
      const ty = plinthH + wallH + roofPeakH;
      const hz = (rh + eaves * 1.5) / 2;
      const pos = xSign > 0
        ? [gx, by, -hz, gx, ty, 0, gx, by, hz]
        : [gx, by, hz, gx, ty, 0, gx, by, -hz];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      return this.trackGeo(geo);
    };
    const eastGable = new THREE.Mesh(buildGableGeo(1), gableMat);
    eastGable.castShadow = true;
    eastGable.receiveShadow = true;
    eastGable.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(eastGable);
    group.add(eastGable);

    const westGable = new THREE.Mesh(buildGableGeo(-1), gableMat);
    westGable.castShadow = true;
    westGable.receiveShadow = true;
    westGable.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(westGable);
    group.add(westGable);

    // 4. 3D Chimney (if house has chimney decoration or default)
    const hasChimney = o.house?.decorations?.some((d) => d.kind === "chimney") ?? true;
    if (hasChimney) {
      const chimGeo = this.trackGeo(new THREE.BoxGeometry(0.52, roofPeakH + 0.8, 0.52));
      const chimMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x7c382b, roughness: 0.9 }));
      const chimMesh = new THREE.Mesh(chimGeo, chimMat);
      chimMesh.position.set(-rw * 0.32, plinthH + wallH + roofPeakH * 0.5 + 0.25, -rh * 0.22);
      chimMesh.castShadow = true;
      chimMesh.receiveShadow = true;
      chimMesh.userData = { objectId: o.id, tile: [rx, ry] };
      this.verticalPickables.push(chimMesh);
      group.add(chimMesh);

      const rimGeo = this.trackGeo(new THREE.BoxGeometry(0.64, 0.12, 0.64));
      const rimMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x4f2219, roughness: 0.9 }));
      const rimMesh = new THREE.Mesh(rimGeo, rimMat);
      rimMesh.position.set(-rw * 0.32, plinthH + wallH + roofPeakH + 0.68, -rh * 0.22);
      rimMesh.castShadow = true;
      rimMesh.receiveShadow = true;
      rimMesh.userData = { objectId: o.id, tile: [rx, ry] };
      this.verticalPickables.push(rimMesh);
      group.add(rimMesh);
    }

    // 5. Entrance Step
    const stepGeo = this.trackGeo(new THREE.BoxGeometry(1.2, 0.12, 0.36));
    const stepMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x5b5349, roughness: 0.9 }));
    const stepMesh = new THREE.Mesh(stepGeo, stepMat);
    stepMesh.position.set(0, 0.06, rh / 2 + 0.18);
    stepMesh.castShadow = true;
    stepMesh.receiveShadow = true;
    stepMesh.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(stepMesh);
    group.add(stepMesh);

    // 6. Ground Contact Shadow Decal
    const shadowGeo = this.trackGeo(new THREE.PlaneGeometry(rw + 1.2, rh + 1.2));
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMesh = new THREE.Mesh(shadowGeo, this.contactShadowMat);
    shadowMesh.position.set(0, 0.012, 0);
    group.add(shadowMesh);

    return group;
  }

  /** Build a procedural 3D stone well with circular masonry, water surface, support posts, and canopy. */
  private buildProceduralWell(o: LiteObject, elev: number): THREE.Group {
    const [rx, ry, rw, rh] = o.rect;
    const group = new THREE.Group();
    group.position.set(rx + rw / 2, elev, ry + rh / 2);

    // Stone well curb
    const curbGeo = this.trackGeo(new THREE.CylinderGeometry(0.72, 0.78, 0.65, 12));
    const curbMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x5b5449, roughness: 0.95 }));
    const curb = new THREE.Mesh(curbGeo, curbMat);
    curb.position.y = 0.325;
    curb.castShadow = true;
    curb.receiveShadow = true;
    curb.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(curb);
    group.add(curb);

    // Water surface inside well
    const waterGeo = this.trackGeo(new THREE.CylinderGeometry(0.58, 0.58, 0.04, 12));
    const waterMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x225d7c, roughness: 0.15, metalness: 0.2 }));
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = 0.42;
    group.add(water);

    // 2 Wooden side posts
    const postMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x482d18, roughness: 0.9 }));
    const postGeo = this.trackGeo(new THREE.BoxGeometry(0.12, 1.35, 0.12));
    for (const sx of [-0.62, 0.62]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(sx, 0.675, 0);
      post.castShadow = true;
      post.receiveShadow = true;
      post.userData = { objectId: o.id, tile: [rx, ry] };
      this.verticalPickables.push(post);
      group.add(post);
    }

    // Cross beam
    const beamGeo = this.trackGeo(new THREE.BoxGeometry(1.4, 0.1, 0.1));
    const beam = new THREE.Mesh(beamGeo, postMat);
    beam.position.set(0, 1.32, 0);
    beam.castShadow = true;
    beam.receiveShadow = true;
    group.add(beam);

    // Miniature pitched roof canopy
    const canopyMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x7a4332, roughness: 0.85 }));
    const canopySlopeGeo = this.trackGeo(new THREE.BoxGeometry(1.45, 0.06, 0.65));
    const southCanopy = new THREE.Mesh(canopySlopeGeo, canopyMat);
    southCanopy.position.set(0, 1.48, 0.25);
    southCanopy.rotation.x = -0.55;
    southCanopy.castShadow = true;
    southCanopy.receiveShadow = true;
    group.add(southCanopy);

    const northCanopy = new THREE.Mesh(canopySlopeGeo, canopyMat);
    northCanopy.position.set(0, 1.48, -0.25);
    northCanopy.rotation.x = 0.55;
    northCanopy.castShadow = true;
    northCanopy.receiveShadow = true;
    group.add(northCanopy);

    // Soft contact shadow
    const shadowGeo = this.trackGeo(new THREE.PlaneGeometry(1.8, 1.8));
    shadowGeo.rotateX(-Math.PI / 2);
    const shadow = new THREE.Mesh(shadowGeo, this.contactShadowMat);
    shadow.position.y = 0.012;
    group.add(shadow);

    return group;
  }

  /** Build a stylized procedural 3D tree with faceted dodecahedron foliage and trunk. */
  private buildProceduralTree(wx: number, wy: number, elev: number, id: number, radius = 0.9): THREE.Group {
    const group = new THREE.Group();
    group.position.set(wx, elev, wy);

    // Trunk
    const trunkMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x543820, roughness: 0.95 }));
    const trunkGeo = this.trackGeo(new THREE.CylinderGeometry(0.16, 0.22, 1.2, 8));
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.6;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    trunk.userData = { objectId: id, tile: [Math.floor(wx), Math.floor(wy)] };
    this.verticalPickables.push(trunk);
    group.add(trunk);

    // Lower foliage cluster
    const folMat1 = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x3d7b42, roughness: 0.85, flatShading: true }));
    const folGeo1 = this.trackGeo(new THREE.DodecahedronGeometry(radius * 0.9, 0));
    const fol1 = new THREE.Mesh(folGeo1, folMat1);
    fol1.position.set(0, 1.4, 0);
    fol1.castShadow = true;
    fol1.receiveShadow = true;
    fol1.userData = { objectId: id, tile: [Math.floor(wx), Math.floor(wy)] };
    this.verticalPickables.push(fol1);
    group.add(fol1);

    // Upper foliage cluster
    const folMat2 = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x52994c, roughness: 0.82, flatShading: true }));
    const folGeo2 = this.trackGeo(new THREE.DodecahedronGeometry(radius * 0.68, 0));
    const fol2 = new THREE.Mesh(folGeo2, folMat2);
    fol2.position.set(0, 2.05, 0);
    fol2.castShadow = true;
    fol2.receiveShadow = true;
    fol2.userData = { objectId: id, tile: [Math.floor(wx), Math.floor(wy)] };
    this.verticalPickables.push(fol2);
    group.add(fol2);

    // Ground contact shadow
    const shadowGeo = this.trackGeo(new THREE.PlaneGeometry(radius * 1.8, radius * 1.8));
    shadowGeo.rotateX(-Math.PI / 2);
    const shadow = new THREE.Mesh(shadowGeo, this.contactShadowMat);
    shadow.position.y = 0.014;
    group.add(shadow);

    return group;
  }

  /** Build a procedural 3D street lantern. */
  private buildProceduralLantern(o: LiteObject, elev: number): THREE.Group {
    const [rx, ry, rw, rh] = o.rect;
    const group = new THREE.Group();
    group.position.set(rx + rw / 2, elev, ry + rh / 2);

    const metalMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x34373d, roughness: 0.7, metalness: 0.3 }));
    // Base & Post
    const postGeo = this.trackGeo(new THREE.CylinderGeometry(0.06, 0.1, 1.4, 8));
    const post = new THREE.Mesh(postGeo, metalMat);
    post.position.y = 0.7;
    post.castShadow = true;
    post.receiveShadow = true;
    post.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(post);
    group.add(post);

    // Glowing lantern box
    const lanternGeo = this.trackGeo(new THREE.BoxGeometry(0.3, 0.36, 0.3));
    const glassMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xfef08a,
        emissive: 0xfef08a,
        emissiveIntensity: 0.85,
        roughness: 0.3,
      }),
    );
    const lantern = new THREE.Mesh(lanternGeo, glassMat);
    lantern.position.y = 1.48;
    lantern.castShadow = true;
    lantern.receiveShadow = true;
    lantern.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(lantern);
    group.add(lantern);

    // Lantern cap
    const capGeo = this.trackGeo(new THREE.ConeGeometry(0.24, 0.16, 4));
    const cap = new THREE.Mesh(capGeo, metalMat);
    cap.position.y = 1.74;
    cap.rotation.y = Math.PI / 4;
    cap.castShadow = true;
    group.add(cap);

    // Contact shadow
    const shadowGeo = this.trackGeo(new THREE.PlaneGeometry(0.7, 0.7));
    shadowGeo.rotateX(-Math.PI / 2);
    const shadow = new THREE.Mesh(shadowGeo, this.contactShadowMat);
    shadow.position.y = 0.012;
    group.add(shadow);

    return group;
  }

  /** Build a procedural 3D wooden barrel. */
  private buildProceduralBarrel(o: LiteObject, elev: number): THREE.Group {
    const [rx, ry, rw, rh] = o.rect;
    const group = new THREE.Group();
    group.position.set(rx + rw / 2, elev, ry + rh / 2);

    const woodMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x6e4a2c, roughness: 0.9 }));
    const barrelGeo = this.trackGeo(new THREE.CylinderGeometry(0.34, 0.32, 0.75, 10));
    const barrel = new THREE.Mesh(barrelGeo, woodMat);
    barrel.position.y = 0.375;
    barrel.castShadow = true;
    barrel.receiveShadow = true;
    barrel.userData = { objectId: o.id, tile: [rx, ry] };
    this.verticalPickables.push(barrel);
    group.add(barrel);

    // Iron hoops
    const ironMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x36383b, roughness: 0.6, metalness: 0.4 }));
    const hoopGeo = this.trackGeo(new THREE.CylinderGeometry(0.35, 0.35, 0.05, 10));
    for (const hy of [0.18, 0.57]) {
      const hoop = new THREE.Mesh(hoopGeo, ironMat);
      hoop.position.y = hy;
      group.add(hoop);
    }

    // Contact shadow
    const shadowGeo = this.trackGeo(new THREE.PlaneGeometry(0.9, 0.9));
    shadowGeo.rotateX(-Math.PI / 2);
    const shadow = new THREE.Mesh(shadowGeo, this.contactShadowMat);
    shadow.position.y = 0.012;
    group.add(shadow);

    return group;
  }

  /** Build a procedural 3D wooden fence. */
  private buildProceduralFence(o: LiteObject, elev: number): THREE.Group {
    const [rx, ry, rw, rh] = o.rect;
    const group = new THREE.Group();
    group.position.set(rx, elev, ry);

    const woodMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x7a5639, roughness: 0.9 }));
    const postGeo = this.trackGeo(new THREE.BoxGeometry(0.14, 0.85, 0.14));
    const isHorizontal = rw >= rh;

    if (isHorizontal) {
      // Posts at ends and intervals
      const numPosts = Math.max(2, rw + 1);
      for (let i = 0; i < numPosts; i++) {
        const px = (i / (numPosts - 1)) * rw;
        const post = new THREE.Mesh(postGeo, woodMat);
        post.position.set(px, 0.425, rh / 2);
        post.castShadow = true;
        post.receiveShadow = true;
        post.userData = { objectId: o.id, tile: [rx, ry] };
        this.verticalPickables.push(post);
        group.add(post);
      }
      // 2 horizontal rails
      const railGeo = this.trackGeo(new THREE.BoxGeometry(rw, 0.08, 0.06));
      for (const ryPos of [0.3, 0.62]) {
        const rail = new THREE.Mesh(railGeo, woodMat);
        rail.position.set(rw / 2, ryPos, rh / 2);
        rail.castShadow = true;
        rail.receiveShadow = true;
        group.add(rail);
      }
    } else {
      const numPosts = Math.max(2, rh + 1);
      for (let i = 0; i < numPosts; i++) {
        const pz = (i / (numPosts - 1)) * rh;
        const post = new THREE.Mesh(postGeo, woodMat);
        post.position.set(rw / 2, 0.425, pz);
        post.castShadow = true;
        post.receiveShadow = true;
        post.userData = { objectId: o.id, tile: [rx, ry] };
        this.verticalPickables.push(post);
        group.add(post);
      }
      const railGeo = this.trackGeo(new THREE.BoxGeometry(0.06, 0.08, rh));
      for (const ryPos of [0.3, 0.62]) {
        const rail = new THREE.Mesh(railGeo, woodMat);
        rail.position.set(rw / 2, ryPos, rh / 2);
        rail.castShadow = true;
        rail.receiveShadow = true;
        group.add(rail);
      }
    }

    return group;
  }

  /** Rebuild the 3D multi-image stacked scene from `LiteTileMap`. */
  rebuild(
    map: LiteTileMap,
    pack: PackRuntime | null,
    bindings: Bindings | null,
    opts: Hd2dRenderOptions,
  ): void {
    this.clearWorldResources();
    this.mapW = map.width;
    this.mapH = map.height;
    const totalCells = map.width * map.height;
    this.elevationGrid = new Float32Array(totalCells);
    this.blockedGrid = new Uint8Array(totalCells);
    const hasBridgeGrid = new Uint8Array(totalCells);
    const hasStairGrid = new Uint8Array(totalCells);
    const waterGrid = new Uint8Array(totalCells);
    const cliffLevels = new Uint8Array(totalCells);

    // Adjust sun shadow camera to cover the entire tilemap cleanly
    const cx = map.width / 2;
    const cz = map.height / 2;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + 24, 72, cz + 48);
    const maxDim = Math.max(map.width, map.height);
    const shadowBound = Math.max(28, maxDim * 0.85);
    this.sun.shadow.camera.left = -shadowBound;
    this.sun.shadow.camera.right = shadowBound;
    this.sun.shadow.camera.top = shadowBound;
    this.sun.shadow.camera.bottom = -shadowBound;
    this.sun.shadow.camera.updateProjectionMatrix();

    // 1. Analyze elevation, water, bridges, and ramps from the 7-category tree
    for (const layer of map.layers) {
      if (!layer.enabled) continue;
      for (const o of layer.objects) {
        if (!o.enabled) continue;
        const role = roleOf(o);
        const isCliff = role === "terrain/cliff" || role.startsWith("terrain_elevation/");
        const isWater = role === "terrain/water" || role === "terrain_decoration/path/river";
        const isBridge = role.startsWith("terrain_decoration/path/bridge");
        const isTraversal = role.startsWith("terrain_decoration/traversal/");

        if (isCliff) {
          if (o.terrain) {
            const t = o.terrain;
            for (let r = 0; r < t.h; r++) {
              for (let c = 0; c < t.w; c++) {
                if (t.data[r * t.w + c] < 0) continue;
                const wx = t.ox + c, wy = t.oy + r;
                if (wx >= 0 && wy >= 0 && wx < map.width && wy < map.height) {
                  cliffLevels[wy * map.width + wx] += 1;
                }
              }
            }
          } else {
            const [rx, ry, rw, rh] = o.rect;
            for (let y = Math.max(0, ry); y < Math.min(map.height, ry + rh); y++) {
              for (let x = Math.max(0, rx); x < Math.min(map.width, rx + rw); x++) {
                cliffLevels[y * map.width + x] += 1;
              }
            }
          }
        } else if (isWater) {
          if (o.terrain) {
            const t = o.terrain;
            for (let r = 0; r < t.h; r++) {
              for (let c = 0; c < t.w; c++) {
                if (t.data[r * t.w + c] < 0) continue;
                const wx = t.ox + c, wy = t.oy + r;
                if (wx >= 0 && wy >= 0 && wx < map.width && wy < map.height) {
                  waterGrid[wy * map.width + wx] = 1;
                }
              }
            }
          } else {
            const [rx, ry, rw, rh] = o.rect;
            for (let y = Math.max(0, ry); y < Math.min(map.height, ry + rh); y++) {
              for (let x = Math.max(0, rx); x < Math.min(map.width, rx + rw); x++) {
                waterGrid[y * map.width + x] = 1;
              }
            }
          }
        } else if (isBridge) {
          const [rx, ry, rw, rh] = o.rect;
          for (let y = Math.max(0, ry); y < Math.min(map.height, ry + rh); y++) {
            for (let x = Math.max(0, rx); x < Math.min(map.width, rx + rw); x++) {
              hasBridgeGrid[y * map.width + x] = 1;
            }
          }
        } else if (isTraversal) {
          const [rx, ry, rw, rh] = o.rect;
          for (let y = Math.max(0, ry); y < Math.min(map.height, ry + rh); y++) {
            for (let x = Math.max(0, rx); x < Math.min(map.width, rx + rw); x++) {
              hasStairGrid[y * map.width + x] = 1;
            }
          }
        }
      }
    }

    // Prioritize stair cells over cliff so stair entrance is clean and walkable
    for (let i = 0; i < totalCells; i++) {
      if (hasStairGrid[i]) {
        this.elevationGrid[i] = 0.6; // intermediate stair level connecting 0.0 and 1.2
        this.blockedGrid[i] = 0;
      } else if (cliffLevels[i] > 0) {
        this.elevationGrid[i] = cliffLevels[i] * 1.2;
      } else if (hasBridgeGrid[i]) {
        this.elevationGrid[i] = 0.12;
      } else if (waterGrid[i]) {
        this.elevationGrid[i] = -0.35;
        this.blockedGrid[i] = 1;
      } else {
        this.elevationGrid[i] = 0.0;
      }
    }

    const s = pack ? pack.tileResolution : 16;
    const baseStepY = 0.014 * Math.max(1, opts.stackExplode);

    // 2. Distant Ocean Backdrop (eliminates the black void)
    const oceanGeo = this.trackGeo(new THREE.PlaneGeometry(1600, 1600));
    oceanGeo.rotateX(-Math.PI / 2);
    const oceanMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x287c98,
        roughness: 0.55,
        metalness: 0.1,
      }),
    );
    const oceanMesh = new THREE.Mesh(oceanGeo, oceanMat);
    oceanMesh.position.set(cx, -0.42, cz);
    oceanMesh.receiveShadow = true;
    this.worldRoot.add(oceanMesh);

    // Base Board / Kraft Underlay under editable tilemap
    const baseGeo = this.trackGeo(new THREE.BoxGeometry(map.width, 0.35, map.height));
    const baseMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x3b352c, roughness: 0.95 }));
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.set(cx, -0.25, cz);
    baseMesh.receiveShadow = true;
    this.worldRoot.add(baseMesh);

    // 3. Sunken Water Meshes
    const waterGeo = this.trackGeo(new THREE.PlaneGeometry(1, 1));
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x287ea3,
        roughness: 0.16,
        metalness: 0.15,
        transparent: true,
        opacity: 0.85,
      }),
    );
    const waterBedMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x34463c, roughness: 0.95 }));

    for (let r = 0; r < map.height; r++) {
      for (let c = 0; c < map.width; c++) {
        const idx = r * map.width + c;
        if (waterGrid[idx]) {
          // Riverbed plane
          const bed = new THREE.Mesh(waterGeo, waterBedMat);
          bed.position.set(c + 0.5, -0.38, r + 0.5);
          bed.receiveShadow = true;
          this.worldRoot.add(bed);

          // Water surface plane
          const surf = new THREE.Mesh(waterGeo, waterMat);
          surf.position.set(c + 0.5, -0.30, r + 0.5);
          surf.receiveShadow = true;
          surf.userData = { isWaterSurface: true, tile: [c, r] };
          this.groundPickables.push(surf);
          this.worldRoot.add(surf);
        }
      }
    }

    // 4. Procedural 3D Cliff Rock Walls & Canal Riverbank Walls (Stepped elevation heightfield)
    const cliffWallPositions: number[] = [];
    const cliffWallNormals: number[] = [];
    const cliffWallUvs: number[] = [];

    const addWallQuad = (
      nx: number, ny: number, nz: number,
      x0: number, y0: number, z0: number,
      x1: number, y1: number, z1: number,
      x2: number, y2: number, z2: number,
      x3: number, y3: number, z3: number,
      u0: number, u1: number,
    ) => {
      // In Three.js with default flipY=true:
      // V = 1 maps to canvas top (green grass overhang lip);
      // V = 0 maps to canvas bottom (dark rock strata base).
      // Points at y0, y3 are at low elevation (V = 0);
      // Points at y1, y2 are at top elevation (V = 1).
      // Triangle 1: (0, 1, 2)
      cliffWallPositions.push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
      cliffWallNormals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      cliffWallUvs.push(u0, 0, u0, 1, u1, 1);

      // Triangle 2: (0, 2, 3)
      cliffWallPositions.push(x0, y0, z0, x2, y2, z2, x3, y3, z3);
      cliffWallNormals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      cliffWallUvs.push(u0, 0, u1, 1, u1, 0);
    };

    for (let r = 0; r < map.height; r++) {
      for (let c = 0; c < map.width; c++) {
        const y = this.elevationAt(c, r);
        const isCurStair = hasStairGrid[r * map.width + c] === 1;

        // North wall (facing -Z)
        const lowN = r > 0 ? this.elevationAt(c, r - 1) : 0;
        const isNeighborStairN = r > 0 && hasStairGrid[(r - 1) * map.width + c] === 1;
        if (lowN < y - 0.05 && !(isCurStair && lowN >= 0) && !(isNeighborStairN && y <= 0.65)) {
          addWallQuad(0, 0, -1, c + 1, lowN, r, c + 1, y, r, c, y, r, c, lowN, r, c, c + 1);
        }

        // South wall (facing +Z)
        const lowS = r < map.height - 1 ? this.elevationAt(c, r + 1) : 0;
        const isNeighborStairS = r < map.height - 1 && hasStairGrid[(r + 1) * map.width + c] === 1;
        if (lowS < y - 0.05 && !(isCurStair && lowS >= 0) && !(isNeighborStairS && y <= 0.65)) {
          addWallQuad(0, 0, 1, c, lowS, r + 1, c, y, r + 1, c + 1, y, r + 1, c + 1, lowS, r + 1, c, c + 1);
        }

        // West wall (facing -X)
        const lowW = c > 0 ? this.elevationAt(c - 1, r) : 0;
        const isNeighborStairW = c > 0 && hasStairGrid[r * map.width + (c - 1)] === 1;
        if (lowW < y - 0.05 && !(isCurStair && lowW >= 0) && !(isNeighborStairW && y <= 0.65)) {
          addWallQuad(-1, 0, 0, c, lowW, r, c, y, r, c, y, r + 1, c, lowW, r + 1, r, r + 1);
        }

        // East wall (facing +X)
        const lowE = c < map.width - 1 ? this.elevationAt(c + 1, r) : 0;
        const isNeighborStairE = c < map.width - 1 && hasStairGrid[r * map.width + (c + 1)] === 1;
        if (lowE < y - 0.05 && !(isCurStair && lowE >= 0) && !(isNeighborStairE && y <= 0.65)) {
          addWallQuad(1, 0, 0, c + 1, lowE, r + 1, c + 1, y, r + 1, c + 1, y, r, c + 1, lowE, r, r, r + 1);
        }
      }
    }

    if (cliffWallPositions.length > 0) {
      const cliffGeo = new THREE.BufferGeometry();
      cliffGeo.setAttribute("position", new THREE.Float32BufferAttribute(cliffWallPositions, 3));
      cliffGeo.setAttribute("normal", new THREE.Float32BufferAttribute(cliffWallNormals, 3));
      cliffGeo.setAttribute("uv", new THREE.Float32BufferAttribute(cliffWallUvs, 2));
      this.trackGeo(cliffGeo);

      const cliffMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          map: this.cliffTex,
          roughness: 0.92,
          metalness: 0.05,
          side: THREE.DoubleSide,
        }),
      );
      const cliffWallMesh = new THREE.Mesh(cliffGeo, cliffMat);
      cliffWallMesh.castShadow = true;
      cliffWallMesh.receiveShadow = true;
      cliffWallMesh.userData = { isCliffWall: true };
      this.verticalPickables.push(cliffWallMesh);
      this.worldRoot.add(cliffWallMesh);
    }

    // 5. Render Ground Stratum Objects as Multi-Image Stacked 3D Layers
    let groundStackIndex = 0;
    for (const layer of map.layers) {
      if (!layer.enabled || layer.vertical) continue;
      for (const o of layer.objects) {
        if (!o.enabled) continue;
        const role = roleOf(o);
        const [rx, ry, rw, rh] = o.rect;
        const isCliff = role === "terrain/cliff" || role.startsWith("terrain_elevation/");
        const isWater = role === "terrain/water" || role === "terrain_decoration/path/river";
        const isBridge = role.startsWith("terrain_decoration/path/bridge");
        const isStair = role.startsWith("terrain_decoration/traversal/");

        // 5A. Procedural 3D Stairs / Ramps
        if (isStair) {
          const stairGroup = new THREE.Group();
          stairGroup.position.set(rx, 0, ry);
          const stepsCount = 5;
          const stepMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x766d62, roughness: 0.9 }));

          // Determine ascending direction by comparing neighbor elevations:
          const midX = rx + Math.floor(rw / 2);
          const midY = ry + Math.floor(rh / 2);
          const eWest = this.elevationAt(rx - 1, midY);
          const eEast = this.elevationAt(rx + rw, midY);
          const eNorth = this.elevationAt(midX, ry - 1);
          const eSouth = this.elevationAt(midX, ry + rh);

          let dir = "east";
          let maxNeighbor = eEast;
          if (eWest > maxNeighbor) { dir = "west"; maxNeighbor = eWest; }
          if (eNorth > maxNeighbor) { dir = "north"; maxNeighbor = eNorth; }
          if (eSouth > maxNeighbor) { dir = "south"; maxNeighbor = eSouth; }

          const targetH = Math.max(1.2, maxNeighbor);

          for (let step = 0; step < stepsCount; step++) {
            const stepElev = ((step + 1) / stepsCount) * targetH;
            let stepGeo: THREE.BoxGeometry;
            let sx = 0, sz = 0;

            if (dir === "east") {
              const stepW = rw / stepsCount;
              stepGeo = this.trackGeo(new THREE.BoxGeometry(stepW, stepElev, rh));
              sx = (step + 0.5) * stepW;
              sz = rh / 2;
            } else if (dir === "west") {
              const stepW = rw / stepsCount;
              stepGeo = this.trackGeo(new THREE.BoxGeometry(stepW, stepElev, rh));
              sx = rw - (step + 0.5) * stepW;
              sz = rh / 2;
            } else if (dir === "north") {
              const stepD = rh / stepsCount;
              stepGeo = this.trackGeo(new THREE.BoxGeometry(rw, stepElev, stepD));
              sx = rw / 2;
              sz = rh - (step + 0.5) * stepD;
            } else {
              const stepD = rh / stepsCount;
              stepGeo = this.trackGeo(new THREE.BoxGeometry(rw, stepElev, stepD));
              sx = rw / 2;
              sz = (step + 0.5) * stepD;
            }

            const stepMesh = new THREE.Mesh(stepGeo, stepMat);
            stepMesh.position.set(sx, stepElev / 2, sz);
            stepMesh.castShadow = true;
            stepMesh.receiveShadow = true;
            stepMesh.userData = { objectId: o.id, tile: [rx, ry] };
            this.verticalPickables.push(stepMesh);
            this.groundPickables.push(stepMesh);
            stairGroup.add(stepMesh);
          }
          this.worldRoot.add(stairGroup);
          continue;
        }

        // 5B. Procedural 3D Bridge
        if (isBridge) {
          const bridgeElev = 0.08;
          const bridgeMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x755238, roughness: 0.88 }));
          const plankGeo = this.trackGeo(new THREE.BoxGeometry(rw, 0.12, rh));
          const plankMesh = new THREE.Mesh(plankGeo, bridgeMat);
          plankMesh.position.set(rx + rw / 2, bridgeElev, ry + rh / 2);
          plankMesh.castShadow = true;
          plankMesh.receiveShadow = true;
          plankMesh.userData = { objectId: o.id, tile: [rx, ry] };
          this.verticalPickables.push(plankMesh);
          this.groundPickables.push(plankMesh);
          this.worldRoot.add(plankMesh);

          // Railings along bridge sides
          const railMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x513520, roughness: 0.9 }));
          const isHorizontal = rw >= rh;
          const railGeo = this.trackGeo(
            isHorizontal ? new THREE.BoxGeometry(rw, 0.35, 0.1) : new THREE.BoxGeometry(0.1, 0.35, rh),
          );
          for (const sgn of [-1, 1]) {
            const rail = new THREE.Mesh(railGeo, railMat);
            if (isHorizontal) {
              rail.position.set(rx + rw / 2, bridgeElev + 0.22, ry + rh / 2 + sgn * (rh / 2 - 0.05));
            } else {
              rail.position.set(rx + rw / 2 + sgn * (rw / 2 - 0.05), bridgeElev + 0.22, ry + rh / 2);
            }
            rail.castShadow = true;
            rail.receiveShadow = true;
            rail.userData = { objectId: o.id, tile: [rx, ry] };
            this.verticalPickables.push(rail);
            this.worldRoot.add(rail);
          }
          continue;
        }

        // 5C. Flat Ground / Road / Paving / Grass Surface Plane
        const cv = renderObjectLocalCanvas(o, s, pack, bindings, opts.renderMode);
        if (!cv) continue;

        const tex = this.trackTex(makeCrispCanvasTexture(cv));
        const avgElev = this.elevationAt(rx + Math.floor(rw / 2), ry + Math.floor(rh / 2));
        const layerY =
          (isWater ? -0.32 : isCliff ? 1.2 : avgElev) + groundStackIndex * baseStepY;
        groundStackIndex++;

        const planeGeo = this.trackGeo(new THREE.PlaneGeometry(rw, rh));
        planeGeo.rotateX(-Math.PI / 2);
        const planeMat = this.trackMat(
          new THREE.MeshStandardMaterial({
            map: tex,
            transparent: true,
            alphaTest: 0.05,
            depthWrite: true,
            roughness: 0.92,
            polygonOffset: true,
            polygonOffsetFactor: -groundStackIndex,
            polygonOffsetUnits: -groundStackIndex,
          }),
        );
        const mesh = new THREE.Mesh(planeGeo, planeMat);
        mesh.position.set(rx + rw / 2, layerY, ry + rh / 2);
        mesh.receiveShadow = true;
        mesh.userData = { objectId: o.id, isGroundPlane: true, tile: [rx, ry] };
        this.groundPickables.push(mesh);
        this.worldRoot.add(mesh);
      }
    }

    // 6. Render Vertical Stratum Objects (3D Houses + Upright Multi-Sprite Cards)
    const tileVerticalCount = new Map<string, number>();
    const nextVerticalSlot = (tx: number, ty: number): number => {
      const k = `${tx},${ty}`;
      const cur = tileVerticalCount.get(k) ?? 0;
      tileVerticalCount.set(k, cur + 1);
      return cur;
    };

    const spriteCache = new Map<string, THREE.Texture>();
    const getPaletteTex = (p: Palette): THREE.Texture => {
      const cached = spriteCache.get(p.hash);
      if (cached) return cached;
      if (!pack) throw new Error("No pack");
      const tex = this.trackTex(makeCrispCanvasTexture(renderPaletteSpriteCanvas(pack.atlas, p, s)));
      spriteCache.set(p.hash, tex);
      return tex;
    };

    for (const layer of map.layers) {
      if (!layer.enabled || !layer.vertical) continue;
      for (const o of layer.objects) {
        if (!o.enabled) continue;
        const role = roleOf(o);
        const rgb = colorForRole(role);
        const b = pack && bindings && opts.renderMode !== "blueprint" ? bindings.get(o.id) : undefined;

        if (o.type === "HOUSE" || o.type === "FIXED_RECT") {
          const [rx, ry, rw, rh] = o.rect;
          for (let y = Math.max(0, ry); y < Math.min(map.height, ry + rh); y++) {
            for (let x = Math.max(0, rx); x < Math.min(map.width, rx + rw); x++) {
              this.blockedGrid[y * map.width + x] = 1;
            }
          }
        } else if (
          o.terrain &&
          (role.startsWith("boundary/") || role.startsWith("nature_prop/tree") || role.startsWith("nature_prop/rock"))
        ) {
          const t = o.terrain;
          for (let r = 0; r < t.h; r++) {
            for (let c = 0; c < t.w; c++) {
              if (t.data[r * t.w + c] < 0) continue;
              const wx = t.ox + c, wy = t.oy + r;
              if (wx >= 0 && wy >= 0 && wx < map.width && wy < map.height) {
                this.blockedGrid[wy * map.width + wx] = 1;
              }
            }
          }
        }

        // 6A. Procedural 3D Cottage / House (`HOUSE`)
        if (o.type === "HOUSE") {
          const houseGroup = this.buildProceduralHouse(o, map, pack, bindings, opts);
          this.worldRoot.add(houseGroup);
          continue;
        }

        // 6B. Procedural 3D Stone Well
        if (role === "outdoor_prop/facility/well") {
          const [rx, ry, rw, rh] = o.rect;
          const elev = this.elevationAt(rx + Math.floor(rw / 2), ry + Math.floor(rh / 2));
          const wellGroup = this.buildProceduralWell(o, elev);
          this.worldRoot.add(wellGroup);
          continue;
        }

        // 6C. Procedural 3D Lantern
        if (role.startsWith("outdoor_prop/facility/lantern")) {
          const [rx, ry, rw, rh] = o.rect;
          const elev = this.elevationAt(rx + Math.floor(rw / 2), ry + Math.floor(rh / 2));
          const lanternGroup = this.buildProceduralLantern(o, elev);
          this.worldRoot.add(lanternGroup);
          continue;
        }

        // 6D. Procedural 3D Wooden Barrel
        if (role.startsWith("outdoor_prop/furniture/barrel")) {
          const [rx, ry, rw, rh] = o.rect;
          const elev = this.elevationAt(rx + Math.floor(rw / 2), ry + Math.floor(rh / 2));
          const barrelGroup = this.buildProceduralBarrel(o, elev);
          this.worldRoot.add(barrelGroup);
          continue;
        }

        // 6E. Procedural 3D Wooden Fence
        if (role.startsWith("boundary/fence")) {
          const [rx, ry, rw, rh] = o.rect;
          const elev = this.elevationAt(rx + Math.floor(rw / 2), ry + Math.floor(rh / 2));
          const fenceGroup = this.buildProceduralFence(o, elev);
          this.worldRoot.add(fenceGroup);
          continue;
        }

        // 6F. Procedural 3D Trees (rendered in 3D when billboard is off or in blueprint mode)
        if (role.startsWith("nature_prop/tree") && (!opts.billboardSprites || !b || opts.renderMode === "blueprint")) {
          const [rx, ry, rw, rh] = o.rect;
          const elev = this.elevationAt(rx + Math.floor(rw / 2), ry + Math.floor(rh / 2));
          const treeGroup = this.buildProceduralTree(rx + rw / 2, ry + rh / 2, elev, o.id, Math.max(rw, rh) * 0.55);
          this.worldRoot.add(treeGroup);
          continue;
        }

        // 6G. FRG Scatter (Trees, Rocks, Plants, Props)
        if (o.type === "FIXED_RECT_GROUP" && o.terrain) {
          const t = o.terrain;
          for (let r = 0; r < t.h; r++) {
            for (let c = 0; c < t.w; c++) {
              if (t.data[r * t.w + c] < 0) continue;
              const wx = t.ox + c;
              const wy = t.oy + r;
              const slotIdx = nextVerticalSlot(wx, wy);
              const elev = this.elevationAt(wx, wy);

              if (b && b.kind === "frg" && pack) {
                const vi = b.cellVariant[r * t.w + c];
                const v = vi >= 0 ? b.variants[vi] : b.variants[0];
                if (v) {
                  const [pw, ph] = v.size;
                  const tex = getPaletteTex(v);
                  const cardGeo = this.trackGeo(new THREE.PlaneGeometry(pw, ph));
                  cardGeo.translate(0, ph / 2, 0);
                  const cardMat = this.trackMat(
                    new THREE.MeshStandardMaterial({
                      map: tex,
                      transparent: true,
                      alphaTest: 0.1,
                      side: THREE.DoubleSide,
                      roughness: 0.9,
                    }),
                  );
                  const card = new THREE.Mesh(cardGeo, cardMat);
                  card.position.set(
                    wx + 0.5,
                    elev + slotIdx * 0.02,
                    wy + 0.85 + slotIdx * 0.06,
                  );
                  card.castShadow = true;
                  card.receiveShadow = true;
                  card.userData = { objectId: o.id, tile: [wx, wy] };
                  this.verticalPickables.push(card);
                  if (opts.billboardSprites) {
                    this.billboardMeshes.push(card);
                  } else {
                    card.rotation.x = -0.18;
                  }
                  this.worldRoot.add(card);

                  if (role.startsWith("nature_prop/tree") || role.startsWith("nature_prop/rock")) {
                    const shadowGeo = this.trackGeo(new THREE.PlaneGeometry(pw * 0.9, pw * 0.9));
                    shadowGeo.rotateX(-Math.PI / 2);
                    const shadow = new THREE.Mesh(shadowGeo, this.contactShadowMat);
                    shadow.position.set(wx + 0.5, elev + 0.012, wy + 0.75);
                    this.worldRoot.add(shadow);
                  }
                  continue;
                }
              }

              const fallbackGeo = this.trackGeo(new THREE.BoxGeometry(0.7, 1.4, 0.7));
              const fallbackMat = this.trackMat(new THREE.MeshStandardMaterial({ color: rgbaCss(rgb, 1), roughness: 0.9 }));
              const fallbackMesh = new THREE.Mesh(fallbackGeo, fallbackMat);
              fallbackMesh.position.set(wx + 0.5, elev + 0.7, wy + 0.5);
              fallbackMesh.castShadow = true;
              fallbackMesh.receiveShadow = true;
              fallbackMesh.userData = { objectId: o.id, tile: [wx, wy] };
              this.verticalPickables.push(fallbackMesh);
              this.worldRoot.add(fallbackMesh);
            }
          }
          continue;
        }

        // 6H. Vertical Autotile Line (`boundary/fence`, `boundary/wall`)
        if ((o.type === "TERRAIN_2_EDGE" || o.type === "TERRAIN_2_CORNER") && o.terrain) {
          const t = o.terrain;
          const borderConn = o.tags["borderAsConnected"] === "true";
          for (let r = 0; r < t.h; r++) {
            for (let c = 0; c < t.w; c++) {
              if (t.data[r * t.w + c] < 0) continue;
              const wx = t.ox + c;
              const wy = t.oy + r;
              const slotIdx = nextVerticalSlot(wx, wy);
              const elev = this.elevationAt(wx, wy);

              if (b && b.kind === "auto" && pack) {
                const a = autotileCellAtlas(b.palette, t, c, r, borderConn);
                if (a) {
                  const key = `auto:${b.palette.hash}:${a[0]},${a[1]}`;
                  let tex = spriteCache.get(key);
                  if (!tex) {
                    tex = this.trackTex(
                      makeCrispCanvasTexture(renderSingleTileCanvas(pack.atlas, a[0], a[1], b.palette.tileResolution, s)),
                    );
                    spriteCache.set(key, tex);
                  }
                  const cardGeo = this.trackGeo(new THREE.PlaneGeometry(1, 1.05));
                  cardGeo.translate(0, 0.525, 0);
                  const cardMat = this.trackMat(
                    new THREE.MeshStandardMaterial({
                      map: tex,
                      transparent: true,
                      alphaTest: 0.1,
                      side: THREE.DoubleSide,
                      roughness: 0.9,
                    }),
                  );
                  const card = new THREE.Mesh(cardGeo, cardMat);
                  card.position.set(wx + 0.5, elev, wy + 0.65 + slotIdx * 0.05);
                  card.castShadow = true;
                  card.receiveShadow = true;
                  card.userData = { objectId: o.id, tile: [wx, wy] };
                  this.verticalPickables.push(card);
                  this.worldRoot.add(card);
                  continue;
                }
              }

              const postGeo = this.trackGeo(new THREE.BoxGeometry(0.85, 0.75, 0.35));
              const postMat = this.trackMat(new THREE.MeshStandardMaterial({ color: rgbaCss(rgb, 1), roughness: 0.9 }));
              const post = new THREE.Mesh(postGeo, postMat);
              post.position.set(wx + 0.5, elev + 0.375, wy + 0.5);
              post.castShadow = true;
              post.receiveShadow = true;
              post.userData = { objectId: o.id, tile: [wx, wy] };
              this.verticalPickables.push(post);
              this.worldRoot.add(post);
            }
          }
          continue;
        }

        // 6I. Fixed Rect Vertical Object (Lush trees, props, plants, flowers)
        const [rx, ry, rw, rh] = o.rect;
        const elev = this.elevationAt(rx + Math.floor(rw / 2), ry + Math.floor(rh / 2));
        const slotIdx = nextVerticalSlot(rx, ry);
        const cv = renderObjectLocalCanvas(o, s, pack, bindings, opts.renderMode);
        if (cv) {
          const tex = this.trackTex(makeCrispCanvasTexture(cv));
          const isBuildingBlock = role.startsWith("building/");
          if (isBuildingBlock) {
            const boxH = Math.max(1.8, rh * 0.85);
            const sideMat = this.trackMat(new THREE.MeshStandardMaterial({ color: 0x8b7e70, roughness: 0.9 }));
            const frontMat = this.trackMat(
              new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.08, roughness: 0.9 }),
            );
            const boxGeo = this.trackGeo(new THREE.BoxGeometry(rw, boxH, Math.max(1, rh * 0.75)));
            const mesh = new THREE.Mesh(boxGeo, [sideMat, sideMat, frontMat, sideMat, frontMat, sideMat]);
            mesh.position.set(rx + rw / 2, elev + boxH / 2, ry + rh / 2);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.userData = { objectId: o.id, tile: [rx, ry] };
            this.verticalPickables.push(mesh);
            this.worldRoot.add(mesh);
          } else {
            const cardGeo = this.trackGeo(new THREE.PlaneGeometry(rw, rh));
            cardGeo.translate(0, rh / 2, 0);
            const cardMat = this.trackMat(
              new THREE.MeshStandardMaterial({
                map: tex,
                transparent: true,
                alphaTest: 0.1,
                side: THREE.DoubleSide,
                roughness: 0.9,
              }),
            );
            const card = new THREE.Mesh(cardGeo, cardMat);
            const zBias = role.startsWith("building_prop/") ? 0.22 : 0.05;
            card.position.set(rx + rw / 2, elev + slotIdx * 0.02, ry + rh * 0.85 + zBias + slotIdx * 0.05);
            card.castShadow = true;
            card.receiveShadow = true;
            card.userData = { objectId: o.id, tile: [rx, ry] };
            this.verticalPickables.push(card);
            if (opts.billboardSprites && !role.startsWith("building_prop/")) {
              this.billboardMeshes.push(card);
            } else {
              card.rotation.x = -0.15;
            }
            this.worldRoot.add(card);

            // Ground contact shadow decal under trees, props and flowers
            if (
              role.startsWith("nature_prop/") ||
              role.startsWith("outdoor_prop/")
            ) {
              const shadowRadius = Math.max(rw, rh) * 0.85;
              const shadowGeo = this.trackGeo(new THREE.PlaneGeometry(shadowRadius, shadowRadius));
              shadowGeo.rotateX(-Math.PI / 2);
              const shadow = new THREE.Mesh(shadowGeo, this.contactShadowMat);
              shadow.position.set(rx + rw / 2, elev + 0.012, ry + rh / 2);
              this.worldRoot.add(shadow);
            }
          }
        }
      }
    }

    // 7. Optional 3D Grid Overlay (Scene View only)
    if (opts.showGrid) {
      const gridHelper = new THREE.GridHelper(
        Math.max(map.width, map.height),
        Math.max(map.width, map.height),
        0x5a6578,
        0x363e4c,
      );
      gridHelper.position.set(map.width / 2, 0.005, map.height / 2);
      (gridHelper.material as THREE.Material).transparent = true;
      (gridHelper.material as THREE.Material).opacity = 0.28;
      this.gridGroup.add(gridHelper);
    }
  }

  /**
   * 3D Scene View Raycast Picker:
   * 1. Checks 3D vertical meshes (houses, trees, fences, props, cliffs) first;
   * 2. Checks 3D ground surfaces at their actual elevation (plateau 1.2, plain 0.0, bridge 0.08, water -0.32);
   * 3. Falls back to ground plane intersection at y=0.
   */
  pickAtRay(
    raycaster: THREE.Raycaster,
    map: LiteTileMap,
  ): { objectId: number | null; tile: [number, number] | null } {
    // 1. Check 3D vertical objects first
    const hits = raycaster.intersectObjects(this.verticalPickables, false);
    if (hits.length > 0) {
      const topHit = hits[0];
      const objId = topHit.object.userData?.objectId as number | undefined;
      const hitTile = (topHit.object.userData?.tile as [number, number] | undefined) ?? [
        Math.max(0, Math.min(map.width - 1, Math.floor(topHit.point.x))),
        Math.max(0, Math.min(map.height - 1, Math.floor(topHit.point.z))),
      ];
      if (typeof objId === "number") {
        return { objectId: objId, tile: hitTile };
      }
    }

    // 2. Check 3D ground surfaces at their true elevation (high plateau 1.2, plain 0.0, bridge 0.08, water -0.32)
    const groundHits = raycaster.intersectObjects(this.groundPickables, false);
    if (groundHits.length > 0) {
      const topHit = groundHits[0];
      const tx = Math.max(0, Math.min(map.width - 1, Math.floor(topHit.point.x)));
      const ty = Math.max(0, Math.min(map.height - 1, Math.floor(topHit.point.z)));
      const stack = inspectTileStack(map, tx, ty);
      const topItem = stack.length > 0 ? stack[stack.length - 1] : null;
      return {
        objectId: topItem ? topItem.objectId : ((topHit.object.userData?.objectId as number | undefined) ?? null),
        tile: [tx, ty],
      };
    }

    // 3. Fallback to ground plane y=0 if ray missed ground meshes
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, pt)) {
      return { objectId: null, tile: null };
    }
    const tx = Math.floor(pt.x);
    const ty = Math.floor(pt.z);
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) {
      return { objectId: null, tile: null };
    }
    const stack = inspectTileStack(map, tx, ty);
    const topItem = stack.length > 0 ? stack[stack.length - 1] : null;
    return {
      objectId: topItem ? topItem.objectId : null,
      tile: [tx, ty],
    };
  }

  /** Hover tile highlight in Scene View (shows single-tile inspection cursor). */
  updateHoverTile(tx: number | null, ty: number | null): void {
    this.hoverGroup.clear();
    if (tx == null || ty == null || tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) return;
    const elev = this.elevationAt(tx, ty);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(tx + 0.5, elev + 0.06, ty + 0.5);
    this.hoverGroup.add(mesh);
  }

  /** Draw 3D selection highlight bounding boxes around selected objects in Scene View. */
  updateSelectionBoxes(map: LiteTileMap, selected: Set<number>): void {
    this.selectionGroup.clear();
    if (selected.size === 0) return;

    for (const id of selected) {
      const o = findObject(map, id);
      if (!o || !o.enabled) continue;
      const [rx, ry, rw, rh] = o.rect;
      const role = roleOf(o);
      const isVertical =
        o.type === "HOUSE" ||
        role.startsWith("building") ||
        role.startsWith("nature_prop") ||
        role.startsWith("outdoor_prop") ||
        role.startsWith("boundary");
      const boxH = o.type === "HOUSE" ? 3.5 : isVertical ? 1.8 : 0.35;
      const elev = this.elevationAt(rx + Math.floor(rw / 2), ry + Math.floor(rh / 2));

      const boxGeo = new THREE.BoxGeometry(rw + 0.08, boxH, rh + 0.08);
      const edges = new THREE.EdgesGeometry(boxGeo);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false, transparent: true, opacity: 0.95 });
      const wireframe = new THREE.LineSegments(edges, lineMat);
      wireframe.position.set(rx + rw / 2, elev + boxH / 2, ry + rh / 2);
      this.selectionGroup.add(wireframe);

      const baseGeo = new THREE.PlaneGeometry(rw, rh);
      baseGeo.rotateX(-Math.PI / 2);
      const baseMat = new THREE.MeshBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthTest: false,
      });
      const basePlane = new THREE.Mesh(baseGeo, baseMat);
      basePlane.position.set(rx + rw / 2, elev + 0.04, ry + rh / 2);
      this.selectionGroup.add(basePlane);
    }
  }

  /**
   * Sync the shared player actor position and (if `showFrustumGizmo` is true in Scene View)
   * render the Unity-style Game Camera frustum & ground viewport frame around the player.
   */
  syncPlayerAndGameCameraGizmo(player: PlayerState, showFrustumGizmo: boolean, gameZoom = 1): void {
    const footTx = Math.max(0, Math.min(this.mapW - 1, Math.floor(player.x)));
    const footTz = Math.max(0, Math.min(this.mapH - 1, Math.floor(player.z)));
    const elev = this.elevationAt(footTx, footTz);
    const bob = Math.abs(Math.sin(player.walkPhase)) * 0.08;

    this.actorGroup.position.set(player.x, elev + bob, player.z);
    const sprite = this.actorGroup.getObjectByName("WalkActorSprite");
    if (sprite) {
      sprite.scale.x = player.facing;
    }

    this.frustumGroup.clear();
    if (!showFrustumGizmo) return;

    // HD2D Game Camera benchmark: Perspective, pitch -14°, yaw 0°, FOV 30.5°, Near 0.036, Far 700
    // Offset relative to player: x: 0, y: +7.491446, z: +26.035766
    const zoom = Math.max(0.4, gameZoom);
    const camPos = new THREE.Vector3(
      player.x,
      elev + 7.491446 / zoom,
      player.z + 26.035766 / zoom,
    );

    // Ground viewport coverage under pitch -14° and FOV 30.5° (16:9 aspect)
    const centerZ = player.z - 4.0 / zoom;
    const halfW = 12.0 / zoom;
    const halfD = 7.5 / zoom;

    const c0 = new THREE.Vector3(player.x - halfW, elev + 0.08, centerZ - halfD);
    const c1 = new THREE.Vector3(player.x + halfW, elev + 0.08, centerZ - halfD);
    const c2 = new THREE.Vector3(player.x + halfW, elev + 0.08, centerZ + halfD);
    const c3 = new THREE.Vector3(player.x - halfW, elev + 0.08, centerZ + halfD);

    // Ground frame showing Game View's visible region
    const framePts = [c0, c1, c2, c3, c0];
    const frameGeo = new THREE.BufferGeometry().setFromPoints(framePts);
    const frameMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: false, transparent: true, opacity: 0.9 });
    this.frustumGroup.add(new THREE.Line(frameGeo, frameMat));

    // Sightlines from Game Camera eye to ground frame corners
    const rayPts = [camPos, c0, camPos, c1, camPos, c2, camPos, c3];
    const rayGeo = new THREE.BufferGeometry().setFromPoints(rayPts);
    const rayMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.35 });
    this.frustumGroup.add(new THREE.LineSegments(rayGeo, rayMat));

    // Camera box icon at camPos oriented at pitch -14°
    const camBoxGeo = new THREE.BoxGeometry(0.8, 0.55, 1.0);
    const camBoxMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true });
    const camBox = new THREE.Mesh(camBoxGeo, camBoxMat);
    camBox.position.copy(camPos);
    camBox.rotation.order = "YXZ";
    camBox.rotation.x = -14 * (Math.PI / 2);
    this.frustumGroup.add(camBox);
  }

  /** Step player movement by (ix, iz) input direction for dt seconds with collision & height checks. */
  stepPlayerMovement(player: PlayerState, keys: Set<string>, dt: number): PlayerState {
    let ix = 0;
    let iz = 0;
    if (keys.has("w") || keys.has("arrowup")) iz -= 1;
    if (keys.has("s") || keys.has("arrowdown")) iz += 1;
    if (keys.has("a") || keys.has("arrowleft")) ix -= 1;
    if (keys.has("d") || keys.has("arrowright")) ix += 1;

    const len = Math.hypot(ix, iz);
    if (len === 0) {
      if (player.walkPhase === 0) return player;
      return { ...player, walkPhase: 0 };
    }

    const speed = keys.has("shift") ? 11 : 7;
    ix = (ix / len) * speed;
    iz = (iz / len) * speed;
    const facing: 1 | -1 = Math.abs(ix) > 0.01 ? (ix > 0 ? 1 : -1) : player.facing;
    const walkPhase = player.walkPhase + dt * 12;

    const curFootX = Math.max(0, Math.min(this.mapW - 1, Math.floor(player.x)));
    const curFootZ = Math.max(0, Math.min(this.mapH - 1, Math.floor(player.z)));
    const curElev = this.elevationAt(curFootX, curFootZ);

    const canStepTo = (nx: number, nz: number): boolean => {
      const tx = Math.floor(nx);
      const tz = Math.floor(nz);
      if (tx < 0 || tz < 0 || tx >= this.mapW || tz >= this.mapH) return false;
      if (this.isBlockedAt(tx, tz)) return false;
      const targetElev = this.elevationAt(tx, tz);
      // Elevation step threshold: allows stepping between plain (0), stairs (0.6), and mountain (1.2)
      return Math.abs(targetElev - curElev) <= 0.65;
    };

    let x = player.x;
    let z = player.z;
    const nextX = x + ix * dt;
    const nextZ = z + iz * dt;
    if (canStepTo(nextX, z)) x = nextX;
    if (canStepTo(x, nextZ)) z = nextZ;

    const newFootX = Math.max(0, Math.min(this.mapW - 1, Math.floor(x)));
    const newFootZ = Math.max(0, Math.min(this.mapH - 1, Math.floor(z)));
    const y = this.elevationAt(newFootX, newFootZ);

    return { x, y, z, facing, walkPhase };
  }

  orientBillboards(camera: THREE.Camera): void {
    if (this.billboardMeshes.length === 0) return;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const yaw = Math.atan2(-dir.x, -dir.z);
    for (const m of this.billboardMeshes) {
      m.rotation.set(0, yaw, 0);
    }
  }

  dispose(): void {
    this.clearWorldResources();
    this.cliffTex.dispose();
    this.roofTex.dispose();
    this.timberWallTex.dispose();
    this.contactShadowMat.dispose();
  }
}
