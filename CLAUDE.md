# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dyadia is a multi-service monorepo for a Bachelor Thesis project involving AI agents and learning science. It comprises a Go backend (`richter`, `arthur`), a Next.js 16 frontend (`heino`), and shared infrastructure using Protocol Buffers, PostgreSQL, and FoundationDB.

## Build & Development Commands

### Go Workspace
```sh
go test ./...                    # Run all Go tests
go test -tags=integ ./...        # Run integration tests (requires running containers)
go run ./golang/richter          # Start richter service
```

### TypeScript/Next.js
```sh
pnpm --filter heino dev          # Start Next.js dev server
pnpm --filter heino build        # Production build
pnpm --filter heino lint         # Run ESLint
```

### Code Generation
```sh
make generate-protoc             # Regenerate protobuf code (Go + TypeScript)
sqlc generate                    # Regenerate SQL code from queries/migrations
```

### Local Infrastructure
```sh
podman compose up -d             # Start FoundationDB, Postgres, Caddy (and other services)
podman compose up -d <service>   # Start a specific service only
```

### Container DNS (Critical)
For host-to-container connectivity (resolving `postgres`, `fdb-coordinator`), use the dev shell:
```sh
./scripts/setup/environment.dev/dev-shell.sh -- go run ./golang/richter
```
This joins Podman's rootless network namespace and bind-mounts a private `/etc/resolv.conf` pointing to Aardvark DNS. Use `container-shell.sh` for bidirectional connectivity.

### Integration Tests
```sh
./scripts/test/golang/richter/test.sh
```

## Architecture

### Dependency Injection
The Go backend uses `samber/do/v2` for dependency injection. Services register themselves via `do.Package()` in `init()` functions. Key pattern:
- Each package defines a `Package` variable with `do.Lazy(Constructor)`
- `init()` calls `Package(internal.Injector)` to register
- Use `do.Invoke[Type](injector)` to retrieve dependencies
- Scoped injectors: `internal.Injector.Scope("module-name")`

### Service Structure (richter)
- `cmd/root.go` - Cobra CLI with viper config, sets up shutdown on signals
- `cfg/cfg.go` - Configuration hierarchy: `RichterCfg` → `LogCfg`, `DbCfg`, `ApiCfg`, `JwtCfg`
- `internal/api/` - HTTP server and API handlers
- `internal/svc/` - Business logic services (e.g., `users.UsersSvc`)
- `internal/svc/errors.go` - `ConnectDBError` and other shared error helpers
- `internal/svc/mapper.go` - Proto ↔ SQL type conversions
- `log/` - Structured logging with `slog`, injected via DI

### API Layer
- Connect RPC (gRPC-compatible) with HTTP/1.1 and HTTP/2 support
- API v1 handlers registered in `internal/api/v1/v1.go` using `http.ServeMux`
- Proto definitions in `proto/richter/v1/`
- Validation interceptor via `connectrpc.com/validate` (Buf protovalidate rules on all messages)

### Database
- PostgreSQL with `sqlc` for type-safe queries (generated to `golang/sql/gen`)
- Migrations in `sql/migrations/` (Goose format), queries in `sql/queries/`
- FoundationDB for additional storage (configured via `fdb.cluster`)

### Frontend (heino)
- Next.js 16 with React 19, TypeScript 6
- TailwindCSS 4 + Radix UI + Shadcn/UI + `jose` (JWT)
- Two RPC transport clients:
  - `src/lib/connect-client.ts` — server-side (Node, HTTP/2), reads `RICHTER_BASE_URL`; accepts optional `token` param for auth
  - `src/lib/connect-webclient.ts` — browser-side hook `useRichterWebClient()`, reads `NEXT_PUBLIC_RICHTER_BASE_URL`
- Auth: `src/proxy.ts` (middleware — Next.js 16 renames `middleware.ts` → `proxy.ts`, export `proxy()`)
- Server-only auth helpers: `src/lib/auth.ts` — `getSession()`, `requireAdmin()`, `displayName()`
- Cookies: `dyadia_access` (access token) + `dyadia_refresh` (refresh token), httpOnly, sameSite: lax
- Server actions in `src/app/actions/` — must use `useActionState` wrapper in client components (form action type constraint)
- Components in `src/components/`, app routes in `src/app/`

### Service Communication
```
heino (Next.js) → Connect RPC (HTTP POST) → richter:8080 → PostgreSQL:5432
                                                          ↕ (configured, optional)
                                                      FoundationDB:4500
```

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
- Frontend env vars: `RICHTER_BASE_URL` (server-side) and `NEXT_PUBLIC_RICHTER_BASE_URL` (browser)

### Commit Style
Conventional Commits with scopes: `feat(heino):`, `fix(richter):`, `refactor(sql):`, etc.

