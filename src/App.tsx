import { useCallback, useEffect, useRef, useState } from 'react';
import { Scene } from './components/Scene';
import type { AnimationType } from './animation-catalog';
import {
  finishBodyAnimationOverride,
  resolveBodyAnimation,
  type BodyAnimationOverride,
  type AnimationValue,
} from './animation-priority';

const INITIAL_STATE: VoiceState = {
  activity: 'idle',
  microphoneMuted: false,
  outputMuted: false,
  phase: 'inactive',
};

const BODY_IDLE_DELAY_MS = 650;

/** Detached-avatar windows (electron/detached-avatar-window.cjs) load this SAME bundle
 *  with `?solo=<modelUrl>` set, instead of a separate render path — one pipeline for
 *  both the shared scene and a solo detached window. Read once; the URL never changes
 *  after a detached window loads. */
function getSoloModelUrl(): string | null {
  const raw = new URLSearchParams(window.location.search).get('solo');
  return raw ? decodeURIComponent(raw) : null;
}

export function App() {
  const soloModelUrl = useRef(getSoloModelUrl()).current;
  const [voice, setVoice] = useState<VoiceState>(INITIAL_STATE);
  const [audioLevel, setAudioLevel] = useState(0);
  const [voiceAnimation, setVoiceAnimation] = useState<AnimationType>('IDLE');
  const [bodyOverride, setBodyOverride] =
    useState<BodyAnimationOverride | null>(null);
  const [talkTurn, setTalkTurn] = useState(0);
  const [extraSlots, setExtraSlots] = useState<Array<{ slotId: string; modelUrl: string }>>([]);
  const previousPhase = useRef<VoicePhase>('inactive');
  const previousSpeaking = useRef(false);

  useEffect(() => {
    const bridge = window.personaBridge;
    if (!bridge) return;
    void bridge.getSnapshot().then((event) => {
      if (event?.type === 'state') setVoice(event.state);
    });
    return bridge.subscribe((event) => {
      if (event.type === 'state') {
        setVoice(event.state);
      } else if (event.type === 'audio-level') {
        setAudioLevel(event.level);
      } else if (event.type === 'animation') {
        if (event.source === 'mcp' && event.requestId != null) {
          setBodyOverride({
            animation: event.animation,
            requestId: event.requestId,
          });
        } else if (typeof event.animation === 'string' && event.animation.startsWith('FILE:')) {
          // FILE: animations are one-shots, treat like MCP overrides
          setBodyOverride({
            animation: event.animation,
            requestId: Math.random(),
          });
        } else {
          setVoiceAnimation(event.animation as AnimationType);
        }
      } else if (event.type === 'spawn-avatar') {
        // Idempotent by slotId: main replays every tracked slot on each
        // snapshot pull (that is how slots survive the window reload a
        // character switch does), so the same slot can legitimately arrive
        // more than once — appending unconditionally would duplicate it.
        setExtraSlots((current) =>
          current.some((slot) => slot.slotId === event.slotId)
            ? current
            : [...current, { slotId: event.slotId, modelUrl: event.modelUrl }],
        );
      } else if (event.type === 'remove-avatar') {
        setExtraSlots((current) =>
          current.filter((slot) => slot.slotId !== event.slotId),
        );
      }
    });
  }, []);

  const speaking =
    voice.phase === 'active' &&
    voice.activity === 'speaking' &&
    !voice.outputMuted;

  useEffect(() => {
    const startedSpeaking = speaking && !previousSpeaking.current;
    previousSpeaking.current = speaking;
    if (startedSpeaking) setTalkTurn((turn) => turn + 1);

    if (voice.phase === 'active' && previousPhase.current !== 'active') {
      setVoiceAnimation('GREETING');
      const timer = window.setTimeout(
        () => setVoiceAnimation(voice.activity === 'speaking' ? 'TALK' : 'IDLE'),
        2600,
      );
      previousPhase.current = voice.phase;
      return () => window.clearTimeout(timer);
    }
    previousPhase.current = voice.phase;

    if (voice.phase !== 'active' || voice.outputMuted) {
      setVoiceAnimation('IDLE');
      setAudioLevel(0);
      return;
    }

    if (voice.activity === 'speaking' && !voice.outputMuted) {
      setVoiceAnimation('TALK');
      return;
    }

    const timer = window.setTimeout(
      () => setVoiceAnimation('IDLE'),
      BODY_IDLE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [speaking, voice.activity, voice.outputMuted, voice.phase]);

  const animation = resolveBodyAnimation(voiceAnimation, bodyOverride);
  const animationRequest =
    bodyOverride?.requestId ?? (animation === 'TALK' ? talkTurn : 0);
  const overrideRequestId = bodyOverride?.requestId ?? null;
  const handleAnimationComplete = useCallback(() => {
    if (overrideRequestId == null) return;
    setBodyOverride((current) =>
      finishBodyAnimationOverride(current, overrideRequestId),
    );
  }, [overrideRequestId]);

  return (
    <main className="app">
      {/* D-2170 follow-up: making the whole canvas a drag region (so the
          frameless window could be moved at all) swallowed right-click
          (Characters/Talk/Quit menu), OrbitControls rotate-drag AND native
          Windows edge-resize — all of it routes through the same OS
          non-client-area handling as an app-region drag, so the canvas has
          to stay a real interactive surface. This is a dedicated, separate
          drag handle instead: a thin strip along the top edge only. */}
      <div className="drag-handle" />
      <Scene
        animation={animation}
        animationRequest={animationRequest}
        audioLevel={audioLevel}
        onAnimationComplete={handleAnimationComplete}
        playback={bodyOverride ? 'once' : 'loop'}
        speaking={speaking}
        extraSlots={extraSlots}
        modelUrl={soloModelUrl ?? undefined}
      />
    </main>
  );
}
