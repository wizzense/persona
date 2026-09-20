import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import { createPushToTalk } from './voice/pushToTalk';
import { Scene } from './components/Scene';
import { clearLevel, setLevel } from './hooks/voiceLevels';
import { speechGain } from './speech-gain';
import { bubbleDurationMs, bubbleText, type SpeechBubble } from './speech-bubble';
import { Deck } from './components/Deck';
import { ChatView } from './components/ChatView';
import { Beads } from './components/Beads';
import { renderVrmFullBody } from './thumbnails';
import type { AnimationType } from './animation-catalog';
import {
  bridgeAnimationOverride,
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
  volume?: number,
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
    // The fader sits AFTER the analyser on purpose: lip sync reads the signal
    // at full scale, so an agent turned down to 0.2 still moves its mouth like
    // it is talking instead of mumbling in proportion to the owner's volume.
    const gain = ctx.createGain();
    gain.gain.value = speechGain(volume);
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);
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
  // ONE hook, then the returns: a second useState after `if (isDeck) return`
  // was itself the conditional-hook shape this comment warns about (lint
  // measured it again 2026-09-18).
  const [mode] = useState<'deck' | 'chat' | 'avatar'>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('deck') === '1') return 'deck';
    if (params.get('chat') === '1') return 'chat';
    return 'avatar';
  });
  if (mode === 'deck') return <Deck />;
  if (mode === 'chat') return <ChatView />;
  return <AvatarSceneApp />;
}

