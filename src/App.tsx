import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { Scene } from './components/Scene';
import { Deck } from './components/Deck';
import { ChatView } from './components/ChatView';
import { Beads } from './components/Beads';
import type { AnimationType } from './animation-catalog';
import {
  finishBodyAnimationOverride,
  resolveBodyAnimation,
  type BodyAnimationOverride,
} from './animation-priority';

const INITIAL_STATE: VoiceState = {
  activity: 'idle',
  microphoneMuted: false,
  outputMuted: false,
  phase: 'inactive',
};

const BODY_IDLE_DELAY_MS = 650;

/** Play a base64 audio verdict through the avatar. Sets the voice state to
 *  speaking for the duration (TALK animation) and streams the analyser RMS
 *  into audioLevel (lip sync). Fail-soft: playback trouble drops the audio,
 *  never the verdict row the deck already rendered. */
async function playSpoken(
  audioBase64: string,
  setVoice: Dispatch<SetStateAction<VoiceState>>,
  setAudioLevel: (level: number) => void,
  ctxRef: MutableRefObject<AudioContext | null>,
): Promise<void> {
  try {
    ctxRef.current?.close().catch(() => {});
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    const bin = atob(audioBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buffer = await ctx.decodeAudioData(bytes.buffer);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    setVoice((current) => ({ ...current, phase: 'active', activity: 'speaking' }));
    source.start();
    const samples = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (ctxRef.current !== ctx) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const d = (samples[i] - 128) / 128;
        sum += d * d;
      }
      setAudioLevel(Math.min(1, Math.sqrt(sum / samples.length) * 5));
      requestAnimationFrame(tick);
    };
    source.onended = () => {
      setAudioLevel(0);
      setVoice((current) => ({ ...current, activity: 'idle' }));
      ctxRef.current = null;
      void ctx.close().catch(() => {});
    };
    requestAnimationFrame(tick);
  } catch {
    // Playback failed — the deck row already carries the verdict text.
  }
}

/** Detached-avatar windows (electron/detached-avatar-window.cjs) load this SAME bundle
 *  with `?solo=<modelUrl>` set, instead of a separate render path — one pipeline for
 *  both the shared scene and a solo detached window. Read once; the URL never changes
 *  after a detached window loads. */
function getSoloModelUrl(): string | null {
  const raw = new URLSearchParams(window.location.search).get('solo');
  return raw ? decodeURIComponent(raw) : null;
}

export function App() {
  // `?deck=1` loads the Desk panel instead of the avatar scene — the "full
  // UI/UX" that opens on right-click (owner redesign 2026-08-25). Same bundle,
  // same bridge, so the panel is a second window over the SAME app, never a
  // second app.
  //
  // App is a pure router: it reads the URL ONCE (lazy state, not a ref read
  // during render) and renders exactly one subtree. The scene hooks below
  // used to live here after a conditional early-return, which violates the
  // rules of hooks — a window that ever flipped modes would have corrupted
  // hook state (measured lint class, 2026-08-25).
  // ONE hook, read before any return: the second useState used to sit after the
  // deck early-return, the exact rules-of-hooks break the note above describes.
  const [mode] = useState<'deck' | 'chat' | 'avatar'>(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('deck') === '1') return 'deck';
    return query.get('chat') === '1' ? 'chat' : 'avatar';
  });
  if (mode === 'deck') return <Deck />;
  if (mode === 'chat') return <ChatView />;
  return <AvatarSceneApp />;
}

/** The avatar window: the scene, the beads, and the voice/animation state. */
function AvatarSceneApp() {
  const [soloModelUrl] = useState(getSoloModelUrl);
  const [voice, setVoice] = useState<VoiceState>(INITIAL_STATE);
  const [audioLevel, setAudioLevel] = useState(0);
  const [voiceAnimation, setVoiceAnimation] = useState<AnimationType>('IDLE');
  const [bodyOverride, setBodyOverride] =
    useState<BodyAnimationOverride | null>(null);
  const [talkTurn, setTalkTurn] = useState(0);
  const [extraSlots, setExtraSlots] = useState<Array<{ slotId: string; modelUrl: string }>>([]);
  const previousPhase = useRef<VoicePhase>('inactive');
  const previousSpeaking = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const bridge = window.deskBridge;
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
      } else if (event.type === 'speak') {
        // Drop-to-avatar (2026-08-29): main TTS'd a verdict and handed the
        // audio over. Play it through Web Audio and drive the SAME audioLevel
        // + voice-state props the scene already renders — lip sync and the
        // TALK animation come from the existing pipeline, no new render path.
        void playSpoken(event.audioBase64, setVoice, setAudioLevel, audioCtxRef);
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
      {/* Follow-up: making the whole canvas a drag region (so the
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
      {/* Floating beads — the notification badge + quick actions that live ON
          the avatar box. Not in solo mode: a detached single-character window
          is a view of one avatar, not the desk. */}
      {soloModelUrl ? null : <Beads />}
    </main>
  );
}
