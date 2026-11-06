# The process that parses hostile pages. Node strips the types itself, so the source goes in as
# it is, and only this package and what it needs goes in at all: --permission lets the host read
# this tree, so nothing else should be here to read.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# pnpm hashes every patch in the workspace config, though this install uses none of them.
COPY scripts/patches scripts/patches
COPY packages/mdx/package.json packages/mdx/
COPY packages/tenancy/package.json packages/tenancy/
RUN corepack enable \
  && pnpm install --frozen-lockfile --prod --ignore-scripts --filter '@drefyn/mdx...'

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/mdx/node_modules packages/mdx/node_modules
COPY package.json ./
COPY packages/mdx/package.json packages/mdx/
COPY packages/mdx/src packages/mdx/src
COPY packages/tenancy/package.json packages/tenancy/
COPY packages/tenancy/src packages/tenancy/src
USER node
# Without a healthcheck here a plain docker run would look healthy with the host down.
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.DREFYN_PARSE_PORT ?? 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--permission", "--allow-fs-read=/app", "--allow-child-process", "packages/mdx/src/supervisor-main.ts"]
