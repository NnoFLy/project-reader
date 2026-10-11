# syntax=docker/dockerfile:1
FROM node:22-alpine@sha256:b74031e546d7f4faf561d797ac1b76beccac856a042815ca77db4fd047581605 AS build

WORKDIR /app

RUN corepack enable \
    && pnpm config set store-dir /pnpm/store

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM caddy:2.11.4-alpine@sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a AS runtime

ARG RELEASE=development
LABEL org.opencontainers.image.source="https://github.com/nnofly/vfs" \
    org.opencontainers.image.revision="$RELEASE"

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
RUN mkdir -p /srv/health \
    && printf '%s\n' "$RELEASE" > /srv/health/version \
    && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

EXPOSE 80
