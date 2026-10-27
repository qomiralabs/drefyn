// Checks the pins the ui workflow depends on: every action at a full commit SHA, every
// image at a digest, and the screenshot image on the same Playwright as the test runner.
// Read line by line rather than parsed, so it needs no YAML dependency. A flow style map
// such as `{ uses: x }` would slip past; no workflow here is written that way.

export interface PinInput {
  workflow: string;
  // The image in-container.ts starts for every browser job.
  image: string;
  // The @playwright/test version in package.json.
  playwright: string;
}

const FULL_SHA = /^[^@\s]+@[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const PLAYWRIGHT_IMAGE =
  /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[0-9a-f]{64}$/;

const unquote = (value: string): string => value.replace(/^(['"])(.*)\1$/, '$2');

// The value of `key:` on a line, without quotes or a trailing comment.
function valueOf(line: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(\\S[^#]*?)\\s*(?:#.*)?$`).exec(line);
  return match?.[1] === undefined ? undefined : unquote(match[1]);
}

function usesProblem(uses: string): string | undefined {
  if (uses.startsWith('./')) return undefined;
  if (uses.startsWith('docker://')) {
    return DIGEST.test(uses) ? undefined : `${uses} has no @sha256 digest`;
  }
  return FULL_SHA.test(uses) ? undefined : `${uses} is not pinned to a full commit SHA`;
}

function imageProblems(image: string, expected: string): string[] {
  const problems: string[] = [];
  if (!DIGEST.test(image)) problems.push(`image ${image} has no @sha256 digest`);
  if (image.startsWith('mcr.microsoft.com/playwright') && image !== expected) {
    problems.push(`image ${image} is not ${expected}`);
  }
  return problems;
}

export function pinProblems({ workflow, image, playwright }: PinInput): string[] {
  const problems: string[] = [];
  const version = PLAYWRIGHT_IMAGE.exec(image)?.[1];
  if (version === undefined) {
    problems.push(`runner image ${image} is not a Playwright noble tag pinned by @sha256 digest`);
  } else if (version !== playwright) {
    problems.push(`runner image is Playwright ${version} but @playwright/test is ${playwright}`);
  }

  workflow.split('\n').forEach((line, index) => {
    const at = `line ${index + 1}: `;
    const uses = valueOf(line, 'uses');
    if (uses !== undefined) {
      const problem = usesProblem(uses);
      if (problem !== undefined) problems.push(at + problem);
    }
    // `container:` alone opens a block whose `image:` is checked on its own line.
    const container = valueOf(line, 'container') ?? valueOf(line, 'image');
    if (container !== undefined) {
      for (const problem of imageProblems(container, image)) problems.push(at + problem);
    }
    if (/\bplaywright\s+install\b/.test(line)) {
      problems.push(`${at}playwright install puts host browsers in CI; run in the pinned image`);
    }
  });
  return problems;
}
