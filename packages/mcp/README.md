# `@drefyn/mcp`

The MCP server assistants such as Claude, Cursor and Copilot use to read a team's published
docs. It adapts `@drefyn/retrieval` to the protocol and adds nothing of its own: every tool
answers exactly what the library answers for the same input, so the two never disagree. It
reads only published, public text, because the library does.

The API service serves it at `POST /mcp` behind `mcp.v1` (off in production) and the
`mcp.serve` kill switch. See `apps/api` for keys, flags and plan checks.

## Public API

Everything other packages may use is exported from `src/index.ts`.

- `createMcpServer({ retrieval, tenant, logger? })` returns an `McpServer` from the official
  SDK with three tools. `tenant` is proved by the caller, from a key or the stdio settings; no
  tool argument can name another one. Build one per HTTP request, or one per stdio process.
- `handleMcpHttp(request, server, { maxBodyBytes })` answers one Streamable HTTP request,
  stateless, in JSON: `POST` only, any other method is 405 with `Allow: POST`, no session id, a
  body over the cap is 413. It closes the server once the answer is written.
- `serveStdio(server, streams?)` serves the same server over newline delimited JSON-RPC on
  stdin and stdout. The `drefyn mcp --stdio` command is separate.
- `MCP_TOOLS`: `search_docs`, `get_page`, `list_versions`, in the order `tools/list` gives
  them. `McpRetrieval` is the part of the library the server needs; the scored search is not
  part of it, so scores never reach a client.

## Tools

Every tool is marked read only, idempotent and closed world, and has an input and an output
schema.

| Tool            | Input                                                                        | Library call   |
| --------------- | ---------------------------------------------------------------------------- | -------------- |
| `search_docs`   | `query` (1 to 512 characters), `version?`, `limit?` (1 to 20), `pathPrefix?` | `retrieve`     |
| `get_page`      | exactly one of `path` or `nodeId`, `version?`                                | `getPage`      |
| `list_versions` | nothing                                                                      | `listVersions` |

A result carries the library's value as `structuredContent` and the same value as JSON in one
text block. A refusal is a tool result with `isError: true`, `structuredContent: { code }` and
the same JSON as text, where `code` is one of the library's: `retrieval.bad_input`,
`retrieval.version_not_found`, `retrieval.not_found`, `retrieval.busy`,
`retrieval.unavailable`. Input that fails the schema is `retrieval.bad_input`, never a protocol
error, and is never echoed. Each output schema admits the value or the refusal, because the
official client checks structured content against it even on an error. A library that throws
answers `retrieval.unavailable`. An unknown tool name is a protocol error.

## Logs

`mcp.tool_call` once per call: organization and project ids, the tool, the outcome and the
time. `mcp.tool_failed` when the library throws, with the error's name only. Never the
arguments or the result: they hold the question and page text.

## Tests

```sh
pnpm --filter @drefyn/mcp test               # unit and the parity property, 95 percent lines
pnpm --filter @drefyn/mcp test:integration   # needs the compose stack and COMPOSE_PROJECT_NAME
```

The parity property checks each tool against the library over generated inputs and results,
and checks that the adapter refuses exactly the inputs the real library refuses. The
integration tests run a stock MCP client over Streamable HTTP and stdio against Postgres, and
one project's server against pages in two organizations, including protected pages, drafts
and replaced versions.
