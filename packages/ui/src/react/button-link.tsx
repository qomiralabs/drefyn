import type { ComponentPropsWithRef, ReactNode } from 'react';
import {
  buttonClasses,
  LABEL_CELL,
  type ButtonSize,
  type ButtonVariant,
} from './button-classes.ts';

export interface ButtonLinkProps extends Omit<ComponentPropsWithRef<'a'>, 'className' | 'style'> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  children: ReactNode;
}

// An anchor that looks like a Button. It has no disabled state: a link that goes nowhere
// is text, so render the text with its reason instead.
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  target,
  rel,
  ...rest
}: ButtonLinkProps): ReactNode {
  const newTab = target === '_blank';
  // A new tab gets no window.opener and no referrer, whatever rel the caller passed.
  const relation = newTab
    ? [
        ...new Set([...(rel ?? '').split(' ').filter((r) => r !== ''), 'noopener', 'noreferrer']),
      ].join(' ')
    : rel;
  return (
    <a
      {...rest}
      target={target}
      rel={relation}
      className={buttonClasses({ variant, size, disabled: false })}
    >
      <span className={LABEL_CELL}>
        {icon}
        {children}
        {newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
      </span>
    </a>
  );
}
