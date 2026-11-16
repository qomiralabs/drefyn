import { describe, expect, it } from 'vitest';
import { checkApiName } from '../src/index.ts';

describe('apiName rule', () => {
  it.each(['a', 'A', 'title', 'Title_2', 'snake_case', 'trailing_', 'has__double', 'a'.repeat(64)])(
    'accepts %s',
    (name) => {
      expect(checkApiName(name)).toBeNull();
    },
  );

  it.each([
    '__typename',
    '__schema',
    '__type',
    '__',
    '__anything',
    '__proto__',
    'String',
    'Int',
    'Float',
    'Boolean',
    'ID',
    'Query',
    'Mutation',
    'Subscription',
    'true',
    'false',
    'null',
    'constructor',
    'prototype',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
  ])('reserves %s', (name) => {
    expect(checkApiName(name)).toBe('schema.name_reserved');
  });

  it.each([
    '',
    '_leading',
    '1digit',
    'has space',
    'has-dash',
    'dot.ted',
    'a'.repeat(65),
    'trailing\n',
    '\nleading',
    'nul\u0000',
    'café',
    // Cyrillic a, which reads the same as the Latin letter.
    'аdmin',
    "x'; drop table app.nodes; --",
  ])('refuses %j', (name) => {
    expect(checkApiName(name)).toBe('schema.name_invalid');
  });

  it('leaves names that only look reserved', () => {
    expect(checkApiName('string')).toBeNull();
    expect(checkApiName('query')).toBeNull();
  });
});
