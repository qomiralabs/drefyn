// Builds the token specimen page used for review screenshots. Not shipped and not exported:
// it exists so a reviewer can see every token, in both modes, from the same source the tests
// read. Run `pnpm --filter @drefyn/ui preview`, then serve packages/ui and open
// /preview/dist/index.html.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeScript } from '../src/theme-script.ts';
import {
  colorOf,
  expandPairs,
  forbiddenPairs,
  measure,
  minimum,
  requiredPairs,
  ruledOutPairs,
  type Backdrop,
  type ColorRole,
  type Pair,
} from '../src/tokens/pairs.ts';
import { reducedFadeCapMs, tokens, type Mode, type ModeColor } from '../src/tokens/tokens.ts';

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const cssName = (role: string) => `--dr-${role.split('.').map(kebab).join('-')}`;
const ratio = (n: number) => n.toFixed(2);

function roles(): { role: ColorRole; value: ModeColor }[] {
  const out: { role: ColorRole; value: ModeColor }[] = [];
  const walk = (node: Record<string, unknown>, path: string[]) => {
    for (const [key, child] of Object.entries(node)) {
      const c = child as Record<string, unknown>;
      if (typeof c['light'] === 'string') {
        out.push({ role: [...path, key].join('.') as ColorRole, value: c as unknown as ModeColor });
      } else walk(c, [...path, key]);
    }
  };
  walk(tokens.color, []);
  return out;
}

function colorSection(): string {
  const rows = roles()
    .map(
      ({ role, value }) => `
      <li class="role">
        <span class="swatch" style="background: var(${cssName(role)})"></span>
        <span class="role-name">${role}<code>${cssName(role)}</code></span>
        <span class="role-value"><span class="mode">Light</span> ${value.light}</span>
        <span class="role-value"><span class="mode">Dark</span> ${value.dark}</span>
      </li>`,
    )
    .join('');
  return `
    <section aria-labelledby="color">
      <h2 id="color">Colour roles</h2>
      <p class="lede">Components read roles, never hexes. Swatches follow the current mode.</p>
      <ul class="roles">${rows}</ul>
    </section>`;
}

const BACKDROPS: Backdrop[] = ['surface.ground', 'surface.raised', 'surface.sunken', 'accent.wash'];

function pairMatrix(mode: Mode): string {
  const required = expandPairs(requiredPairs).filter((p) => p.mode === mode);
  const forbidden = expandPairs([...forbiddenPairs, ...ruledOutPairs]).filter(
    (p) => p.mode === mode,
  );
  const onSurfaces = (p: Pair) => BACKDROPS.includes(p.bg);
  const fgs = [...new Set([...required, ...forbidden].filter(onSurfaces).map((p) => p.fg))];
  const cell = (fg: ColorRole, bg: Backdrop) => {
    const ok = required.find((p) => p.fg === fg && p.bg === bg);
    const bad = forbidden.find((p) => p.fg === fg && p.bg === bg);
    const pair = ok ?? bad;
    if (pair === undefined)
      return '<td class="empty"><span class="visually-hidden">not used</span></td>';
    const r = measure(pair, mode);
    const colors = `--fg: ${colorOf(fg, mode)}; color: ${colorOf(fg, mode)}; background: ${colorOf(bg, mode)}`;
    const sample =
      ok !== undefined && pair.kind === 'text'
        ? `<span class="sample" style="${colors}" aria-hidden="true">Aa</span>`
        : `<span class="sample sample-mark" style="${colors}" aria-hidden="true"></span>`;
    const verdict = ok === undefined ? '<span class="verdict">not allowed</span>' : '';
    return `<td class="${ok === undefined ? 'fail' : 'pass'}">${sample}<span class="ratio">${ratio(r)}</span>${verdict}</td>`;
  };
  const head = BACKDROPS.map((b) => `<th scope="col">${b.split('.')[1] ?? b}</th>`).join('');
  const body = fgs
    .map(
      (fg) => `<tr><th scope="row">${fg}</th>${BACKDROPS.map((bg) => cell(fg, bg)).join('')}</tr>`,
    )
    .join('');
  const others = required
    .filter((p) => !onSurfaces(p))
    .map(
      (p) =>
        `<li><span>${p.fg} on ${p.bg}</span><span class="ratio">${ratio(measure(p, mode))}</span></li>`,
    )
    .join('');
  return `
    <figure class="matrix">
      <figcaption>${mode === 'light' ? 'Light' : 'Dark'}</figcaption>
      <div class="scroll" tabindex="0" role="region" aria-label="${mode} contrast pairs">
        <table>
          <thead><tr><th scope="col">Foreground</th>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <ul class="other-pairs">${others}</ul>
    </figure>`;
}

function pairsSection(): string {
  return `
    <section aria-labelledby="contrast">
      <h2 id="contrast">Contrast</h2>
      <p class="lede">Measured from the tokens and floored to two decimals. Text needs ${minimum.text}:1,
      marks and control edges need ${minimum['non-text']}:1. Pairs marked not allowed are never used:
      most fail, and the rest are ruled out so a rule reads the same in both modes.</p>
      <div class="matrices">${pairMatrix('light')}${pairMatrix('dark')}</div>
    </section>`;
}

function stateSection(): string {
  const states = [
    ['fresh', 'Operational', 'Up to date'],
    ['stale', 'Degraded', 'Out of date'],
    ['broken', 'Outage', 'Wrong'],
    ['neutral', 'Maintenance', 'No data'],
  ] as const;
  const items = states
    .map(
      ([key, status, docs]) => `
      <li class="state state-${key}">
        <span class="band" aria-hidden="true"></span>
        <span class="state-words"><strong>${status}</strong><span>${docs}</span></span>
      </li>`,
    )
    .join('');
  return `
    <section aria-labelledby="state">
      <h2 id="state">State</h2>
      <p class="lede">Three hues and a neutral, used only for state. Every mark carries a tick in its text colour and sits beside a word.</p>
      <ul class="states">${items}</ul>
    </section>`;
}

