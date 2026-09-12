/**
 * Real avatar previews (owner, 2026-09-10: "let it give real previews").
 *
 * The deck used to show a coloured monogram per character because no thumbnail
 * existed anywhere (VRoid Hub thumbnails are only fetchable at enroll time and
 * most of this roster predates that). So we render one OURSELVES: load the
 * character's own model.vrm into an offscreen WebGL renderer, frame the head
 * with the humanoid head bone (a bounding box includes hair, tails and props
 * and frames oddly), and paint it over the same hue gradient the tile uses.
 *
 * One render at a time, module-level queue — each load is a 10-30 MB VRM and
 * parallel loads fight for the GPU. Results are cached by the CALLER (main
 * writes characters/<slug>/thumbnail.jpg), so this runs once per character,
 * ever.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const SIZE = 256;
const THUMB_QUALITY = 0.86;
// Roster models run to 66 MB and a pathological GLB can leave loadAsync
// pending forever — measured 2026-09-11, the serialized queue stalled at 5 of
// 62 with no error (a resolved-never promise is invisible in a catch chain).
// A timeout turns "one bad model" back into "one missing preview".
// 180s: the big VRoid exports (60 MB+) genuinely take minutes to fetch, parse
// and texture-decode on a box that is also running the avatar — a tight
// timeout would trade a stall for a permanently tile-only character.
const LOAD_TIMEOUT_MS = 180_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Same stable hue the card tiles use (Deck.tsx avatarHue) so a card whose
 *  preview has not rendered yet keeps the EXACT colour it will land on. */
function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function renderSceneToDataUrl(source: HTMLCanvasElement | THREE.WebGLRenderer, hue: number): string {
  const webglCanvas = source instanceof THREE.WebGLRenderer ? source.domElement : source;
  const composite = document.createElement('canvas');
  composite.width = SIZE;
  composite.height = SIZE;
  const ctx = composite.getContext('2d');
  if (!ctx) return '';
  const gradient = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  gradient.addColorStop(0, `hsl(${hue} 55% 46%)`);
  gradient.addColorStop(1, `hsl(${(hue + 38) % 360} 60% 30%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(webglCanvas, 0, 0, SIZE, SIZE);
  return composite.toDataURL('image/jpeg', THUMB_QUALITY);
}

/** ONE rig for the whole session, reused across renders.
 *
 *  A fresh WebGLRenderer per character was the first design and it STALLED at
 *  ~40 previews (measured 2026-09-11): every context costs GPU-process state,
 *  and Chromium caps live contexts, so later creations failed silently and
 *  every remaining card kept its monogram tile — "nothing" for a reason other
 *  than there being nothing. One context, cleared between models, also skips
 *  the per-render context setup entirely. */
interface ThumbRig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}
let rig: ThumbRig | null = null;

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}

function getRig(): ThumbRig {
  if (rig) return rig;
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(0.6, 1.4, 1.6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9db8ff, 0.7);
  rim.position.set(-0.9, 0.9, -1.2);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 30);
  rig = { renderer, scene, camera };
  return rig;
}

/** Render one VRM into a square JPEG data URL. Resolves null on ANY failure —
 *  a character that will not load must cost its own preview, not the deck. */
async function renderOne(name: string, url: string): Promise<string | null> {
  const { renderer, scene, camera } = getRig();
  let added: THREE.Object3D | null = null;

  try {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await withTimeout(loader.loadAsync(url), LOAD_TIMEOUT_MS, `load ${name}`);
    const vrm = (gltf.userData as { vrm?: import('@pixiv/three-vrm').VRM }).vrm;
    if (!vrm) return null;

    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.rotateVRM0(vrm);
    scene.add(vrm.scene);
    added = vrm.scene;
    vrm.update(0);
    scene.updateMatrixWorld(true);

    // Frame the head from the HUMANOID BONE, never a bounding box: hair,
    // tails, wings and weapons all inflate the box and put the face at the
    // edge of the frame (measured on siren-head and the kitsune models).
    const head = vrm.humanoid?.getNormalizedBoneNode('head');
    const target = new THREE.Vector3();
    if (head) {
      head.getWorldPosition(target);
      target.y += 0.035;
    } else {
      const box = new THREE.Box3().setFromObject(vrm.scene);
      target.set(0, box.min.y + (box.max.y - box.min.y) * 0.9, 0);
    }
    camera.position.set(target.x, target.y + 0.01, target.z + 0.72);
    camera.lookAt(target.x, target.y - 0.02, target.z);

    renderer.render(scene, camera);
    const dataUrl = renderSceneToDataUrl(renderer, hueFor(name));
    scene.remove(vrm.scene);
    disposeObject(vrm.scene);
    added = null;
    return dataUrl;
  } catch (error) {
    console.warn(`[desk] thumbnail render failed for ${name}`, error);
    if (added) {
      scene.remove(added);
      disposeObject(added);
    }
    // A lost context poisons every later render — drop the rig so the next
    // character builds a fresh one instead of failing on a dead GL object.
    if (renderer.getContext()?.isContextLost?.()) {
      renderer.dispose();
      rig = null;
    }
    return null;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Serialized entry point: every request queues behind the previous one. */
export function renderVrmThumbnail(name: string, url: string): Promise<string | null> {
  const result = queue.then(() => renderOne(name, url));
  queue = result.catch(() => undefined);
  return result;
}
