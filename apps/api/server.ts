// The API service's entry: `node server.ts`. It holds drefyn_app and drefyn_public_reader and
// refuses to start beside the auth database URL or any auth secret.
import { createJsonLogger } from './src/log.ts';
import { describeStartFailure, startApi, stopOnSignals } from './src/start.ts';

const logger = createJsonLogger();
try {
  const running = await startApi(process.env, { logger });
  stopOnSignals(running, (code) => process.exit(code));
} catch (error) {
  logger.error('api.start_failed', describeStartFailure(error));
  process.exit(1);
}
