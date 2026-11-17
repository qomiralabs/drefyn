// Writes the committed OpenAPI document from the code. The contract test fails until the
// committed copy matches, so a route change cannot ship without its document.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApi } from '../src/openapi.ts';

const target = join(import.meta.dirname, '..', 'openapi', 'v1.json');
writeFileSync(target, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
