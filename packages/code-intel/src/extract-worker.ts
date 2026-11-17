// First, so nothing the grammars load can run before the seal is on.
import '@drefyn/mdx/seal-thread';
import { parentPort } from 'node:worker_threads';
import { z } from 'zod';
import { extractFile } from './extract.ts';
import { CODE_LANGUAGES, loadGrammars } from './grammars.ts';

const messageSchema = z.object({
  id: z.int(),
  language: z.enum(CODE_LANGUAGES),
  source: z.string(),
  path: z.string(),
});

const port = parentPort;
if (port === null) throw new Error('this file runs only inside a worker thread');
const grammars = await loadGrammars();
port.on('message', (message: unknown) => {
  // A throw here is uncaught on purpose: it ends the thread, and the host sees a crash.
  const { id, language, source, path } = messageSchema.parse(message);
  port.postMessage({ id, result: extractFile(language, source, grammars, { path }) });
});
port.postMessage({ ready: true });
