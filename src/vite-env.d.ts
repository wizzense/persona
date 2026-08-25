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
  | { type: 'remove-avatar'; slotId: string };

interface Window {
  personaBridge?: {
    getSnapshot(): Promise<AvatarBridgeEvent | null>;
    hide(): void;
    subscribe(listener: (event: AvatarBridgeEvent) => void): () => void;
  };
}