### Next.js 16 Breaking Changes
- Middleware: file is `src/proxy.ts`, exported function is `proxy()` (not `middleware.ts`/`middleware()`)
- `startTransition` callback must return `void` — wrap server actions: `startTransition(async () => { await action(); })`
- `<form action={fn}>` only accepts `(formData: FormData) => void | Promise<void>` — actions returning state must be wrapped in a client component using `useActionState`
- Read `node_modules/next/dist/docs/` before modifying frontend code

### Code Style
- Go: `gofmt`, package-oriented lowercase names
- TypeScript: PascalCase for React components, camelCase for helpers
- 2-space indentation, LF line endings (see `.editorconfig`)
- UI components colocated under `src/components/ui`

## Runtime & Process Rules (MUST follow every session)

### NEVER use detached/shell background processes
**Forbidden — cause orphan leaks:**
- `nohup ... &` — detach khỏi session
- Shell `cmd &` bên trong Bash tool hoặc Agent script — tách process khỏi tầm kiểm soát
- `Bash(run_in_background: true)` để start server — process sống sót sau khi Agent/session tắt, leak vào session tiếp theo

**Allowed — session-managed, tự tắt khi session kết thúc:**
- `Monitor(persistent: true)` — dùng để start server (richter, heino) khi cần chạy test tự động. Claude Code kill process này khi session kết thúc hoặc `TaskStop`.

**Correct approach để chạy server + test tự động (không cần hỏi user):**
```
# 1. Start richter via Monitor (không dùng run_in_background)
Monitor: ./container-shell.sh richter -- go run ./golang/richter/ -c richter.base.toml,richter.test.toml

# 2. Đợi server sẵn sàng (foreground, poll)
Bash: until curl -sf http://richter:8080 >/dev/null; do sleep 2; done

# 3. Chạy test (foreground)
Bash: ./container-shell.sh richter -- ./scripts/test/golang/richter/test.sh
# hoặc Playwright:
Bash: ./container-shell.sh heino -- pnpm -F heino exec playwright test

# 4. Dừng server
TaskStop: <monitor task id>
```

**Go integration tests** (`test.sh`): Tự spin up test server trong process — **không cần start server riêng**, chỉ cần chạy `test.sh` foreground.

First, always check `ps aux` and kill any orphan richter/heino not owned by the current session. Never reuse orphan processes from a previous session.

### ALL operations MUST use container-shell
Every command — servers, tests, migrations, seed — must run inside `container-shell.sh` (Aardvark DNS resolves `postgres`, `storage`, `richter`).

```sh
# Heino dev server (via Shell mode or Agent)
./scripts/setup/environment.dev/container-shell.sh heino -- pnpm -F heino dev

# Richter service — test DB (via Shell mode or Agent)
./scripts/setup/environment.dev/container-shell.sh richter -- go run ./golang/richter/ -c golang/richter/richter.base.toml,golang/richter/richter.test.toml

# Richter service — dev DB
./scripts/setup/environment.dev/container-shell.sh richter -- go run ./golang/richter/ -c golang/richter/richter.base.toml,golang/richter/richter.local.toml

# Playwright E2E tests — richter PHẢI dùng richter.test.toml (test DB), KHÔNG dùng richter.local.toml
./scripts/setup/environment.dev/container-shell.sh heino -- pnpm -F heino exec playwright test

# Go integration tests
./scripts/setup/environment.dev/container-shell.sh richter -- ./scripts/test/golang/richter/test.sh
```

Config via `-c` flag for richter. Never hardcode hostnames/passwords/endpoints in source.

**CRITICAL — Test vs Dev config:**
- `richter.test.toml` = test DB (`dyadia_test`) + test bucket (`dyadia-test`). Dùng khi chạy Playwright E2E tests và Go integration tests.
- `richter.local.toml` = dev DB (`dyadia`) + dev bucket (`dyadia`). Chỉ dùng cho development, KHÔNG dùng khi test.
- Trước khi chạy Playwright, luôn kiểm tra richter đang dùng `richter.test.toml`.

### DB reset for tests
```sh
# Use goose -env flag to load .env/.env.test — do NOT inline GOOSE_DBSTRING or source the file manually
./scripts/setup/environment.dev/container-shell.sh richter -- goose -env .env.test reset
./scripts/setup/environment.dev/container-shell.sh richter -- goose -env .env.test up

# Reseed
./scripts/setup/environment.dev/container-shell.sh richter -- go run ./golang/richter/ -c golang/richter/richter.base.toml,golang/richter/richter.test.toml seed --dev
```

## Adding a New RPC Method

1. Add message + service method to `proto/richter/v1/users.proto` (include protovalidate annotations)
2. Run `make generate-protoc` — updates `golang/buf/gen/` and `typescript/buf/gen/`
3. Implement handler in `golang/richter/internal/svc/users/users.go`
4. Add SQL query to `sql/queries/users.sql` and run `sqlc generate`
5. Add proto ↔ SQL conversion to `internal/svc/mapper.go` if needed
6. Call from frontend via `connect-client.ts` (server component) or `useRichterWebClient()` (client component)
