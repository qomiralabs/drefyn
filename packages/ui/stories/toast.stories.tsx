import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, toast, ToastRegion, useLandmark } from '../src/react/index.ts';
import { tokens } from '../src/index.ts';

const seconds = (ms: number) => ms / 1000;

const meta = {
  title: 'Components/Toast',
  parameters: {
    docs: {
      description: {
        component: `Says what just happened, bottom left, and never takes focus. A reversible action applies at once and offers Undo, which runs once; Cmd+Z or Ctrl+Z runs the newest Undo when focus is not in a text field. A toast waits ${seconds(tokens.timer.toast.ms)} seconds, ${seconds(tokens.timer.toastUndo.ms)} with Undo, and holds while it is hovered or focused and while the tab is hidden. Errors stay until dismissed. F6 moves focus to the notifications. Mount one ToastRegion per app and call toast() from anywhere. On this page the buttons show their toasts; each story's own view shows them at once.`,
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

type Input = Parameters<typeof toast>[0];
type Run = (what: string) => void;

// Story view shows the toasts at once, for the screenshots and the axe run. The docs page
// shows them only when a button is pressed, so it does not open under a pile of toasts.
const inStoryView = (context?: { viewMode?: string }) => context?.viewMode !== 'docs';

// The docs page renders a story more than once, and an app mounts one region, so the docs
// page gets exactly one: the first story to mount claims it.
let claimed = false;
function OneRegion() {
  const [mine] = useState(() => {
    if (claimed) return false;
    claimed = true;
    return true;
  });
  useEffect(
    () => () => {
      if (mine) claimed = false;
    },
    [mine],
  );
  return mine ? <ToastRegion /> : null;
}

// Every press and every Undo is written to a live output, so tests and readers see what ran.
function Frame({
  toasts,
  now,
  children,
}: {
  toasts: (run: Run) => Input[];
  now: boolean;
  children: (show: () => void) => ReactNode;
}) {
  const [last, setLast] = useState('none');
  const [inputs] = useState(() => toasts(setLast));
  useEffect(() => {
    if (!now) return undefined;
    const handles = inputs.map((input) => toast(input));
    return () => {
      for (const handle of handles) handle.close();
    };
  }, [inputs, now]);
  return (
    <div className="flex flex-col items-start gap-16 p-24 sm:p-48">
      <div className="flex flex-wrap items-center gap-12">
        {children(() => {
          for (const input of inputs) toast(input);
        })}
      </div>
      <output aria-live="polite" className="text-body-s text-secondary">
        Last action: {last}
      </output>
      {now ? <ToastRegion /> : <OneRegion />}
    </div>
  );
}

const archived = (run: Run): Input => ({
  title: 'Archived Pricing',
  description: 'Readers no longer see this page.',
  undo: () => {
    run('Restored Pricing');
  },
});

const copied: Input = { title: 'Copied the component ID' };

const failed: Input = {
  title: 'Could not save the page',
  description: 'Your changes are still here. Check the connection and try again.',
  tone: 'error',
};

export const Undo: Story = {
  render: (_args, context) => (
    <Frame toasts={(run) => [archived(run)]} now={inStoryView(context)}>
      {(show) => (
        <>
          <Button onClick={show}>Archive page</Button>
          <Button>Edit page</Button>
        </>
      )}
    </Frame>
  ),
};

export const Message: Story = {
  render: (_args, context) => (
    <Frame toasts={() => [copied]} now={inStoryView(context)}>
      {(show) => <Button onClick={show}>Copy ID</Button>}
    </Frame>
  ),
};

export const ErrorToast: Story = {
  name: 'Error',
  render: (_args, context) => (
    <Frame toasts={() => [failed]} now={inStoryView(context)}>
      {(show) => <Button onClick={show}>Save page</Button>}
    </Frame>
  ),
};

export const Stack: Story = {
  render: (_args, context) => (
    <Frame
      toasts={(run) => [
        failed,
        copied,
        {
          title: 'Moved 3 pages to Guides',
          undo: () => {
            run('Moved 3 pages back');
          },
        },
      ]}
      now={inStoryView(context)}
    >
      {(show) => <Button onClick={show}>Show three</Button>}
    </Frame>
  ),
};

// A page that holds its own landmarks through useLandmark, as the dashboard shell does, so
// F6 moves bar, sidebar, main, notifications and round again. The docs page already has its
// own landmarks, so there the parts are plain boxes outside the cycle.
function InAPageView({ landmarks }: { landmarks: boolean }) {
  // Div refs fit both element kinds the parts render as.
  const bar = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const skip = !landmarks;
  const barProps = useLandmark(bar, { role: 'banner', skip });
  const navProps = useLandmark(nav, { role: 'navigation', label: 'Pages', skip });
  const mainProps = useLandmark(main, { role: 'main', skip });
  const Bar = landmarks ? 'header' : 'div';
  const Nav = landmarks ? 'nav' : 'div';
  const Main = landmarks ? 'main' : 'div';
  const zone = 'outline-none focus-visible:focus-ring-inset';
  return (
    <div className="flex min-h-full flex-col">
      <Bar
        ref={bar}
        {...barProps}
        className={`flex items-center gap-12 border-b border-rule px-24 py-12 ${zone}`}
      >
        <span className="font-medium text-ink">Payments API</span>
        <Button>Publish</Button>
      </Bar>
      <div className="flex flex-1">
        <Nav
          ref={nav}
          {...navProps}
          className={`flex w-shell-nav-collapsed flex-col gap-8 border-e border-rule p-12 sm:w-shell-nav ${zone}`}
        >
          <a href="#pricing" className="rounded-sm text-body focus-visible:focus-ring">
            Pricing
          </a>
          <a href="#guides" className="rounded-sm text-body focus-visible:focus-ring">
            Guides
          </a>
        </Nav>
        <Main ref={main} {...mainProps} className={`min-w-0 flex-1 ${zone}`}>
          <Frame toasts={(run) => [archived(run)]} now={landmarks}>
            {(show) => (
              <>
                <Button onClick={show}>Archive page</Button>
                <Button>Edit page</Button>
              </>
            )}
          </Frame>
        </Main>
      </div>
    </div>
  );
}

export const InAPage: Story = {
  name: 'In a page',
  render: (_args, context) => <InAPageView landmarks={inStoryView(context)} />,
};
