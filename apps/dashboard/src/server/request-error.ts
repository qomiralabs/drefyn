const WORD = /^[A-Za-z0-9_.-]{1,64}$/;

const word = (value: unknown): string | undefined =>
  typeof value === 'string' && WORD.test(value) ? value : undefined;

const defined = (fields: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

// A message, a stack, a path or a header can each carry a password, a code or a token, and
// no pattern list catches every one. So only fixed shapes go out, and the digest ties a line
// to the error a person saw.
export function redactedRequestError(
  error: unknown,
  request: { readonly method?: string | undefined },
  context: {
    readonly routePath?: string | undefined;
    readonly routeType?: string | undefined;
  },
): Record<string, string> {
  const { name, digest } = (error ?? {}) as { name?: unknown; digest?: unknown };
  return defined({
    digest: word(digest),
    name: word(name) ?? 'Error',
    method: word(request.method),
    // The route pattern, [org] and all, never the path that was asked for.
    routePath: typeof context.routePath === 'string' ? context.routePath : undefined,
    routeType: word(context.routeType),
  });
}
