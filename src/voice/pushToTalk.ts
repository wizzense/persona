/**
 * Push-to-talk, anywhere — Plan 40, slice C ("I also want to be able to talk back").
 *
 * The desk could already hear the owner, but ONLY inside the deck's chat box:
 * the mic lived in one React section, so talking to the agents meant finding
 * that pane first. This drives the same capture from the avatar window, which is
 * open whenever the overlay is, so the tray item, the palette and the global
 * hotkey all have somewhere to land.
 *
 * The recorder itself is a thin state machine over MediaRecorder, kept apart
 * from React so it can be tested with a fake recorder: the failure modes here
 * are a stream that is never released (the mic light stays on, which the owner
 * reads as "it is still listening") and a second start while the first is live.
 */

export type TalkState = 'idle' | 'listening' | 'transcribing';

export interface TalkDeps {
  /** getUserMedia, injected so the test can hand over a fake stream. */
  getStream: () => Promise<MediaStream>;
  /** MediaRecorder factory, injected for the same reason. */
  makeRecorder: (stream: MediaStream, mime: string) => MediaRecorder;
  /** Blob -> base64, injected because the browser path uses FileReader/btoa. */
  encode: (blob: Blob) => Promise<string>;
  /** Main's transcriber (gateway `transcribe_audio`). */
  transcribe: (base64: string, format: string) => Promise<string>;
  /** Where a finished transcript goes: main posts it to the room and answers. */
  deliver: (text: string) => void;
  /** Told on every state change, so a surface can show that it is listening. */
  onState?: (state: TalkState) => void;
  /** Anything that went wrong, in words the owner can act on. */
  onError?: (message: string) => void;
}

const MIME_PREFERRED = 'audio/webm;codecs=opus';

export function preferredMime(
  isSupported: (mime: string) => boolean = (mime) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime),
): string {
  try {
    return isSupported(MIME_PREFERRED) ? MIME_PREFERRED : 'audio/webm';
  } catch {
    return 'audio/webm';
  }
}

export function createPushToTalk(deps: TalkDeps) {
  let state: TalkState = 'idle';
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];

  function setState(next: TalkState) {
    state = next;
    deps.onState?.(next);
  }

  /** Release the mic. Called on every exit path — a stream left open keeps the
   *  OS mic indicator lit, which reads as "it is still recording me". */
  function release() {
    try {
      stream?.getTracks().forEach((track) => track.stop());
    } catch {
      /* a track that is already dead is the normal case */
    }
    stream = null;
    recorder = null;
  }

  async function start() {
    if (state !== 'idle') return;         // a second start is a no-op, not a second mic
    setState('listening');
    try {
      stream = await deps.getStream();
      const mime = preferredMime();
      chunks = [];
      recorder = deps.makeRecorder(stream, mime);
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        release();
        setState('transcribing');
        try {
          const blob = new Blob(chunks, { type: mime });
          chunks = [];
          // Nothing was captured: say so rather than sending an empty clip to the
          // gateway and reporting whatever it makes of silence.
          if (!blob.size) {
            deps.onError?.('nothing was recorded');
            setState('idle');
            return;
          }
          const text = await deps.transcribe(await deps.encode(blob), 'webm');
          if (typeof text === 'string' && text.startsWith('ERROR:')) {
            deps.onError?.(text.slice(6).trim());
          } else if (text && text.trim()) {
            deps.deliver(text.trim());
          } else {
            deps.onError?.('nothing was heard');
          }
        } catch (error) {
          deps.onError?.(error instanceof Error ? error.message : String(error));
        } finally {
          setState('idle');
        }
      };
      recorder.start();
    } catch (error) {
      release();
      setState('idle');
      deps.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  function stop() {
    if (state !== 'listening' || !recorder) return;
    try {
      recorder.stop();                    // onstop does the rest
    } catch (error) {
      release();
      setState('idle');
      deps.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    start,
    stop,
    toggle: () => (state === 'listening' ? stop() : void start()),
    get state() {
      return state;
    },
  };
}
