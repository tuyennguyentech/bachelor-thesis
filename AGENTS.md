# Dyadia — Project Instructions

Multi-service monorepo (Bachelor Thesis IT4995). Go backend (`richter`, `arthur` is a stub), Next.js 16 frontend (`heino`), Postgres, FoundationDB, Connect RPC, SeaweedFS (S3).

## Container Networking — ALL commands use this

Dev processes have no direct network access to compose containers. Always use:

```
./scripts/setup/environment.dev/container-shell.sh <service> -- <command>
```

Default container is `debug` (alpine/curl). Replace `<service>` with `richter`, `heino`, etc. to join that container's network namespace. Inside the shell, `postgres`, `fdb-coordinator`, `storage`, `richter` all resolve via aardvark-dns.

## Commands

| Action | Command |
|--------|---------|
| Start compose services | `podman compose up -d` |
| Proto codegen | `buf generate` (Makefile is empty — do NOT use `make`) |
| SQL codegen | `sqlc generate` |
| All Go tests | `go test ./...` |
| Go integ tests | `go test -tags=integ ./...` (compose must be up) |
| Go integ test script | `./scripts/test/golang/richter/test.sh` (spins own server) |
| Heino dev | `pnpm --filter heino dev` |
| Heino build | `pnpm --filter heino build` |
| Heino lint | `pnpm --filter heino lint` |
| Heino E2E | `pnpm --filter heino exec playwright test` |

## Verification after changes

```
go vet ./golang/richter/...
pnpm --filter heino exec tsc --noEmit
```

## Starting Richter (config flags required)

```
# test DB (for Playwright E2E + integ tests)
./scripts/setup/environment.dev/container-shell.sh richter -- \
  go run ./golang/richter/ -c golang/richter/richter.base.toml,golang/richter/richter.test.toml

# dev DB
./scripts/setup/environment.dev/container-shell.sh richter -- \
  go run ./golang/richter/ -c golang/richter/richter.base.toml,golang/richter/richter.local.toml
```

Configs are comma-separated, merged left-to-right via viper `MergeInConfig`. Env vars prefixed `RICHTER_` (e.g. `RICHTER_LOG_LEVEL`).

## Seed

```
./scripts/setup/environment.dev/container-shell.sh richter -- \
  go run ./golang/richter/ -c ... seed --dev
```

`seed` creates admin user. `--dev` also inserts dev data (orgs, courses, etc.). Requires seed-asset videos (run `scripts/seed/download-assets.sh` first).

## DB Reset

```
./scripts/setup/environment.dev/container-shell.sh richter -- goose -env .env.test reset
./scripts/setup/environment.dev/container-shell.sh richter -- goose -env .env.test up
```

Uses `goose` with `.env`/`.env.test` for DB connection strings — do not inline `GOOSE_DBSTRING`. Migration naming convention: `NNNNN_action_type_objects.sql` (see `docs/backend/migration-naming.md`).

## Test vs Dev DB

- `richter.test.toml` → DB `dyadia_test` + bucket `dyadia-test` — for tests
- `richter.local.toml` → DB `dyadia` + bucket `dyadia` — dev only
- Init script creates both roles/DBs: `scripts/init/postgresql/dev.sql`

## Architecture (key facts)

### DI pattern (`samber/do/v2`)
Each package exports `var Package = do.Package(do.Lazy(Constructor))`. `init()` calls `Package(internal.Injector)`. Retrieve with `do.Invoke[Type](injector)`. Scoped: `internal.Injector.Scope("module-name")`.

### Go workspace (`go.work`)
4 modules: `golang/richter`, `golang/arthur`, `golang/buf` (proto gen), `golang/sql` (sqlc gen).

### Richter entrypoints
`cmd/root.go` (Cobra) → `internal/api/server.go` (HTTP) → handlers in `internal/api/v1/` → business logic in `internal/svc/`. Proto ↔ SQL conversions in `internal/svc/mapper.go`.

### Connect RPC
gRPC-compatible, HTTP/1.1 + HTTP/2. Proto definitions in `proto/richter/v1/`. Validation via `connectrpc.com/validate` (Buf protovalidate).

### Frontend (heino)
- **Critical Next.js 16 breaking changes**: see `typescript/heino/AGENTS.md` — this is NOT the Next.js you know
- Middleware: `src/proxy.ts` exporting `proxy()` (not `middleware.ts`)
- Server RPC client: `src/lib/connect-client.ts` (reads `RICHTER_BASE_URL`)
- Browser RPC hook: `useRichterWebClient()` (reads `NEXT_PUBLIC_RICHTER_BASE_URL`)
- Auth: JWT cookies `dyadia_access` + `dyadia_refresh`, helpers `getSession()`, `requireAdmin()` in `src/lib/auth.ts`

