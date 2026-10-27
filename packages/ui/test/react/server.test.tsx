// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  IconCheck,
  Skeleton,
  StatusDot,
  StatusPip,
} from '../../src/react/index.ts';

// Server safe components render once on the server and ship no JS, so their markup alone
// has to be right: with JS off nothing can correct it.
describe('server rendered markup', () => {
  it('gives a disabled Button aria-disabled and no disabled attribute', () => {
    const html = renderToStaticMarkup(<Button disabled>Publish update</Button>);
    expect(html).toMatch(/^<button[^>]* aria-disabled="true"/);
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it('never lets a disabled submit button submit, even with JS off', () => {
    const html = renderToStaticMarkup(
      <Button type="submit" disabled>
        Publish update
      </Button>,
    );
    expect(html).not.toContain('type="submit"');
    expect(html).toContain('type="button"');
  });

  it('never lets a busy submit button submit twice, even with JS off', () => {
    const html = renderToStaticMarkup(
      <Button type="submit" busy busyLabel="Publishing">
        Publish update
      </Button>,
    );
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toMatch(/\sdata-busy(=|\s|>)/);
  });

  it('writes both labels of a button that can be busy, at rest and busy, with only the inactive one hidden', () => {
    const rest = renderToStaticMarkup(<Button busyLabel="Publishing">Publish update</Button>);
    const busy = renderToStaticMarkup(
      <Button busy busyLabel="Publishing">
        Publish update
      </Button>,
    );
    for (const html of [rest, busy]) {
      expect(html).toContain('Publish update');
      expect(html).toContain('Publishing');
      expect(html).not.toContain('aria-live');
      expect(html.match(/\binvisible\b/g)).toHaveLength(1);
    }
    expect(rest).toMatch(
      /data-label="busy"[^>]*class="[^"]*\binvisible\b|class="[^"]*\binvisible\b[^"]*"[^>]*data-label="busy"/,
    );
    expect(busy).toMatch(
      /data-label="rest"[^>]*class="[^"]*\binvisible\b|class="[^"]*\binvisible\b[^"]*"[^>]*data-label="rest"/,
    );
  });

  it('keeps a live submit button a submit button', () => {
    expect(renderToStaticMarkup(<Button type="submit">Publish update</Button>)).toContain(
      'type="submit"',
    );
  });

  it('renders ButtonLink as a plain anchor', () => {
    const html = renderToStaticMarkup(<ButtonLink href="/history">View history</ButtonLink>);
    expect(html).toMatch(/^<a [^>]*href="\/history"[^>]*>.*View history.*<\/a>$/);
  });

  it('puts the state word in the markup of a badge and a dot, and the name on a pip', () => {
    expect(renderToStaticMarkup(<Badge state="stale">Out of date</Badge>)).toContain('Out of date');
    expect(renderToStaticMarkup(<StatusDot state="live">Syncing</StatusDot>)).toContain('Syncing');
    const pip = renderToStaticMarkup(<StatusPip state="broken" label="Major outage" />);
    expect(pip).toContain('role="img"');
    expect(pip).toContain('aria-label="Major outage"');
  });

  it('renders an empty state with its heading and sentence', () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No components yet">Add one to start.</EmptyState>,
    );
    expect(html).toMatch(/<h2[^>]*>No components yet<\/h2>/);
    expect(html).toContain('Add one to start.');
  });

  it('renders skeletons and icons hidden from screen readers', () => {
    expect(renderToStaticMarkup(<Skeleton />)).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<IconCheck />)).toContain('aria-hidden="true"');
  });

  it('writes no inline style and no event handler attribute', () => {
    const html = [
      renderToStaticMarkup(<Button variant="primary">Publish update</Button>),
      renderToStaticMarkup(<ButtonLink href="/x">Go</ButtonLink>),
      renderToStaticMarkup(<Badge state="fresh">Fresh</Badge>),
      renderToStaticMarkup(<StatusPip state="fresh" label="Fresh" />),
      renderToStaticMarkup(<StatusDot state="fresh">Fresh</StatusDot>),
      renderToStaticMarkup(<Skeleton />),
      renderToStaticMarkup(<EmptyState title="Empty">Nothing here.</EmptyState>),
    ].join('\n');
    expect(html.length).toBeGreaterThan(7);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/i);
  });
});
