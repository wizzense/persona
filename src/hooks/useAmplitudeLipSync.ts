import { useCallback, useRef } from 'react';
import type { VRM } from '@pixiv/three-vrm';

const VISEMES = ['aa', 'ee', 'ih', 'oh', 'ou'] as const;

export function useAmplitudeLipSync(vrm: VRM | null) {
  const smoothed = useRef(0);
  const phase = useRef(0);
  // True once every viseme has been written back to 0: a silent body then skips
  // its five expression writes per frame (each marks the expression set dirty).
  const rested = useRef(false);

  return useCallback(
    (delta: number, level: number, speaking: boolean) => {
      if (!vrm?.expressionManager) return;
      const audible = speaking && level > 0.008;
      const normalized = audible ? Math.min(1, Math.max(0, level) * 2.8) : 0;
      const smoothing = 1 - Math.exp(-delta / (normalized > smoothed.current ? 0.055 : 0.1));
      smoothed.current += (normalized - smoothed.current) * smoothing;
      if (!audible && smoothed.current < 0.002) {
        if (rested.current) return;
        smoothed.current = 0;
        for (const viseme of VISEMES) vrm.expressionManager.setValue(viseme, 0);
        rested.current = true;
        return;
      }
      rested.current = false;
      phase.current += delta * (8 + smoothed.current * 9);
      const active = Math.floor(phase.current) % VISEMES.length;

      for (let index = 0; index < VISEMES.length; index += 1) {
        const shape = Math.max(0, 1 - Math.abs(index - active) * 0.72);
        const flutter = 0.74 + Math.sin(phase.current * 5.7 + index) * 0.18;
        vrm.expressionManager.setValue(
          VISEMES[index],
          Math.min(0.62, smoothed.current * shape * flutter),
        );
      }
    },
    [vrm],
  );
}