### S3 storage
SeaweedFS via compose service `storage:9000`. Public endpoint differs between dev (`http://localhost/api/storage`) and test (`http://caddy/api/storage`).

### AI audio key path
Must be `lessons/<lessonID>/ai-audio/<uuid>.wav` (not `ai-generated/audio/`).

## Interaction System — Phase Progress

| Phase | Feature | Status |
|-------|---------|--------|
| 0 | MCQ refactor + registry pattern + UI redesign + feedback mode | Backend done, FE pending |
| 1 | Fill-blank interaction + AI generation | Done |
| 2 | Listening + Reading interactions (audio upload, comprehension, dictation) | Done |
| 3 | Writing interaction (AI-graded essay via Gemini judge, async grading pipeline) | Not started |
| 4 | Code interaction (Monaco editor + sandboxed execution) | Not started |

Phase 3 introduces async grading pipeline (`LessonAttempt.status='pending_review'`). Phase 4 reuses it.
Multi-attempt support: Phase 0 single-attempt; Phases 1+ may differ — scope per interaction type.

## Generated Code — NEVER hand-edit

- `golang/buf/gen/` — protobuf Go
- `typescript/buf/gen/` — protobuf TypeScript
- `golang/sql/gen/` — sqlc Go

## Adding a New RPC Method

1. Add message + service to `proto/richter/v1/<entity>.proto` (protovalidate annotations)
2. Run `buf generate`
3. Implement handler in `golang/richter/internal/svc/<entity>/<entity>.go`
4. Add SQL to `sql/queries/<entity>.sql`, run `sqlc generate`
5. Add proto ↔ SQL mapping in `internal/svc/mapper.go`
6. Call from frontend via `connect-client.ts` (server) or `useRichterWebClient()` (client)

## Commit Style

Conventional Commits with scopes: `feat(heino):`, `fix(richter):`, `refactor(sql):`, etc.

Rules:
- NEVER use `git add .` or `git add -A` — always explicit file paths
- NEVER add `Co-Authored-By:` trailers
- Auto-commit only when: build clean + tests pass + coherent unit

## Background Processes

Never use `nohup ... &`, `cmd &`, or detached processes (orphan leaks). Use session-managed processes only. Before starting servers, check `ps aux` for orphan `richter`/`heino` processes from prior sessions.

When killing orphans: kill by command name (`go run ./golang/richter`, `pnpm --filter heino dev`, `next-server`), NOT by the shell that launched them. Never kill interactive `container-shell.sh bash` sessions — those belong to the user.

## Frontend Conventions (from past sessions)

### Auth details
- JWT claims: snake_case from Go protobuf JSON tags; `role` = 1 (NORMAL), 2 (ADMIN)
- Cookies: `dyadia_access` + `dyadia_refresh`, httpOnly, sameSite: lax
- Server-only auth helpers: `getSession()` (wrapped in `cache()`, includes silent refresh), `requireAdmin()`, `requireAnyUser()`, `requireOrgMember(orgId, ...roles)`

### Proto imports (TypeScript)
```ts
import { UserService, UserRole } from "buf/gen/richter/v1/users_pb"
```
Enum members use SHORT names: `UserRole.ADMIN` (NOT `USER_ROLE_ADMIN`).

### Pagination
```ts
const LIMIT = 20
const hasNext = res.users.length === LIMIT  // no total field
```
`limit`/`offset` are `number` (int32), not bigint. Proto must validate `limit: gte:1, lte:100`, `offset: gte:0`.

### Playwright E2E
- `baseURL` uses Caddy `http://localhost` (port 80), not `localhost:3000`
- Radix `DropdownMenuItem` with `asChild`+`Link` is flaky in Firefox — read `href` attribute instead of click-navigate
- After `revalidatePath`, wait for updated heading in-place — don't `page.goto` back
- Use `?q=` search param to find seed data (page 1 may not contain oldest records)

## Testing Rules (from past sessions)

### Test infrastructure checklist (before claiming "test broken")
1. Confirm richter is up with `richter.test.toml` (not local)
2. Reset + re-seed test DB (`goose -env .env.test reset` + `goose -env .env.test up` + `seed --dev`)
3. **Critical: restart richter AFTER goose reset** (schema OID cache invalidation)
4. Verify seed data matches test expectations

### Don't change working code to fix new tests
Fix the test assertion, not the pre-existing passing code.

### DB seed: runs once, no upsert
INSERT + skip-on-duplicate only (NOT `ON CONFLICT DO UPDATE`). Tests must not create conflicting data with seed.

## Package & Dependency Rules

- Don't run `pnpm add`/`pnpm install` without asking user
- Use `podman compose` (not `podman-compose`, not `docker compose`)
- No hardcoded env-specific values (URIs, hostnames) in source code
- All :many SQL queries must have `LIMIT $n OFFSET $m`
