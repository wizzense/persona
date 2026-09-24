import { useCallback, useEffect, useState } from 'react';

import { awarenessRows, type AwarenessState } from './awareness';
import { collapseAwareness } from './model';
import './decisions.css';

/**
 * System awareness panel. Owner, 2026-09-23: five rows all reading "HTTP 503:
 * Authorization backend unreachable". Sources that fail the SAME way render as
 * ONE line naming every source that shares the cause (collapseAwareness).
 */
export function SystemAwareness() {
  const [awareness, setAwareness] = useState<Record<string, AwarenessState | undefined>>({});
  const [busy, setBusy] = useState(false);

  const runAwareness = useCallback(() => {
    const bridge = window.deskBridge as unknown as {
      system?: Partial<Record<'snapshot' | 'voice' | 'vision' | 'desktop' | 'connect', () => Promise<AwarenessState>>>;
    } | undefined;
    if (!bridge?.system) return;
    setBusy(true);
    const guard = (name: string) => (res: AwarenessState | undefined) => {
      setAwareness((prev) => ({ ...prev, [name]: res ?? { ok: false, reason: 'unreachable' } }));
    };
    const fail = (name: string) => (error: unknown) => {
      guard(name)({ ok: false, reason: error instanceof Error ? error.message : 'the desk did not answer' });
    };
    void bridge.system.snapshot?.().then(guard('system'), fail('system')).finally(() => setBusy(false));
    void bridge.system.voice?.().then(guard('voice'), fail('voice'));
    void bridge.system.vision?.().then(guard('vision'), fail('vision'));
    void bridge.system.desktop?.().then(guard('desktop'), fail('desktop'));
    void bridge.system.connect?.().then(guard('connect'), fail('connect'));
  }, []);

  useEffect(() => {
    runAwareness();
  }, [runAwareness]);

  const lines = collapseAwareness(awarenessRows(awareness));
  const failing = lines.filter((line) => line.failing).length;

  return (
    <section className="dx-card" aria-label="System awareness">
      <div className="dx-card-head">
        <h2 className="dx-section">System awareness</h2>
        <span className="dx-note">
          {failing === 0 ? 'every source answered' : `${failing} distinct problem${failing === 1 ? '' : 's'}`}
        </span>
        <span className="dx-grow" />
        <button type="button" className="dx-btn dx-small" title="Refresh every awareness source" onClick={runAwareness} disabled={busy}>
          {busy ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <div className="dx-aw-list">
        {lines.map((line) => (
          <div className={`dx-aw-row${line.failing ? ' is-failing' : ''}`} key={line.labels.join('|')}>
            <span className={`dx-dot ${line.failing ? 'dx-urg-critical' : 'dx-ok'}`} />
            <span className="dx-aw-label">{line.labels.join(' · ')}</span>
            <span className="dx-aw-text" title={line.text}>
              {line.shared ? `${line.labels.length} sources, one cause: ${line.text}` : line.text}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
