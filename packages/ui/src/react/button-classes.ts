export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
// Quiet with an accent ink label, for the one action inside a toast. Not a public variant.
export type ButtonLookVariant = ButtonVariant | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonLook {
  variant: ButtonLookVariant;
  size: ButtonSize;
  disabled: boolean;
  // Busy keeps the variant's paint, so the label stays readable, with no hover or pressed
  // change and a progress cursor.
  busy?: boolean;
  // A square button that shows only an icon, such as a menu's "more" trigger.
  iconOnly?: boolean;
  // Round for a control that is a circle, such as the account avatar, so its edge and fills
  // follow the circle instead of sitting square behind it.
  shape?: ButtonShape;
}

export type ButtonShape = 'square' | 'round';

const SHAPE: Record<ButtonShape, string> = { square: 'rounded-sm', round: 'rounded-full' };

// Both labels of a button that can be busy sit in one grid cell, so the grid is always
// there and a button looks the same whether or not it can be busy.
const BASE =
  'inline-grid shrink-0 place-items-center border font-medium whitespace-nowrap select-none transition-colors duration-fast ease-enter focus-visible:focus-ring';

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-control-sm px-8 text-body-s',
  md: 'h-control-md px-12 text-body-s',
  lg: 'h-control-lg px-16 text-body-m',
};

const ICON_ONLY: Record<ButtonSize, string> = {
  sm: 'size-control-sm text-body-s',
  md: 'size-control-md text-body-s',
  lg: 'size-control-lg text-body-m',
};

// The paint at rest. The quiet variant has no fill or edge, so its border is transparent
// and the label lines up with the others.
const REST: Record<ButtonLookVariant, string> = {
  primary: 'border-transparent bg-accent-ink text-accent-on',
  secondary: 'border-rule-strong bg-ground text-body',
  quiet: 'border-transparent text-secondary',
  accent: 'border-transparent text-accent-ink',
};

// Text colours stay put on hover and press: each is measured on both fills.
const LIVE: Record<ButtonLookVariant, string> = {
  primary: 'cursor-pointer hover:bg-accent-press active:bg-accent-press',
  secondary: 'cursor-pointer hover:bg-hover active:bg-pressed',
  quiet: 'cursor-pointer hover:bg-hover active:bg-pressed',
  accent: 'cursor-pointer hover:bg-hover active:bg-pressed',
};

// Disabled paints with the disabled family, never with opacity, and takes no hover or
// pressed fill. A quiet button stays without fill or edge.
const DISABLED: Record<ButtonLookVariant, string> = {
  primary: 'border-disabled-edge bg-disabled-fill text-disabled-text cursor-not-allowed',
  secondary: 'border-disabled-edge bg-disabled-fill text-disabled-text cursor-not-allowed',
  quiet: 'border-transparent text-disabled-text cursor-not-allowed',
  accent: 'border-transparent text-disabled-text cursor-not-allowed',
};

// One class function for Button, ButtonLink and the React Aria triggers of overlays, so every
// button looks the same whichever element renders it.
export function buttonClasses({
  variant,
  size,
  disabled,
  busy = false,
  iconOnly = false,
  shape = 'square',
}: ButtonLook): string {
  const box = iconOnly ? ICON_ONLY[size] : SIZE[size];
  let paint: string;
  if (disabled) paint = DISABLED[variant];
  else if (busy) paint = `${REST[variant]} data-busy:cursor-progress`;
  else paint = `${REST[variant]} ${LIVE[variant]}`;
  return `${BASE} ${SHAPE[shape]} ${box} ${paint}`;
}

// The cell each label takes. Both labels of a button that can be busy share it.
export const LABEL_CELL = 'col-start-1 row-start-1 inline-flex items-center justify-center gap-8';
