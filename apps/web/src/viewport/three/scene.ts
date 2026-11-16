import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { HotspotFit, HotspotLayout, ShapeFace, TestShape } from '@hotspotter/core';
import type { View3dMode } from '../../state/store';
import { atlasTexture, releaseTexture, textureList } from './atlasTextures';
import type { AtlasTextureSet } from './atlasTextures';

/** The UI accent (tailwind `accent`), for the rect outlines. */
const ACCENT = '#f59e0b';
/** zinc-950, the viewport background. */
const BACKGROUND = '#09090b';
/**
 * three builds the tangent frame from the uv derivatives with +X along u and +Y along v, the GL convention the engine
 * writes; with the rows flipped on upload (uv v up) the normal map needs no Y flip. The lit probe in view3d.spec
 * checks it (decision 80).
 */
export const NORMAL_SCALE = new THREE.Vector2(1, 1);
/** Rect outlines float this far off their face (metres) so the depth test keeps them on top of it. */
const LINE_LIFT_M = 0.002;
const DIRECTIONAL_INTENSITY = 1.6;
const ENVIRONMENT_INTENSITY = 0.6;
/** Camera direction of the framing: azimuth and elevation, degrees. */
const VIEW_AZIMUTH_DEG = 35;
const VIEW_ELEVATION_DEG = 22;

/** Debug counters and handles (exposed by the test harness). */
export const view3dDebug: {
  /** Frames drawn by any 3D view. */
  frames: number;
  /** Live renderers (WebGL contexts). */
  renderers: number;
  scene: View3DScene | null;
  /** The atlas the shown textures were read from. */
  shownAtlas: unknown;
  /** Unmounts and remounts the 3D view. */
  remount: (() => void) | null;
} = { frames: 0, renderers: 0, scene: null, shownAtlas: null, remount: null };

