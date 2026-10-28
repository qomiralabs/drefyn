// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  isNormalizedEmailAddress,
  normalizeEmailAddress,
  type AddressError,
  type NormalizedEmailAddress,
  type Result,
} from '../../src/index.ts';

declare const plain: string;
declare const normalized: NormalizedEmailAddress;

function takesAddress(address: NormalizedEmailAddress): NormalizedEmailAddress {
  return address;
}

function compileOnly(): void {
  // @ts-expect-error a plain string is not a normalized address
  takesAddress(plain);
  // @ts-expect-error a string literal is not a normalized address
  takesAddress('jane@example.com');
  // @ts-expect-error a result is not an address until it is checked
  takesAddress(normalizeEmailAddress(plain));
  // @ts-expect-error the guard takes a string, not anything
  isNormalizedEmailAddress(1);

  // What must keep compiling.
  takesAddress(normalized);
  const result = normalizeEmailAddress(plain);
  if (result.ok) takesAddress(result.value);
  if (isNormalizedEmailAddress(plain)) takesAddress(plain);
  const asString: string = normalized;
  expect(asString).toBeTypeOf('string');
}

describe('address type tests', () => {
  it('compile under pnpm typecheck', () => {
    expect(typeof compileOnly).toBe('function');
  });

  it('pin the exported shapes', () => {
    expectTypeOf<NormalizedEmailAddress>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<NormalizedEmailAddress>();
    expectTypeOf<AddressError>().toEqualTypeOf<{
      readonly code: 'address.invalid';
      readonly reason: 'length' | 'local_part' | 'domain' | 'control' | 'shape';
    }>();
    expectTypeOf(normalizeEmailAddress).parameters.toEqualTypeOf<[string]>();
    expectTypeOf(normalizeEmailAddress).returns.toEqualTypeOf<
      Result<NormalizedEmailAddress, AddressError>
    >();
  });
});
