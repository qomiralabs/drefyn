# The API service. Node strips the types itself, so the source goes in as it is, and only this
# app and the packages it imports go in at all.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# pnpm hashes every patch in the workspace config, so the flags package's patch has to be here.
COPY scripts/patches scripts/patches
COPY apps/api/package.json apps/api/
COPY packages/address/package.json packages/address/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/entitlements/package.json packages/entitlements/
COPY packages/flags/package.json packages/flags/
COPY packages/tenancy/package.json packages/tenancy/
RUN corepack enable \
  && pnpm install --frozen-lockfile --prod --ignore-scripts --filter '@drefyn/api...'

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=deps /app/packages/auth/node_modules packages/auth/node_modules
COPY --from=deps /app/packages/db/node_modules packages/db/node_modules
COPY --from=deps /app/packages/flags/node_modules packages/flags/node_modules
COPY package.json ./
COPY apps/api/package.json apps/api/server.ts apps/api/
COPY apps/api/src apps/api/src
COPY packages/address/package.json packages/address/
COPY packages/address/src packages/address/src
COPY packages/auth/package.json packages/auth/
COPY packages/auth/src packages/auth/src
COPY packages/auth/data packages/auth/data
COPY packages/db/package.json packages/db/
COPY packages/db/src packages/db/src
COPY packages/entitlements/package.json packages/entitlements/
COPY packages/entitlements/src packages/entitlements/src
COPY packages/flags/package.json packages/flags/
COPY packages/flags/src packages/flags/src
COPY packages/tenancy/package.json packages/tenancy/
COPY packages/tenancy/src packages/tenancy/src
COPY deploy/api/entrypoint.sh deploy/api/entrypoint.sh
USER node
EXPOSE 3100
# Without a healthcheck here a plain docker run would look healthy with the process wedged.
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.DREFYN_API_PORT || 3100) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["sh", "/app/deploy/api/entrypoint.sh"]