const UNLIT_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Shows the stored bytes as they are (as the 2D view does): no lighting, tone mapping or colour management.
const UNLIT_FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform int channel;
uniform bool srgb;
uniform bool hasMap;
varying vec2 vUv;
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  if (!hasMap) { gl_FragColor = vec4(vec3(0.5), 1.0); return; }
  vec4 t = texture2D(map, vUv);
  vec3 c = channel == 0 ? vec3(t.r) : channel == 1 ? vec3(t.g) : channel == 2 ? vec3(t.b) : t.rgb;
  gl_FragColor = vec4(srgb ? linearToSrgb(c) : c, 1.0);
}
`;

type Unlit = { tex: keyof Omit<AtlasTextureSet, 'gen'>; channel: -1 | 0 | 1 | 2; srgb?: boolean };

/** Which texture and channel shows each map unlit (see AtlasTextureSet for the packing). */
const UNLIT: Partial<Record<View3dMode, Unlit>> = {
  baseColor: { tex: 'baseColor', channel: -1, srgb: true },
  normal: { tex: 'normal', channel: -1 },
  height: { tex: 'heightWear', channel: 0 },
  roughness: { tex: 'orm', channel: 1 },
  metallic: { tex: 'orm', channel: 2 },
  ao: { tex: 'orm', channel: 0 },
  wearMask: { tex: 'heightWear', channel: 1 },
  rectId: { tex: 'rectId', channel: -1 },
  pieceId: { tex: 'pieceId', channel: -1 },
};

const v3 = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]);

/** Direction from the origin toward azimuth / elevation in degrees (azimuth 0 = +Z, the front; 90 = +X). */
function direction(azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

function faceGeometry(face: ShapeFace, fit: HotspotFit): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(face.corners.flat(), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 2, 3].flatMap(() => face.normal), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(fit.uv.flat(), 2));
  // The corners run CCW seen from the normal's side.
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/**
 * Where the borders of a face's rect land on the face, as world segments: the lines u = rect u0 / u1 and
 * v = rect v0 / v1 inside the face's uv range (every repeat of them along a strip's tiling axis), clamped onto the
 * face, so an inset rect is outlined on the face edge.
 */
export function rectOutline(face: ShapeFace, fit: HotspotFit, layout: HotspotLayout): THREE.Vector3[] {
  const rect = layout.rects.find((r) => r.id === fit.rectId);
  if (!rect) return [];
  const bounds: [number, number][] = [
    [rect.x / layout.widthPx, (rect.x + rect.w) / layout.widthPx],
    [1 - (rect.y + rect.h) / layout.heightPx, 1 - rect.y / layout.heightPx],
  ];
  const [p0, p1, , p3] = face.corners.map(v3);
  const lift = v3(face.normal).multiplyScalar(LINE_LIFT_M);
  const along = p1.clone().sub(p0);
  const up = p3.clone().sub(p0);
  const at = (s: number, t: number) => p0.clone().addScaledVector(along, s).addScaledVector(up, t).add(lift);
  const out: THREE.Vector3[] = [];
  for (const k of [0, 1] as const) {
    const base = fit.uv[0][k];
    // uv runs along exactly one face axis per atlas axis (the mapping is axis-aligned, maybe turned 90 degrees).
    const ds = fit.uv[1][k] - base;
    const dt = fit.uv[3][k] - base;
    const onS = Math.abs(ds) >= Math.abs(dt);
    const slope = onS ? ds : dt;
    if (slope === 0) continue;
    const lo = Math.min(base, base + slope);
    const hi = Math.max(base, base + slope);
    const [r0, r1] = bounds[k];
    const tol = 0.25 * (r1 - r0) + 1e-9;
    const repeats = fit.tiled ? [Math.floor(lo - r1), Math.ceil(hi - r0)] : [0, 0];
    const seen = new Set<number>();
    for (let n = repeats[0]; n <= repeats[1]; n++) {
      for (const edge of [r0 + n, r1 + n]) {
        if (edge < lo - tol || edge > hi + tol) continue;
        const f = Math.min(1, Math.max(0, (Math.min(hi, Math.max(lo, edge)) - base) / slope));
        const key = Math.round(f * 1e6);
        if (seen.has(key)) continue;
        seen.add(key);
        if (onS) out.push(at(f, 0), at(f, 1));
        else out.push(at(0, f), at(1, f));
      }
    }
  }
  return out;
}

/** What a face of the shape on screen shows (debug and tests). */
export interface FaceOnScreen {
  rectId: string;
  normal: [number, number, number];
  uv: HotspotFit['uv'];
  tiled: boolean;
  /** Corners in canvas CSS pixels, top-left origin. */
  screen: [number, number][];
  /** The face's front side looks at the camera. */
  facing: boolean;
}

/**
 * The three.js side of the 3D view: one WebGL renderer, a test shape (one mesh per face, uv from the hotspot fit) and
 * the atlas textures. It draws on demand (camera, light, texture, mode, shape or size change), never in a loop, and
 * not at all while its canvas is 0 × 0.
 */
export class View3DScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.02, 200);
  private readonly controls: OrbitControls;
  private readonly light = new THREE.DirectionalLight(0xffffff, DIRECTIONAL_INTENSITY);
  private readonly envTarget: THREE.WebGLRenderTarget;
  private readonly lit = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.8, metalness: 0 });
  private readonly unlit = new THREE.ShaderMaterial({
    vertexShader: UNLIT_VERTEX,
    fragmentShader: UNLIT_FRAGMENT,
    uniforms: { map: { value: null }, channel: { value: -1 }, srgb: { value: false }, hasMap: { value: false } },
  });
  private readonly lineMaterial = new THREE.LineBasicMaterial({ color: ACCENT, toneMapped: false });
  private readonly shape = new THREE.Group();
  private lines: THREE.LineSegments | null = null;
  private meshes: THREE.Mesh[] = [];
  private textures: AtlasTextureSet | null = null;
  private mode: View3dMode = 'lit';
  private width = 0;
  private height = 0;
  private frame = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    view3dDebug.renderers++;
    view3dDebug.scene = this;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.scene.background = new THREE.Color(BACKGROUND);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    this.scene.add(this.light, this.shape);
    this.lit.normalScale.copy(NORMAL_SCALE);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener('change', () => this.requestRender());
  }

  /** Canvas size in CSS pixels; 0 × 0 (a hidden pane) stops drawing until a real size comes back. */
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** Shows a texture set (null: none); the caller disposes the previous one after this. */
  setTextures(set: AtlasTextureSet | null): void {
    this.textures = set;
    if (set) for (const t of textureList(set)) this.renderer.initTexture(t);
    const m = this.lit;
    m.map = set?.baseColor ?? null;
    m.normalMap = set?.normal ?? null;
    m.roughnessMap = m.metalnessMap = m.aoMap = set?.orm ?? null;
    m.color.set(set ? 0xffffff : 0x808080);
    m.roughness = set ? 1 : 0.8;
    m.metalness = set ? 1 : 0;
    m.needsUpdate = true;
    this.applyMode();
  }

  /** The textures were re-filtered (point filter): upload and draw again. */
  texturesChanged(): void {
    this.requestRender();
  }

  setMode(mode: View3dMode): void {
    this.mode = mode;
    this.applyMode();
  }

  setLight(azimuthDeg: number, elevationDeg: number): void {
    this.light.position.copy(direction(azimuthDeg, elevationDeg).multiplyScalar(10));
    this.requestRender();
  }

  /** Replaces the shape: one mesh per face with its fit's uv, and the rect outlines. */
  setShape(faces: readonly ShapeFace[], fits: readonly HotspotFit[], layout: HotspotLayout | null): void {
    this.clearShape();
    const outline: THREE.Vector3[] = [];
    faces.forEach((face, i) => {
      const mesh = new THREE.Mesh(faceGeometry(face, fits[i]), this.lit);
      mesh.userData = { rectId: fits[i].rectId, face, fit: fits[i] };
      this.meshes.push(mesh);
      this.shape.add(mesh);
      if (layout) outline.push(...rectOutline(face, fits[i], layout));
    });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(outline), this.lineMaterial);
    this.shape.add(this.lines);
    this.applyMode();
  }

  /** Frames the whole shape; the corridor, seen from inside, is framed from inside its open end. */
  fit(shape: TestShape): void {
    const box = new THREE.Box3();
    for (const m of this.meshes) box.expandByObject(m);
    if (box.isEmpty()) return;
    if (shape === 'corridor') {
      const c = box.getCenter(new THREE.Vector3());
      this.controls.target.set(c.x, 1.5, c.z);
      this.camera.position.set(c.x + 0.3, 1.6, box.max.z - 0.1);
    } else {
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
      const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
      const dist = (sphere.radius / Math.sin(Math.min(vHalf, hHalf))) * 1.05;
      this.controls.target.copy(sphere.center);
      this.camera.position.copy(sphere.center).addScaledVector(direction(VIEW_AZIMUTH_DEG, VIEW_ELEVATION_DEG), dist);
    }
    this.controls.update();
    this.requestRender();
  }

  /** Rect id of the face under a client-space point, or null. */
  pick(clientX: number, clientY: number): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.meshes, false)[0];
    return hit ? (hit.object.userData.rectId as string) : null;
  }

  /** Each face's rect and where its corners are on screen (debug and tests). */
  facesOnScreen(): FaceOnScreen[] {
    this.camera.updateMatrixWorld();
    return this.meshes.map((m) => {
      const face = m.userData.face as ShapeFace;
      const fit = m.userData.fit as HotspotFit;
      const screen = face.corners.map((c): [number, number] => {
        const p = v3(c).project(this.camera);
        return [((p.x + 1) / 2) * this.width, ((1 - p.y) / 2) * this.height];
      });
      const toCamera = this.camera.position.clone().sub(v3(face.corners[0]));
      return { rectId: fit.rectId, normal: face.normal, uv: fit.uv, tiled: fit.tiled, screen, facing: toCamera.dot(v3(face.normal)) > 0 };
    });
  }

  /** Textures the renderer holds on the GPU. */
  get gpuTextures(): number {
    return this.renderer.info.memory.textures;
  }

  requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    if (this.disposed || this.width === 0 || this.height === 0) return;
    this.renderer.render(this.scene, this.camera);
    view3dDebug.frames++;
  }

  private applyMode(): void {
    const unlit = UNLIT[this.mode];
    const material = unlit ? this.unlit : this.lit;
    if (unlit) {
      const u = this.unlit.uniforms;
      const tex = this.textures ? this.textures[unlit.tex] : null;
      u.map.value = tex;
      u.hasMap.value = tex !== null;
      u.channel.value = unlit.channel;
      u.srgb.value = !!unlit.srgb;
    }
    for (const m of this.meshes) m.material = material;
    if (this.lines) this.lines.visible = this.mode === 'rects';
    this.requestRender();
  }

  private clearShape(): void {
    for (const m of this.meshes) m.geometry.dispose();
    this.lines?.geometry.dispose();
    this.shape.clear();
    this.meshes = [];
    this.lines = null;
  }

  /**
   * Renders a 1 × 2 test texture pair through the same upload path and lit material settings, to check the row flip
   * and the normal map convention: the top row's normal leans toward +v (up), the bottom row's toward −v, and the
   * light comes from above. Returns the mean grey of the top and bottom halves lit, and their unlit colour (the colour
   * texture's top row is red, its bottom row blue).
   */
  probe(): { litTop: number; litBottom: number; colorTop: number[]; colorBottom: number[] } {
    const size = 16;
    const target = new THREE.WebGLRenderTarget(size, size);
    const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10);
    camera.position.z = 1;
    const tilt = (y: number) => [128, Math.round((y * 0.5 + 0.5) * 255), Math.round((0.8 * 0.5 + 0.5) * 255), 255];
    const normal = atlasTexture({ width: 1, height: 2, data: new Uint8Array([...tilt(0.6), ...tilt(-0.6)]) }, false);
    const colour = atlasTexture({ width: 1, height: 2, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) }, true);
    for (const t of [normal, colour]) {
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
    }
    const lit = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1, metalness: 0, normalMap: normal });
    lit.normalScale.copy(NORMAL_SCALE);
    const flat = new THREE.MeshBasicMaterial({ map: colour });
    const plane = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh<THREE.PlaneGeometry, THREE.Material>(plane, lit);
    const light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(0, 1, 0.3);
    const scene = new THREE.Scene();
    scene.add(mesh, light);
    const px = new Uint8Array(size * size * 4);
    /** Mean RGB of the top and bottom halves (readPixels rows run bottom-up). */
    const halves = () => {
      this.renderer.setRenderTarget(target);
      this.renderer.render(scene, camera);
      this.renderer.setRenderTarget(null);
      this.renderer.readRenderTargetPixels(target, 0, 0, size, size, px);
      const mean = (y0: number, y1: number) => [0, 1, 2].map((c) => {
        let s = 0;
        for (let y = y0; y < y1; y++) for (let x = 0; x < size; x++) s += px[(y * size + x) * 4 + c];
        return s / ((y1 - y0) * size);
      });
      return { top: mean(size / 2, size), bottom: mean(0, size / 2) };
    };
    const litHalves = halves();
    mesh.material = flat;
    const colourHalves = halves();
    for (const t of [normal, colour]) releaseTexture(t);
    lit.dispose();
    flat.dispose();
    plane.dispose();
    target.dispose();
    const grey = (c: number[]) => (c[0] + c[1] + c[2]) / 3;
    return {
      litTop: grey(litHalves.top), litBottom: grey(litHalves.bottom),
      colorTop: colourHalves.top, colorBottom: colourHalves.bottom,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.clearShape();
    this.controls.dispose();
    this.lit.dispose();
    this.unlit.dispose();
    this.lineMaterial.dispose();
    this.envTarget.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    view3dDebug.renderers--;
    if (view3dDebug.scene === this) view3dDebug.scene = null;
  }
}
