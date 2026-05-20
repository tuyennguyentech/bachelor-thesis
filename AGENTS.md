# Dyadia — Project Instructions

This file provides context for AI assistants working on this project (DeepSeek TUI / Claude Code).

## Project Overview

Dyadia is a multi-service monorepo for a Bachelor Thesis project (IT4995) involving AI agents and learning science. It comprises a Go backend (`richter`, `arthur`), a Next.js 16 frontend (`heino`), and shared infrastructure using Protocol Buffers, PostgreSQL, and FoundationDB.

## Build & Development Commands

### Go Workspace
- `go test ./...` — Run all Go tests
- `go test -tags=integ ./...` — Run integration tests (requires running containers)
- `go run ./golang/richter` — Start richter service

### TypeScript/Next.js
- `pnpm --filter heino dev` — Start Next.js dev server
- `pnpm --filter heino build` — Production build
- `pnpm --filter heino lint` — Run ESLint

### Code Generation
- `make generate-protoc` — Regenerate protobuf code (Go + TypeScript)
- `sqlc generate` — Regenerate SQL code from queries/migrations

### Local Infrastructure
- `podman-compose up -d` — Start FoundationDB, Postgres, Caddy

### Container DNS (Critical)
For host-to-container connectivity, use the dev shell:
```
./scripts/setup/environment.dev/container-shell.sh -- go run ./golang/richter
```
This joins Podman's rootless network namespace and bind-mounts a private `/etc/resolv.conf`.

### Integration Tests
- `./scripts/test/golang/richter/test.sh`

## Architecture

### Dependency Injection
The Go backend uses `samber/do/v2` for DI. Key pattern:
- Each package defines a `Package` variable with `do.Lazy(Constructor)`
- `init()` calls `Package(internal.Injector)` to register
- Use `do.Invoke[Type](injector)` to retrieve dependencies
- Scoped injectors: `internal.Injector.Scope("module-name")`

### Service Structure (richter)
- `cmd/root.go` — Cobra CLI with viper config
- `cfg/cfg.go` — Configuration hierarchy
- `internal/api/` — HTTP server and API handlers
- `internal/svc/` — Business logic services
- `internal/svc/errors.go` — `ConnectDBError` and shared error helpers
- `internal/svc/mapper.go` — Proto ↔ SQL type conversions
- `log/` — Structured logging with `slog`, injected via DI

### API Layer
- Connect RPC (gRPC-compatible) with HTTP/1.1 and HTTP/2 support
- API v1 handlers registered in `internal/api/v1/v1.go`
- Proto definitions in `proto/richter/v1/`
- Validation interceptor via `connectrpc.com/validate` (Buf protovalidate)

### Database
- PostgreSQL with `sqlc` for type-safe queries (generated to `golang/sql/gen`)
- Migrations in `sql/migrations/` (Goose format), queries in `sql/queries/`
- FoundationDB for additional storage (configured via `fdb.cluster`)

### Frontend (heino)
- Next.js 16 with React 19, TypeScript 6
- TailwindCSS 4 + Radix UI + Shadcn/UI + `jose` (JWT)
- Two RPC transport clients:
  - `src/lib/connect-client.ts` — server-side (Node, HTTP/2)
  - `src/lib/connect-webclient.ts` — browser-side hook `useRichterWebClient()`
- Auth: `src/proxy.ts` (Next.js 16 middleware), cookies `dyadia_access` + `dyadia_refresh`
- Server-only auth helpers: `getSession()`, `requireAdmin()`, `displayName()`
- Server actions in `src/app/actions/`

### Service Communication
```
heino (Next.js) → Connect RPC (HTTP POST) → richter:8080 → PostgreSQL:5432
                                                           ↕ (configured, optional)
                                                       FoundationDB:4500
```

## Important Conventions

### Generated Code — NEVER hand-edit
- `golang/buf/gen/` — Generated protobuf Go code
- `typescript/buf/gen/` — Generated protobuf TypeScript code
- `golang/sql/gen/` — Generated SQL code from sqlc

### Configuration
- Viper with TOML config files: `richter.base.toml` → `richter.local.toml` / `richter.test.toml`
- Environment variables prefixed with `RICHTER_` (e.g., `RICHTER_LOG_LEVEL`)
- Frontend env vars: `RICHTER_BASE_URL` (server-side), `NEXT_PUBLIC_RICHTER_BASE_URL` (browser)

### Commit Style
Conventional Commits with scopes: `feat(heino):`, `fix(richter):`, `refactor(sql):`, etc.

### Code Style
- Go: `gofmt`, package-oriented lowercase names
- TypeScript: PascalCase for React components, camelCase for helpers
- 2-space indentation, LF line endings (see `.editorconfig`)
- UI components colocated under `src/components/ui`

## Runtime Rules (MUST follow)

### NEVER use detached/shell background processes
**Forbidden:** `nohup ... &`, shell `cmd &`, background shell tasks for servers (orphan leaks).

**Allowed:** Session-managed processes only.

### ALL operations must use container-shell
Every command — servers, tests, migrations, seed — must run inside `container-shell.sh`:
```
./scripts/setup/environment.dev/container-shell.sh richter -- <command>
./scripts/setup/environment.dev/container-shell.sh heino -- <command>
```

### Test vs Dev Config (Critical)
- `richter.test.toml` = test DB (`dyadia_test`) + test bucket — for Playwright E2E and Go integration tests
- `richter.local.toml` = dev DB (`dyadia`) — for development only

### DB Reset for Tests
```
./scripts/setup/environment.dev/container-shell.sh richter -- goose -env .env.test reset
./scripts/setup/environment.dev/container-shell.sh richter -- goose -env .env.test up
```

## Adding a New RPC Method
1. Add message + service method to `proto/richter/v1/<entity>.proto` (include protovalidate annotations)
2. Run `make generate-protoc`
3. Implement handler in `golang/richter/internal/svc/<entity>/<entity>.go`
4. Add SQL query to `sql/queries/<entity>.sql` and run `sqlc generate`
5. Add proto ↔ SQL conversion to `internal/svc/mapper.go`
6. Call from frontend via `connect-client.ts` or `useRichterWebClient()`

## Version Control
This project uses Git. See `.gitignore` for excluded files.

## Guidelines
- Follow existing code style and patterns
- Write tests for new functionality
- Keep changes focused and atomic
- Document public APIs
