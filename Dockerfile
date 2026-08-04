FROM oven/bun:1.2.20-alpine

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY tsconfig.json ./
COPY src ./src

ENV T3RESEARCH_HOST=0.0.0.0
ENV T3RESEARCH_PORT=7341
ENV T3RESEARCH_DATA_DIR=/data
EXPOSE 7341
VOLUME ["/data"]

HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=12 \
  CMD wget -qO- http://127.0.0.1:7341/health >/dev/null || exit 1

CMD ["bun", "src/server.ts"]
