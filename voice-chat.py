"""Talk to the Persona avatar — speech in, agent thinks, avatar speaks with lip sync.

The loop:  mic -> AitherVoice /voice/transcribe/base64 (faster-whisper)
                -> genesis /chat  -> reply text
                -> AitherVoice /voice/synthesize -> mp3
                -> play locally while driving Persona's speaking state + audio levels.

TLS: AitherVoice is HTTPS behind the AitherNet internal CA. This trusts that CA properly
(`AitherOS/config/certs/aithernet-ca-bundle.pem`, override with AITHER_CA_BUNDLE) — never
disable verification (CLAUDE.md ground truth).

Usage:
    python voice-chat.py                      # push-to-talk: ENTER starts, ENTER stops
    python voice-chat.py --text "hello"       # one shot, no microphone needed
    python voice-chat.py --no-avatar          # skip the Persona window entirely
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

VOICE_BASE = os.environ.get("AITHER_VOICE_URL", "https://127.0.0.1:8084/voice")
GENESIS_URL = os.environ.get("AITHER_GENESIS_URL", "http://localhost:8001")
PERSONA_EVENTS = os.environ.get("PERSONA_EVENTS_URL", "http://127.0.0.1:47831/events")
CA_BUNDLE = os.environ.get(
    "AITHER_CA_BUNDLE", r"D:\AitherOS-Fresh\AitherOS\config\certs\aithernet-ca-bundle.pem"
)
SESSION_ID = os.environ.get("PERSONA_VOICE_SESSION", "persona-voice-chat")
SAMPLE_RATE = 16_000


def tls_context() -> ssl.SSLContext:
    """Verified TLS against the internal CA. Never falls back to unverified."""
    if not Path(CA_BUNDLE).exists():
        raise SystemExit(
            f"Internal CA bundle not found at {CA_BUNDLE}. Set AITHER_CA_BUNDLE to the "
            "aithernet-ca-bundle.pem path — do not disable verification."
        )
    return ssl.create_default_context(cafile=CA_BUNDLE)


def post_json(url: str, payload: dict, timeout: float, context: ssl.SSLContext | None = None) -> dict:
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        return json.loads(response.read())


# ── Persona avatar (fire-and-forget; a missing avatar never blocks the conversation) ──

class Avatar:
    def __init__(self, enabled: bool = True):
        self.enabled = enabled

    def _send(self, payload: dict) -> None:
        if not self.enabled:
            return
        try:
            post_json(PERSONA_EVENTS, payload, timeout=0.6)
        except (urllib.error.URLError, OSError, TimeoutError, ValueError):
            pass

    def state(self, activity: str) -> None:
        self._send({
            "type": "state",
            "state": {
                "phase": "active",
                "activity": activity,
                "microphoneMuted": activity != "listening",
                "outputMuted": False,
            },
        })

    def level(self, value: float) -> None:
        self._send({"type": "audio-level", "level": max(0.0, min(1.0, value))})

    def animate(self, name: str) -> None:
        self._send({"type": "animation", "animation": name})

    def pulse_while_speaking(self, seconds: float) -> threading.Thread:
        """Alternate mouth level for `seconds` so the avatar visibly talks."""
        def run() -> None:
            deadline = time.monotonic() + seconds
            high = True
            while time.monotonic() < deadline:
                self.level(0.35 if high else 0.12)
                high = not high
                time.sleep(0.18)
            self.level(0.0)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread


# ── Voice services ──

def transcribe(audio_bytes: bytes, fmt: str, context: ssl.SSLContext) -> str:
    payload = {"audio_base64": base64.b64encode(audio_bytes).decode(), "format": fmt}
    data = post_json(f"{VOICE_BASE}/transcribe/base64", payload, timeout=300, context=context)
    if not data.get("success"):
        raise RuntimeError(data.get("error") or "transcription failed")
    return (data.get("text") or "").strip()


def synthesize(text: str, voice: str | None, context: ssl.SSLContext) -> tuple[bytes, str, float]:
    payload: dict = {"text": text, "return_base64": True}
    if voice:
        payload["voice"] = voice
    data = post_json(f"{VOICE_BASE}/synthesize", payload, timeout=180, context=context)
    if not data.get("success") or not data.get("audio_base64"):
        raise RuntimeError(data.get("error") or "synthesis returned no audio")
    return (
        base64.b64decode(data["audio_base64"]),
        data.get("format", "mp3"),
        float(data.get("duration_seconds") or 0.0),
    )


def ask_agent(message: str) -> str:
    data = post_json(
        f"{GENESIS_URL}/chat", {"message": message, "session_id": SESSION_ID}, timeout=300
    )
    return (data.get("response") or "").strip()


def play_audio(audio: bytes, fmt: str) -> Path:
    """Write the clip and hand it to the OS player, detached (never blocks the loop)."""
    path = Path(tempfile.gettempdir()) / f"persona-reply.{fmt}"
    path.write_bytes(audio)
    if sys.platform == "win32":
        subprocess.Popen(  # noqa: S603 - fixed argv, path is ours
            ["cmd", "/c", "start", "/min", "", str(path)],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        opener = "afplay" if sys.platform == "darwin" else "xdg-open"
        subprocess.Popen([opener, str(path)])  # noqa: S603
    return path


# ── Microphone ──

def record_push_to_talk() -> bytes | None:
    """ENTER to start, ENTER to stop. Returns WAV bytes, or None when unavailable."""
    try:
        import sounddevice  # noqa: PLC0415 - optional dependency, probed at call time
    except ImportError:
        print(
            "  (no microphone support: pip install sounddevice — "
            "use --text \"...\" to talk without a mic)"
        )
        return None

    frames: list = []
    stop = threading.Event()

    def callback(indata, _frames, _time, _status) -> None:
        frames.append(bytes(indata))

    input("  press ENTER to start speaking… ")
    stream = sounddevice.RawInputStream(
        samplerate=SAMPLE_RATE, channels=1, dtype="int16", callback=callback
    )
    with stream:
        threading.Thread(
            target=lambda: (input("  recording… press ENTER to stop "), stop.set()), daemon=True
        ).start()
        while not stop.is_set():
            time.sleep(0.05)

    if not frames:
        return None
    path = Path(tempfile.gettempdir()) / "persona-mic.wav"
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(b"".join(frames))
    return path.read_bytes()


def turn(text: str, avatar: Avatar, context: ssl.SSLContext, voice: str | None) -> None:
    """One conversational turn: agent replies, avatar speaks it."""
    print(f"you:    {text}")
    avatar.state("idle")
    reply = ask_agent(text)
    if not reply:
        print("aither: (no reply)")
        return
    print(f"aither: {reply}")
    audio, fmt, duration = synthesize(reply, voice, context)
    avatar.state("speaking")
    pulse = avatar.pulse_while_speaking(duration or 2.0)
    play_audio(audio, fmt)
    pulse.join(timeout=(duration or 2.0) + 2)
    avatar.state("idle")
    print(f"        ({duration:.2f}s of speech)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Talk to the Persona avatar.")
    parser.add_argument("--text", help="one-shot message; skips the microphone")
    parser.add_argument("--no-avatar", action="store_true", help="do not drive the Persona window")
    parser.add_argument("--voice", help="AitherVoice voice name (default: service default)")
    args = parser.parse_args()

    context = tls_context()
    avatar = Avatar(enabled=not args.no_avatar)

    if args.text:
        turn(args.text, avatar, context, args.voice)
        return 0

    print("Persona voice chat — ENTER to talk, type 'quit' to exit.\n")
    avatar.animate("GREETING")
    while True:
        audio = record_push_to_talk()
        if audio is None:
            typed = input("you (typed): ").strip()
            if typed.lower() in {"quit", "exit"}:
                return 0
            if typed:
                turn(typed, avatar, context, args.voice)
            continue
        avatar.state("listening")
        try:
            heard = transcribe(audio, "wav", context)
        except (RuntimeError, urllib.error.URLError, OSError) as error:
            print(f"  transcription failed: {error}")
            avatar.state("idle")
            continue
        if not heard:
            print("  (heard nothing)")
            avatar.state("idle")
            continue
        if heard.lower().strip(" .!") in {"quit", "exit", "stop"}:
            return 0
        turn(heard, avatar, context, args.voice)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print()
        sys.exit(0)
