import * as THREE from "three";
import { cardHeight, gridPosition, type Surface, type WorldCard, type WorldMap } from "./model";

export type WorldImages = ReadonlyMap<string, CanvasImageSource>;

interface CardBatch {
  mesh: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  cards: WorldCard[];
}

export class WorldCards {
  readonly group = new THREE.Group();
  private readonly batches: CardBatch[] = [];
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly matrix = new THREE.Matrix4();
  private readonly offset = new THREE.Vector3();
  private currentCards = new Map<string, WorldCard>();
  private readonly knownIds = new Set<string>();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private world: WorldMap, private readonly width: number, images: WorldImages) {
    const groups = new Map<string, WorldCard[]>();
    for (const card of world.cards ?? []) {
      if (card.id) this.knownIds.add(card.id);
      const key = JSON.stringify([card.texture, card.region, card.flipH, card.flipV, card.threshold, card.color[3]]);
      const batch = groups.get(key);
      if (batch) batch.push(card);
      else groups.set(key, [card]);
    }
    for (const cards of groups.values()) {
      const first = cards[0];
      const image = images.get(first.texture);
      if (!image) continue;
      const [x, y, width, height] = first.region;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.translate(first.flipH ? width : 0, first.flipV ? height : 0);
      ctx.scale(first.flipH ? -1 : 1, first.flipV ? -1 : 1);
      ctx.drawImage(image, x, y, width, height, 0, 0, width, height);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshBasicMaterial({
        map: texture, side: THREE.DoubleSide, alphaTest: Math.max(0.01, first.threshold), opacity: first.color[3],
      });
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, cards.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Both cameras see the complete set, with a different billboard orientation per view.
      mesh.frustumCulled = false;
      cards.forEach((card, index) => {
        const [r, g, b] = card.color;
        mesh.setColorAt(index, new THREE.Color().setRGB(r, g, b));
      });
      this.batches.push({ mesh, cards });
      this.group.add(mesh);
    }
    this.update(world);
    this.faceCamera(new THREE.PerspectiveCamera(), []);
  }

  update(world: WorldMap): boolean {
    if (world.cards?.some(card => card.id && !this.knownIds.has(card.id))) return false;
    if (world.cards !== this.world.cards || this.currentCards.size === 0) {
      this.currentCards = new Map((world.cards ?? []).filter(card => card.id).map(card => [card.id!, card]));
    }
    this.world = world;
    return true;
  }

  faceCamera(camera: THREE.Camera, surfaces: Array<Surface | undefined>) {
    const metres = this.world.metresPerTile;
    for (const { mesh, cards } of this.batches) {
      cards.forEach((original, index) => {
        const card = original.id ? this.currentCards.get(original.id) : original;
        if (!card) {
          mesh.setMatrixAt(index, this.matrix.makeScale(0, 0, 0));
          return;
        }
        const [x, z] = gridPosition(this.world, card.position[0], card.position[2]);
        const y = cardHeight(this.world, this.width, card, surfaces);
        this.rotation.setFromAxisAngle(this.up, Math.atan2(camera.position.x - x, camera.position.z - z));
        this.position.set(x, y / metres, z);
        this.offset.set(card.offset[0] / metres, card.offset[1] / metres, 0).applyQuaternion(this.rotation);
        this.position.add(this.offset);
        this.scale.set(card.size[0] / metres, card.size[1] / metres, 1);
        this.matrix.compose(this.position, this.rotation, this.scale);
        mesh.setMatrixAt(index, this.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    for (const { mesh } of this.batches) {
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
  }
}
