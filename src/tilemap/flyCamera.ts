import { MathUtils, Vector3, type PerspectiveCamera } from "three";

const flightKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"]);
const lookSensitivity = 0.004;
const pitchLimit = Math.PI / 2 - 0.01;

export function attachFlyCamera(
  camera: PerspectiveCamera,
  pane: HTMLElement,
  speed: number,
  requestRender: (turned?: boolean) => void,
  resetView: () => void,
) {
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const keys = new Set<string>();
  const forward = new Vector3();
  const right = new Vector3();
  const direction = new Vector3();
  let lastFrame: number | undefined;
  let fast = false;
  let look: { id: number; x: number; y: number } | undefined;

  camera.rotation.order = "YXZ";

  function endLook() {
    const id = look?.id;
    look = undefined;
    if (id !== undefined && pane.hasPointerCapture(id)) pane.releasePointerCapture(id);
  }

  function clearInput() {
    keys.clear();
    lastFrame = undefined;
    fast = false;
    endLook();
  }

  pane.addEventListener("pointerdown", event => {
    if (event.button !== 0 && event.button !== 2) return;
    pane.focus({ preventScroll: true });
    if (event.button !== 2) return;
    event.preventDefault();
    look = { id: event.pointerId, x: event.clientX, y: event.clientY };
    pane.setPointerCapture(event.pointerId);
  }, options);

  pane.addEventListener("pointermove", event => {
    if (look?.id !== event.pointerId) return;
    if (!(event.buttons & 2)) {
      endLook();
      return;
    }
    const dx = event.clientX - look.x;
    const dy = event.clientY - look.y;
    if (!dx && !dy) return;
    look.x = event.clientX;
    look.y = event.clientY;
    camera.rotation.y -= dx * lookSensitivity;
    camera.rotation.x = MathUtils.clamp(camera.rotation.x - dy * lookSensitivity, -pitchLimit, pitchLimit);
    requestRender(true);
  }, options);

  function finishLook(event: PointerEvent) {
    if (look?.id === event.pointerId) endLook();
  }

  pane.addEventListener("pointerup", finishLook, options);
  pane.addEventListener("pointercancel", finishLook, options);
  pane.addEventListener("lostpointercapture", finishLook, options);
  pane.addEventListener("contextmenu", event => event.preventDefault(), options);
  pane.addEventListener("blur", clearInput, options);
  window.addEventListener("blur", clearInput, options);

  pane.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code !== "KeyF" && !flightKeys.has(event.code)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === "KeyF") {
      if (!event.repeat) resetView();
      return;
    }
    if (!keys.size) lastFrame = undefined;
    keys.add(event.code);
    fast = event.shiftKey;
    requestRender();
  }, options);

  pane.addEventListener("keyup", event => {
    if (!flightKeys.has(event.code)) return;
    keys.delete(event.code);
    fast = event.shiftKey;
    if (!keys.size) lastFrame = undefined;
  }, options);

  return {
    update(now: number) {
      const forwardInput = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
      const rightInput = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
      const upInput = Number(keys.has("KeyE")) - Number(keys.has("KeyQ"));
      if (!forwardInput && !rightInput && !upInput) {
        lastFrame = undefined;
        return false;
      }
      const elapsed = Math.min(0.05, (now - (lastFrame ?? now)) / 1000);
      lastFrame = now;
      camera.getWorldDirection(forward);
      right.crossVectors(forward, camera.up).normalize();
      direction.copy(forward).multiplyScalar(forwardInput)
        .addScaledVector(right, rightInput).addScaledVector(camera.up, upInput);
      camera.position.addScaledVector(direction.normalize(), speed * elapsed * (fast ? 3 : 1));
      return true;
    },
    dispose() {
      clearInput();
      listeners.abort();
    },
  };
}
