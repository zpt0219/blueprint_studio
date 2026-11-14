import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { LiteTileMap } from "../model";
import type { PackRuntime } from "../pack/types";
import type { Bindings } from "../pack/compile";
import type { RenderMode } from "../render";
import { Hd2dWorld, type PlayerState } from "../hd2d/Hd2dWorld";
import { inspectTileStack, type TileStackItem } from "../fastBrush";

export interface Hd2dViewProps {
  viewRole: "scene" | "game";
  map: LiteTileMap;
  version: number;
  isPainting: boolean;
  pack: PackRuntime | null;
  bindings: Bindings | null;
  renderMode: RenderMode;
  selected: Set<number>;
  player: PlayerState;
  onChangePlayer: (next: PlayerState | ((prev: PlayerState) => PlayerState)) => void;
  onPickObject?: (id: number | null, additive: boolean) => void;
  lang: "zh" | "en";
}

type CameraPreset = "hd2d" | "iso45" | "stack";

export function Hd2dView({
  viewRole,
  map,
  version,
  isPainting,
  pack,
  bindings,
  renderMode,
  selected,
  player,
  onChangePlayer,
  onPickObject,
  lang,
}: Hd2dViewProps) {
  const isSceneView = viewRole === "scene";
  const wrapRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<Hd2dWorld | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

  const [preset, setPreset] = useState<CameraPreset>("hd2d");
  const [stackExplode, setStackExplode] = useState<number>(1);
  const [billboard, setBillboard] = useState<boolean>(true);
  const [showGrid, setShowGrid] = useState<boolean>(isSceneView);
  const [gameZoom, setGameZoom] = useState<number>(1);
  const [hoverTile, setHoverTile] = useState<[number, number] | null>(null);
  const [hoverStack, setHoverStack] = useState<TileStackItem[]>([]);

  // Spherical orbit camera state around target (used in Scene View)
  const orbitRef = useRef({
    target: new THREE.Vector3(map.width / 2, 0, map.height / 2),
    distance: Math.max(map.width, map.height) * 0.85,
    polar: Math.PI / 2 - 14 * (Math.PI / 180), // 默认正南微俯仰 -14° (经典 HD-2D)
    azimuth: 0,
  });

  const dragRef = useRef<{
    mode: "none" | "orbit" | "pan" | "click_candidate";
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    ctrlKey: boolean;
    shiftKey: boolean;
  }>({
    mode: "none",
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    ctrlKey: false,
    shiftKey: false,
  });

  const keysRef = useRef<Set<string>>(new Set());
  const playerRef = useRef<PlayerState>(player);
  playerRef.current = player;
  const gameZoomRef = useRef<number>(gameZoom);
  gameZoomRef.current = gameZoom;
  const isSceneRef = useRef<boolean>(isSceneView);
  isSceneRef.current = isSceneView;

  const syncSceneCameraFromOrbit = useCallback(() => {
    const cam = cameraRef.current;
    if (!cam) return;
    const { target, distance, polar, azimuth } = orbitRef.current;
    const sinP = Math.sin(polar);
    const cosP = Math.cos(polar);
    cam.position.set(
      target.x + distance * sinP * Math.sin(azimuth),
      target.y + distance * cosP,
      target.z + distance * sinP * Math.cos(azimuth),
    );
    cam.lookAt(target);
  }, []);

  const applyPreset = useCallback(
    (next: CameraPreset) => {
      setPreset(next);
      const span = Math.max(map.width, map.height);
      orbitRef.current.target.set(map.width / 2, 0, map.height / 2);
      if (next === "hd2d") {
        // 与 gameCamera 一致的 -14° 微俯仰基准视角
        orbitRef.current.polar = Math.PI / 2 - 14 * (Math.PI / 180);
        orbitRef.current.azimuth = 0;
        orbitRef.current.distance = span * 0.85;
      } else if (next === "iso45") {
        // 对应 tilemap-hd2d-world 的 focus 倾角 (约 37° 俯视, 45° 偏航)
        orbitRef.current.polar = 0.93;
        orbitRef.current.azimuth = Math.PI / 4;
        orbitRef.current.distance = span * 0.92;
      } else {
        // 叠层拆解侧上方观察视角
        orbitRef.current.polar = 1.05;
        orbitRef.current.azimuth = 0.42;
        orbitRef.current.distance = span * 0.8;
        if (stackExplode < 6) setStackExplode(8);
      }
      syncSceneCameraFromOrbit();
    },
    [map.width, map.height, stackExplode, syncSceneCameraFromOrbit],
  );

  const focusPlayerInScene = useCallback(() => {
    const p = playerRef.current;
    orbitRef.current.target.set(p.x, p.y, p.z);
    orbitRef.current.polar = 0.93; // 对应 tilemap-hd2d-world 的 focus 相对偏移 (14, 20, 23)
    orbitRef.current.azimuth = 0.54;
    orbitRef.current.distance = 33.5;
    syncSceneCameraFromOrbit();
  }, [syncSceneCameraFromOrbit]);

  // Initialize Three.js renderer, scene, and animation loop
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const world = new Hd2dWorld();
    worldRef.current = world;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.className = "hd2d-canvas";
    wrap.innerHTML = "";
    wrap.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // tilemap-hd2d-world benchmarks:
    // sceneCamera: PerspectiveCamera(50, aspect, 0.05, 1000)
    // gameCamera: PerspectiveCamera(30.5, aspect, 0.036, 700), pitch -14°, yaw 0°
    const camera = new THREE.PerspectiveCamera(
      isSceneRef.current ? 50 : 30.5,
      1,
      isSceneRef.current ? 0.05 : 0.036,
      isSceneRef.current ? 1000 : 700,
    );
    camera.rotation.order = "YXZ";
    cameraRef.current = camera;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    orbitRef.current.target.set(map.width / 2, 0, map.height / 2);
    orbitRef.current.distance = Math.max(map.width, map.height) * 0.88;
    syncSceneCameraFromOrbit();

    let rafId = 0;
    let lastTime = performance.now();
    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      // Only Game View drives WASD physics stepping so player doesn't step twice when both views are mounted
      if (!isSceneRef.current && keysRef.current.size > 0) {
        const nextP = world.stepPlayerMovement(playerRef.current, keysRef.current, dt);
        if (
          nextP.x !== playerRef.current.x ||
          nextP.z !== playerRef.current.z ||
          nextP.walkPhase !== playerRef.current.walkPhase
        ) {
          playerRef.current = nextP;
          onChangePlayer(nextP);
        }
      }

      const curP = playerRef.current;
      world.syncPlayerAndGameCameraGizmo(curP, isSceneRef.current, gameZoomRef.current);

      if (!isSceneRef.current) {
        // HD2D Game Camera benchmark: Perspective, pitch -14°, yaw 0°, FOV 30.5°, Near 0.036, Far 700
        // Offset relative to player: x: 0, y: +7.491446, z: +26.035766
        const zoom = Math.max(0.4, gameZoomRef.current);
        const footTx = Math.max(0, Math.min(map.width - 1, Math.floor(curP.x)));
        const footTz = Math.max(0, Math.min(map.height - 1, Math.floor(curP.z)));
        const elev = world.elevationAt(footTx, footTz);
        const targetY = elev + 7.491446 / zoom;
        const targetZ = curP.z + 26.035766 / zoom;
        const desiredPos = new THREE.Vector3(curP.x, targetY, targetZ);
        camera.position.lerp(desiredPos, Math.min(1, dt * 14));
        camera.rotation.order = "YXZ";
        camera.rotation.x = -14 * (Math.PI / 180);
        camera.rotation.y = 0;
        camera.rotation.z = 0;
      }

      world.orientBillboards(camera);
      renderer.render(world.scene, camera);
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      world.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the 2D brush responsive by rebuilding 3D once the stroke commits.
  useEffect(() => {
    const world = worldRef.current;
    if (!world || isPainting) return;
    world.rebuild(map, pack, bindings, {
      renderMode,
      // Game View always renders compact authentic game layers (stackExplode = 1, showGrid = false)
      stackExplode: isSceneView ? stackExplode : 1,
      billboardSprites: billboard,
      showGrid: isSceneView ? showGrid : false,
      isSceneView,
    });
  }, [map, version, isPainting, pack, bindings, renderMode, isSceneView, stackExplode, billboard, showGrid]);

  // Update 3D selection highlight boxes whenever `selected` changes in Scene View
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !isSceneView || isPainting) return;
    world.updateSelectionBoxes(map, selected);
  }, [map, selected, version, isSceneView, isPainting]);

  // Keyboard listener for WASD walk in Game View
  useEffect(() => {
    if (isSceneView) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"].includes(k)) {
        keysRef.current.add(k);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key.toLowerCase());
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [isSceneView]);

  const buildRaycasterFromEvent = useCallback((clientX: number, clientY: number): THREE.Raycaster | null => {
    const wrap = wrapRef.current;
    const cam = cameraRef.current;
    if (!wrap || !cam) return null;
    const rect = wrap.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);
    return raycaster;
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isSceneView) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    // Right click = Orbit, Middle click (or Alt+Left) = Pan, Left click = Pick object (or drag to Pan)
    if (e.button === 2) {
      dragRef.current = {
        mode: "orbit",
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        ctrlKey: e.ctrlKey || e.metaKey,
        shiftKey: e.shiftKey,
      };
      return;
    }
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      dragRef.current = {
        mode: "pan",
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        ctrlKey: e.ctrlKey || e.metaKey,
        shiftKey: e.shiftKey,
      };
      return;
    }
    if (e.button === 0) {
      dragRef.current = {
        mode: "click_candidate",
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        ctrlKey: e.ctrlKey || e.metaKey,
        shiftKey: e.shiftKey,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isSceneView) return;
    const world = worldRef.current;

    if (dragRef.current.mode === "click_candidate") {
      const dist = Math.hypot(e.clientX - dragRef.current.startX, e.clientY - dragRef.current.startY);
      if (dist > 5) {
        dragRef.current.mode = "pan";
      }
    }

    if (dragRef.current.mode === "orbit") {
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      orbitRef.current.azimuth -= dx * 0.007;
      orbitRef.current.polar = Math.max(0.2, Math.min(1.42, orbitRef.current.polar - dy * 0.006));
      syncSceneCameraFromOrbit();
      return;
    }

    if (dragRef.current.mode === "pan") {
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      const scale = orbitRef.current.distance * 0.0016;
      const az = orbitRef.current.azimuth;
      orbitRef.current.target.x -= (dx * Math.cos(az) + dy * Math.sin(az)) * scale;
      orbitRef.current.target.z -= (-dx * Math.sin(az) + dy * Math.cos(az)) * scale;
      syncSceneCameraFromOrbit();
      return;
    }

    // Hover raycast in Scene View (inspect tile stack, read-only)
    const raycaster = buildRaycasterFromEvent(e.clientX, e.clientY);
    if (raycaster && world) {
      const picked = world.pickAtRay(raycaster, map);
      setHoverTile(picked.tile);
      if (picked.tile) {
        setHoverStack(inspectTileStack(map, picked.tile[0], picked.tile[1]));
        world.updateHoverTile(picked.tile[0], picked.tile[1]);
      } else {
        setHoverStack([]);
        world.updateHoverTile(null, null);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isSceneView) return;
    if (dragRef.current.mode === "click_candidate") {
      const raycaster = buildRaycasterFromEvent(e.clientX, e.clientY);
      const world = worldRef.current;
      if (raycaster && world) {
        const picked = world.pickAtRay(raycaster, map);
        if (dragRef.current.shiftKey && picked.tile) {
          // Shift+Click in Scene View teleports the player to that tile!
          const [tx, ty] = picked.tile;
          const elev = world.elevationAt(tx, ty);
          onChangePlayer((prev) => ({
            ...prev,
            x: tx + 0.5,
            y: elev,
            z: ty + 0.5,
            walkPhase: 0,
          }));
        } else if (onPickObject) {
          onPickObject(picked.objectId, dragRef.current.ctrlKey);
        }
      }
    }
    dragRef.current.mode = "none";
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!isSceneView) {
      // In Game View, wheel subtly adjusts Game Camera lens zoom (0.65x ~ 1.6x)
      setGameZoom((z) => Math.max(0.65, Math.min(1.6, Number((z * (e.deltaY > 0 ? 0.92 : 1.08)).toFixed(2)))));
      return;
    }
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    orbitRef.current.distance = Math.max(6, Math.min(260, orbitRef.current.distance * factor));
    syncSceneCameraFromOrbit();
  };

  return (
    <div
      className={`hd2d-wrap ${isSceneView ? "hd2d-scene-view" : "hd2d-game-view"}`}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    >
      <div ref={wrapRef} className="hd2d-canvas" />

      {/* Top HUD Bar */}
      <div className="hd2d-hud-top">
        <span className={`view-role-pill ${isSceneView ? "scene" : "game"}`}>
          {isSceneView
            ? lang === "zh"
              ? "🎥 Scene View (3D 自由观察 · 点击选中 · 不可编辑)"
              : "🎥 Scene View (Free Camera · Click to Select · Read-only)"
            : lang === "zh"
              ? "🎮 Game View (锁定玩家视角 · WASD 实时行走)"
              : "🎮 Game View (Locked Player Camera · WASD Walk)"}
        </span>

        {isSceneView ? (
          <>
            <div className="seg">
              <button className={preset === "hd2d" ? "active" : ""} onClick={() => applyPreset("hd2d")}>
                HD-2D
              </button>
              <button className={preset === "iso45" ? "active" : ""} onClick={() => applyPreset("iso45")}>
                45° Iso
              </button>
              <button className={preset === "stack" ? "active" : ""} onClick={() => applyPreset("stack")}>
                {lang === "zh" ? "叠层检视" : "Stack Inspect"}
              </button>
            </div>

            <div className="hd2d-stack-slider" title={lang === "zh" ? "拉开 3D 地表多层贴图间距，观察单 Tile 多图叠加结构（不影响 Game View）" : "Explode stacked 3D tile layers"}>
              <span>{lang === "zh" ? "叠层间距" : "Stack Gap"}</span>
              <input
                type="range"
                min={1}
                max={18}
                step={1}
                value={stackExplode}
                onChange={(e) => setStackExplode(Number(e.target.value))}
              />
              <code>{stackExplode}x</code>
            </div>

            <button className={showGrid ? "active" : ""} onClick={() => setShowGrid((g) => !g)}>
              {lang === "zh" ? "网格" : "Grid"}
            </button>
            <button onClick={focusPlayerInScene} title={lang === "zh" ? "将 Scene 相机对准当前玩家位置" : "Center Scene camera on Player"}>
              🎯 {lang === "zh" ? "定位玩家" : "Find Player"}
            </button>
          </>
        ) : (
          <>
            <div className="seg">
              {[0.75, 1, 1.35].map((z) => (
                <button key={z} className={Math.abs(gameZoom - z) < 0.08 ? "active" : ""} onClick={() => setGameZoom(z)}>
                  {z}x
                </button>
              ))}
            </div>
            <button className={billboard ? "active" : ""} onClick={() => setBillboard((b) => !b)}>
              {lang === "zh" ? "立牌朝向" : "Billboard"}
            </button>
          </>
        )}
      </div>

      {/* Bottom Status Bar */}
      <div className="status hd2d-status">
        {isSceneView ? (
          <>
            <span>
              {lang === "zh"
                ? "左键点击=选中对象 · Shift+左键=传送玩家到此格 · 右键旋转 · 拖拽平移"
                : "LMB=Select · Shift+LMB=Move Player Here · RMB=Orbit · Drag=Pan"}
            </span>
            {hoverTile && (
              <>
                <span className="hover">
                  ({hoverTile[0]}, {hoverTile[1]})
                </span>
                {hoverStack.length > 0 && (
                  <span className="status-stack">
                    {lang === "zh" ? `叠层(${hoverStack.length}): ` : `Stack(${hoverStack.length}): `}
                    {hoverStack.map((item, idx) => (
                      <span key={`${item.objectId}-${idx}`} className={`stack-chip ${item.stratum}`}>
                        {item.objectName}
                      </span>
                    ))}
                  </span>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <span>
              {lang === "zh"
                ? "🕹️ 按 WASD / 方向键移动玩家（按住 Shift 奔跑）· 视角永远锁定玩家"
                : "🕹️ WASD / Arrows to walk (Shift to run) · Camera locked to Player"}
            </span>
            <span className="hover">
              Player ({Math.floor(player.x)}, {Math.floor(player.z)})
            </span>
          </>
        )}
      </div>
    </div>
  );
}
