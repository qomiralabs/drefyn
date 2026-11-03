import { createRequire } from 'node:module';
export const http = createRequire(import.meta.url)('node:http');
