import * as THREE from "three";
import { WORLD_DETAIL_COLORS, type WorldDetail, type WorldMap } from "./model";

const fluidTint = {
  sea: [0.14, 0.28, 0.34],
  tide: [0.25, 0.48, 0.48],
  lava: [1, 0.48, 0.06],
};

export function buildWorldFeatures(world: WorldMap, time: THREE.IUniform<number>, seaMask: THREE.DataTexture, width: number, height: number) {
  const group = new THREE.Group();
  for (const detail of world.details ?? []) {
    const { kind, vertices, triangles } = detail;
    const positions = new Float32Array(vertices.length);
    const metres = world.metresPerTile;
    for (let i = 0; i < vertices.length; i += 3) {
      positions[i] = (vertices[i] - world.origin[0]) / metres;
      positions[i + 1] = vertices[i + 1] / metres;
      positions[i + 2] = (vertices[i + 2] - world.origin[1]) / metres;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(triangles);
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({
      color: WORLD_DETAIL_COLORS[kind], flatShading: true, side: THREE.DoubleSide,
      polygonOffset: kind !== "sea", polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      transparent: kind === "sea", depthWrite: kind !== "sea",
      emissive: kind === "lava" || kind === "embers" ? WORLD_DETAIL_COLORS[kind] : 0x000000,
      emissiveIntensity: kind === "lava" ? 0.24 : 0.48,
    });
    if (kind === "sea" || kind === "tide" || kind === "lava") {
      addFluidPattern(material, kind, time);
      if (kind === "sea") {
        geometry.computeBoundingBox();
        const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
        const half = geometry.boundingBox!.getSize(new THREE.Vector3()).multiplyScalar(0.5);
        const fluid = material.onBeforeCompile;
        material.onBeforeCompile = (shader, renderer) => {
          fluid(shader, renderer);
          shader.uniforms.seaMask = { value: seaMask };
          shader.uniforms.mapSize = { value: [width, height] };
          shader.uniforms.seaCenter = { value: [center.x, center.z] };
          shader.uniforms.seaHalf = { value: [half.x, half.z] };
          shader.fragmentShader = "uniform sampler2D seaMask;\nuniform vec2 mapSize, seaCenter, seaHalf;\n"
            + shader.fragmentShader.replace("#include <alphatest_fragment>", `#include <alphatest_fragment>
              vec2 mapUV = vFluidPosition / mapSize;
              if (all(greaterThanEqual(mapUV, vec2(0.0))) && all(lessThan(mapUV, vec2(1.0)))
                && texture2D(seaMask, mapUV).r > 0.5) discard;
              vec2 edge = abs(vFluidPosition - seaCenter) / seaHalf;
              diffuseColor.a *= 1.0 - smoothstep(0.62, 0.995, max(edge.x, edge.y));`);
        };
      }
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = kind;
    group.add(mesh);
  }
  return group;
}

function addFluidPattern(
  material: THREE.MeshLambertMaterial,
  kind: Extract<WorldDetail["kind"], "sea" | "tide" | "lava">,
  time: THREE.IUniform<number>,
) {
  const lava = kind === "lava";
  const tide = kind === "tide";
  material.customProgramCacheKey = () => kind;
  material.onBeforeCompile = shader => {
    shader.uniforms.featureTime = time;
    shader.uniforms.fluidTint = { value: fluidTint[kind] };
    shader.vertexShader = "varying vec2 vFluidPosition;\n" + shader.vertexShader.replace(
      "#include <begin_vertex>", "#include <begin_vertex>\nvFluidPosition = position.xz;",
    );
    const lavaNoise = `
      float heatHash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float heatNoise(vec2 p) {
        vec2 cell = floor(p), part = smoothstep(vec2(0.0), vec2(1.0), fract(p));
        return mix(mix(heatHash(cell), heatHash(cell + vec2(1, 0)), part.x),
          mix(heatHash(cell + vec2(0, 1)), heatHash(cell + vec2(1, 1)), part.x), part.y);
      }
    `;
    const lavaSurface = `
      vec2 p = vFluidPosition * 1.7;
      float t = featureTime * 0.19;
      float heat = heatNoise(p + vec2(t, -t * 0.4)) * 0.67
        + heatNoise(p * 2.4 + vec2(-t * 0.6, t)) * 0.23
        + heatNoise(p * 6.3) * 0.10;
      float ridge = 1.0 - smoothstep(0.01, 0.08, abs(heat - 0.53));
      float glow = smoothstep(0.52, 0.91, heat);
      diffuseColor.rgb = mix(vec3(0.27, 0.027, 0.004), vec3(0.96, 0.24, 0.016), glow)
        + fluidTint * ridge * 0.29;
    `;
    const waterSurface = `
      vec2 p = vFluidPosition * ${tide ? "6.0" : "1.15"};
      float t = featureTime * 0.75;
      float a = sin(p.x * 2.6 + sin(p.y * 3.1 + t) * 1.6 - t);
      float b = sin(p.y * 3.7 - p.x * 1.55 + sin(p.x * 1.3 - t) + t * 0.8);
      float wave = a * 0.63 + b * 0.37;
      float crest = smoothstep(0.51, 0.96, wave);
      float detail = 1.0 - smoothstep(0.15, 0.8, length(fwidth(p)));
      diffuseColor.rgb = mix(diffuseColor.rgb * 0.78, fluidTint, crest * detail * 0.62);
    `;
    shader.fragmentShader = "varying vec2 vFluidPosition;\nuniform float featureTime;\nuniform vec3 fluidTint;\n"
      + (lava ? lavaNoise : "") + shader.fragmentShader.replace("#include <color_fragment>",
        "#include <color_fragment>\n" + (lava ? lavaSurface : waterSurface));
  };
}
