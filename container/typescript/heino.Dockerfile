# syntax=docker/dockerfile:1
#
# heino — Next.js 16 frontend. Optimal production image:
#   bufgen:  latest Go + buf → generate the TS protobuf code (typescript/buf/gen).
#   build:   latest Node + pnpm (corepack) → install + `pnpm -F heino build` with
#            output:"standalone" (Next traces a minimal server + node_modules).
#   runtime: distroless/nodejs (no pnpm, no devDeps) → `node server.js`. ~150 MB.
#
# Version pins come from compose build args (single source: .env). Config is NEVER
# baked or injected here: NEXT_PUBLIC_* is inlined at build from the COMMITTED public
# typescript/heino/.env, and the secret .env.local is excluded from the build context
# and not needed to build. Runtime config is injected via env_file at run
# (compose.dev.yml). The build depends only on committed inputs → reproducible on a
# fresh clone / git worktree / CI.

ARG GO_VERSION=1.26
ARG NODE_VERSION=24
ARG BUF_VERSION=1.67.0
ARG PNPM_VERSION=11.2.2

# ── TS protobuf codegen ────────────────────────────────────────────────────────
FROM golang:${GO_VERSION}-bookworm AS bufgen
ARG BUF_VERSION
RUN curl -fsSL "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-$(uname -s)-$(uname -m)" \
      -o /usr/local/bin/buf && chmod +x /usr/local/bin/buf
WORKDIR /src
COPY buf.yaml buf.gen.yaml buf.lock ./
COPY proto/ ./proto/
RUN buf generate   # writes typescript/buf/gen (+ golang/buf/gen, unused here)

# ── build ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
# Build-only pnpm tuning: deterministic store (for the cache mount) + generous
# fetch timeout/retries so a slow/flaky registry doesn't abort the build.
RUN printf 'store-dir=/pnpm/store\nfetch-timeout=600000\nfetch-retries=5\n' > .npmrc
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY typescript/ ./typescript/
COPY --from=bufgen /src/typescript/buf/gen/ ./typescript/buf/gen/
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile
# `next build` reads the COMMITTED, public typescript/heino/.env from the build context
# (NEXT_PUBLIC_* inlined into the client bundle + the non-secret RICHTER_BASE_URL). The
# secret .env.local is excluded from the build context (.dockerignore) and is NOT needed
# to build — server secrets are read at runtime — so the build depends only on committed,
# public inputs and is reproducible on a fresh clone / git worktree / CI.
RUN pnpm -F heino build

# ── runtime (distroless/nodejs runs `node` as entrypoint) ──────────────────────
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12:nonroot AS heino
WORKDIR /app
# Image invariants (not env-specific config): prod mode + bind addr/port.
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
# Next standalone output (monorepo: server nests under the package path).
COPY --from=build /app/typescript/heino/.next/standalone/ ./
COPY --from=build /app/typescript/heino/.next/static/ ./typescript/heino/.next/static/
COPY --from=build /app/typescript/heino/public/ ./typescript/heino/public/
EXPOSE 3000
CMD ["typescript/heino/server.js"]
