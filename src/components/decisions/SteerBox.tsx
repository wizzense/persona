import { useState } from 'react';

import { steerApi } from './bridge';

/**
 * "None of these — do this instead." The card plane's STEER verb: the text
 * goes to the asking session and is mirrored to the coordination channel.
 * Until 2026-09-08 a card whose right answer was not one of its options had
 * to be retyped in a terminal (`awask steer <id> "..."`).
 */
export function SteerBox({ cardId }: { cardId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    const steer = steerApi();
    if (!steer) {
      setNote('Steering needs a newer Desk build.');
      return;
    }
    setText('');
    // "Handed to awask", never "sent to the session": the write is a DETACHED
    // spawn by design, so main learns that the process started, not that the
    // store took it.
    void steer(cardId, body)
      .then((ok) => setNote(ok ? 'Handed to awask.' : 'Refused — awask did not start.'))
      .catch(() => setNote('Refused — awask is unreachable.'));
  };

  if (!open) {
    return (
      <button
        type="button"
        className="dx-btn dx-ghost"
        title="Tell the asking session what to do instead of picking one of its options"
        onClick={() => setOpen(true)}
      >
        Something else…
      </button>
    );
  }
  return (
    <div className="dx-steer">
      <input
        className="dx-input"
        autoFocus
        placeholder="Do this instead…"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (note) setNote(null);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') send();
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      <button type="button" className="dx-btn" onClick={send}>Send</button>
      {note ? <p className="dx-note">{note}</p> : null}
    </div>
  );
}
