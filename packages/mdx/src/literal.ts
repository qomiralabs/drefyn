import type { Expression, Node, ObjectExpression, Program } from 'estree';

const keyName = (key: Node) => {
  if (key.type === 'Identifier') return key.name;
  return key.type === 'Literal' ? key.value : undefined;
};

function isPlainObject(node: ObjectExpression): boolean {
  return node.properties.every(
    (property) =>
      property.type === 'Property' &&
      property.kind === 'init' &&
      !property.computed &&
      !property.shorthand &&
      !property.method &&
      // In an object literal this key sets the prototype, it does not make a field.
      keyName(property.key) !== '__proto__' &&
      isLiteral(property.value),
  );
}

function isLiteral(node: Node): boolean {
  switch (node.type) {
    case 'Literal':
      // Regular expressions and big integers are not JSON, so no prop schema can hold them.
      return !('regex' in node) && !('bigint' in node);
    case 'TemplateLiteral':
      return node.expressions.length === 0;
    case 'UnaryExpression':
      return (
        (node.operator === '-' || node.operator === '+') &&
        node.argument.type === 'Literal' &&
        typeof node.argument.value === 'number'
      );
    case 'ArrayExpression':
      return node.elements.every((element) => element !== null && isLiteral(element));
    case 'ObjectExpression':
      return isPlainObject(node);
    default:
      return false;
  }
}

// Allow listed on purpose: a syntax this does not know about stays inert.
export function isLiteralProgram(program: Program | null | undefined): boolean {
  const [statement, extra] = program?.body ?? [];
  if (statement?.type !== 'ExpressionStatement' || extra !== undefined) return false;
  return isLiteral(statement.expression satisfies Expression);
}
