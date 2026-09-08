# Build from the REPO ROOT: docker build -f apps/web/Dockerfile .
#
# Same turbo-prune pattern as apps/api/Dockerfile, plus Next's `standalone`
# output (see next.config.ts) so the runner stage doesn't carry a second copy
# of every workspace's node_modules.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo@2.10.12 prune web --docker

FROM base AS installer
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# `turbo prune` only copies files that belong to an included workspace
# package; every package's tsconfig extends this repo-root file, which lives
# outside all of them.
COPY tsconfig.base.json ./tsconfig.base.json
RUN pnpm dlx turbo@2.10.12 run build --filter=web...
# This app ships no public/ directory at all (no static assets committed),
# but the runner stage's COPY below needs a source that exists — an absent
# directory fails the build outright rather than copying nothing.
RUN mkdir -p apps/web/public

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# `.next/standalone` already mirrors the monorepo layout (it was built inside
# one), so copying it to `/app` reconstructs `apps/web/server.js` alongside
# the trimmed `node_modules` it actually traced. Static assets and `public/`
# are excluded from `standalone` by design and have to be layered back in.
COPY --from=installer --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=installer --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
