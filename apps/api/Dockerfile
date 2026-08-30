FROM node:24.15-bookworm-slim

ENV NODE_ENV=production APP_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker-documents/package.json apps/worker-documents/package.json
COPY packages/database/package.json packages/database/package.json
RUN npm ci --omit=dev --workspace @salarivo/api --workspace @salarivo/database --include-workspace-root=false

COPY --chown=node:node apps/api apps/api
COPY --chown=node:node packages/database packages/database

USER node
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
