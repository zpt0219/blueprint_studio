import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { attachFlyCamera } from "./flyCamera";
import { buildMesh, disposeMesh } from "./mesh";
import type { Atlases } from "./draw";
import { tilesetImage } from "./files";
import { WorldCards, type WorldImages } from "./worldCards";
import { buildWorldFeatures } from "./worldFeatures";
import { WorldTerrain } from "./worldTerrain";
import { canWalk, worldWallTest } from "./worldWalk";
import { gridPosition, type Point, type Surface, type WorldMap } from "./model";

interface Props {
  width: number;
  height: number;
  atlases: Atlases;
  surfaces: Array<Surface | undefined>;
  world?: WorldMap;
  focus?: Point;
  onFocus?: (point: Point) => void;
}

interface Preview {
  update: (surfaces: Array<Surface | undefined>, atlases: Atlases) => void;
  locatePlayer: (x: number, z: number) => void;
  decorate: (world: WorldMap, images: WorldImages) => void;
}

const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"]);

export default function MapPreview({ width, height, atlases, surfaces, world, focus, onFocus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scenePane = useRef<HTMLDivElement>(null);
  const gamePane = useRef<HTMLDivElement>(null);
  const preview = useRef<Preview | null>(null);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const initialFocus = useRef(focus);
  initialFocus.current = focus;
  const [error, setError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [terrainError, setTerrainError] = useState(false);
  const [images, setImages] = useState<WorldImages>(new Map());
  const textures = world?.textures;
  useEffect(() => {
    let cancelled = false;
    setImageError(false);
    Promise.all((textures ?? []).map(async texture =>
      [texture.id, await tilesetImage(texture.png)] as const)).then(entries => {
      if (!cancelled) setImages(new Map(entries));
    }).catch(() => { if (!cancelled) setImageError(true); });
    return () => { cancelled = true; };
  }, [textures]);
  const isWorld = !!world;
  const metres = world?.metresPerTile ?? 1;

  useEffect(() => {
    const parent = host.current!;
    const sceneView = scenePane.current!;
    const gameView = gamePane.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setError(true);
      return;
    }
    setError(false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setScissorTest(true);
    renderer.domElement.className = "tm-preview-canvas";
    renderer.domElement.setAttribute("aria-hidden", "true");
    parent.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#dce8e4");
    const extent = Math.max(width, height, 8);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, extent * 30);
    camera.layers.enable(2);
    const gameCamera = new THREE.PerspectiveCamera(30.5, 1, 0.036 / metres, 700 / metres);
    gameCamera.rotation.set(-14 * Math.PI / 180, 0, 0);
    gameCamera.layers.enable(1);
    const followOffset = new THREE.Vector3(0, 7.491446, 26.035766).divideScalar(metres);

    const ambient = new THREE.AmbientLight(0xffffff, 2.0);
    const sun = new THREE.DirectionalLight(0xfff4da, 1.9);
    sun.position.set(-extent, extent * 1.8, extent / 2);
    scene.add(ambient, sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ color: "#f1efe7" }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(width / 2, -0.025, height / 2);
    if (!isWorld) scene.add(floor);
    const points: number[] = [];
    for (let x = 0; x <= width; x++) points.push(x, -0.02, 0, x, -0.02, height);
    for (let z = 0; z <= height; z++) points.push(0, -0.02, z, width, -0.02, z);
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const grid = new THREE.LineSegments(gridGeometry, new THREE.LineBasicMaterial({ color: "#d7d7cb" }));
    if (!isWorld) scene.add(grid);

    const player = new THREE.Mesh(new THREE.CapsuleGeometry(0.25 / metres, 1.1 / metres, 4, 8),
      new THREE.MeshLambertMaterial({ color: "#254f69" }));
    player.layers.set(1);
    scene.add(player);
    const hiddenPlayer = new THREE.Mesh(player.geometry, new THREE.MeshBasicMaterial({
      color: "#ffd578", transparent: true, opacity: 0.75, depthFunc: THREE.GreaterDepth, depthWrite: false,
    }));
    hiddenPlayer.layers.set(1);
    hiddenPlayer.renderOrder = 100;
    scene.add(hiddenPlayer);
    const markRadius = Math.max(0.35, extent * 0.008);
    const markHeight = Math.max(0.9, extent * 0.022);
    const playerMark = new THREE.Mesh(
      new THREE.CylinderGeometry(markRadius * 0.35, markRadius, markHeight, 12),
      new THREE.MeshBasicMaterial({ color: "#e11d48" }),
    );
    playerMark.layers.set(2);
    scene.add(playerMark);
    const start = initialFocus.current ?? [Math.floor(width / 2) + 0.5, Math.floor(height / 2) + 0.5];
    const feet = new THREE.Vector3(start[0], 0, start[1]);

    let frame: number | null = null;
    let pending: { surfaces: Array<Surface | undefined>; atlases: Atlases } | undefined;
    let latest: typeof pending;
    let terrain: WorldTerrain | undefined;
    let terrainData: Blob | undefined;
    let disposed = false;
    let wallData: WorldMap["wallColliders"];
    let wallAt = (_x: number, _y: number, _z: number) => false;
    const featureTime = { value: 0 };
    const seaEdits = new Uint8Array(width * height);
    const seaMask = new THREE.DataTexture(seaEdits, width, height, THREE.RedFormat);
    seaMask.needsUpdate = true;
    let ground: Array<Surface | undefined> = [];
    let group: THREE.Group | undefined;
    let decoration: THREE.Group | undefined;
    let testMark: THREE.Mesh | undefined;
    let details: THREE.Group | undefined;
    let detailData: WorldMap["details"];
    let cards: WorldCards | undefined;
    let cardImages: WorldImages | undefined;
    let fitPending = true;
    let hasFlown = false;
    const flight = attachFlyCamera(camera, sceneView, Math.max(6 / metres, extent * 0.13), turned => {
      if (turned) hasFlown = true;
      render();
    }, () => {
      fitPending = true;
      hasFlown = false;
      render();
    });
    let viewWidth = 0;
    let sceneHeight = 0;
    let gameHeight = 0;
    let lastMove: number | undefined;
    const keys = new Set<string>();

    function fitMap() {
      const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(width, 0, height));
      if (group) bounds.expandByObject(group);
      if (decoration) bounds.expandByObject(decoration);
      for (const feature of details?.children ?? []) {
        if (feature.name !== "sea") bounds.expandByObject(feature);
      }
      if (terrain) bounds.expandByObject(terrain.mesh);
      if (cards) bounds.expandByObject(cards.group);
      const center = bounds.getCenter(new THREE.Vector3());
      const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      const direction = new THREE.Vector3(0.65, 1.05, 1).normalize();
      const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right);
      const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const horizontal = vertical * camera.aspect;
      const corner = new THREE.Vector3();
      let distance = 0;
      for (const x of [-half.x, half.x]) {
        for (const y of [-half.y, half.y]) {
          for (const z of [-half.z, half.z]) {
            corner.set(x, y, z);
            const screen = Math.max(Math.abs(corner.dot(right)) / horizontal, Math.abs(corner.dot(up)) / vertical);
            distance = Math.max(distance, corner.dot(direction) + 1.12 * screen);
          }
        }
      }
      camera.position.copy(center).addScaledVector(direction, distance);
      camera.lookAt(center);
      camera.far = Math.max(extent * 30, distance * 3);
      camera.updateProjectionMatrix();
    }

    function clearGroup(meshes?: THREE.Group) {
      if (!meshes) return;
      scene.remove(meshes);
      disposeMesh(meshes);
    }

    function heightAt(x: number, z: number) {
      const col = Math.floor(x), row = Math.floor(z);
      if (col < 0 || col >= width || row < 0 || row >= height) return;
      const index = row * width + col;
      const elevation = terrain && !terrain.hasReplacement(index) ? terrain.heightAt(x, z) : ground[index]?.height;
      return isWorld && elevation !== undefined && elevation * metres <= -2 ? undefined : elevation;
    }

    function blockedAt(x: number, y: number, z: number) {
      if (wallAt(x, y, z)) return true;
      const radius = 0.4 / metres;
      for (let row = Math.max(0, Math.floor(z - 1)); row <= Math.min(height - 1, Math.floor(z + 1)); row++) {
        for (let col = Math.max(0, Math.floor(x - 1)); col <= Math.min(width - 1, Math.floor(x + 1)); col++) {
          const surface = ground[row * width + col];
          if (surface?.blocked && Math.abs(x - col - 0.5) < 0.5 + radius && Math.abs(z - row - 0.5) < 0.5 + radius) return true;
          for (const prop of surface?.decorations ?? []) {
            const half = Math.min(prop.size[0] * 0.35, 0.8) / 2 + radius;
            if (prop.blocked && Math.abs(x - col - 0.5) < half && Math.abs(z - row - 0.5) < half) return true;
          }
        }
      }
      return false;
    }

    function updateGame(now: number) {
      if (keys.size) {
        const elapsed = Math.min(0.05, (now - (lastMove ?? now)) / 1000);
        const x = Number(keys.has("KeyD") || keys.has("ArrowRight")) - Number(keys.has("KeyA") || keys.has("ArrowLeft"));
        const z = Number(keys.has("KeyS") || keys.has("ArrowDown")) - Number(keys.has("KeyW") || keys.has("ArrowUp"));
        const step = 6 / metres * elapsed / Math.max(1, Math.hypot(x, z));
        const moveX = THREE.MathUtils.clamp(feet.x + x * step, 0.01, width - 0.01);
        const moveZ = THREE.MathUtils.clamp(feet.z + z * step, 0.01, height - 0.01);
        const prevX = feet.x, prevZ = feet.z;
        if (canWalk([feet.x, feet.z], [moveX, feet.z], metres, heightAt, blockedAt)) feet.x = moveX;
        if (canWalk([feet.x, feet.z], [feet.x, moveZ], metres, heightAt, blockedAt)) feet.z = moveZ;
        if (feet.x !== prevX || feet.z !== prevZ) {
          onFocusRef.current?.([Number(feet.x.toFixed(3)), Number(feet.z.toFixed(3))]);
        }
        lastMove = now;
        render();
      }
      feet.y = heightAt(feet.x, feet.z) ?? 0;
      player.position.set(feet.x, feet.y + 0.8 / metres, feet.z);
      hiddenPlayer.position.copy(player.position);
      playerMark.position.set(feet.x, feet.y + markHeight / 2, feet.z);
      gameCamera.position.copy(feet).add(followOffset);
      if (testMark) {
        const floorY = heightAt(testMark.position.x, testMark.position.z);
        if (floorY !== undefined) testMark.position.y = floorY + 0.225;
      }
    }

    function renderView(viewCamera: THREE.PerspectiveCamera, bottom: number, viewHeight: number) {
      renderer.setViewport(0, bottom, viewWidth, viewHeight);
      renderer.setScissor(0, bottom, viewWidth, viewHeight);
      cards?.faceCamera(viewCamera, ground);
      for (const mesh of group?.children ?? []) {
        if (mesh.userData.billboard) mesh.rotation.y = Math.atan2(viewCamera.position.x - mesh.position.x, viewCamera.position.z - mesh.position.z);
      }
      renderer.render(scene, viewCamera);
    }

    function render() {
      if (frame !== null) return;
      frame = requestAnimationFrame(now => {
        frame = null;
        if (!viewWidth || !sceneHeight || !gameHeight) return;
        if (pending) {
          clearGroup(group);
          ground = pending.surfaces;
          terrain?.update(ground, pending.atlases, seaEdits);
          seaMask.needsUpdate = true;
          group = buildMesh(ground, width, height, pending.atlases, isWorld, terrain);
          scene.add(group);
          pending = undefined;
        }
        if (fitPending) {
          fitPending = false;
          fitMap();
        }
        if (flight.update(now)) {
          hasFlown = true;
          render();
        }
        featureTime.value = now / 1000;
        updateGame(now);
        renderView(camera, gameHeight, sceneHeight);
        renderView(gameCamera, 0, gameHeight);
      });
    }

    const observer = new ResizeObserver(() => {
      viewWidth = parent.clientWidth;
      sceneHeight = sceneView.offsetHeight;
      gameHeight = parent.clientHeight - sceneHeight;
      if (!viewWidth || !sceneHeight || !gameHeight) return;
      if (!hasFlown && camera.aspect !== viewWidth / sceneHeight) fitPending = true;
      camera.aspect = viewWidth / sceneHeight;
      camera.updateProjectionMatrix();
      gameCamera.aspect = viewWidth / gameHeight;
      gameCamera.updateProjectionMatrix();
      renderer.setSize(viewWidth, sceneHeight + gameHeight, false);
      render();
    });
    observer.observe(parent);

    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || !movementKeys.has(event.code)) return;
      event.preventDefault();
      keys.add(event.code);
      render();
    }
    function onKeyUp(event: KeyboardEvent) {
      keys.delete(event.code);
      if (!keys.size) lastMove = undefined;
    }
    function clearKeys() {
      keys.clear();
      lastMove = undefined;
    }
    gameView.addEventListener("keydown", onKeyDown);
    gameView.addEventListener("keyup", onKeyUp);
    gameView.addEventListener("blur", clearKeys);
    window.addEventListener("blur", clearKeys);
    const animateFeatures = window.setInterval(() => {
      if (terrain && !document.hidden) render();
    }, 125);

    preview.current = {
      update(surfaces, atlases) {
        latest = pending = { surfaces, atlases };
        render();
      },
      locatePlayer(x, z) {
        if (Math.abs(feet.x - x) < 0.0006 && Math.abs(feet.z - z) < 0.0006) return;
        const dx = x - feet.x;
        const dz = z - feet.z;
        feet.x = x;
        feet.z = z;
        if (hasFlown) {
          camera.position.x += dx;
          camera.position.z += dz;
        }
        render();
      },
      decorate(world, images) {
        if (wallData !== world.wallColliders) {
          wallData = world.wallColliders;
          wallAt = worldWallTest(world);
        }
        if (terrainData !== world.terrain) {
          setTerrainError(false);
          if (terrain) {
            scene.remove(terrain.mesh);
            terrain.dispose();
            terrain = undefined;
          }
          const blob = terrainData = world.terrain;
          pending = latest;
          if (blob) {
            WorldTerrain.load(world, width, height).then(next => {
              if (disposed || terrainData !== blob) {
                next.dispose();
                return;
              }
              terrain = next;
              scene.add(next.mesh);
              pending = latest;
              if (!hasFlown) fitPending = true;
              render();
            }).catch(() => { if (!disposed && terrainData === blob) setTerrainError(true); });
          }
        }
        if (detailData !== world.details) {
          clearGroup(details);
          detailData = world.details;
          details = buildWorldFeatures(world, featureTime, seaMask, width, height);
          scene.add(details);
        }
        if (!cards || cardImages !== images || !cards.update(world)) {
          if (cards) {
            scene.remove(cards.group);
            cards.dispose();
            cards = undefined;
          }
          if (world.cards?.length && images.size) {
            cards = new WorldCards(world, width, images);
            cards.faceCamera(camera, ground);
            scene.add(cards.group);
          }
          cardImages = images;
        }
        clearGroup(decoration);
        decoration = new THREE.Group();
        testMark = undefined;
        for (const proxy of world.proxies) {
          const [x, z] = gridPosition(world, proxy.position[0], proxy.position[2]);
          const [w, h, d] = proxy.size.map(size => size / metres);
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
            new THREE.MeshLambertMaterial({ color: "#786354" }));
          mesh.position.set(x, proxy.position[1] / metres, z);
          decoration.add(mesh);
        }
        if (world.testPoint) {
          const [x, z] = gridPosition(world, world.testPoint[0], world.testPoint[2]);
          const mark = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 0.45),
            new THREE.MeshLambertMaterial({ color: "#f47732" }));
          mark.layers.set(2);
          mark.position.set(x, world.testPoint[1] / metres + 0.225, z);
          decoration.add(mark);
          testMark = mark;
        }
        scene.add(decoration);
        render();
      },
    };

    return () => {
      disposed = true;
      window.clearInterval(animateFeatures);
      if (frame !== null) cancelAnimationFrame(frame);
      clearGroup(group);
      clearGroup(decoration);
      clearGroup(details);
      terrain?.dispose();
      seaMask.dispose();
      cards?.dispose();
      flight.dispose();
      observer.disconnect();
      gameView.removeEventListener("keydown", onKeyDown);
      gameView.removeEventListener("keyup", onKeyUp);
      gameView.removeEventListener("blur", clearKeys);
      window.removeEventListener("blur", clearKeys);
      player.geometry.dispose();
      player.material.dispose();
      hiddenPlayer.material.dispose();
      playerMark.geometry.dispose();
      playerMark.material.dispose();
      floor.geometry.dispose();
      floor.material.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      preview.current = null;
    };
  }, [width, height, isWorld, metres]);

  useEffect(() => {
    preview.current?.update(surfaces, atlases);
  }, [width, height, isWorld, metres, surfaces, atlases]);

  const cardData = world?.cards;
  const proxies = world?.proxies;
  const details = world?.details;
  const terrain = world?.terrain;
  const walls = world?.wallColliders;
  const testPoint = world?.testPoint;
  useEffect(() => {
    if (world) preview.current?.decorate(world, images);
  }, [width, height, isWorld, metres, cardData, proxies, details, terrain, walls, testPoint, images, world?.elevations]);

  useEffect(() => {
    const [x, z] = focus ?? [Math.floor(width / 2) + 0.5, Math.floor(height / 2) + 0.5];
    preview.current?.locatePlayer(x, z);
  }, [width, height, isWorld, metres, focus]);

  return <section className="tm-preview" aria-label="3D 预览">
    <div ref={host} className="tm-preview-host">
      <div ref={scenePane} className="tm-preview-pane tm-preview-flight" role="region" aria-label="自由视角" tabIndex={0}
        title="Q/E 升降，F 回到全图">
        <span className="tm-view-label">自由视角 · 右键转向 · WASD 飞行 · Shift 加速</span>
      </div>
      <div ref={gamePane} className="tm-preview-pane tm-preview-game" role="region" aria-label="游戏视角" tabIndex={0}
        onPointerDown={event => event.currentTarget.focus({ preventScroll: true })}>
        <span className="tm-view-label">游戏视角 · 点击后 WASD 移动</span>
      </div>
    </div>
    {imageError && <p className="tm-preview-error" role="alert">面片贴图加载失败。</p>}
    {terrainError && <p className="tm-preview-error" role="alert">原场景地形加载失败，当前使用网格地面。</p>}
    {error && <p className="tm-preview-error" role="alert">当前浏览器无法打开 WebGL 预览。</p>}
  </section>;
}