/** The avatar window: the scene, the beads, and the voice/animation state. */
function AvatarSceneApp() {
  const [soloModelUrl] = useState(getSoloModelUrl);
  const [voice, setVoice] = useState<VoiceState>(INITIAL_STATE);
  const [voiceAnimation, setVoiceAnimation] = useState<AnimationType>('IDLE');
  const [bodyOverride, setBodyOverride] =
    useState<BodyAnimationOverride | null>(null);
  const [talkTurn, setTalkTurn] = useState(0);
  const [extraSlots, setExtraSlots] = useState<Array<{ slotId: string; modelUrl: string }>>([]);
  // Per-slot mouth state for spawned avatars (the room stage): level + speaking.
  const [slotVoices, setSlotVoices] = useState<Record<string, { level: number; speaking: boolean }>>({});
  const previousPhase = useRef<VoicePhase>('inactive');
  const previousSpeaking = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // One playback context per stage body: a new utterance for a slot closes that
  // slot's previous one instead of stacking contexts and rAF loops.
  const slotAudioRefs = useRef(new Map<string, { current: AudioContext | null }>());
  // What each body is saying, as text. One bubble per slot: a new line from the
  // same speaker REPLACES its bubble (and restarts its timer) rather than
  // stacking, which is what keeps a chatty agent from papering over the stage.
  const [bubbles, setBubbles] = useState<Record<string, SpeechBubble>>({});
  const bubbleTimers = useRef(new Map<string, number>());
  const bubbleSeq = useRef(0);
  useEffect(() => {
    const timers = bubbleTimers.current;
    return () => {
      for (const id of timers.values()) window.clearTimeout(id);
      timers.clear();
    };
  }, []);

  // Push-to-talk, driven by main (tray item, palette, global hotkey). Built once
  // and kept in a ref: a recorder rebuilt on every render would lose the stream
  // it is holding.
  const talkRef = useRef<ReturnType<typeof createPushToTalk> | null>(null);
  if (!talkRef.current && typeof window !== 'undefined') {
    talkRef.current = createPushToTalk({
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      makeRecorder: (stream, mime) => new MediaRecorder(stream, { mimeType: mime }),
      encode: async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (const b of bytes) binary += String.fromCharCode(b);
        return btoa(binary);
      },
      transcribe: (base64, format) =>
        window.deskBridge?.voiceTranscribe?.(base64, format) ?? Promise.resolve(''),
      deliver: (text) => { void window.deskBridge?.voiceHeard?.(text); },
      onState: (state) => window.deskBridge?.voiceListenState?.(state),
      onError: (message) => window.deskBridge?.voiceListenState?.(`error: ${message}`),
    });
  }

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
        // A per-frame SIGNAL, not UI state: the body reads it in useFrame.
        setLevel('slot0', event.level);
      } else if (event.type === 'animation') {
        if (event.source === 'mcp' && event.requestId != null) {
          setBodyOverride({
            animation: event.animation,
            requestId: event.requestId,
          });
        } else {
          // Bridge-posted (no MCP requestId): only IDLE/TALK may take over the
          // looping voice slot. GREETING/HAPPY/DANCE/FILE: are one-shots that
          // clear themselves — a looping GREETING walked the avatar in from
          // off-screen every ~4.5 s forever (2026-09-10).
          const override = bridgeAnimationOverride(event.animation);
          if (override) setBodyOverride(override);
          else setVoiceAnimation(event.animation as AnimationType);
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
        clearLevel(event.slotId);
        slotAudioRefs.current.get(event.slotId)?.current?.close().catch(() => {});
        slotAudioRefs.current.delete(event.slotId);
        // A body that left takes its caption with it: slot ids are REUSED, so a
        // lingering bubble would appear over whoever spawns into the id next.
        const gone = event.slotId;
        const pending = bubbleTimers.current.get(gone);
        if (pending !== undefined) window.clearTimeout(pending);
        bubbleTimers.current.delete(gone);
        setBubbles((current) => {
          if (!(gone in current)) return current;
          const next = { ...current };
          delete next[gone];
          return next;
        });
      } else if (event.type === 'capture-roster') {
        // The content rater asked main for a full-body frame of each model
        // (POST /roster/capture). Rendered offscreen on thumbnails.ts's one
        // serialized rig and handed back file by file; a model that will not
        // load costs its own frame, never the batch. Fire-and-forget: main
        // counts the saves (GET /roster/capture) and the rater polls it.
        const api = (window.deskBridge as unknown as {
          deck?: { saveCharacterFullBody?: (name: string, dataUrl: string) => Promise<boolean> };
        }).deck;
        const list = Array.isArray(event.characters) ? event.characters : [];
        for (const item of list) {
          if (!item || typeof item.name !== 'string' || typeof item.modelUrl !== 'string') continue;
          void renderVrmFullBody(item.name, item.modelUrl).then((dataUrl) => {
            if (dataUrl) void api?.saveCharacterFullBody?.(item.name, dataUrl);
          });
        }
      } else if (event.type === 'listen') {
        // Slice C. The recorder lives outside React (src/voice/pushToTalk.ts) so
        // the mic is released on every exit path, including a throw from the
        // gateway -- a stream left open keeps the OS mic light on, which reads
        // as "it is still listening to me".
        if (event.listening) void talkRef.current?.start();
        else talkRef.current?.stop();
      } else if (event.type === 'bubble') {
        const text = bubbleText(event.text);
        if (!text) return;
        const slotId = event.slotId || 'slot0';
        bubbleSeq.current += 1;
        const seq = bubbleSeq.current;
        setBubbles((current) => ({ ...current, [slotId]: { text, muted: Boolean(event.muted), seq } }));
        const timers = bubbleTimers.current;
        const previous = timers.get(slotId);
        if (previous !== undefined) window.clearTimeout(previous);
        timers.set(
          slotId,
          window.setTimeout(() => {
            timers.delete(slotId);
            // Only clear the bubble this timer was armed for: a newer line for
            // the same slot owns the slot now and has its own timer.
            setBubbles((current) => {
              if (current[slotId]?.seq !== seq) return current;
              const next = { ...current };
              delete next[slotId];
              return next;
            });
          }, bubbleDurationMs(text, event.durationMs)),
        );
      } else if (event.type === 'speak') {
        // Drop-to-avatar (2026-08-29): main TTS'd a verdict and handed the
        // audio over. Play it through Web Audio and drive the SAME audioLevel
        // + voice-state props the scene already renders — lip sync and the
        // TALK animation come from the existing pipeline, no new render path.
        const slotId = event.slotId && event.slotId !== 'slot0' ? event.slotId : null;
        if (slotId) {
          // A room-stage agent speaks: drive THAT slot's mouth, not the resident's.
          // React state changes only on the speaking START/STOP transition; the
          // level itself goes to the per-frame store.
          let ref = slotAudioRefs.current.get(slotId);
          if (!ref) {
            ref = { current: null };
            slotAudioRefs.current.set(slotId, ref);
          }
          void playSpoken(
            event.audioBase64,
            (update) => {
              const next = typeof update === 'function' ? update(INITIAL_STATE) : update;
              const isSpeaking = next.activity === 'speaking';
              setSlotVoices((current) =>
                current[slotId]?.speaking === isSpeaking
                  ? current
                  : { ...current, [slotId]: { level: 0, speaking: isSpeaking } },
              );
            },
            (level) => setLevel(slotId, level),
            ref,
            event.volume,
          );
        } else {
          void playSpoken(
            event.audioBase64,
            setVoice,
            (level) => setLevel('slot0', level),
            audioCtxRef,
            event.volume,
          );
        }
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
      setLevel('slot0', 0);
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
        audioLevel={0}
        onAnimationComplete={handleAnimationComplete}
        playback={bodyOverride ? 'once' : 'loop'}
        speaking={speaking}
        extraSlots={extraSlots}
        slotVoices={slotVoices}
        bubbles={bubbles}
        modelUrl={soloModelUrl ?? undefined}
      />
      {/* Floating beads — the notification badge + quick actions that live ON
          the avatar box. Not in solo mode: a detached single-character window
          is a view of one avatar, not the desk. */}
      {soloModelUrl ? null : <Beads />}
    </main>
  );
}
