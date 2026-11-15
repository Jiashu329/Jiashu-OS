# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG SELFHOST_PUBLIC_ORIGIN=https://www.treefund.asia
RUN SELFHOST_PUBLIC_ORIGIN="$SELFHOST_PUBLIC_ORIGIN" npm run build:selfhost

FROM node:24-bookworm-slim AS runtime
ARG APP_COMMIT_SHA
LABEL org.opencontainers.image.revision="$APP_COMMIT_SHA"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SELFHOST_DB_PATH=/data/app.sqlite3 \
    APP_COMMIT_SHA="$APP_COMMIT_SHA"
WORKDIR /app
RUN groupadd --gid 10001 lifeos && useradd --uid 10001 --gid lifeos --no-create-home lifeos \
    && mkdir /data && chown lifeos:lifeos /data
COPY --from=build --chown=lifeos:lifeos /src/dist/standalone/ ./
USER lifeos
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:3000/_selfhost/healthz').then(async r=>{if(!r.ok||!(await r.json()).ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["sh", "selfhost/entrypoint.sh"]
