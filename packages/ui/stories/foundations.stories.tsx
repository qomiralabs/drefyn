import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { tokens } from '../src/index.ts';

type StepKey = keyof typeof tokens.type;
type SurfaceKey = keyof typeof tokens.color.surface;
type DurationKey = keyof typeof tokens.motion.duration;

// Class names are written out in full so Tailwind finds them in this file.
const steps: { key: StepKey; name: string; className: string }[] = [
  { key: 'displayXl', name: 'Display XL', className: 'text-display-xl' },
  { key: 'displayL', name: 'Display L', className: 'text-display-l' },
  { key: 'displayM', name: 'Display M', className: 'text-display-m' },
  { key: 'displayS', name: 'Display S', className: 'text-display-s' },
  { key: 'title', name: 'Title', className: 'text-title' },
  { key: 'bodyL', name: 'Body L', className: 'text-body-l' },
  { key: 'bodyM', name: 'Body M', className: 'text-body-m' },
  { key: 'bodyS', name: 'Body S', className: 'text-body-s' },
  { key: 'code', name: 'Code', className: 'text-code font-mono' },
  { key: 'caption', name: 'Caption', className: 'text-caption' },
  { key: 'label', name: 'Label', className: 'text-label font-mono uppercase' },
];

const surfaces: { key: SurfaceKey; name: string; use: string; className: string }[] = [
  { key: 'ground', name: 'Ground', use: 'The page', className: 'bg-ground border-rule' },
  { key: 'raised', name: 'Raised', use: 'Cards and panels', className: 'bg-raised border-rule' },
  { key: 'sunken', name: 'Sunken', use: 'Wells and code', className: 'bg-sunken border-rule' },
  {
    key: 'overlay',
    name: 'Overlay',
    use: 'Menus, popovers and dialogs',
    className: 'bg-overlay border-rule-strong shadow-1',
  },
];

// Each sample carries its transition, so a pointer over a row shows the duration, and
// the reduced motion check has something real to read.
const motion: { key: DurationKey; name: string; className: string }[] = [
  { key: 'fast', name: 'Fade, fast', className: 'transition-colors duration-fast hover:bg-hover' },
  { key: 'base', name: 'Fade, base', className: 'transition-colors duration-base hover:bg-hover' },
  { key: 'slow', name: 'Fade, slow', className: 'transition-colors duration-slow hover:bg-hover' },
  {
    key: 'moveBase',
    name: 'Move, base',
    className: 'transition-transform duration-move-base motion-safe:hover:translate-x-4',
  },
];

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-64">
      <h2 id={id} className="text-title text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Foundations() {
  return (
    <main className="mx-auto max-w-page px-24 py-48 sm:px-48 sm:py-64">
      <p className="font-mono text-label text-secondary uppercase">Foundations</p>
      <h1 className="mt-8 text-display-s text-ink sm:text-display-m">Type and surfaces</h1>
      <p className="mt-16 max-w-measure text-body-l text-body">
        Every Drefyn surface is set from these steps and grounds. The values come from the token
        source, so this page changes when the tokens do.
      </p>

      <Section id="type-scale" title="Type scale">
        <ul className="mt-24">
          {steps.map(({ key, name, className }) => {
            const step = tokens.type[key];
            return (
              <li key={key} className="grid gap-8 border-t border-rule py-16 sm:grid-cols-4">
                <div>
                  <p className="text-body-s text-ink">{name}</p>
                  <p className="text-caption text-secondary" data-numeric>
                    {step.size}px / {step.lineHeight}
                  </p>
                </div>
                <p className={`text-ink sm:col-span-3 ${className}`}>Status at a glance</p>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section id="surfaces" title="Surfaces">
        <ul className="mt-24 grid gap-16 sm:grid-cols-2">
          {surfaces.map(({ key, name, use, className }) => {
            const value = tokens.color.surface[key];
            return (
              <li key={key} className={`rounded-md border p-16 ${className}`}>
                <p className="text-body-m text-ink">{name}</p>
                <p className="text-body-s text-secondary">{use}</p>
                <dl className="mt-12 grid grid-cols-2 gap-4 text-caption text-secondary">
                  <dt>Light</dt>
                  <dd className="font-mono" data-numeric>
                    {value.light}
                  </dd>
                  <dt>Dark</dt>
                  <dd className="font-mono" data-numeric>
                    {value.dark}
                  </dd>
                </dl>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section id="focus-and-motion" title="Focus and motion">
        <p className="mt-16 max-w-measure text-body-m text-body">
          Focus draws a two pixel ring outside the element. Try it here:{' '}
          <a
            href="#type-scale"
            className="rounded-xs text-accent-ink underline focus-visible:focus-ring"
          >
            Back to the type scale
          </a>
          .
        </p>
        <ul className="mt-24">
          {motion.map(({ key, name, className }) => (
            <li
              key={key}
              className={`flex items-baseline justify-between gap-16 border-t border-rule px-8 py-12 ${className}`}
            >
              <span className="text-body-s text-ink">{name}</span>
              <span className="text-caption text-secondary" data-numeric>
                {tokens.motion.duration[key].ms} ms
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </main>
  );
}

const meta = {
  title: 'Foundations',
  // A page of tokens has no props table to document.
  tags: ['!autodocs'],
} satisfies Meta;

export default meta;

export const TypeAndSurfaces: StoryObj = {
  name: 'Type and surfaces',
  render: () => <Foundations />,
};
