# Build from the REPO ROOT: docker build -f apps/worker/Dockerfile .
#
# Same turbo-prune pattern as apps/api/Dockerfile — see the comment there.
# No EXPOSE: this process only consumes BullMQ queues, it never listens on a
# port.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo@2.10.12 prune worker --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# `turbo prune` only copies files that belong to an included workspace
# package; every package's tsconfig extends this repo-root file, which lives
# outside all of them.
COPY tsconfig.base.json ./tsconfig.base.json
RUN pnpm dlx turbo@2.10.12 run build --filter=worker...

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 workeruser
COPY --from=installer --chown=workeruser:nodejs /app .
USER workeruser
CMD ["node", "apps/worker/dist/index.js"]
