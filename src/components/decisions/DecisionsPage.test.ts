import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DecisionsPage, FALLBACK_ANSWER_MAX } from './DecisionsPage';
import { PAGE_SIZE, type DecisionCard } from './model';

const NOW = new Date(2026, 8, 23, 12, 0, 0).getTime();
const nowSec = Math.floor(NOW / 1000);

function cards(n: number): DecisionCard[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `d-${i}`,
    title: `Decision ${i}`,
    summary: `Summary ${i}`,
    urgency: i % 7 === 0 ? 'high' : 'normal',
    createdAt: nowSec - i * 3600,
    options: [
      { key: 'go', label: 'Go', recommended: true },
      { key: 'wait', label: 'Wait', recommended: false, consequence: i === 3 ? 'runs awrise disable' : '' },
    ],
    defaultKey: i % 2 === 0 ? 'go' : '',
    tab: '',
    cwd: i % 3 === 0 ? 'C:\\AitherOS-Fresh' : 'D:\\desk',
    agent: 'claude-code',
    kind: i % 5 === 0 ? 'fyi' : 'decision',
  }));
}

function render(props: Partial<Parameters<typeof DecisionsPage>[0]> = {}): string {
  const noop = () => {};
  return renderToStaticMarkup(createElement(DecisionsPage, {
    cards: cards(302),
    nowMs: NOW,
    onAnswer: noop,
    onPopout: noop,
    onOpenQueue: noop,
    bulk: null,
    onBulkDone: noop,
    ...props,
  }));
}

const rowCount = (html: string) => (html.match(/role="listitem"/g) ?? []).length;

describe('DecisionsPage', () => {
  it('renders a LIST of the first page, not a one-card pager', () => {
    const html = render();
    expect(rowCount(html)).toBe(PAGE_SIZE);
    expect(html).not.toContain('1 of 302');
    expect(html).toContain('Show 50 more · 252 not shown');
    // newest first
    expect(html.indexOf('data-card-id="d-0"')).toBeLessThan(html.indexOf('data-card-id="d-1"'));
  });

  it('carries counts on the age and kind chips', () => {
    const html = render();
    expect(html).toMatch(/Today <span class="dx-chip-n">13<\/span>/);
    expect(html).toMatch(/fyi <span class="dx-chip-n">61<\/span>/);
  });

  it('a deep-linked card opens expanded with every option, even past page one', () => {
    const html = render({ focusId: 'd-120' });
    expect(rowCount(html)).toBe(3 * PAGE_SIZE);
    const at = html.indexOf('data-card-id="d-120"');
    const row = html.slice(at, html.indexOf('role="listitem"', at + 10));
    expect(row).toContain('aria-expanded="true"');
    expect(row).toContain('>Go</button>');
    expect(row).toContain('>Wait</button>');
    expect(row).toContain('Something else');
  });

  it('says so when the deep-linked card is gone', () => {
    expect(render({ focusId: 'gone' })).toContain('Card gone is no longer open');
  });

  it('hides Dismiss without the bulk channel and shows it with one', () => {
    expect(render({ focusId: 'd-0' })).not.toContain('>Dismiss</button>');
    const bulk = async () => ({ ok: true, verb: 'cancel', done: [], failed: [], skipped: [] });
    expect(render({ focusId: 'd-0', bulk })).toContain('>Dismiss</button>');
  });

  it('shows an empty state instead of a list when nothing waits', () => {
    const html = render({ cards: [] });
    expect(html).toContain('Nothing waiting');
    expect(rowCount(html)).toBe(0);
  });

  it('caps the fallback answer loop', () => {
    expect(FALLBACK_ANSWER_MAX).toBeLessThanOrEqual(25);
  });
});
