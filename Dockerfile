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

FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS runtime

ARG RELEASE=development
LABEL org.opencontainers.image.source="https://github.com/I0I-I0I/project-reader" \
    org.opencontainers.image.revision="$RELEASE"

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
RUN mkdir -p /srv/health \
    && printf '%s\n' "$RELEASE" > /srv/health/version \
    && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

EXPOSE 80
