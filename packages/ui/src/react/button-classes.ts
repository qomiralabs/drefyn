export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonLook {
  variant: ButtonVariant;
  size: ButtonSize;
  disabled: boolean;
}

// One class function for Button, ButtonLink and the React Aria triggers of overlays, so every
// button looks the same whichever element renders it.
// TODO(#58): build the class list from token utilities.
export const buttonClasses: (look: ButtonLook) => string = () => '';
