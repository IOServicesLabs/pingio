# Deployment Options

This directory contains packaging for deploying the Pingio central-auth stack to the internet while keeping the self-hosted path available.

## Self-hosted (local)

Use `infrastructure/docker/docker-compose.yml`:

```bash
cd infrastructure/docker
cp .env.example .env
# edit .env
docker compose up -d
```

The relay runs in `local` auth mode and handles registration/login itself.

## VPS with Docker Compose + Caddy

Use `infrastructure/docker/docker-compose.prod.yml`:

```bash
cd infrastructure/docker
cp .env.example .env
# edit domains, secrets, and Postgres password
docker compose -f docker-compose.prod.yml up -d
```

Services:
- `postgres` — shared database instance
- `redis` — session/message cache
- `auth` — OAuth2/OIDC authority on port 3001
- `relay` — messaging relay on port 3000 in `AUTH_MODE=central`
- `caddy` — reverse proxy with automatic TLS for `auth.pingio.io` and `relay.pingio.io`

The relay validates access tokens via the auth service's JWKS endpoint. Device verification and registration/login live in the auth service.

## Railway

Two service configs are provided because Railway's JSON schema is per-service:

- `railway.json` — relay server
- `railway.auth.json` — auth server

Create two Railway services from the same repo, point each at the corresponding config file, and set the environment variables from `infrastructure/docker/.env.example`.

## Render

`render.yaml` is a Blueprint that creates:
- managed PostgreSQL
- managed Redis
- `pingio-auth` web service
- `pingio-relay` web service

Create a new Blueprint in Render, paste the repo URL, and update the `ISSUER`/`RELAY_URL` values to match your actual Render domains.

## Fly.io

Two app configs are provided:

- `fly.auth.toml` — auth service
- `fly.toml` — relay service

Deploy each:

```bash
fly deploy --config fly.auth.toml
fly deploy --config fly.toml
```

Provision Postgres and Redis through Fly, attach them to the apps, and set the secrets listed in the TOML comments.

## Environment Notes

- `AUTH_MODE=central` tells the relay to validate tokens from the auth service JWKS.
- `CENTRAL_AUTH_ISSUER` must match the auth service's public URL and the `iss` claim in tokens.
- `RELAY_URL`/`RELAY_DOMAIN` are returned by `/.well-known/pingio` so MCP clients can auto-discover the relay.
- Always change `JWT_SECRET`, `POSTGRES_PASSWORD`, and other defaults in production.
