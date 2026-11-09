'use client';
import {
  cloneElement,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Focusable, Tooltip as AriaTooltip, TooltipTrigger } from 'react-aria-components';
import { tokens } from '../tokens/tokens.ts';

export interface TooltipProps {
  // Short text that describes the trigger. Never the trigger's only name.
  content: string;
  // One focusable element that forwards its ref, such as a Button or ButtonLink.
  children: ReactElement;
  placement?: 'top' | 'bottom' | 'start' | 'end';
  defaultOpen?: boolean;
  // The text is already the trigger's name, kept out of sight, as on an icon rail. The
  // tooltip is then for sighted people only: hidden from assistive tech, and it describes
  // nothing, so the name is not read twice.
  repeats?: boolean;
  // Asked each time it would open; false keeps it shut, as when the name it repeats is on
  // screen after all.
  when?: () => boolean;
}

// Focusable is typed for a host element, but it only clones the child with its handlers and
// a ref, which Button and ButtonLink pass straight to their element.
type FocusableChild = ComponentProps<typeof Focusable>['children'];

// React Aria opens it on keyboard focus at once and on hover after the wait, never on touch,
// keeps it open while the pointer is on it, closes it on Escape without moving focus, and
// describes the trigger with it. Focusable lends those handlers to a plain element, so our
// native Button and ButtonLink work as triggers. A disabled Button keeps its hover and focus
// handlers for exactly this.
// True when the element has focus and the browser would draw a keyboard ring on it.
function keyboardFocused(el: HTMLElement | null): boolean {
  if (el === null || el !== document.activeElement) return false;
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

// React Aria passes no aria-hidden through to the tooltip, so it is written on the element.
const hideFromReaders = (el: HTMLElement | null) => {
  el?.setAttribute('aria-hidden', 'true');
};

// The trigger's own props win over the ones React Aria lends it, and null renders no
// attribute, so this keeps the tooltip from describing a trigger whose name it repeats.
function undescribed(child: ReactElement): ReactElement {
  const own = (child.props as { 'aria-describedby'?: string })['aria-describedby'];
  return cloneElement(child, { 'aria-describedby': own ?? null } as Record<string, unknown>);
}

export function Tooltip({
  content,
  children,
  placement = 'top',
  defaultOpen = false,
  repeats = false,
  when,
}: TooltipProps): ReactNode {
  if (content.trim() === '') throw new Error('Tooltip needs text to show.');
  const [open, setOpen] = useState(defaultOpen);
  const trigger = useRef<HTMLElement>(null);
  const scrolling = useRef(false);

  // React Aria closes a tooltip on any scroll around its trigger, and the scroll the browser
  // makes to bring a newly focused trigger into view counts. The tooltip and its description
  // would then vanish for a keyboard or screen reader user, disabled reasons included. A
  // close that comes from a scroll while the trigger keeps keyboard focus reopens it on the
  // next frame, which also places it again where the trigger now is.
  useEffect(() => {
    let reset = 0;
    const onScroll = () => {
      scrolling.current = true;
      window.clearTimeout(reset);
      reset = window.setTimeout(() => {
        scrolling.current = false;
      }, 0);
    };
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.clearTimeout(reset);
    };
  }, []);

  const onOpenChange = (next: boolean) => {
    if (next && when !== undefined && !when()) return;
    setOpen(next);
    if (next || !scrolling.current || !keyboardFocused(trigger.current)) return;
    requestAnimationFrame(() => {
      if (keyboardFocused(trigger.current)) setOpen(true);
    });
  };

  return (
    <TooltipTrigger delay={tokens.timer.tooltip.ms} isOpen={open} onOpenChange={onOpenChange}>
      <Focusable ref={trigger}>
        {(repeats ? undescribed(children) : children) as FocusableChild}
      </Focusable>
      <AriaTooltip
        {...(repeats ? { ref: hideFromReaders } : {})}
        placement={placement}
        offset={tokens.space[4]}
        className="z-overlay max-w-measure rounded-sm border border-rule-strong bg-overlay px-8 py-4 text-caption text-body shadow-1"
      >
        {content}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
