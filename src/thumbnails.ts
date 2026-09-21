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
import { applyCustomise, type DeskCustomise } from './hooks/useVrmLoader';

const SIZE = 256;
const THUMB_QUALITY = 0.86;
/** The full-body frame (owner, 2026-09-20: rating a character by its HEAD
 *  crop under-judges the body -- the rater's vision pass reads this one when
 *  it exists). Portrait, whole model in frame from its bounding box.
 *
 *  768x1152, not 384x768, because this frame is no longer only a thumbnail:
 *  forge-art.py trains a per-character LoRA on it at 1024. A 384-wide source
 *  upscaled 2.7x has no face left in it -- measured 2026-09-20, char-417's
 *  first LoRA rendered a correctly-dressed figure with a blank head, which is
 *  a faithful reproduction of its dataset. The rating pass reads the same
 *  frame and only gets sharper. */
const BODY_W = 768;
const BODY_H = 1152;
type Frame = 'head' | 'body';

/** Bring the arms down before framing a full-body shot, and report whether it
 *  worked.
 *
 *  🚩 A T-POSE IS WHAT PUSHES THE CAMERA BACK, NOT THE CHARACTER'S HEIGHT.
 *  The body framing fits `max(size.y, size.x * (height / width))`. In a 2:3
 *  portrait frame a 1.4 m T-pose arm span therefore demands ~2.8 world-units
 *  of vertical extent to hold a 1.6 m character, so the model fills barely
 *  half the frame and its head lands at ~60 px. Measured 2026-09-20: that is
 *  why char-417's LoRA learned a faceless silhouette. Arms down cuts the span
 *  to roughly the shoulders and the camera comes in ~2x.
 *
 *  The SIGN of the rotation is rig-dependent, so this does not assume one: it
 *  tries a sign, measures the bounding box, and keeps whichever is narrower.
 *  A rig with no humanoid arm bones simply keeps its T-pose -- a wider frame
 *  is a worse dataset, not a failed render. */
function relaxArms(vrm: import('@pixiv/three-vrm').VRM): boolean {
  const left = vrm.humanoid?.getNormalizedBoneNode('leftUpperArm');
  const right = vrm.humanoid?.getNormalizedBoneNode('rightUpperArm');
  if (!left || !right) return false;
  const ANGLE = 1.15; // ~66 deg: arms beside the body, not clipping the coat
  const spanWith = (sign: number): number => {
    left.rotation.z = sign * ANGLE;
    right.rotation.z = -sign * ANGLE;
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(vrm.scene).getSize(new THREE.Vector3()).x;
  };
  const plus = spanWith(1);
  const minus = spanWith(-1);
  if (plus < minus) spanWith(1);
  return true;
}
/** A turntable shot: the body frame, rotated. Feeds a per-character LoRA --
 *  a likeness trained on one T-pose front shot is a vibe, not a character. */
const TURNTABLE_TAG = 'turn';
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

function renderSceneToDataUrl(
  source: HTMLCanvasElement | THREE.WebGLRenderer,
  hue: number,
  width = SIZE,
  height = SIZE,
): string {
  const webglCanvas = source instanceof THREE.WebGLRenderer ? source.domElement : source;
  const composite = document.createElement('canvas');
  composite.width = width;
  composite.height = height;
  const ctx = composite.getContext('2d');
  if (!ctx) return '';
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${hue} 55% 46%)`);
  gradient.addColorStop(1, `hsl(${(hue + 38) % 360} 60% 30%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(webglCanvas, 0, 0, width, height);
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
async function renderOne(name: string, url: string, frame: Frame = 'head', customise?: DeskCustomise, yaw = 0): Promise<string | null> {
  const { renderer, scene, camera } = getRig();
  let added: THREE.Object3D | null = null;
  // The one rig serves both frames: size it per render (cheap; no new context).
  const width = frame === 'body' ? BODY_W : SIZE;
  const height = frame === 'body' ? BODY_H : SIZE;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

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
    // A FORK is its base's mesh plus a recipe. Apply it BEFORE the framing
    // maths: the content rater judges this picture, and a variant judged on its
    // base's body is the wrong verdict on the wrong character.
    if (customise) applyCustomise(vrm, customise);
    // Turn the MODEL, not the camera: the lights stay put, so a turntable set
    // is lit consistently and the trainer learns the character rather than a
    // rotating key light.
    vrm.scene.rotation.y = yaw;
    // Arms down for the body frame only. The head frame is already cropped to
    // the head bone, so the arm span costs it nothing.
    if (frame === 'body') relaxArms(vrm);
    vrm.update(0);
    scene.updateMatrixWorld(true);

    // Frame the head from the HUMANOID BONE, never a bounding box: hair,
    // tails, wings and weapons all inflate the box and put the face at the
    // edge of the frame (measured on siren-head and the kitsune models).
    const target = new THREE.Vector3();
    if (frame === 'body') {
      // The whole model, from its box: the rater needs to SEE the outfit, and
      // a head crop is exactly what let a revealing body read as general.
      const box = new THREE.Box3().setFromObject(vrm.scene);
      const size = box.getSize(new THREE.Vector3());
      box.getCenter(target);
      const fit = Math.max(size.y, size.x * (height / width)) * 1.12;
      const distance = (fit / 2) / Math.tan((camera.fov * Math.PI) / 360);
      camera.position.set(target.x, target.y, target.z + Math.max(distance, 0.5));
      camera.lookAt(target);
    } else {
      const head = vrm.humanoid?.getNormalizedBoneNode('head');
      if (head) {
        head.getWorldPosition(target);
        target.y += 0.035;
      } else {
        const box = new THREE.Box3().setFromObject(vrm.scene);
        target.set(0, box.min.y + (box.max.y - box.min.y) * 0.9, 0);
      }
      camera.position.set(target.x, target.y + 0.01, target.z + 0.72);
      camera.lookAt(target.x, target.y - 0.02, target.z);
    }

    renderer.render(scene, camera);
    const dataUrl = renderSceneToDataUrl(renderer, hueFor(name), width, height);
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
  const result = queue.then(() => renderOne(name, url, 'head'));
  queue = result.catch(() => undefined);
  return result;
}

/** The same queue, whole model in a portrait frame (characters/<slug>/fullbody.jpg).
 *  `customise` is a fork's recipe, applied before the shot. */
export function renderVrmFullBody(name: string, url: string, customise?: DeskCustomise): Promise<string | null> {
  const result = queue.then(() => renderOne(name, url, 'body', customise));
  queue = result.catch(() => undefined);
  return result;
}

/** One turntable shot at `yaw` radians. Same queue and the same one rig, so a
 *  66-character turntable is still one WebGL context (see getRig's note). */
export function renderVrmTurntable(
  name: string, url: string, yaw: number, customise?: DeskCustomise,
): Promise<string | null> {
  const result = queue.then(() => renderOne(name, url, 'body', customise, yaw));
  queue = result.catch(() => undefined);
  return result;
}
void TURNTABLE_TAG;
