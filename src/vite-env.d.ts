/// <reference types="vite/client" />

type VoicePhase = 'inactive' | 'starting' | 'active' | 'stopping';
type VoiceActivity = 'idle' | 'listening' | 'speaking';

interface VoiceState {
  activity: VoiceActivity;
  locator?: { conversationId?: string; hostId?: string } | null;
  microphoneMuted: boolean;
  outputMuted: boolean;
  phase: VoicePhase;
  preferredPresentationSurface?: string | null;
  sessionId?: string | null;
}

interface AudioListenerStatus {
  available: boolean;
  capturing: boolean;
  error?: string;
  monitoring: boolean;
  source: string | null;
}

type AvatarBridgeEvent =
  | { type: 'state'; state: VoiceState }
  | { type: 'audio-level'; level: number; bands?: Record<string, number> }
  | {
      type: 'animation';
      animation:
        | 'IDLE'
        | 'GREETING'
        | 'TALK'
        | 'HAPPY'
        | 'FINGER_GUN'
        | 'DANCE'
        | string;
      source?: 'mcp';
      requestId?: number;
    }
  | { type: 'listener-status'; status: AudioListenerStatus }
  | { type: 'bridge-status'; connected: boolean }
  | { type: 'spawn-avatar'; slotId: string; modelUrl: string }
  | { type: 'remove-avatar'; slotId: string }
  // Per-avatar context-menu actions (main -> renderer). focus-avatar with a slotId
  // frames THAT avatar only; slotId null frames everyone again. reset-avatar-layout
  // drops the slot's stored spot/scale so it returns to the default transform.
  | { type: 'focus-avatar'; slotId: string | null }
  | { type: 'reset-avatar-layout'; slotId: string }
  // Plan 40 slice G: main names an ARRANGEMENT and the renderer places every
  // live body (src/stage/arrangements.ts holds the geometry, beside the bounds).
  // `slotId` is the subject for `focus`; `pair` names the two for `pair`.
  | { type: 'stage-arrange'; arrangement: string; slotId?: string | null; pair?: string[] }
  // An AUTHORED placement for one body (the cast file, relayed by main). Every
  // field is optional and an omitted one leaves that component alone; yaw is
  // radians. Bounds are the renderer's (stagePlacement.authoredFields) -- an
  // out-of-stage value is DROPPED, never clamped.
  | {
      type: 'place-avatar';
      slotId: string;
      position?: [number, number, number];
      scale?: number;
      yaw?: number;
    }
  // The owner's physics knobs for one body (cast.json `physics`, resolved by
  // main with provenance; the renderer only sees the numbers). Multipliers
  // over the model's authored springs -- see useVrmLoader.ts DeskSpringTuning.
  // Sanitised on arrival: a missing knob is 1 (as authored), never 0.
  | {
      type: 'tune-avatar';
      slotId: string;
      physics?: { enabled?: boolean; weight?: number; stiffness?: number; damping?: number; jiggle?: number };
    }
  // A forked character's recipe (character-roster.customiseOf): the variant
  // renders its BASE's mesh with these deltas applied at load -- no mesh is
  // copied. See useVrmLoader.applyCustomise.
  | {
      type: 'customise-avatar';
      slotId: string;
      customise: {
        blendshapes?: Record<string, number>;
        boneScale?: Record<string, number>;
        materials?: { tint?: string; tintStrength?: number; outlineWidth?: number };
      };
    }
  // Drop-to-avatar (2026-08-29): main TTS'd the drop verdict and hands the
  // audio over for playback + lip sync in the avatar window.
  // `volume` is cast.json's master x actor fader, already multiplied (0..2).
  // Optional: an absent value plays at full volume (see speech-gain.ts).
  | { type: 'speak'; audioBase64: string; slotId?: string; volume?: number }
  // The words over the speaker's head. Arrives WITH a speak event when there is
  // audio, and ALONE when there is none (muted, or the voice service is down):
  // `muted` means "there is no clip to time this against".
  | { type: 'bubble'; slotId?: string; text: string; muted?: boolean; durationMs?: number }
  // Plan 40 slice C ("I also want to be able to talk back"): main asks the avatar
  // window to open the mic, because that window is up whenever the overlay is --
  // the deck's chat box was the only place the owner could speak from before.
  | { type: 'listen'; listening: boolean; oneShot?: boolean }
  | { type: 'open-mic'; on: boolean }
  // The content rater's full-body frames (main relays POST /roster/capture):
  // render each model whole and hand the JPEG back through
  // deck.saveCharacterFullBody. See src/thumbnails.ts renderVrmFullBody.
  | {
      type: 'capture-roster';
      /** >1 asks for a turntable of that many evenly spaced yaws (LoRA dataset). */
      angles?: number;
      characters: Array<{
        name: string;
        modelUrl: string | null;
        /** A fork's recipe, applied before the shot so the rater judges the VARIANT. */
        customise?: {
          blendshapes?: Record<string, number>;
          boneScale?: Record<string, number>;
          materials?: { tint?: string; tintStrength?: number; outlineWidth?: number };
        } | null;
      }>;
    };

/** The verdict of a dropped file (preload -> main -> drop-router). */
interface DropVerdict {
  ok: boolean;
  kind?: 'image' | 'audio' | 'video' | 'doc';
  name?: string;
  summary?: string;
  detail?: string;
  reason?: string;
}

interface Window {
  deskBridge?: {
    getSnapshot(): Promise<AvatarBridgeEvent | null>;
    hide(): void;
    minimize(): void;
    close(): void;
    avatarContextMenu(slotId: string): void;
    subscribe(listener: (event: AvatarBridgeEvent) => void): () => void;
    /** Mic clip -> gateway transcribe_audio -> text (or an "ERROR: …" string). */
    voiceTranscribe?(audioB64: string, format: string): Promise<string>;
    /** A finished transcript: main posts it to the room and answers it. */
    voiceHeard?(text: string): Promise<unknown>;
    /** Listening / transcribing / idle, so the tray can say what the mic is doing. */
    voiceListenState?(state: string): void;
    runCommand?(id: string): Promise<{ ok: boolean; error?: string }>;
    getMicDeviceId?(): Promise<string>;
  };
}
