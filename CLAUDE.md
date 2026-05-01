# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dyadia is a multi-service monorepo for a Bachelor Thesis project involving AI agents and learning science. It comprises a Go backend (`richter`, `arthur`), a Next.js 16 frontend (`heino`), and shared infrastructure using Protocol Buffers, PostgreSQL, and FoundationDB.

## Build & Development Commands

### Go Workspace
```sh
go test ./...                    # Run all Go tests
go test -tags=integ ./...        # Run integration tests
go run ./golang/richter          # Start richter service
```

### TypeScript/Next.js
```sh
pnpm --filter heino dev          # Start Next.js dev server
pnpm --filter heino build       # Production build
pnpm --filter heino lint        # Run ESLint
```

### Code Generation
```sh
make generate-protoc             # Regenerate protobuf code (Go + TypeScript)
sqlc generate                    # Regenerate SQL code from queries/migrations
```

### Local Infrastructure
```sh
podman-compose up -d             # Start FoundationDB, Postgres, Caddy
```

### Container DNS (Critical)
For host-to-container connectivity (resolving `postgres`, `fdb-coordinator`), use the dev shell:
```sh
./scripts/setup/environment.dev/dev-shell.sh -- go run ./golang/richter
```

### Integration Tests
```sh
./scripts/test/golang/richter/integ.sh
```

## Architecture

### Dependency Injection
The Go backend uses `samber/do/v2` for dependency injection. Services register themselves via `do.Package()` in `init()` functions. Key pattern:
- Each package defines a `Package` variable with `do.Lazy(Constructor)`
- `init()` calls `Package(internal.Injector)` to register
- Use `do.Invoke[Type](injector)` to retrieve dependencies

### Service Structure (richter)
- `cmd/root.go` - Cobra CLI with viper config, sets up shutdown on signals
- `cfg/cfg.go` - Configuration hierarchy: `RichterCfg` → `LogCfg`, `DbCfg`, `ApiCfg`
- `internal/api/` - HTTP server and API handlers
- `internal/svc/` - Business logic services (e.g., `users.UsersSvc`)
- `log/` - Structured logging with `slog`, injected via DI

### API Layer
- Connect RPC (gRPC-compatible) with HTTP/1.1 and HTTP/2 support
- API v1 handlers registered in `internal/api/v1/v1.go` using `http.ServeMux`
- Proto definitions in `proto/richter/v1/`

### Database
- PostgreSQL with `sqlc` for type-safe queries (generated to `golang/sql/gen`)
- Migrations in `sql/migrations/`, queries in `sql/queries/`
- FoundationDB for additional storage (configured via `fdb.cluster`)

### Frontend (heino)
- Next.js 16 with React 19, TypeScript 6
- TailwindCSS 4 + Radix UI + Shadcn/UI
- Connect RPC web client (`@connectrpc/connect-web`)
- Components in `src/components/`, app routes in `src/app/`

## Important Conventions

### Generated Code
Never hand-edit files in:
- `golang/buf/gen/` - Generated protobuf Go code
- `typescript/buf/gen/` - Generated protobuf TypeScript code
- `golang/sql/gen/` - Generated SQL code from sqlc

### Configuration
- Viper with TOML config files: `/etc/richter/richter.toml` → `~/.richter/richter.toml` → `./richter.toml`
- Environment variables prefixed with `RICHTER_` (e.g., `RICHTER_LOG_LEVEL`)
- Local overrides: `richter.local.toml`, `richter.test.toml`

### Commit Style
Conventional Commits with scopes: `feat(heino):`, `fix(richter):`, `refactor(sql):`, etc.

### Next.js Warning
This uses Next.js 16 (bleeding edge with breaking changes). Read `node_modules/next/dist/docs/` before modifying frontend code.

### Code Style
- Go: `gofmt`, package-oriented lowercase names
- TypeScript: PascalCase for React components, camelCase for helpers
- 2-space indentation, LF line endings (see `.editorconfig`)
- UI components colocated under `src/components/ui`
