// A stdio MCP server over the real library and the reader role, for the client test to spawn.
// The CLI command that does this for operators is separate; this is its smallest stand in.
import { closeDatabase, createPublishedDatabase, parsePublishedReaderConfig } from '@drefyn/db';
import { createRetrieval, DEFAULT_RETRIEVAL_CONFIG, publishedReader } from '@drefyn/retrieval';
import { organizationId, projectId } from '@drefyn/tenancy';
import { createMcpServer, serveStdio } from '../../src/index.ts';

const reader = await createPublishedDatabase(parsePublishedReaderConfig(process.env));
const retrieval = createRetrieval({
  reader: publishedReader(reader),
  config: DEFAULT_RETRIEVAL_CONFIG,
  flags: { evaluate: () => Promise.resolve({ value: true }) },
});
const tenant = {
  organizationId: organizationId(process.env['MCP_TEST_ORGANIZATION_ID'] ?? ''),
  projectId: projectId(process.env['MCP_TEST_PROJECT_ID'] ?? ''),
};
const served = await serveStdio(createMcpServer({ retrieval, tenant }));
process.stdin.on('end', () => {
  void served.close().then(() => closeDatabase(reader));
});
