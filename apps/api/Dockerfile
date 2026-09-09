# Build from the REPO ROOT: docker build -f apps/api/Dockerfile .
#
# Uses `turbo prune` to cut the monorepo down to just this app's workspace
# subset before installing, so the build doesn't pnpm-install every package's
# dependencies for a container that only ever runs one of them.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo@2.10.12 prune api --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# `turbo prune` only copies files that belong to an included workspace
# package; every package's tsconfig extends this repo-root file, which lives
# outside all of them.
COPY tsconfig.base.json ./tsconfig.base.json
RUN pnpm dlx turbo@2.10.12 run build --filter=api...

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 apiuser
COPY --from=installer --chown=apiuser:nodejs /app .
USER apiuser
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
