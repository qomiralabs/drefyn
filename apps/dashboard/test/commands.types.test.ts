// Checked by tsc in the gate. Each marker fails the build the day its field turns optional,
// because an unused @ts-expect-error is itself an error.
import { describe, expectTypeOf, it } from 'vitest';
import { defineCommands, type Command } from '../src/shell/commands.ts';

// Never called: the run time refusals have their own tests, and these are about the compiler.
const register = (entries: readonly Command[]) => () => defineCommands(entries);

describe('what the compiler refuses', () => {
  it('needs a name', () => {
    expectTypeOf(
      register([
        // @ts-expect-error a row with no name has nothing to show or to search
        { id: 'a', kind: 'product', icon: 'page', href: '/a', permission: 'docs.read' },
      ]),
    ).toBeFunction();
  });

  it('needs a target the keyboard can reach', () => {
    expectTypeOf(
      register([
        // @ts-expect-error a row with no target cannot run
        { id: 'a', name: 'A', kind: 'product', icon: 'page', permission: 'docs.read' },
      ]),
    ).toBeFunction();
  });

  it('needs a permission check', () => {
    expectTypeOf(
      register([
        // @ts-expect-error a row with no permission would reach everyone
        { id: 'a', name: 'A', kind: 'product', icon: 'page', href: '/a' },
      ]),
    ).toBeFunction();
  });

  it('needs a permission that exists', () => {
    expectTypeOf(
      register([
        // @ts-expect-error a typo here would hide the row from everyone
        { id: 'a', name: 'A', kind: 'product', icon: 'page', href: '/a', permission: 'docs.raed' },
      ]),
    ).toBeFunction();
  });

  it('takes a complete entry', () => {
    expectTypeOf(
      register([
        { id: 'a', name: 'A', kind: 'product', icon: 'page', href: '/a', permission: 'docs.read' },
      ]),
    ).toBeFunction();
  });
});
