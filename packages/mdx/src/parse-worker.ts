import { serveJobs } from './worker-host.ts';
import { parseForStore } from './parse.ts';

// The page, dialect and policy were checked by zod in the parent before they crossed.
serveJobs(({ source, dialect, policy }) => parseForStore(source, dialect, policy));
