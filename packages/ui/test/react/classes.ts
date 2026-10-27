// Class lists read from the attribute, so svg elements work too.
export const classesOf = (el: Element): string[] =>
  (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c !== '');

// Utilities that would make a control look dimmed, move behind a variant, or animate forever.
export const FORBIDDEN_LOOKS = [
  /(^|:)opacity-/,
  /(^|:)animate-/,
  /^(?:hover|focus|focus-visible|active|aria-[a-z-]+|data-[a-z-]+):transition/,
];

// The element a component rendered, or a failure that says it rendered nothing.
export function rootOf(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('the component rendered nothing');
  return el;
}

// The one element a query found, or a failure that says how many there were.
export function only<T extends Element>(list: ArrayLike<T>): T {
  const el = list[0];
  if (list.length !== 1 || el === undefined) throw new Error(`expected one, found ${list.length}`);
  return el;
}
