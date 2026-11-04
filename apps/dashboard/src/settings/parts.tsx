import { IconAlert, Skeleton } from '@drefyn/ui/react';
import type { ReactNode } from 'react';
import { Eyebrow, Head } from '../views/calm.tsx';
import { TryAgain } from '../views/try-again.tsx';
import './settings.css';

// Settings answer before they list: a two tone sentence, then rows on hairlines.

const WIDTHS = {
  calm: 'max-w-landing gap-32 sm:pt-48',
  work: 'max-w-page gap-16',
} as const;

export function SettingsPage({
  width,
  children,
}: {
  width: keyof typeof WIDTHS;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={`flex flex-col px-16 pt-24 pb-96 sm:px-24 ${WIDTHS[width]}`}>{children}</div>
  );
}

export function PageHead({
  label,
  claim,
  rest,
  size = 'work',
  actions,
}: {
  label: string;
  claim: string;
  rest: string;
  size?: 'calm' | 'work';
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-start justify-between gap-16">
      <div className="flex max-w-measure min-w-0 flex-col gap-8">
        <Eyebrow>{label}</Eyebrow>
        <h1
          tabIndex={-1}
          className={`${
            size === 'calm' ? 'text-display-s text-balance' : 'text-title'
          } text-ink outline-none focus-visible:focus-ring`}
        >
          {claim} <span className="text-secondary">{rest}</span>
        </h1>
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap gap-8">{actions}</div>}
    </div>
  );
}

export function SectionHead({
  id,
  children,
  actions,
}: {
  id?: string;
  children: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-h-control-md items-center justify-between gap-12">
      <h2 id={id} className="text-body-s font-medium text-ink">
        {children}
      </h2>
      {actions}
    </div>
  );
}

export function Fine({ id, children }: { id?: string; children: ReactNode }): ReactNode {
  return (
    <p id={id} className="max-w-measure text-caption text-secondary">
      {children}
    </p>
  );
}

// A row of the calm pages: what it is, what is true of it, and what can be done.
export function Row({
  icon,
  title,
  detail,
  actions,
}: {
  icon: ReactNode;
  title: ReactNode;
  detail: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <li className="flex flex-wrap items-start gap-12 border-b border-rule py-12 sm:flex-nowrap">
      <span className="inline-flex pt-2 text-secondary">{icon}</span>
      <div className="flex min-w-0 flex-1 basis-128 flex-col gap-2">
        <span className="font-medium text-ink">{title}</span>
        <span className="text-caption text-secondary">{detail}</span>
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-8">{actions}</div>
      )}
    </li>
  );
}

export function Rows({ label, children }: { label?: string; children: ReactNode }): ReactNode {
  return (
    <ul aria-labelledby={label} className="border-t border-rule">
      {children}
    </ul>
  );
}

// News the page must say without an error: neutral, never a state colour.
export function PageNotice({
  icon,
  title,
  children,
  actions,
  focusRef,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  focusRef?: (node: HTMLDivElement | null) => void;
}): ReactNode {
  return (
    <div
      ref={focusRef}
      role="status"
      tabIndex={-1}
      className="flex flex-wrap items-start gap-12 rounded-sm border border-rule-strong bg-raised p-12 outline-none focus-visible:focus-ring"
    >
      <span className="inline-flex pt-2 text-secondary">{icon}</span>
      <div className="flex min-w-0 flex-1 basis-128 flex-col gap-2">
        <p className="font-medium text-ink">{title}</p>
        {children === undefined ? null : <p className="text-secondary">{children}</p>}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap gap-8">{actions}</div>}
    </div>
  );
}

// A page that did not load. Says what is still true, because that is what a person fears.
export function LoadProblem({
  title,
  children,
  reference,
}: {
  title: string;
  children: ReactNode;
  reference?: string;
}): ReactNode {
  return (
    <SettingsPage width="calm">
      <Head>
        <span className="inline-flex text-state-broken-mark">
          <IconAlert size="md" />
        </span>
        <h1 tabIndex={-1} className="text-title text-ink outline-none focus-visible:focus-ring">
          {title}
        </h1>
        <p className="max-w-measure text-secondary">{children}</p>
        {reference === undefined ? null : (
          <p className="text-caption text-secondary">
            Reference <code className="font-mono">{reference}</code>
          </p>
        )}
        <div>
          <TryAgain />
        </div>
      </Head>
    </SettingsPage>
  );
}

// The final layout in skeleton blocks. Main keeps its name through a heading that is read,
// not drawn.
export function LoadingPage({
  name,
  width,
  rows,
}: {
  name: string;
  width: 'calm' | 'work';
  rows: number;
}): ReactNode {
  return (
    <SettingsPage width={width}>
      <h1 className="sr-only">{name}</h1>
      <div className="flex max-w-measure flex-col gap-8">
        <Skeleton width="1/4" />
        <span className="block h-32">
          <Skeleton shape="block" width="3/4" />
        </span>
      </div>
      <div className="flex flex-col border-t border-rule">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex items-center gap-12 border-b border-rule py-16">
            <span className="block size-icon-sm">
              <Skeleton shape="circle" />
            </span>
            <div className="flex-1">
              <Skeleton width="1/2" />
            </div>
            <div className="w-64">
              <Skeleton width="full" />
            </div>
          </div>
        ))}
      </div>
    </SettingsPage>
  );
}

export function Meter({
  label,
  value,
  max,
  words,
}: {
  label: string;
  value: number;
  max: number | null;
  words: string;
}): ReactNode {
  const top = max === null ? value : Math.max(max, value);
  const percent = top === 0 ? 0 : Math.round((value / top) * 100);
  return (
    <div className="flex max-w-measure flex-col gap-4">
      <div className="flex items-baseline justify-between gap-12">
        <span>{label}</span>
        <span data-numeric="">{words}</span>
      </div>
      {max === null ? null : (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={top}
          aria-valuenow={value}
          aria-valuetext={words}
          className="h-2 overflow-hidden rounded-full bg-meter-track"
        >
          {/* Through the DOM, because the content security policy refuses a style attribute. */}
          <div
            className="h-full bg-meter-fill"
            ref={(node) => {
              if (node !== null) node.style.width = `${String(percent)}%`;
            }}
          />
        </div>
      )}
    </div>
  );
}
