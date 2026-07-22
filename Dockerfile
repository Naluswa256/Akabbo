# ─────────────────────────────────────────────────────────────────────────────
# AKABBO — single image, two processes (api | worker) selected by APP_ROLE.
# "One deployable backend + one worker process, same codebase" (CLAUDE.md §2).
# Deployed as two Cloud Run services that differ only by the APP_ROLE env var.
# ─────────────────────────────────────────────────────────────────────────────

# --- Base with pnpm via corepack ---------------------------------------------
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- Dependencies (cached on lockfile) ---------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- Build (generate Prisma client, compile TS) ------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma:generate
RUN pnpm build

# --- Runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Run as the non-root user that ships with the node image.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh
USER node
# Cloud Run injects PORT (api only); default for local runs.
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["./docker/entrypoint.sh"]