function typeSection(): string {
  const rows = Object.entries(tokens.type)
    .map(([step, s]) => {
      const name = kebab(step);
      return `
      <li class="type-row">
        <span class="label">${name}<span class="numbers">${s.size} / ${s.lineHeight} / ${s.tracking}em / ${s.weight}</span></span>
        <span class="type-sample" style="font: var(--dr-type-${name}); letter-spacing: var(--dr-type-${name}-tracking)">${
          step === 'label'
            ? 'LAST CHECKED 14:02 UTC'
            : step === 'code'
              ? 'drefyn status set api --degraded'
              : 'Checkout API has been slower than usual in Europe since 14:02 UTC'
        }</span>
      </li>`;
    })
    .join('');
  return `
    <section aria-labelledby="type">
      <h2 id="type">Type</h2>
      <p class="lede">Inter and JetBrains Mono, self hosted Latin subsets. Sizes in rem so zoom works.</p>
      <ul class="type-scale">${rows}</ul>
    </section>`;
}

function scaleSection(): string {
  const space = Object.entries(tokens.space)
    .map(
      ([k, v]) => `
      <li><span class="label numbers">${k}</span><span class="bar" style="inline-size: var(--dr-space-${k})"></span><span class="numbers">${v / 16}rem</span></li>`,
    )
    .join('');
  const radius = Object.entries(tokens.radius)
    .map(
      ([k, v]) =>
        `<li><span class="corner" style="border-radius: var(--dr-radius-${k})"></span><span class="label">${k}</span><span class="numbers">${v}px</span></li>`,
    )
    .join('');
  const stroke = Object.entries(tokens.stroke)
    .map(
      ([k, v]) =>
        `<li><span class="line" style="block-size: var(--dr-stroke-${k})"></span><span class="label">${k}</span><span class="numbers">${v}px</span></li>`,
    )
    .join('');
  return `
    <section aria-labelledby="scale">
      <h2 id="scale">Space, radius, stroke</h2>
      <p class="lede">A 4 px base, named by pixels. There is no 20.</p>
      <div class="scales">
        <ul class="space">${space}</ul>
        <div>
          <h3>Radius</h3>
          <ul class="tiles">${radius}</ul>
          <h3>Stroke</h3>
          <ul class="tiles">${stroke}</ul>
        </div>
      </div>
    </section>`;
}

function motionSection(): string {
  const rows = Object.entries(tokens.motion.duration)
    .map(([k, d]) => {
      const reduced = d.kind === 'move' ? 0 : Math.min(d.ms, reducedFadeCapMs);
      return `<tr><th scope="row">${kebab(k)}</th><td>${d.kind}</td><td class="numbers">${d.ms} ms</td><td class="numbers">${reduced} ms</td></tr>`;
    })
    .join('');
  return `
    <section aria-labelledby="motion">
      <h2 id="motion">Motion and depth</h2>
      <p class="lede">Fades change state, moves travel. Under reduced motion nothing travels and no fade runs past ${reducedFadeCapMs} ms.</p>
      <div class="motion">
        <div class="scroll" tabindex="0" role="region" aria-label="Durations">
          <table>
            <thead><tr><th scope="col">Duration</th><th scope="col">Kind</th><th scope="col">Default</th><th scope="col">Reduced</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <ul class="elevation">
          <li class="card shadow-0"><span class="label">shadow 0</span>Hairline only</li>
          <li class="card shadow-1"><span class="label">shadow 1</span>Menus and popovers</li>
          <li class="card shadow-2"><span class="label">shadow 2</span>Command bar and dialogs</li>
        </ul>
      </div>
      <p class="focus-demo"><a href="#top">A link</a> <button type="button">Primary action</button> <button type="button" class="quiet">Quiet action</button></p>
    </section>`;
}

export function renderPreview(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drefyn tokens</title>
<script>${themeScript}</script>
<link rel="preload" href="../../src/fonts/inter-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="../../src/generated/tokens.css">
<link rel="stylesheet" href="../preview.css">
</head>
<body>
<header class="masthead" id="top">
  <div>
    <p class="label">Drefyn design tokens</p>
    <h1>One source, every surface</h1>
    <p class="standfirst">Every value below comes from tokens.ts. The stylesheet, the Tailwind theme, the chart themes and these numbers are generated from it.</p>
  </div>
  <fieldset class="theme">
    <legend>Theme</legend>
    <label><input type="radio" name="theme" value=""> System</label>
    <label><input type="radio" name="theme" value="light"> Light</label>
    <label><input type="radio" name="theme" value="dark"> Dark</label>
  </fieldset>
</header>
<main>
${colorSection()}
${pairsSection()}
${stateSection()}
${typeSection()}
${scaleSection()}
${motionSection()}
</main>
<script>
document.querySelectorAll('input[name="theme"]').forEach(function (input) {
  var root = document.documentElement;
  input.checked = input.value === (root.dataset.theme || '');
  input.addEventListener('change', function () {
    if (input.value) root.dataset.theme = input.value; else delete root.dataset.theme;
    try { if (input.value) localStorage.setItem('dr-theme', input.value); else localStorage.removeItem('dr-theme'); } catch (e) {}
  });
});
</script>
</body>
</html>
`;
}

if (import.meta.main) {
  const out = join(dirname(fileURLToPath(import.meta.url)), 'dist');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), renderPreview());
  process.stdout.write(`wrote ${join(out, 'index.html')}\n`);
}
