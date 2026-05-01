# Project Overview: Bachelor Thesis (Dyadia)

This project is a multi-service application (monorepo) comprising a Go backend (`richter`, `arthur`), a Next.js frontend (`heino`), and shared infrastructure using Protocol Buffers and PostgreSQL. It appears to be part of a Bachelor Thesis project, potentially involving AI agents and learning science.

## Core Technologies

- **Backend**: Go 1.26+
  - **RPC**: [Connect RPC](https://connectrpc.com/) (gRPC-compatible)
  - **Dependency Injection**: [samber/do/v2](https://github.com/samber/do)
  - **Database**: PostgreSQL (using `pgx/v5` and `sqlc` for type-safe queries)
  - **Configuration**: `viper` and `pflag`
- **Frontend**: TypeScript & Next.js 16 (React 19)
  - **Styling**: TailwindCSS, Radix UI, Shadcn/UI
  - **Communication**: `@connectrpc/connect-web`
- **Shared**:
  - **API Definitions**: Protocol Buffers (managed via `buf`)
  - **Infrastructure**: Podman/Docker Compose, FoundationDB (FDB), Caddy
  - **Documentation**: Typst (for the thesis document)

## Repository Structure

- `golang/`: Go services and generated code.
  - `richter/`: Primary backend service.
  - `arthur/`: Secondary backend service.
  - `buf/`: Generated Go code from Protos.
  - `sql/`: Generated Go code from SQL (via `sqlc`).
- `typescript/`: TypeScript projects.
  - `heino/`: Next.js frontend application.
  - `buf/`: Generated TypeScript code from Protos.
- `proto/`: Protobuf definitions (`.proto` files).
- `sql/`: Database schema and queries.
  - `migrations/`: PostgreSQL migration files.
  - `queries/`: SQL queries for `sqlc`.
- `docs/`: Architectural documentation and environment setup guides.
- `scripts/`: Initialization, setup, and testing scripts.
- `typst/`: Source files for the thesis document.

## Development Workflow

### 1. Local Infrastructure
The project uses Podman/Docker Compose for local services (Postgres, FDB, Caddy).
```sh
podman-compose up -d
```

### 2. DNS & Networking (Crucial)
For host-to-container connectivity (resolving container names like `postgres` or `fdb-coordinator`), use the provided `dev-shell.sh` script. This enters the Podman rootless network namespace.
```sh
./scripts/setup/environment.dev/dev-shell.sh -- go run ./golang/richter
```

### 3. Code Generation
- **Protos**: `make generate-protoc` (requires `buf`).
- **SQL**: `sqlc generate`.

### 4. Running Services
- **Backend (Richter)**: `go run ./golang/richter` (prefer within `dev-shell.sh`).
- **Frontend (Heino)**: `cd typescript/heino && pnpm dev`.

### 5. Testing
- **Go Integration Tests**: Use the `integ` build tag and specific test config.
  ```sh
  ./scripts/test/golang/richter/integ.sh
  ```

## Development Conventions

- **Dependency Injection**: Services should be registered using `samber/do/v2` in their respective `init()` functions or dedicated DI modules.
- **Error Handling**: Use `connectrpc`'s error codes and wrapping where appropriate.
- **Database**: All database interactions should go through `sqlc` generated code in `golang/sql/gen`.
- **Protos**: Use `protovalidate` for request validation as configured in `buf.yaml`.
- **Typing**: Strict TypeScript and Go typing are expected. Avoid `any` or `interface{}` where possible.
