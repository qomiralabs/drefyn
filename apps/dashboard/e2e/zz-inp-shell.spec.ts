import { expect } from '@playwright/test';
import { test } from './csp.ts';
import { archive, openPages, select, toastRegion } from './undo-helpers.ts';

interface Node {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  hitCount?: number;
  children?: number[];
}

// Temporary diagnosis: what the Archive press spends its time on.
for (let i = 0; i < 6; i += 1) {
  test(`diag ${String(i)}`, async ({ page }) => {
    await openPages(page);
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const control = await page.evaluate(() => {
      const start = performance.now();
      let x = 0;
      for (let n = 0; n < 2e7; n += 1) x = (x + n * 31) % 1000003;
      return { ms: performance.now() - start, x };
    });
    await select(page, 'Refunds');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const seen: object[] = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEventTiming[]) {
          seen.push({
            n: e.name,
            d: e.duration,
            delay: Math.round(e.processingStart - e.startTime),
            run: Math.round(e.processingEnd - e.processingStart),
            present: Math.round(e.startTime + e.duration - e.processingEnd),
            id: e.interactionId,
          });
        }
      }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
      Object.assign(window, { seen });
    });
    await client.send('Profiler.enable');
    await client.send('Profiler.setSamplingInterval', { interval: 500 });
    await client.send('Profiler.start');
    await archive(page).click();
    await expect(toastRegion(page).getByText('Archived Refunds.')).toBeVisible();
    await page.waitForTimeout(400);
    const { profile } = (await client.send('Profiler.stop')) as unknown as {
      profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] };
    };
    const self = new Map<number, number>();
    profile.samples.forEach((id, k) =>
      self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[k] ?? 0)),
    );
    const label = (n: Node) =>
      `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop() ?? ''}:${String(n.callFrame.columnNumber)}`;
    const totals = new Map<string, number>();
    for (const n of profile.nodes) {
      const t = (self.get(n.id) ?? 0) / 1000;
      const k = label(n);
      totals.set(k, (totals.get(k) ?? 0) + t);
    }
    const top = [...totals]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([k, t]) => `${t.toFixed(1)} ${k}`);
    const scripts = new Map<string, number>();
    for (const n of profile.nodes) {
      const t = (self.get(n.id) ?? 0) / 1000;
      const k =
        n.callFrame.url === ''
          ? n.callFrame.functionName
          : (n.callFrame.url.split('/').pop() ?? '');
      scripts.set(k, (scripts.get(k) ?? 0) + t);
    }
    const seen = await page.evaluate(() => (window as unknown as { seen: object[] }).seen);
    const interactions = (seen as { id: number; n: string }[]).filter((e) => e.id > 0);
    console.log(`DIAG control ${control.ms.toFixed(0)} ms | ${JSON.stringify(interactions)}`);
    if (i === 3) {
      console.log(`DIAG top\n${top.join('\n')}`);
      console.log(
        `DIAG scripts ${JSON.stringify(
          [...scripts]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([k, t]) => [k, Math.round(t)]),
        )}`,
      );
    }
  });
}
