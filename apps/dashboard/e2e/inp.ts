import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, type CDPSession, type Page } from '@playwright/test';
import type { InpSummary } from './inp-summary.ts';

// The slowdown the budget is defined at.
export const CPU_SLOWDOWN = 4;

export interface InpReading {
  readonly value: number;
  readonly target: string;
  readonly type: string;
  readonly inputDelay: number;
  readonly processing: number;
  readonly presentation: number;
  // The timed step alone, which the session value above can hide behind an earlier press.
  readonly press: number;
}

interface VitalsWindow {
  readonly webVitals: {
    readonly onINP: (
      report: (metric: {
        readonly value: number;
        readonly attribution: {
          readonly interactionTarget: string;
          readonly interactionType: string;
          readonly inputDelay: number;
          readonly processingDuration: number;
          readonly presentationDelay: number;
        };
      }) => void,
      options: { readonly reportAllChanges: true; readonly durationThreshold: number },
    ) => void;
  };
  inpReadings: Omit<InpReading, 'press'>[];
  pressDurations: number[];
}

// By path, because the package's exports leave out the one build a page can evaluate.
const library = readFileSync(
  new URL('../node_modules/web-vitals/dist/web-vitals.attribution.iife.js', import.meta.url),
  'utf8',
);

// Every change reports, so the value is there without leaving the page, and 16 ms is the lowest
// threshold the browser allows, so a fast press still gives a number.
export async function watchInp(page: Page): Promise<void> {
  await page.evaluate(`${library}\nglobalThis.webVitals = webVitals;`);
  await page.evaluate(() => {
    const vitals = window as unknown as VitalsWindow;
    vitals.inpReadings = [];
    vitals.webVitals.onINP(
      ({ value, attribution }) => {
        vitals.inpReadings.push({
          value,
          target: attribution.interactionTarget,
          type: attribution.interactionType,
          inputDelay: attribution.inputDelay,
          processing: attribution.processingDuration,
          presentation: attribution.presentationDelay,
        });
      },
      { reportAllChanges: true, durationThreshold: 16 },
    );
  });
}

// From here on, so the step being timed reads apart from whatever led up to it. Not buffered, or
// the browser would hand over earlier presses too.
export async function watchPress(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vitals = window as unknown as VitalsWindow;
    vitals.pressDurations = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        if (entry.interactionId > 0) vitals.pressDurations.push(entry.duration);
      }
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
  });
}

// Keep the session open: a closed one takes its throttle with it.
export async function slowCpu(page: Page): Promise<CDPSession> {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  return client;
}

// The browser hands over a press a frame or so after it paints, and the library queues it for
// an idle moment, so a few frames then an idle callback behind that queue sees every report.
export async function readInp(page: Page): Promise<InpReading> {
  const settled = () =>
    page.evaluate(
      () =>
        new Promise<InpReading | null>((resolve) => {
          const vitals = window as unknown as VitalsWindow;
          let frames = 4;
          const next = () => {
            frames -= 1;
            if (frames > 0) requestAnimationFrame(next);
            else
              requestIdleCallback(() => {
                const reading = vitals.inpReadings.at(-1);
                resolve(
                  reading === undefined
                    ? null
                    : { ...reading, press: Math.max(0, ...vitals.pressDurations) },
                );
              });
          };
          requestAnimationFrame(next);
        }),
    );
  await expect.poll(settled, { message: 'the page reported no INP' }).not.toBeNull();
  const reading = await settled();
  if (reading === null) throw new Error('the page reported no INP');
  return reading;
}

// Beside the Lighthouse reports, so a run's numbers outlive its log.
export function recordInp(summary: InpSummary, readings: readonly InpReading[]): void {
  const directory = new URL('../test-results/inp/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  const body = `${JSON.stringify({ ...summary, readings }, null, 2)}\n`;
  writeFileSync(new URL(`${summary.name}.json`, directory), body);
}
