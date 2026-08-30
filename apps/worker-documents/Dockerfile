FROM node:24.15-bookworm-slim

ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates poppler-utils tesseract-ocr tesseract-ocr-spa tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker-documents/package.json apps/worker-documents/package.json
COPY packages/database/package.json packages/database/package.json
RUN npm ci --omit=dev --workspace @salarivo/worker-documents --workspace @salarivo/database --include-workspace-root=false

COPY --chown=node:node apps/worker-documents apps/worker-documents
COPY --chown=node:node packages/database packages/database

USER node
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/worker-documents/src/index.ts"]
