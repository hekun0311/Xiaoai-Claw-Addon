ARG OPENCLAW_BASE
FROM ${OPENCLAW_BASE} AS plugin
USER root
WORKDIR /build
COPY package.json package-lock.json tsconfig.json index.ts ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev
COPY openclaw.plugin.json README.md ./
COPY assets ./assets
COPY scripts ./scripts
COPY installers ./installers
RUN rm -rf src tsconfig.json index.ts

FROM ${OPENCLAW_BASE}
USER root
RUN if ! command -v ffmpeg >/dev/null || ! python3 -c 'import requests' >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-requests && rm -rf /var/lib/apt/lists/*; \
    fi
COPY --from=plugin /build /opt/xiaoai-plugin
USER node
