FROM node:24.15-bookworm-slim

ENV NODE_ENV=production APP_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker-documents/package.json apps/worker-documents/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/economic-data/package.json packages/economic-data/package.json
RUN npm ci --omit=dev --workspace @salarivo/api --workspace @salarivo/database --workspace @salarivo/economic-data --include-workspace-root=false

COPY --chown=node:node apps/api apps/api
COPY --chown=node:node packages/database packages/database
COPY --chown=node:node packages/economic-data packages/economic-data

USER node
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]
