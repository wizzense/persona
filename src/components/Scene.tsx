import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import { Environment, OrbitControls } from '@react-three/drei';
import dawnEnvironment from '@pmndrs/assets/hdri/dawn.exr';
import * as THREE from 'three';
import { Avatar } from './Avatar';
import type { AnimationType } from '../animation-catalog';
import { calculateFullBodyFraming } from '../camera-framing';

interface SceneProps {
  animation: AnimationType | string;
  animationRequest: number;
  audioLevel: number;
  onAnimationComplete: () => void;
  playback: 'loop' | 'once';
  speaking: boolean;
}

interface TargetControls {
  target: THREE.Vector3;
  update: () => void;
}

function supportsTarget(controls: unknown): controls is TargetControls {
  if (!controls || typeof controls !== 'object') return false;
  const candidate = controls as Partial<TargetControls>;
  return candidate.target instanceof THREE.Vector3 &&
    typeof candidate.update === 'function';
}

function FullBodyCamera({ object }: { object: THREE.Object3D | null }) {
  const getThreeState = useThree((state) => state.get);
  const controlsReady = useThree((state) => Boolean(state.controls));
  const framedObject = useRef<THREE.Object3D | null>(null);

  useLayoutEffect(() => {
    const { camera, controls } = getThreeState();
    if (
      !object ||
      framedObject.current === object ||
      !(camera instanceof THREE.PerspectiveCamera) ||
      !supportsTarget(controls)
    ) {
      return;
    }

    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const framing = calculateFullBodyFraming(
      box,
      camera.fov,
      camera.aspect,
      1.12,
      1.5,
    );
    camera.position.copy(framing.position);
    camera.near = Math.max(0.01, framing.distance / 100);
    camera.far = Math.max(100, framing.distance * 100);
    camera.lookAt(framing.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    controls.target.copy(framing.target);
    controls.update();
    framedObject.current = object;
  }, [controlsReady, getThreeState, object]);

  return null;
}

export function Scene(props: SceneProps) {
  const [avatarScene, setAvatarScene] = useState<THREE.Object3D | null>(null);
  const handleAvatarReady = useCallback((scene: THREE.Object3D) => {
    setAvatarScene(scene);
  }, []);

  return (
    <Canvas
      camera={{ position: [0, 2, 4.8], fov: 20 }}
      dpr={[1, 1.5]}
      gl={{
        antialias: true,
        alpha: true,
        toneMapping: THREE.NoToneMapping,
        outputColorSpace: THREE.SRGBColorSpace,
      }}
      style={{ background: 'transparent' }}
    >
      <directionalLight
        color={[1, 1, 1]}
        position={[-3, 3, 3]}
        intensity={Math.PI}
      />
      <ambientLight
        color={[
          0.0036765073221525194,
          0.0036765073221525194,
          0.0036765073221525194,
        ]}
        intensity={Math.PI}
      />
      <Environment files={dawnEnvironment} />
      <FullBodyCamera object={avatarScene} />
      <Avatar {...props} onReady={handleAvatarReady} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        enablePan
        enableZoom
        minDistance={1.4}
        maxDistance={12}
        panSpeed={0.7}
        rotateSpeed={0.45}
        screenSpacePanning
        zoomSpeed={0.8}
      />
    </Canvas>
  );
}
